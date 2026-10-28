(async()=>{
 const button=document.createElement('button');button.id='offlineDownload';button.className='mobile-secondary';button.textContent='下载离线资源';button.disabled=true;document.getElementById('helpOpen').before(button);
 if(!('serviceWorker' in navigator)||!('caches' in window)){button.disabled=true;button.textContent='当前浏览器不支持离线资源';return;}
 let manifest,cache;
 try{
  await navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'});await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('离线服务准备超时')),15000))]);
  const response=await fetch('./offline-assets.json');if(!response.ok)throw Error('资源列表读取失败');manifest=await response.json();
  cache=await caches.open('polestar-public-media-v1');
  const keys=new Set((await cache.keys()).map(request=>request.url));
  if(manifest.files.every(path=>keys.has(new URL(path,location.href).href)))button.textContent='离线资源已就绪';
 }catch{button.disabled=false;button.textContent='重试准备离线资源';button.onclick=()=>location.reload();return;}
 button.disabled=false;
 button.onclick=async()=>{
  button.disabled=true;let completed=0,failed=false,index=0;
  try{
   const download=async()=>{while(index<manifest.files.length&&!failed){const url=new URL(manifest.files[index++],location.href).href;if(!await cache.match(url)){const response=await fetch(url);if(!response.ok)throw Error('图片或语音下载失败');await cache.put(url,response);}completed++;button.textContent='离线资源 '+Math.round(completed/manifest.files.length*100)+'%';}};
   const results=await Promise.allSettled(Array.from({length:3},()=>download().catch(error=>{failed=true;throw error;})));
   if(results.some(result=>result.status==='rejected'))throw Error('离线资源下载中断');
   button.textContent='离线资源已就绪';toast('图片和语音已保存，可离线练习。');
  }catch(error){button.textContent='重试下载离线资源';toast('离线资源尚未下载完整，请联网后重试。');}
  finally{button.disabled=false;}
 };
})();

// An explicit refresh for home-screen web apps; never clear progress or downloaded media.
(()=>{
 const checkpointKey='polestar-refresh-view-v1',allowedTabs=['play','library','matrix','tracking','practice','notesStudy','learningPlans'];
 const indicator=document.createElement('div');indicator.id='pullRefresh';indicator.hidden=true;indicator.setAttribute('role','status');indicator.setAttribute('aria-live','polite');indicator.innerHTML='<span class="pull-refresh-icon" aria-hidden="true">↓</span><span class="pull-refresh-label">下拉刷新</span>';document.body.append(indicator);
 const style=document.createElement('style');style.textContent='html{overscroll-behavior-y:none}#pullRefresh{position:fixed;left:50%;top:calc(10px + env(safe-area-inset-top));z-index:9999;display:flex;align-items:center;gap:9px;max-width:calc(100vw - 32px);padding:10px 17px;border:1px solid #eee;border-radius:24px;background:#fff;box-shadow:0 4px 18px #00000012;color:#555;font-size:14px;pointer-events:none;transform:translate(-50%,-80px)}#pullRefresh[hidden]{display:none}#pullRefresh .pull-refresh-icon{color:#d68b00;font-size:20px;line-height:1}#pullRefresh[data-busy=true] .pull-refresh-icon{display:block;animation:polestar-refresh-spin 1s linear infinite}@keyframes polestar-refresh-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){#pullRefresh[data-busy=true] .pull-refresh-icon{animation:none}}';document.head.append(style);
 let start=null,pulling=false,armed=false,busy=false,hideTimer;
 const label=indicator.querySelector('.pull-refresh-label'),icon=indicator.querySelector('.pull-refresh-icon');
 function show(text,working=false){clearTimeout(hideTimer);indicator.hidden=false;indicator.style.transform='translate(-50%,0)';indicator.dataset.busy=String(working);if(label.textContent!==text)label.textContent=text;icon.textContent=working?'↻':'↓';}
 function reset(){start=null;pulling=false;armed=false;if(!busy)indicator.hidden=true;}
 function fail(text){busy=false;start=null;pulling=false;armed=false;show(text);icon.textContent='!';hideTimer=setTimeout(()=>{indicator.hidden=true;},3000);}
 async function updateWorker(){
  if(!('serviceWorker' in navigator))return;
  const task=(async()=>{const registration=await navigator.serviceWorker.getRegistration();if(!registration)return;await registration.update();const worker=registration.installing||registration.waiting;if(!worker)return;if(worker.state==='activated'||worker.state==='redundant')return;
   await new Promise(resolve=>{const finish=()=>{if(['activated','redundant'].includes(worker.state)){worker.removeEventListener('statechange',finish);resolve();}};worker.addEventListener('statechange',finish);worker.postMessage({type:'SKIP_WAITING'});finish();});})();
  // Fresh navigation and a versioned script remain usable if a worker update is slow.
  await Promise.race([task.catch(()=>{}),new Promise(resolve=>setTimeout(resolve,8000))]);
 }
 async function refresh(){
  if(busy)return false;busy=true;show('正在检查更新…',true);
  try{
   const root=new URL('./',location.href),stamp=String(Date.now()),infoURL=new URL('build-info.json',root),pageURL=new URL('index.html',root);infoURL.searchParams.set('_refresh',stamp);pageURL.searchParams.set('_refresh',stamp);
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);let info;
   try{const [response,page]=await Promise.all([fetch(infoURL,{cache:'no-store',signal:controller.signal}),fetch(pageURL,{cache:'no-store',signal:controller.signal})]);if(!response.ok||!page.ok)throw Error('network');info=await response.json();if(!/^[a-f0-9]{12}$/.test(info.version||''))throw Error('manifest');const parsed=new DOMParser().parseFromString(await page.text(),'text/html');if(parsed.querySelector('meta[name=polestar-build]')?.content!==info.version)throw Error('publishing');}finally{clearTimeout(timer);}
   show('正在准备更新…',true);await updateWorker();
   show('正在保存进度…',true);document.activeElement?.blur();if(typeof persist==='function')persist();if(typeof saveError==='string'&&saveError)throw Error('save');
   try{if(window.polestarCloud?.active)await window.polestarCloud.prepareExit();}catch{throw Error('save');}
   if(typeof stopSpeaking==='function')stopSpeaking();window.polestarNotes?.stopNarration();
   show('正在刷新页面…',true);
   try{sessionStorage.setItem(checkpointKey,JSON.stringify({tab:document.body.dataset.activeTab,owner:window.polestarCloud?.active?window.polestarCloud.storageKey:null,at:Date.now()}));}catch{}
   const destination=new URL(location.href);destination.searchParams.set('v',info.version);destination.searchParams.set('_refresh',stamp);location.replace(destination.href);return true;
  }catch(error){fail(error.message==='save'?'进度暂未保存，请稍后再试':error.message==='publishing'?'新版正在发布，请稍后再试':'暂时无法连接，请联网后重试');return false;}
 }
 function blocked(target){
  if(document.querySelector('dialog[open]')||target.closest('button,a,input,textarea,select,[contenteditable=true]'))return true;
  for(let node=target;node&&node!==document.body&&node!==document.documentElement;node=node.parentElement){const css=getComputedStyle(node);if(/auto|scroll/.test(css.overflowY)&&node.scrollHeight>node.clientHeight+1)return true;}return false;
 }
 document.addEventListener('touchstart',event=>{if(busy||event.touches.length!==1||scrollY>1||!(event.target instanceof Element)||blocked(event.target)){start=null;return;}const touch=event.touches[0];start={x:touch.clientX,y:touch.clientY};pulling=false;armed=false;},{passive:true});
 document.addEventListener('touchmove',event=>{if(!start||busy)return;if(event.touches.length!==1){reset();return;}const touch=event.touches[0],dy=touch.clientY-start.y,dx=Math.abs(touch.clientX-start.x);if(dy<=0||dx>Math.abs(dy)||scrollY>1){reset();return;}if(dy<10&&!pulling)return;pulling=true;armed=dy>=120;if(event.cancelable)event.preventDefault();show(armed?'松开刷新':'下拉刷新');indicator.style.transform=`translate(-50%,${Math.min(76,dy*.55)-76}px)`;icon.style.rotate=armed?'180deg':'0deg';},{passive:false});
 document.addEventListener('touchend',()=>{const shouldRefresh=pulling&&armed;start=null;pulling=false;armed=false;icon.style.rotate='';if(shouldRefresh)void refresh();else if(!busy)indicator.hidden=true;},{passive:true});
 document.addEventListener('touchcancel',()=>{icon.style.rotate='';reset();},{passive:true});
 window.polestarWebRefresh={refresh,get busy(){return busy;}};
 try{const saved=JSON.parse(sessionStorage.getItem(checkpointKey)||'null');if(saved){sessionStorage.removeItem(checkpointKey);if(allowedTabs.includes(saved.tab)&&Date.now()-saved.at<60000){const deadline=Date.now()+15000;const restore=()=>{if(saved.owner&&window.polestarCloud?.storageKey!==saved.owner){if(!window.polestarCloud?.active&&Date.now()<deadline){setTimeout(restore,200);return;}return;}if(typeof tab==='function')tab(saved.tab);};restore();}}}catch{}
})();
