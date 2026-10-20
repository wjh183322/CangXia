import test from 'node:test';import assert from 'node:assert/strict';
import {DefectRepair} from '../electron/defect-repair.mjs';

function screenshotFixture({completed=true,kind='verify'}={}){
 const manager=Object.create(DefectRepair.prototype);
 manager.job={id:'fixture',kind,phase:'running',items:Array.from({length:988},(_,index)=>{
  const n=index+1,verified=completed&&(n<=31||(n>=206&&n<=208));
  return {id:String(n),issues:[],state:verified?'verified':'waiting',...(verified?{verification:{state:n<=31?'unavailable':'unknown'}}:{})};
 })};
 manager.store={work:id=>({remoteState:Number(id)<=205?'unavailable':'unknown'})};
 manager.queue={jobs:[]};manager.registry={revision:0};manager.running=true;manager.currentIndex=208;
 return manager;
}
test('34 checks among 988 show 31 unavailable and 3 unknown without counting 174 historical markers',()=>{
 const manager=screenshotFixture(),state=manager.state();
 assert.equal(state.total,988);assert.equal(state.verified,34);assert.equal(state.processed,34);
 assert.equal(state.sourceUnavailable,31);assert.equal(state.sourceUnknown,3);assert.equal(state.sourceAvailable,0);
 assert.equal(state.pendingVerification,954);
 const page=manager.page({view:'results',status:'pending'});assert.equal(page.total,954);
 assert.equal(manager.page({view:'results',status:'unavailable'}).total,31);
 assert.equal(manager.job.items.filter(i=>i.state==='waiting').length,954);
});
test('historical source states do not advance a newly created verification job',()=>{
 const manager=screenshotFixture({completed:false}),state=manager.state();
 assert.equal(state.verified,0);assert.equal(state.processed,0);assert.equal(state.sourceUnavailable,0);
 assert.equal(state.pendingVerification,988);assert.equal(manager.result(manager.job.items[0]).status,'pending');
 manager.job.items[0].state='running';assert.equal(manager.result(manager.job.items[0]).status,'processing');
 assert.equal(manager.state().processed,0);
});
test('a paused or resumed verification preserves its completed-only totals',()=>{
 const manager=screenshotFixture();manager.job.phase='paused';manager.running=false;
 const paused=manager.state();manager.job.phase='running';manager.running=true;
 const resumed=manager.state();
 for(const key of ['processed','verified','sourceUnavailable','sourceUnknown','pendingVerification'])assert.equal(resumed[key],paused[key]);
 assert.equal(resumed.processed,34);
});
test('normal repair summaries still recognize historical unavailable work as skipped',()=>{
 const manager=screenshotFixture({completed:false,kind:'repair'}),state=manager.state();
 assert.equal(state.sourceUnavailable,205);assert.equal(state.processed,205);
});
