export async function checkStorageSizeUI({notify,data,act,settle,aria,check}){
 const oldRefresh=window.cangxia.refreshStorageSize,oldCancel=window.cangxia.cancelStorageSize,root=data().root;let calls=0,finish,stops=0;
 const saved={root,bytes:1610612736,files:15,scannedAt:'2026-10-21T09:00:00Z'},done={root,running:false,phase:'done',result:saved,message:'目录大小已更新'},frame=scan=>({...data(),storage:{mode:'backup',writable:false,connected:false,directorySize:scan}});
 try{
  window.cangxia.refreshStorageSize=async()=>{calls++;return new Promise(resolve=>finish=resolve);};
  await act(async()=>{notify(frame({root,running:false,phase:'idle',result:null}));await settle();});
  check('storage card offers manual folder-size refresh without NAS write access or automatic scanning',!!document.querySelector('[aria-label="刷新本机目录大小"]')&&!document.querySelector('[aria-label="刷新本机目录大小"]').disabled&&calls===0);
  await aria('刷新本机目录大小');check('refresh starts only on demand and prevents duplicate refresh clicks',calls===1&&document.querySelector('[aria-label="刷新本机目录大小"]').disabled);
  await act(async()=>{notify(frame({root,running:true,phase:'running',files:11,result:null}));await settle();});
  window.cangxia.cancelStorageSize=async()=>{stops++;finish({root,running:false,phase:'cancelled',result:null,message:'大小统计已停止'});};
  await aria('停止目录大小统计');check('directory size refresh can stop while keeping the previous display',stops===1&&!document.querySelector('[aria-label="刷新本机目录大小"]').disabled);
  window.cangxia.refreshStorageSize=async()=>{calls++;return done;};await aria('刷新本机目录大小');
  check('successful folder measurement displays GB and its measurement time',document.querySelector('.storage-card strong').textContent.includes('1.50 GB')&&document.querySelector('.storage-size-time').textContent.includes('统计于'));
  window.cangxia.refreshStorageSize=async()=>({...done,phase:'partial',errors:1,message:'有 1 项无法读取，保留上次结果'});await aria('刷新本机目录大小');
  check('an incomplete directory scan reports the failure and retains the last complete GB value',document.querySelector('.storage-card strong').textContent.includes('1.50 GB')&&document.querySelector('.storage-size-message[role="alert"]').textContent.includes('无法读取'));
  window.cangxia.refreshStorageSize=async()=>new Promise(resolve=>finish=resolve);await aria('刷新本机目录大小');
  const other=root+'-other';await act(async()=>{notify({...frame(done),root:other});finish(done);await settle();});
  check('a late result from an old storage root cannot replace the new root size',!document.querySelector('.storage-card strong').textContent.includes('1.50 GB'));
 }finally{window.cangxia.refreshStorageSize=oldRefresh;window.cangxia.cancelStorageSize=oldCancel;await act(async()=>{notify(data());await settle();});}
}
