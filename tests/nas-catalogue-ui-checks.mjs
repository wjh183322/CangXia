import assert from 'node:assert/strict';
export async function checkNasCatalogueUI({store,notify,data,act,settle,click,aria,check}){
 const api=window.cangxia,old={...api},options=[],prepared=[],confirmed=[];
 const overview={revision:10,counts:{all:45,collection:45,author:0},bytes:0},works=Array.from({length:45},(_,i)=>({id:String(770000+i),name:'NAS 仅记录 '+i,type:'video',author:{nickname:'NAS 作者'},hasRecords:true,hasFiles:false,incomplete:false,sourceCount:1,sources:[{kind:'collection',id:'__all__',name:'收藏',record:true}],preview:null}));
 const state=()=>({...data(),storage:{...data().storage,connected:true,writable:true,scopedDeletion:true},nasCatalogue:{running:false,phase:'ready',revision:10},nasCatalogueOverview:overview});
 api.state=async()=>state();api.refreshNASCatalogue=async()=>({revision:10});api.nasCataloguePage=async input=>{options.push(input);return {token:'catalogue-ui-10',revision:10,total:45,page:input.page,pages:3,overview,items:works.slice((input.page-1)*20,input.page*20)};};api.nasCatalogueGroups=async()=>({total:1,page:1,pages:1,items:[{id:'__all__',name:'收藏',count:45}]});
 api.nasCatalogueWork=async id=>({...works.find(w=>w.id===id),images:[],tags:[],duration:0,local:false,backedUp:false,localRecord:null,backupRecord:null,nasCatalogue:true});
 api.prepareNASRestore=async input=>{prepared.push(input);return {token:'restore-ui-10',summary:{total:input.selection?.all?44:1,restorable:44,records:input.records?44:0,files:0}};};api.confirmNASRestore=async token=>{confirmed.push(token);return {restoredRecords:44,queuedFiles:0};};api.download=async()=>{throw Error('record recovery must not enqueue ordinary downloads');};
 try{
  await act(async()=>{notify(state());[...document.querySelectorAll('.main-nav button')].find(b=>b.textContent.includes('NAS 备份')).click();await settle();});
  check('independent NAS catalogue renders twenty records absent from the local gallery',document.querySelectorAll('.nas-catalogue-panel .work-card').length===20&&!store.work('770000')&&document.querySelector('.nas-catalogue-panel').textContent.includes('仅记录'));
  await aria('NAS 作品详情 770000');check('NAS records-only detail opens by its exact remote identity',document.querySelector('.detail-info h2')?.textContent==='NAS 仅记录 0');await aria('关闭弹窗');
  await act(async()=>{const select=document.querySelector('[aria-label="NAS 本机情况"]');select.value='removed';select.dispatchEvent(new Event('change',{bubbles:true}));await settle();});check('local removal filter is passed to indexed backend before pagination',options.at(-1).local==='removed'&&options.at(-1).limit===20);
  await click('全选 NAS 筛选结果（45）');await aria('NAS 目录下一页');await aria('选择 NAS 作品 770020');await click('恢复所选');
  check('NAS recovery defaults to records with files independently disabled',prepared.at(-1).records===true&&prepared.at(-1).files===false&&document.querySelector('.nas-restore-dialog').textContent.includes('仅恢复文件不会取消其他来源'));
  assert.deepEqual(prepared.at(-1).selection,{token:'catalogue-ui-10',all:true,ids:[],exclude:['770020']});check('NAS all-pages recovery keeps its snapshot and exclusions without expanding IDs',true);check('preparing NAS recovery performs no action',confirmed.length===0);
  await click('确认恢复到本机');check('record recovery confirms its prepared token and reports no file downloads',confirmed.join(',')==='restore-ui-10'&&!document.querySelector('.nas-restore-dialog'));
  api.refreshNASCatalogue=async()=>{throw Error('NAS fixture temporarily offline');};await click('更新 NAS 目录');check('failed catalogue refresh preserves the previous complete page',document.querySelectorAll('.nas-catalogue-panel .work-card').length===20&&document.querySelector('.nas-catalogue-panel').textContent.includes('temporarily offline'));
 }finally{for(const key of Object.keys(api))if(!(key in old))delete api[key];Object.assign(api,old);await act(async()=>{notify(data());await settle();});}
}
