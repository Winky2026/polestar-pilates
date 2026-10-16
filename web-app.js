(async()=>{
 const button=document.createElement('button');button.id='offlineDownload';button.className='mobile-secondary';button.textContent='下载离线资源';button.disabled=true;document.getElementById('helpOpen').before(button);
 if(!('serviceWorker' in navigator)||!('caches' in window)){button.disabled=true;button.textContent='当前浏览器不支持离线资源';return;}
 let manifest,cache;
 try{
  await navigator.serviceWorker.register('./sw.js');await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('离线服务准备超时')),15000))]);
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
