export function planDownloads(store,queue,ids,{scope='unsaved'}={}){
 if(!['unsaved','missing'].includes(scope))throw Error('下载范围无效');
 const groups={unsaved:[],partial:[],complete:[],checking:[]},selected=[],root=store.root;
 for(const id of new Set(ids)){
  const w=store.lightViews.ready?store.lightViews.bases.get(id):store.work(id);if(!w)continue;selected.push(id);
  const d=store.lightViews.ready?store.lightViews.locals.get(id):store.download(id);
  const saved=d&&(d.hasMedia??d.assets?.some(a=>a.kind!=='metadata'));
  const files=store.fileStates.get(id),current=files?.root===root?files:null;
  const group=!saved?'unsaved':current?.status==='complete'?'complete':current?.status==='partial'?'partial':'checking';groups[group].push(id);
 }
 const eligible=scope==='unsaved'?groups.unsaved:[...groups.unsaved,...groups.partial],eligibleSet=new Set(eligible);
 const jobMap=queue.taskRows?.byId||new Map(queue.jobs.map(j=>[j.id,j]));
 const excludedTasks=selected.filter(id=>{const job=jobMap.get(id);return !eligibleSet.has(id)&&job&&job.state!=='complete'&&!job.coverOnly&&(job.source||'douyin')==='douyin';});
 const existing=eligible.filter(id=>['waiting','running'].includes(jobMap.get(id)?.state)).length;
 return {ids:eligible,excludedTasks,report:{selected:selected.length,unsaved:groups.unsaved.length,partial:groups.partial.length,complete:groups.complete.length,checking:groups.checking.length,existing,excludedTasks:excludedTasks.length}};
}
