const maxExpanded=150*1024*1024;
const encoder=new TextEncoder();
function compact(text){return text.replace(/\s+/gu,' ').trim();}
function archive(bytes){
  const buffer=bytes.buffer,view=new DataView(buffer,bytes.byteOffset,bytes.byteLength);
  let end=bytes.length-22;
  while(end>=Math.max(0,bytes.length-65557) && view.getUint32(end,true)!==0x06054b50) end--;
  if(end<Math.max(0,bytes.length-65557)) throw Error('文件没有可读取的压缩目录。');
  let offset=view.getUint32(end+16,true),count=view.getUint16(end+10,true),expanded=0;
  if(count>10000) throw Error('电子书包含过多文件。');
  const files=new Map();
  for(let i=0;i<count;i++){
    if(offset+46>bytes.length || view.getUint32(offset,true)!==0x02014b50) throw Error('电子书压缩目录损坏。');
    const flags=view.getUint16(offset+8,true),method=view.getUint16(offset+10,true);
    const compressed=view.getUint32(offset+20,true),size=view.getUint32(offset+24,true);
    const nameSize=view.getUint16(offset+28,true),extra=view.getUint16(offset+30,true),comment=view.getUint16(offset+32,true);
    const local=view.getUint32(offset+42,true);
    const name=new TextDecoder().decode(bytes.subarray(offset+46,offset+46+nameSize));
    offset+=46+nameSize+extra+comment;
    expanded+=size;
    if(expanded>maxExpanded) throw Error('电子书解包后过大。');
    files.set(name,{flags,method,compressed,size,local});
  }
  return {names:[...files.keys()],async read(name){
    const item=files.get(name);
    if(!item) throw Error('缺少电子书所需文件。');
    const {flags,method,compressed,size,local}=item;
    if((flags&1) || local+30>bytes.length || view.getUint32(local,true)!==0x04034b50) throw Error('文件已加密或损坏。');
    const start=local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true);
    if(start+compressed>bytes.length) throw Error('压缩内容超出文件范围。');
    if(method===0) return bytes.slice(start,start+compressed);
    if(method!==8) throw Error('此压缩格式无法读取。');
    const stream=new Blob([bytes.subarray(start,start+compressed)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader=stream.getReader();
    const blocks=[];let written=0;
    try{
      for(;;){
        const {done,value}=await reader.read();
        if(done) break;
        written+=value.length;
        if(written>size) throw Error('文件的解包大小无效。');
        blocks.push(value);
      }
    } finally {await reader.cancel();}
    if(written!==size) throw Error('电子书正文损坏。');
    return new Uint8Array(await new Blob(blocks).arrayBuffer());
  }};
}
function decode(bytes){
  for(const encoding of bytes[0]===255&&bytes[1]===254?['utf-16le']:bytes[0]===254&&bytes[1]===255?['utf-16be']:['utf-8','gb18030','windows-1252']){
    try{return new TextDecoder(encoding,{fatal:true}).decode(bytes);}catch{}
  }
  throw Error('请将文本另存为 UTF-8。');
}
function parsedXML(bytes){
  const doc=new DOMParser().parseFromString(decode(bytes),'application/xml');
  if(doc.querySelector('parsererror')) throw Error('书的目录或正文格式无法读取。');
  return doc;
}
function tail(selector){return selector.split(' ').at(-1);}
function get(doc,name){return [...doc.getElementsByTagName('*')].find(el=>el.localName===tail(name));}
function byName(doc,name){return [...doc.getElementsByTagName('*')].filter(el=>el.localName===name);}
function textOf(node){return compact(node?.textContent || '');}
function inside(path,ref){return decodeURIComponent(new URL(ref,'https://ebook.invalid/'+path).pathname.slice(1));}
function readHTML(input){
  const template=document.createElement('template');
  template.innerHTML=input;
  template.content.querySelectorAll('script,style,head,template,svg,iframe,noscript,object,link,img,video,audio').forEach(el=>el.remove());
  const parts=[],blocks=new Set(['P','DIV','SECTION','ARTICLE','BLOCKQUOTE','LI','H1','H2','H3','H4','H5','H6','BR','HR','PRE','TD','TR']);
  let pending='',title='';
  const flush=()=>{const text=compact(pending); if(text) parts.push(text);pending='';};
  const visit=node=>{
    if(node.nodeType===Node.TEXT_NODE){pending+=node.textContent;return;}
    const block=blocks.has(node.tagName);
    if(block) flush();
    if(!title && /^H[123]$/.test(node.tagName)) title=textOf(node);
    node.childNodes.forEach(visit);
    if(block) flush();
  };
  template.content.childNodes.forEach(visit);flush();
  return {title,parts};
}
async function epub(zip){
  const container=parsedXML(await zip.read('META-INF/container.xml'));
  const path=get(container,'rootfile')?.getAttribute('full-path');
  if(!path) throw Error('EPUB 目录缺失。');
  if(zip.names.includes('META-INF/encryption.xml')){
    const encrypted=decode(await zip.read('META-INF/encryption.xml'));
    if(/URI="[^"]+\.(xhtml|html|htm|xml)"/i.test(encrypted)) throw Error('这本书的正文受 DRM 保护。');
  }
  const pack=parsedXML(await zip.read(path));
  const manifest=new Map(byName(pack,'item').map(item=>[item.getAttribute('id'),item]));
  const sections=[];
  for(const row of byName(pack,'itemref')){
    const item=manifest.get(row.getAttribute('idref'));
    if(!item || row.getAttribute('linear')==='no') continue;
    const href=item.getAttribute('href');
    if(!href || !/html/i.test(item.getAttribute('media-type')||'')) continue;
    const parsed=readHTML(decode(await zip.read(inside(path,href))));
    if(parsed.title===parsed.parts[0]) parsed.parts.shift();
    if(parsed.parts.length) sections.push([parsed.title || '第 '+(sections.length+1)+' 节',parsed.parts]);
  }
  return {title:textOf(get(pack,'title')),author:textOf(get(pack,'creator')),lang:textOf(get(pack,'language')),sections};
}
const heading=/^(?:#{1,3}\s+.+|(?:chapter|part|book)\s+(?:[\divxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b.{0,55}|prologue|epilogue|第.{1,12}[章节卷回].{0,55})$/i;
function sectionsFrom(paragraphs){
  const sections=[];
  let title='正文',parts=[];
  for(const p of paragraphs){
    if(!p) continue;
    if(heading.test(p)){
      if(parts.length) sections.push([title,parts]);
      title=p.replace(/^#+\s+/,'');parts=[];
    }else parts.push(p);
  }
  if(parts.length) sections.push([title,parts]);
  return sections;
}
function paginate(sections){
  return sections.map(([title,parts])=>{
    const pages=[];let page=[],words=0;
    for(let paragraph of parts){
      while(paragraph){
        const at=paragraph.length>2200?Math.max(paragraph.lastIndexOf(' ',2200),900):paragraph.length;
        const text=paragraph.slice(0,at);paragraph=paragraph.slice(at).trimStart();
        const size=Math.max((text.match(/\p{L}+(?:[’'-]\p{L}+)*/gu)||[]).length,Math.floor(text.length/11));
        if(page.length && (words+size>470 || page.length>=14)){pages.push(page);page=[];words=0;}
        page.push(['text',text]);words+=size;
      }
    }
    if(page.length) pages.push(page);
    return [title,'','',pages];
  }).filter(row=>row[3].length);
}
export async function extractBook(file,language){
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(bytes.length>45*1024*1024) throw Error('文件超过 45 MB。');
  let ext=file.name.split('.').at(-1).toLowerCase(),result={};
  if(ext==='ty'){
    const outer=archive(bytes);
    const inner=outer.names.find(name=>name.toLowerCase().endsWith('.epub'));
    if(!inner) throw Error('这个 TY 文件没有内嵌 EPUB。');
    result=await epub(archive(await outer.read(inner)));ext='epub';
  }else if(ext==='epub'){
    result=await epub(archive(bytes));
  }else if(ext==='html'||ext==='htm'){
    const {title,parts}=readHTML(decode(bytes));result={title,sections:sectionsFrom(parts)};
  }else if(ext==='docx'){
    const doc=parsedXML(await archive(bytes).read('word/document.xml'));
    result={sections:sectionsFrom(byName(doc,'p').map(p=>compact(byName(p,'t').map(t=>t.textContent).join(''))))};
  }else if(ext==='fb2'){
    const doc=parsedXML(bytes),body=get(doc,'body');
    result={title:textOf(get(doc,'book-title')),lang:textOf(get(doc,'lang')),sections:sectionsFrom(body?byName(body,'p').map(textOf):[])};
  }else if(ext==='pdf'){
    const pdfjs=await import('./pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc=new URL('./pdf.worker.mjs',import.meta.url).href;
    const pdf=await pdfjs.getDocument({data:bytes,disableFontFace:true,useSystemFonts:false,isEvalSupported:false}).promise;
    const sections=[];
    try{
      for(let i=1;i<=pdf.numPages;i++){
        const page=await pdf.getPage(i);
        const body=await page.getTextContent();
        const blocks=body.items.map(item=>item.str+(item.hasEOL?'\n':'')).join('');
        if(compact(blocks)) sections.push(['PDF 第 '+i+' 页',[compact(blocks)]]);
      }
    }finally{await pdf.destroy();}
    if(!sections.length) throw Error('扫描版 PDF 需要先做 OCR。');
    result={sections};
  }else if(ext==='txt'||ext==='md'){
    const text=decode(bytes).replace(/\r\n?/g,'\n');
    const parts=text.split(/\n\s*\n/u).flatMap(block=>{
      const rows=block.split('\n').map(compact).filter(Boolean);
      const result=[];let group=[];
      for(const row of rows){
        if(heading.test(row)){if(group.length) result.push(group.join(' '));result.push(row);group=[];}else group.push(row);
      }
      if(group.length) result.push(group.join(' '));
      return result;
    });
    result={sections:sectionsFrom(parts)};
  }else throw Error('请选择 EPUB、TY、TXT、Markdown、HTML、DOCX、FB2 或有文字层的 PDF。');
  const book=paginate(result.sections||[]);
  if(!book.length) throw Error('这本书没有可朗读的文字。');
  const sample=book.flatMap(c=>c[3].flat(1)).slice(0,8).map(([,text])=>text).join(' ').slice(0,2400);
  const lang=language==='auto'?(result.lang || ((sample.match(/[\u3400-\u9fff]/g)||[]).length>sample.length*.2?'zh':'en')):language;
  const normalizedLang=(/^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i.test(lang)?lang:'en').toLowerCase();
  const fileHash=new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()));
  const digest=await crypto.subtle.digest('SHA-256',encoder.encode(Array.from(fileHash).join(',')+':'+normalizedLang));
  const id=Array.from(new Uint8Array(digest)).slice(0,12).map(byte=>byte.toString(16).padStart(2,'0')).join('');
  return {id,title:result.title||file.name.replace(/\.[^.]+$/u,''),author:result.author||'',lang:normalizedLang,
    book,cover:'',format:ext.toUpperCase(),chapters:book.length,pages:book.reduce((sum,c)=>sum+c[3].length,0)};
}
