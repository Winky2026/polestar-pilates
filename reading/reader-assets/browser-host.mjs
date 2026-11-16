import {extractBook} from './epub.mjs';
import {supabase} from './supabase-config.mjs';
const sessionKey='personal-reading-shelf-auth-v1';
function authStatus(){
  try{return JSON.parse(sessionStorage.getItem(sessionKey)) || null;}catch{return null;}
}
let authSession=authStatus();
let refreshInFlight;
function rememberSession(session){
  authSession=session;
  if(session) sessionStorage.setItem(sessionKey,JSON.stringify(session));
  else sessionStorage.removeItem(sessionKey);
}
async function supabaseRequest(path,{method='GET',body,token,timeout=8000}={}){
  const headers={'apikey':supabase.publicKey,'Content-Type':'application/json'};
  if(token) headers.Authorization='Bearer '+token;
  const response=await fetch(supabase.url+path,{
    method,headers,body:body===undefined?undefined:JSON.stringify(body),
    signal:AbortSignal.timeout(timeout)
  });
  const output=await response.json().catch(()=>null);
  if(!response.ok) throw Error(output?.message || output?.msg || '服务暂时不可用。');
  return output;
}
async function usableToken(){
  if(!authSession) throw Error('请先登录。');
  const expiration=(authSession.expires_at || 0)*1000;
  if(expiration>Date.now()+45000) return authSession.access_token;
  if(!refreshInFlight){
    refreshInFlight=supabaseRequest('/auth/v1/token?grant_type=refresh_token',
      {method:'POST',body:{refresh_token:authSession.refresh_token}}).then(session=>{
      rememberSession(session);
      return session.access_token;
    }).finally(()=>{refreshInFlight=null;});
  }
  return refreshInFlight;
}
async function readingAccess(token,owner){
  const query=new URLSearchParams({user_id:'eq.'+owner,select:'enabled',limit:'1'});
  const access=await supabaseRequest('/rest/v1/account_access?'+query,{token});
  return Boolean(access[0]?.enabled);
}
async function signIn(email,password){
  const session=await supabaseRequest('/auth/v1/token?grant_type=password',{method:'POST',body:{email,password}})
    .catch(error=>{throw Error(/invalid login|invalid credentials|credentials/i.test(error.message)?'邮箱或密码不正确。':error.message);});
  if(!session.user?.id || !await readingAccess(session.access_token,session.user.id)) throw Error('这个账号未开通或已停用。');
  rememberSession(session);
  location.reload();
}
async function currentUser(){
  if(!authSession?.user?.id) return null;
  try{
    const token=await usableToken();
    const user=await supabaseRequest('/auth/v1/user',{token});
    if(user.id!==authSession.user.id || !await readingAccess(token,user.id)){
      rememberSession(null);
      return null;
    }
    return user;
  }catch{
    if(authSession?.user?.id && !navigator.onLine) return authSession.user;
    rememberSession(null);
    return null;
  }
}
async function signOut(storage){
  if(storage) await storage.flush();
  if(authSession){
    try{await supabaseRequest('/auth/v1/logout?scope=local',{method:'POST',token:await usableToken()});}
    catch{}
  }
  rememberSession(null);
  location.assign('./');
}

const keys={
  'midnight-reading-activity-v2':'activity',
  'midnight-completed-pages-v1':'completed',
  'midnight-vocabulary-v1':'vocabulary',
  'midnight-reader-v1':'settings'
};

function openDeviceLibrary(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('reading-shelf-books-v1',1);
    request.onupgradeneeded=()=>{
      const store=request.result.createObjectStore('books',{keyPath:['owner','id']});
      store.createIndex('byOwner','owner');
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
function useLibrary(owner){
  let database;
  async function transaction(mode,action){
    database ||= openDeviceLibrary();
    const db=await database;
    return new Promise((resolve,reject)=>{
      const pending=db.transaction('books',mode);
      let request;
      try{request=action(pending.objectStore('books'));}catch(error){reject(error);return;}
      pending.oncomplete=()=>resolve(request.result);
      pending.onerror=()=>reject(pending.error||request.error);
      pending.onabort=()=>reject(pending.error||Error('浏览器未能保存这本书。'));
    });
  }
  return {
    async list(){
      const records=await transaction('readonly',store=>store.index('byOwner').getAll(owner));
      return records.map(({book,owner,...details})=>details).sort((a,b)=>a.title.localeCompare(b.title));
    },
    async get(id){
      const item=await transaction('readonly',store=>store.get([owner,id]));
      if(!item) throw Error('这本书还未导入当前设备。');
      return item;
    },
    async add(file,lang){
      const item=await extractBook(file,lang);
      await transaction('readwrite',store=>store.put({...item,owner}));
      return item;
    }
  };
}
function ownMap(){
  return Object.create(null);
}
function flatten(space,value){
  const result=ownMap();
  if(space==='settings'){
    const {positions,...appearance}=value;
    result.appearance=appearance;
    for(const [book,position] of Object.entries(positions||{})) result['positions/'+book]=position;
  }else if(space==='vocabulary'){
    Object.assign(result,value);
  }else{
    for(const [group,records] of Object.entries(value)){
      for(const [key,record] of Object.entries(records || {})) result[group+'/'+key]=record;
    }
  }
  return result;
}
function expand(space,rows){
  const result=ownMap();
  for(const [key,value] of Object.entries(rows)){
    if(value===null) continue;
    if(space==='vocabulary') result[key]=value;
    else if(space==='settings' && key==='appearance') Object.assign(result,value);
    else {
      const split=key.indexOf('/');
      if(split<0) continue;
      const group=key.slice(0,split);
      const item=key.slice(split+1);
      (result[group]??=ownMap())[item]=value;
    }
  }
  return result;
}
function persisted(storageKey){
  try{return JSON.parse(localStorage.getItem(storageKey)) || {};}catch{return {};}
}
function makeSync(owner){
  const prefix='reading-shelf:'+owner+':';
  const saved=persisted(prefix+'records');
  const pending=persisted(prefix+'pending');
  let syncTimer, syncing=false, problem=false;
  function tell(message){
    const node=document.getElementById('site-sync');
    if(node) node.textContent=message;
  }
  function persist(){
    try{
      localStorage.setItem(prefix+'records',JSON.stringify(saved));
      localStorage.setItem(prefix+'pending',JSON.stringify(pending));
    }catch{tell('设备存储空间不足');}
  }
  function merge(row){
    if(!Object.values(keys).includes(row.space)||typeof row.key!=='string') return;
    const group=saved[row.space]??=ownMap();
    const current=Object.hasOwn(group,row.key)?group[row.key]:null;
    if(!current || current.modified<=row.modified){
      Object.defineProperty(group,row.key,{value:row,enumerable:true,writable:true,configurable:true});
    }
  }
  async function pull(){
    try{
      const token=await usableToken();
      for(let offset=0;;offset+=500){
        const query=new URLSearchParams({
          select:'namespace,record_key,payload,modified',owner:'eq.'+owner,
          order:'namespace.asc,record_key.asc',limit:'500',offset:String(offset)
        });
        const rows=await supabaseRequest('/rest/v1/reader_records?'+query,{token});
        rows.forEach(row=>merge({space:row.namespace,key:row.record_key,modified:row.modified,value:row.payload}));
        if(rows.length<500) break;
      }
      persist();
      problem=false;
    }catch{
      problem=true;
    }
  }
  async function flush(){
    clearTimeout(syncTimer);
    if(syncing) return;
    const rows=Object.entries(pending).slice(0,50);
    if(!rows.length) return;
    syncing=true;
    try{
      await supabaseRequest('/rest/v1/rpc/save_reader_records',{
        method:'POST',token:await usableToken(),body:{records:rows.map(([,row])=>row)}
      });
      for(const [key,row] of rows) if(pending[key]?.modified===row.modified) delete pending[key];
      persist();
      problem=false;
      tell('已同步');
      if(Object.keys(pending).length) syncTimer=setTimeout(flush,80);
    }catch{
      problem=true;
      tell('已保存在本机，待同步');
      syncTimer=setTimeout(flush,15000);
    }finally{syncing=false;}
  }
  function getItem(key){
    const space=keys[key];
    if(!space) return localStorage.getItem(prefix+key);
    const rows=Object.fromEntries(Object.entries(saved[space] || {}).map(([k,row])=>[k,row.value]));
    return JSON.stringify(expand(space,rows));
  }
  function setItem(key,text){
    const space=keys[key];
    if(!space){localStorage.setItem(prefix+key,text);return;}
    const next=flatten(space,JSON.parse(text));
    const prior=saved[space] ?? ownMap();
    let changed=false;
    for(const [k,value] of Object.entries(next)){
      if(Object.hasOwn(prior,k) && JSON.stringify(prior[k].value)===JSON.stringify(value)) continue;
      const modified=Math.max(Date.now(),(Object.hasOwn(prior,k)?prior[k].modified:0)+1);
      const row={space,key:k,modified,value};
      merge(row);
      pending[space+'/'+k]=row;
      changed=true;
    }
    if(space==='vocabulary'){
      for(const [k,old] of Object.entries(prior)){
        if(old.value===null || Object.hasOwn(next,k)) continue;
        const row={space,key:k,modified:Math.max(Date.now(),old.modified+1),value:null};
        merge(row);
        pending[space+'/'+k]=row;
        changed=true;
      }
    }
    if(!changed) return;
    persist();
    clearTimeout(syncTimer);
    syncTimer=setTimeout(flush,550);
  }
  window.addEventListener('online',flush);
  window.addEventListener('pagehide',()=>{
    const records=Object.values(pending).slice(0,25);
    if(records.length && authSession?.access_token){
      fetch(supabase.url+'/rest/v1/rpc/save_reader_records',{method:'POST',keepalive:true,
        headers:{'apikey':supabase.publicKey,'Authorization':'Bearer '+authSession.access_token,'Content-Type':'application/json'},
        body:JSON.stringify({records})
      }).catch(()=>{});
    }
  });
  return {getItem,setItem,pull,flush,get problem(){return problem;}};
}
export async function createHostedReader(){
  const user=await currentUser();
  if(!user){
    return {user:null,signIn,storage:{getItem:()=>null,setItem:()=>{}},books:{list:async()=>[]}};
  }
  const storage=makeSync(user.id);
  await storage.pull();
  storage.flush();
  return {user,signIn,signOut:()=>signOut(storage),storage,books:useLibrary(user.id)};
}
