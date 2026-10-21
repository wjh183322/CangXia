import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
export async function checkCollectionBatchDesktop({win,http,call,check,gateForeground}){
 const original=http.fetch,calls=[];let held=false,linked=false,requestEntered,releaseRequest;
 const response=id=>Response.json({status_code:0,aweme_list:[{aweme_id:id==='810'?'910810':'910820',desc:'批量读取原生合成作品',author:{uid:'7',nickname:'合成作者'},video:{play_addr:{url_list:[]}}}],has_more:0,cursor:'0'});
 http.fetch=async(url,options)=>{const u=new URL(url);if(linked&&u.pathname==='/aweme/v1/web/aweme/listcollection/'){calls.push('__all__');return response('810');}if(u.pathname==='/aweme/v1/web/collects/list/')return Response.json({status_code:0,collects_list:[{collects_id_str:'810',collects_name:'批量同名夹'},{collects_id_str:'820',collects_name:'批量同名夹'}],has_more:0});if(u.pathname==='/aweme/v1/web/collects/video/list/'){const id=u.searchParams.get('collects_id');calls.push(id);if(held)return new Promise(resolve=>{releaseRequest=()=>resolve(response(id));requestEntered?.();});return response(id);}return original.call(http,url,options);};
 const js=source=>win.webContents.executeJavaScript(source,true),wait=async condition=>{for(let i=0;i<150;i++){if(await js(condition))return;await new Promise(r=>setTimeout(r,40));}throw Error('Batch UI did not settle: '+condition);};
 try{
  await call('sync',{discoverOnly:true});await call('addCollections',['810','820']);
  const preparation=gateForeground(),stopped=call('sync',{allAdded:true,mode:'full'});stopped.catch(()=>{});await preparation.entered;await call('stopSync');preparation.release();
  await assert.rejects(stopped,/已停止/);check('native stop during foreground preparation prevents the batch from starting any request',calls.length===0);
  await assert.rejects(call('sync',{allAdded:true,mode:'quick'}),/历史对照/);check('native batch requires one baseline acknowledgement before touching either folder',calls.length===0);
  const before=await call('workDetail','123'),saved=path.join(before.localRecord.path,before.localRecord.assets.find(a=>a.key==='video').file),stamp=fs.statSync(saved).mtimeMs;
  const result=await call('sync',{allAdded:true,mode:'full'}),batch=result.collector.collectionBatch;
  check('native batch reads both added same-name folders by ID and reports individual success',calls.join(',')==='810,820'&&batch.succeeded===2&&!batch.running&&batch.items.filter(i=>i.state==='complete').map(i=>i.id).join(',')==='810,820');
  const logs=await call('readHistoryRuns',{page:1}),children=await call('readHistoryRuns',{batch:batch.historyToken}),after=await call('workDetail','123'),savedAfter=path.join(after.localRecord.path,after.localRecord.assets.find(a=>a.key==='video').file);check('native batch groups independent logs and leaves existing video bytes unchanged',logs.items.some(item=>item.token===batch.historyToken&&item.source==='batch')&&children.items.some(item=>item.scope==='810')&&children.items.some(item=>item.scope==='820')&&fs.statSync(savedAfter).mtimeMs===stamp);
  await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='读取日志').click()`);await wait(`!!document.querySelector('.read-log-runs')`);
  await js(`[...document.querySelectorAll('.read-log-runs>button')].find(b=>b.textContent.includes('批量读取自建收藏夹')).click()`);await wait(`!!document.querySelector('.read-log-group .read-log-runs')`);
  check('native history expands one batch into independently identified same-name folders',await js(`document.querySelector('.read-log-group').textContent.includes('810')&&document.querySelector('.read-log-group').textContent.includes('820')`));
  await js(`[...document.querySelectorAll('.read-log-group .read-log-runs>button')].find(b=>b.textContent.includes('810')).click()`);await wait(`!!document.querySelector('.read-log-counts')`);
  check('native child history displays its own unchanged counts and supports return to its batch',await js(`document.querySelector('.read-log-counts').textContent.includes('本轮读取 1')&&[...document.querySelectorAll('button')].some(b=>b.textContent.includes('返回本批次'))`));
  await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('返回本批次')).click()`);await wait(`!!document.querySelector('.read-log-group')`);await js(`document.querySelector('[aria-label="关闭弹窗"]').click()`);
  await wait(`!!document.querySelector('[aria-label="同步全部自建收藏夹"]')&&!document.querySelector('[aria-label="同步全部自建收藏夹"]').disabled`);await js(`document.querySelector('[aria-label="同步全部自建收藏夹"]').click()`);await wait(`!!document.querySelector('.collection-batch-setup')`);
  check('native batch setup defaults to quick and recognizes both newly established baselines',await js(`document.querySelector('[aria-label="批量检查新增"]').checked&&!document.querySelector('[aria-label="确认可能读到列表末尾"]')`));
  held=true;const entered=new Promise(resolve=>requestEntered=resolve);await js(`document.querySelector('[aria-label="开始批量同步"]').click()`);await entered;
  const active=await call('state');check('native batch progress owns the foreground read and exposes the current folder',active.collector.busy&&active.collector.collectionBatch.running&&active.collector.collectionBatch.currentId==='810');
  const originalSize=win.getContentSize();win.setContentSize(1100,640);await wait(`!!document.querySelector('.collection-batch-progress')`);const bounds=await js(`(()=>{const stop=document.querySelector('.read-stop').getBoundingClientRect(),modal=document.querySelector('.modal').getBoundingClientRect();return {stop:stop.bottom,modal:modal.bottom,height:innerHeight};})()`);check('native batch progress keeps its stop button visible at 1100x640',bounds.stop<=bounds.height&&bounds.modal<=bounds.height);try{fs.writeFileSync('.test-output/collection-batch-progress-small.png',(await win.webContents.capturePage()).toPNG());}catch{}win.setContentSize(...originalSize);
  await assert.rejects(call('download',['123']),/读取|任务/);
  await call('stopSync');releaseRequest();await wait(`!!document.querySelector('.collection-batch-results')`);const final=await call('state');
  check('native late response after stop does not launch the remaining folder or lose saved work',calls.join(',')==='810,820,810'&&final.collector.collectionBatch.phase==='stopped'&&final.collector.collectionBatch.items.find(item=>item.id==='820').state==='waiting'&&final.works.find(w=>w.id==='123').downloaded);
  await js(`[...document.querySelectorAll('.modal-footer button')].find(b=>b.textContent==='关闭').click()`);
  held=false;linked=true;const offset=calls.length;
  await js(`[...document.querySelectorAll('.collection-nav')].find(b=>b.querySelector('span')?.textContent==='收藏').click()`);
  await wait(`!![...document.querySelectorAll('.heading-actions button')].find(b=>b.textContent.trim()==='同步收藏'&&!b.disabled)`);
  await js(`[...document.querySelectorAll('.heading-actions button')].find(b=>b.textContent.trim()==='同步收藏').click()`);
  await wait(`!!document.querySelector('[aria-label="同步自建收藏夹"]')`);
  check('native total-sync dialog defaults to an unchecked custom-folder follow-up',await js(`!document.querySelector('[aria-label="同步自建收藏夹"]').checked`));
  win.setContentSize(1100,640);await js(`document.querySelector('[aria-label="同步自建收藏夹"]').click();document.querySelector('.collection-read-full').open=true`);
  const followupBounds=await js(`(()=>{const box=document.querySelector('.modal').getBoundingClientRect(),footer=document.querySelector('.modal-footer').getBoundingClientRect();return {bottom:box.bottom,footer:footer.bottom,height:innerHeight};})()`);
  check('native linked-sync setup remains scrollable with visible footer at 1100x640',followupBounds.bottom<=followupBounds.height&&followupBounds.footer<=followupBounds.height);
  fs.writeFileSync('.test-output/collection-followup-setup.png',(await win.webContents.capturePage()).toPNG());win.setContentSize(...originalSize);
  await js(`[...document.querySelectorAll('.collection-read-full button')].find(b=>b.textContent.trim()==='从头完整核对').click()`);
  await wait(`!!document.querySelector('.collection-batch-results')`);
  const linkedResult=await call('state');
  check('native checkbox performs total first and then both custom folders through one sync request',calls.slice(offset).join(',')==='__all__,810,820'&&linkedResult.collector.collectionBatch.includeTotal&&linkedResult.collector.collectionBatch.succeeded===3);
  check('native linked result retains total and custom-folder summaries separately',linkedResult.collector.collectionBatch.items.filter(i=>i.state==='complete').map(i=>i.summary.scope).join(',')==='__all__,810,820');
  await js(`[...document.querySelectorAll('.modal-footer button')].find(b=>b.textContent==='关闭').click()`);
 }finally{releaseRequest?.();http.fetch=original;}
}
