export const membershipFields=['members','pendingMembers','localMembers','localPendingMembers'];
export function arrayPatch(before=[],after=[]){let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;if(start===before.length&&start===after.length)return null;let end=0;while(end<before.length-start&&end<after.length-start&&before[before.length-1-end]===after[after.length-1-end])end++;return {start,remove:before.length-start-end,insert:after.slice(start,after.length-end)};}
export function mergeState(before,update){
  if(!update?.delta)return update;
  if(update.baseRevision!==undefined&&before.libraryRevision!==update.baseRevision){
    const runtime={};for(const field of ['collector','queue','flatQueue','qr','syncProgress'])if(update[field]!==undefined)runtime[field]=update[field];
    return {...before,...runtime,...(before.libraryRevision>=update.libraryRevision?{}:{needsFullState:true})};
  }
  const {delta,baseRevision,changedWorks=[],removedWorks=[],membershipPatches={},...rest}=update;
  const next={...before,...rest};
  if(changedWorks.length||removedWorks.length){const map=new Map(before.works.map(w=>[w.id,w]));for(const id of removedWorks)map.delete(id);for(const w of changedWorks)map.set(w.id,w);next.works=[...map.values()];}
  for(const [field,scopes]of Object.entries(membershipPatches)){next[field]={...before[field]};for(const [scope,patch]of Object.entries(scopes)){if(patch===null){delete next[field][scope];continue;}const old=before[field]?.[scope]||[];next[field][scope]=[...old.slice(0,patch.start),...patch.insert,...old.slice(patch.start+patch.remove)];}}
  return next;
}
