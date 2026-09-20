import {arrayPatch,membershipFields} from './state-patch.mjs';
const compact=w=>({...w,thumbnail:undefined});
export class SnapshotFeed {
  constructor(store){this.store=store;this.previous=null;this.revision=-1;}
  frame(runtime,{full=false}={}){
    if(!full&&this.previous&&this.revision===this.store.revision)return {delta:true,...runtime};
    const state=this.store.snapshot({cache:true}),revision=this.store.revision;
    if(full||!this.previous){if(!this.previous){this.previous=state;this.revision=revision;}return {...state,works:state.works.map(compact),libraryRevision:revision,...runtime};}
    const baseRevision=this.revision;this.revision=revision;const prior=this.previous;this.previous=state;const oldWorks=new Map(prior.works.map(w=>[w.id,w])),changedWorks=[],removedWorks=[];
    for(const w of state.works){if(oldWorks.get(w.id)!==w)changedWorks.push(compact(w));oldWorks.delete(w.id);}for(const id of oldWorks.keys())removedWorks.push(id);
    const membershipPatches={};for(const field of membershipFields){const scopes={};for(const id of new Set([...Object.keys(prior[field]||{}),...Object.keys(state[field]||{})])){if(!(id in state[field]))scopes[id]=null;else{const patch=arrayPatch(prior[field]?.[id],state[field][id]);if(patch)scopes[id]=patch;}}if(Object.keys(scopes).length)membershipPatches[field]=scopes;}
    const changes={};for(const [key,value]of Object.entries(state)){if(key==='works'||membershipFields.includes(key))continue;if(JSON.stringify(value)!==JSON.stringify(prior[key]))changes[key]=value;}
    return {delta:true,baseRevision,libraryRevision:revision,changedWorks,removedWorks,membershipPatches,...changes,...runtime};
  }
}
