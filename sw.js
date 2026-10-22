const SHELL='polestar-web-shell-ae09e9aaebf1',MEDIA='polestar-public-media-v1';
const shellFiles=['./','./index.html','./web-app.js','./manifest.webmanifest','./offline-assets.json','./icon-180.png','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>event.waitUntil((async()=>{await (await caches.open(SHELL)).addAll(shellFiles);await self.skipWaiting();})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('polestar-web-shell-')&&name!==SHELL)await caches.delete(name);await self.clients.claim();})()));
async function partial(response,range){
 const bytes=await response.arrayBuffer(),match=/^bytes=(\d*)-(\d*)$/.exec(range);
 if(!match)return response;
 let start=match[1]?Number(match[1]):Math.max(0,bytes.byteLength-Number(match[2]));
 let end=match[1]&&match[2]?Math.min(Number(match[2]),bytes.byteLength-1):bytes.byteLength-1;
 if(start>end||start>=bytes.byteLength)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${bytes.byteLength}`}});
 const headers=new Headers(response.headers);headers.set('Content-Range',`bytes ${start}-${end}/${bytes.byteLength}`);headers.set('Content-Length',String(end-start+1));headers.set('Accept-Ranges','bytes');
 return new Response(bytes.slice(start,end+1),{status:206,headers});
}
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url),base=new URL('./',self.location.href);
 if(request.method!=='GET'||url.origin!==base.origin||!url.pathname.startsWith(base.pathname)||url.pathname.includes('/api/'))return;
 if(request.mode==='navigate'){
  event.respondWith((async()=>{try{const response=await fetch(request);if(response.ok){const cache=await caches.open(SHELL);await cache.put(new URL('./',base),response.clone());}return response;}catch{const response=await caches.match(new URL('./',base));return response||new Response('请先联网打开一次动作库。',{status:503});}})());return;
 }
 const isMedia=url.pathname.startsWith(base.pathname+'assets/');
 event.respondWith((async()=>{
  const cache=await caches.open(isMedia?MEDIA:SHELL),cached=await cache.match(url.href);
  if(cached)return request.headers.has('Range')?partial(cached,request.headers.get('Range')):cached;
  const response=await fetch(request);
  if(response.ok&&response.status===200)await cache.put(url.href,response.clone());return response;
 })());
});
