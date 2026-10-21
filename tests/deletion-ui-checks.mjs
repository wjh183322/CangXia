import assert from 'node:assert/strict';
export async function checkDeletionUI({store,notify,data,act,settle,click,aria,check}){
 const api=window.cangxia,old={...api},calls=[];let prepared;
 const items=Array.from({length:45},(_,i)=>({id:String(880000+i),name:'跨电脑作品 '+i,scopeCount:1,scopes:[{scope:{workId:String(880000+i),kind:'files',sourceId:''},deviceName:'重庆电脑',at:'2026-10-21T10:00:00Z',sourceName:'正式作品文件'}]}));
 const state=(writable=true,count=0)=>({...data(),scopedDeletion:null,deletionResolution:{running:false},storage:{...data().storage,writable,connected:writable,scopedDeletion:writable,deletionPending:count}});
 api.prepareScopedDeletion=async input=>{prepared=input;return {token:'delete-1',summary:{...input,total:input.ids.length,source:'账号收藏（含该作品全部自建收藏夹关联）',otherSourcesPreserved:true}};};
 api.cancelPreparedDeletion=async()=>true;api.confirmScopedDeletion=async token=>{calls.push({token});return {phase:'done'};};api.state=async()=>state();
 api.deletionPendingPage=async({page=1}={})=>({token:'pending-1',revision:1,page,pages:3,total:45,scopeTotal:45,items:items.slice((page-1)*20,page*20)});
 api.resolveDeletionPending=async input=>{calls.push(input);return {running:true};};api.validateDeletionSelection=async input=>({ids:input.ids,token:'pending-1',invalid:0});
 try{
  await act(async()=>{notify(state(false));[...document.querySelectorAll('.main-nav button')].find(b=>b.textContent.includes('账号收藏')).click();await settle();});
  await aria('本页全选');
  check('offline local record removal is enabled',![...document.querySelectorAll('.selection-dock button')].find(b=>b.textContent.includes('删除读取记录')).disabled);
  await click('删除读取记录');
  check('record deletion defaults to current source and local target',prepared.records&&!prepared.files&&prepared.target==='local'&&prepared.source==='__all__');
  check('dialog explains other sources and NAS remain preserved',document.querySelector('.scoped-delete-dialog').textContent.includes('其他来源')&&document.querySelector('.scoped-delete-dialog').textContent.includes('NAS 保留'));
  check('record-only deletion does not warn that media files will be lost',!document.querySelector('.scoped-delete-dialog .invalid-note'));
  await click('取消');check('cancel never executes deletion',calls.length===0);
  await act(async()=>{[...document.querySelectorAll('.main-nav button')].find(b=>b.textContent.includes('本地媒体库')).click();await settle();});await aria('本页全选');await click('删除本地文件');check('file entry defaults to files without removing records',prepared.files&&!prepared.records&&prepared.target==='local');check('offline NAS range is disabled while local confirmation remains available',document.querySelector('input[name="delete-target"]:checked')?.nextSibling?.textContent.includes('仅本机')&&[...document.querySelectorAll('input[name="delete-target"]')].at(1).disabled);check('local file deletion distinguishes source unavailability from recoverable NAS backups',document.querySelector('.scoped-delete-dialog .invalid-note')?.textContent.includes('不能从抖音重新下载')&&document.querySelector('.scoped-delete-dialog .invalid-note')?.textContent.includes('可以从备份恢复'));await click('取消');
  await act(async()=>{notify(state(true,45));await settle();});await click('删除本地文件');await act(async()=>{document.querySelectorAll('input[name="delete-target"]')[1].click();await settle();});check('deleting both copies warns about losing the last usable copy',prepared.target==='local-nas'&&document.querySelector('.scoped-delete-dialog .invalid-note')?.textContent.includes('没有其他可用副本'));await click('取消');check('startup deletion notice groups pending works once',document.querySelector('.deletion-notice')?.textContent.includes('45'));
  await click('稍后');check('dismissing notice does not resolve or delete',calls.length===0&&!document.querySelector('.deletion-notice'));
  await aria('查看 NAS 删除待处理');
  check('pending page limits renderer to twenty works with actor and scope',document.querySelectorAll('.deletion-list article').length===20&&document.querySelector('.deletion-list').textContent.includes('重庆电脑')&&document.querySelector('.deletion-list').textContent.includes('正式作品文件'));
  await click('全选当前筛选结果（45）');await aria('删除待处理列表下一页');await aria('选择删除待处理作品 880020');
  await click('保留并上传 NAS');check('cross-page action confirms forty-four without execution',calls.length===0&&document.querySelector('.deletion-action-confirm').textContent.includes('44'));
  await click('确认保留并上传');assert.deepEqual(calls[0],{action:'restore',selection:{token:'pending-1',all:true,ids:[],exclude:['880020']}});check('all-results selection uses snapshot and exclusions without expanding ids',true);
  await aria('关闭弹窗');await act(async()=>{notify(state(true,45));await settle();});check('runtime updates do not repeat dismissed startup notice',!document.querySelector('.deletion-notice'));
  await act(async()=>{notify({...state(),scopedDeletion:{operationId:'00000000-0000-4000-8000-000000000001',confirmed:true,phase:'partial',running:false,total:1,processed:0,nasSucceeded:1,localFailed:1,failed:1,message:'部分步骤未完成',lastError:'作品 880000 · 本机步骤失败：EPERM · 文件被占用'}});await settle();});await click('删除处理记录');check('a partial deletion shows its real local error and preserves the NAS receipt',document.querySelector('.deletion-progress [role="alert"]')?.textContent.includes('EPERM')&&document.querySelector('.deletion-progress').textContent.includes('不会重复删除 NAS'));await click('关闭');
 }finally{for(const key of Object.keys(api))if(!(key in old))delete api[key];Object.assign(api,old);}
}
