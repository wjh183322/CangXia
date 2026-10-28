import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
export async function checkStorageSizeDesktop({win,call,check}){
 const before=await call('state'),root=path.resolve(before.root),base=path.dirname(process.env.CANGXIA_BACKUP_TEST_PROFILE),relative=path.relative(base,root),owned=path.join(root,'.owned-directory-size-fixture');
 assert.ok(path.basename(base).startsWith('cangxia-backup-desktop-'));assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));assert.equal(path.dirname(owned),root);fs.mkdirSync(root,{recursive:true});fs.mkdirSync(owned);let created=true;
 try{
  fs.mkdirSync(path.join(owned,'配乐'));for(const [name,bytes]of [['未登记.bin',11],['临时.part',7],['作品信息.json',2],['配乐/共享.m4a',3]])fs.writeFileSync(path.join(owned,name),Buffer.alloc(bytes));
  const measured=await call('refreshStorageSize');check('native storage-size refresh works without NAS write access and counts unregistered and partial files',!before.storage.writable&&measured.phase==='done'&&measured.result.bytes===23&&measured.result.files===4);
  const after=await call('state');check('directory measurement changes neither backup records, pending-sync state nor saved media',after.contentRevision===before.contentRevision&&after.storage.pending===before.storage.pending&&after.works.length===before.works.length&&fs.statSync(path.join(owned,'临时.part')).size===7);
  fs.appendFileSync(path.join(owned,'临时.part'),Buffer.from('x'));
  await win.webContents.executeJavaScript(`document.querySelector('[aria-label="刷新本机目录大小"]').click()`);
  let refreshed;for(let n=0;n<100;n++){refreshed=await call('state');if(refreshed.storage.directorySize?.result?.bytes===24&&!refreshed.storage.directorySize.running)break;await new Promise(resolve=>setTimeout(resolve,30));}
  check('native refresh button recomputes the current directory size and records its time',refreshed.storage.directorySize.result.bytes===24&&!!refreshed.storage.directorySize.result.scannedAt);await call('cancelStorageSize');
 }finally{if(created){assert.equal(path.dirname(path.resolve(owned)),root);assert.equal(path.basename(owned),'.owned-directory-size-fixture');fs.rmSync(owned,{recursive:true,force:true,maxRetries:5,retryDelay:100});}}
}

export async function checkLocalFilterLayout({win,check}){
 // Hidden test windows may not produce animation frames. Bound the wait, then still assert real geometry.
 const previous=win.getContentSize();try{win.setContentSize(1000,640);fs.writeFileSync('.test-output/local-filter-layout-visibility.json',JSON.stringify({visibility:await win.webContents.executeJavaScript('document.visibilityState'),visible:win.isVisible(),focused:win.isFocused(),minimized:win.isMinimized()}));await win.webContents.executeJavaScript('Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),new Promise(resolve=>setTimeout(resolve,300))])');
 const layout=await win.webContents.executeJavaScript(`(()=>{const sort=document.querySelector('[aria-label="本地媒体库排序"]'),filters=[...document.querySelectorAll('.source-filters .filter-tile>span')].map(e=>e.textContent),stop=document.querySelector('[aria-label="刷新本机目录大小"]').getBoundingClientRect(),log=document.querySelector('.read-log-nav').getBoundingClientRect();return {filters,sortOutside:!!sort.closest('.selection-toolbar')&&!sort.closest('.filter-panel'),width:document.documentElement.scrollWidth,viewport:innerWidth,storageBottom:stop.bottom,logBottom:log.bottom,height:innerHeight};})()`);
 check('native local filters match account filters and size ordering stays beside pagination at a small window',layout.filters.join(',')==='作者,下载状态,原作品,标签,我的标签'&&layout.sortOutside&&layout.width<=layout.viewport+1);
 try{fs.writeFileSync('.test-output/local-media-storage-small.png',(await win.webContents.capturePage()).toPNG());}catch{}
 assert.ok(layout.storageBottom<=layout.height&&layout.logBottom<=layout.height,JSON.stringify(layout));check('native storage refresh and reading logs remain visible at 1000x640',true);
 }finally{win.setContentSize(...previous);}
}
