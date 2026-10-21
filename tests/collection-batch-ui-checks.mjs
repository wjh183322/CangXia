export async function checkCollectionBatchUI({notify,data,act,settle,click,aria,check}){
 const folders=[{id:'__all__',name:'收藏',added:true},{id:'700001',name:'同名收藏夹',added:true,count:3},{id:'700002',name:'同名收藏夹',added:true,count:4},{id:'700003',name:'未添加',added:false}],info={'700001':{baselineKnown:true},'700002':{baselineKnown:false}};
 const frame=overrides=>({...data(),collections:folders,collectionReadInfo:info,collector:{connected:true,phase:'idle',busy:false},...overrides});
 const oldSync=window.cangxia.sync,oldStop=window.cangxia.stopSync;let input,finish,stops=0;
 try{
  await act(async()=>{notify(frame());[...document.querySelectorAll('.main-nav button')].find(b=>b.textContent.includes('账号收藏')).click();await settle();});
  check('account custom-folder heading exposes sync-all without altering single-folder sync',!!document.querySelector('[aria-label="同步全部自建收藏夹"]')&&[...document.querySelectorAll('.heading-actions button')].some(b=>b.textContent.trim()==='同步收藏'));
  await act(async()=>{[...document.querySelectorAll('.collection-nav')].find(b=>b.querySelector('span')?.textContent==='收藏').click();await settle();});
  await click('同步收藏');
  check('total read offers an unchecked follow-up option',document.querySelector('[aria-label="同步自建收藏夹"]')?.checked===false);
  await aria('同步自建收藏夹');await click('检查新增');
  check('linked quick preflight names every unanchored scope before starting',document.querySelector('.collection-read-confirm')?.textContent.includes('同名收藏夹')&&document.querySelector('.collection-read-confirm').textContent.includes('收藏'));
  window.cangxia.sync=async options=>{input=options;return {collector:{connected:true,busy:false,collectionBatch:{includeTotal:true,running:false,total:3,succeeded:3,items:[]}},readSummary:null};};
  await click('继续检查');
  check('linked quick request carries checkbox and acknowledgement to the backend',input?.collectionId==='__all__'&&input.syncCollections===true&&input.mode==='quick'&&input.allowFullScan===true);
  check('linked completion presents combined results',document.querySelector('.collection-batch-results')?.textContent.includes('总收藏'));
  await click('关闭');await click('同步收藏');await aria('同步自建收藏夹');
  await click('从头完整核对');
  check('full reconciliation also passes the follow-up checkbox',input.syncCollections===true&&input.mode==='full'&&!input.resume);await click('关闭');
  await act(async()=>{notify(frame({collectionReadInfo:{...info,__all__:{baselineKnown:true,full:{canResume:true,checked:4}}}}));await settle();});
  await click('同步收藏');await aria('同步自建收藏夹');await click('继续完整核对');
  check('continue reconciliation preserves resume for the linked operation',input.syncCollections===true&&input.mode==='full'&&input.resume===true);await click('关闭');
  await act(async()=>{[...document.querySelectorAll('.collection-nav')].find(b=>b.querySelector('span')?.textContent==='同名收藏夹').click();await settle();});await click('同步收藏');
  check('individual custom folder never offers total follow-up',!document.querySelector('[aria-label="同步自建收藏夹"]'));await aria('关闭弹窗');
  await act(async()=>{notify(frame());await settle();});
  await aria('同步全部自建收藏夹');
  check('batch setup defaults to quick, counts added folders and names missing baselines',document.querySelector('.collection-batch-setup')?.textContent.includes('2 个自建收藏夹')&&document.querySelector('[aria-label="批量检查新增"]').checked&&document.querySelector('[aria-label="确认可能读到列表末尾"]'));
  check('batch cannot silently turn an unanchored quick read into a full scan',document.querySelector('[aria-label="开始批量同步"]').disabled);
  await aria('确认可能读到列表末尾');
  window.cangxia.sync=async options=>{input=options;return new Promise(resolve=>finish=resolve);};
  await aria('开始批量同步');
  check('one batch request carries all-added quick mode and the explicit full-scan acknowledgement',input?.allAdded===true&&input.mode==='quick'&&input.allowFullScan===true&&input.collectionId===undefined);
  const running={running:true,phase:'running',total:2,processed:1,succeeded:1,failed:0,skipped:0,pending:0,paused:0,currentName:'同名收藏夹',items:[]};
  await act(async()=>{notify(frame({collector:{connected:true,busy:true,collectionBatch:running,readProgress:{name:'同名收藏夹',mode:'quick',stage:'reading',checked:31,added:2,startedAt:Date.now()}}}));await settle();});
  check('batch progress exposes the current folder and finished-folder count',document.querySelector('.collection-batch-progress')?.textContent.includes('同名收藏夹')&&document.querySelector('.collection-batch-progress').textContent.includes('1 / 2'));
  const ended={...running,running:false,phase:'stopped',pending:1,message:'批量同步已停止',items:[{id:'700001',name:'同名收藏夹',state:'complete',message:'已完成',summary:{checked:31,added:2}},{id:'700002',name:'同名收藏夹',state:'waiting',message:''}]};
  window.cangxia.stopSync=async()=>{stops++;finish({collector:{connected:true,busy:false,collectionBatch:ended},collectionReadInfo:info,readSummary:null});};
  await click('停止读取');
  check('stop opens a batch result with both same-name folder identities and unfinished work',stops===1&&document.querySelector('.collection-batch-results')?.textContent.includes('未完成 1')&&document.querySelectorAll('.collection-batch-results article').length===2&&document.querySelector('.collection-batch-results').textContent.includes('700001')&&document.querySelector('.collection-batch-results').textContent.includes('700002'));
  await click('关闭');await aria('同步全部自建收藏夹');await aria('批量完整核对');
  check('full reconciliation is an explicit alternative and needs no quick-baseline acknowledgement',document.querySelector('[aria-label="批量完整核对"]').checked&&!document.querySelector('[aria-label="开始批量同步"]').disabled);
  window.cangxia.sync=async options=>{input=options;return {collector:{connected:true,busy:false,collectionBatch:{...ended,phase:'done',pending:0,items:[]}},readSummary:null};};
  await aria('开始批量同步');check('full batch request never uses the current selected collection scope',input.allAdded===true&&input.mode==='full'&&input.collectionId===undefined);await click('关闭');
  await act(async()=>{notify(frame({storage:{mode:'backup',writable:false}}));await settle();});check('batch sync obeys the existing NAS write guard',document.querySelector('[aria-label="同步全部自建收藏夹"]').disabled);
  await act(async()=>{notify(frame());[...document.querySelectorAll('.main-nav button')].find(b=>b.textContent.includes('本地媒体库')).click();await settle();});check('local media and NAS pages do not offer account batch synchronization',!document.querySelector('[aria-label="同步全部自建收藏夹"]'));
 }finally{window.cangxia.sync=oldSync;window.cangxia.stopSync=oldStop;await act(async()=>{notify(data());await settle();});}
}
