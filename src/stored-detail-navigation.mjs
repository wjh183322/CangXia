const ids=value=>[...new Set(Array.isArray(value)?value:[])].filter(id=>typeof id==='string'&&/^\d{1,32}$/.test(id)).slice(0,100000);
const offset=value=>Number.isFinite(value)?Math.max(0,Math.min(value,10000000)):0;
export function capturePanelReturn({panel,tab,page,filters={},selection={},scrollTop=0,modalScrollTop=0}){
 if(!['downloads','defects'].includes(panel))throw Error('未知返回列表');
 return {panel,tab:typeof tab==='string'?tab:panel==='downloads'?'active':'problems',page:Number.isSafeInteger(page)&&page>0?page:1,filters:{status:filters.status||'all',sourceFilter:filters.sourceFilter||'all',kind:filters.kind||'all',jobId:filters.jobId},selection:{ids:ids(selection.ids),repairIds:ids(selection.repairIds),all:!!selection.all,exclude:ids(selection.exclude),repairExclude:ids(selection.repairExclude),token:typeof selection.token==='string'?selection.token:null},scrollTop:offset(scrollTop),modalScrollTop:offset(modalScrollTop)};
}
export function restorePanelScroll(node,state){if(!node?.isConnected||!state)return;node.scrollTop=offset(state.scrollTop);const modal=node.closest('.modal');if(modal)modal.scrollTop=offset(state.modalScrollTop);}
