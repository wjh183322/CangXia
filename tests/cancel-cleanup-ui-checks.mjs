import assert from 'node:assert/strict';

// Catches reporting successful cancellation when file cleanup failed and its retry row remains.
export async function checkCancelCleanupUI({notify,data,act,settle,click,aria,check}){
 const api=window.cangxia,old={...api},base=data(),calls=[];
 const job={id:'889906',title:'取消清理测试任务',state:'waiting',message:'等待下载'};
 let snapshot={...base,scopedDeletion:null,deletionResolution:{running:false},nasRemoval:null,localRemoval:null,collector:{busy:false},queue:{jobs:[job],paused:true}};
 api.state=async()=>snapshot;
 api.cancelDownloads=async(ids,options)=>{
  calls.push({ids,options});
  if(calls.length===1){snapshot={...snapshot,queue:{...snapshot.queue,jobs:[{...job,state:'failed',phase:'cleanupFailed',message:'取消清理失败：EPERM fixture'}]}};return {cancelled:0,cleanupFailed:1,failures:[{id:'889906',message:'EPERM fixture'}]};}
  snapshot={...snapshot,queue:{...snapshot.queue,jobs:[]}};return {cancelled:1,cleanupFailed:0,failures:[]};
 };
 try{
  await act(async()=>{notify(snapshot);document.querySelector('.downloads-nav').click();await settle();});await click('普通下载');
  await aria('取消下载 '+job.title);
  check('cleanup failure is visible with its real reason and retry guidance',document.querySelector('.toast')?.textContent.includes('清理未完成')&&document.querySelector('.toast').textContent.includes('EPERM fixture')&&document.querySelector('.toast').textContent.includes('再次取消重试清理'));
  await click('下载失败 · 1');check('failed cleanup keeps its retryable task visible',document.querySelector('.job strong')?.textContent===job.title&&document.querySelector('.job').textContent.includes('取消清理失败'));
  await aria('选择下载任务 '+job.title);await click('取消所选任务（1）');
  assert.deepEqual(calls[1],{ids:['889906'],options:{state:'failed'}});
  check('successful failed-list cancellation clears failure wording and confirms its count',document.querySelector('.toast')?.textContent.includes('已取消 1 个下载任务')&&!document.querySelector('.toast').textContent.includes('清理未完成')&&!document.querySelector('.job'));
  await aria('关闭弹窗');
 }finally{for(const key of Object.keys(api))if(!(key in old))delete api[key];Object.assign(api,old);await act(async()=>{notify(data());await settle();});}
}
