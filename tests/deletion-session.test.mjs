import test from 'node:test';import assert from 'node:assert/strict';
test('file deletion waits for selected writers only and releases playback for selected copies',async()=>{
 const {quiesceSelectedDeletion}=await import('../electron/deletion-session.mjs');let stopped=0,cancelled,flatPaused=0,released=0;const active=new Map([['1',new AbortController()]]),selected=active.get('1');
 selected.signal.addEventListener('abort',()=>setTimeout(()=>active.delete('1'),20));
 const queue={cancel:async ids=>{cancelled=ids;}},audio={active,cancel:async ids=>{for(const id of ids)active.get(id)?.abort();},playRequests:new Map([['1:req',new AbortController()],['2:req',new AbortController()]]),sessions:new Map([['first',{id:'1',release:()=>released++}],['second',{id:'2',release:()=>released++}]])},flatQueue={batches:[{id:'f',jobs:[{id:'1'}]},{id:'other',jobs:[{id:'2'}]}],pause:id=>{assert.equal(id,'f');flatPaused++;},waitForBatch:async()=>{}},reconcile={stop:()=>stopped++};
 await quiesceSelectedDeletion({ids:['1'],files:true},{queue,audio,flatQueue,reconcile});assert.deepEqual(cancelled,['1']);assert.equal(active.size,0);assert.equal(flatPaused,1);assert.equal(released,1);assert.equal(audio.sessions.has('second'),true);assert.equal(audio.playRequests.get('2:req').signal.aborted,false);assert.equal(stopped,1);
});
test('record-only and NAS-only changes leave local downloads and playback running',async()=>{const {quiesceSelectedDeletion}=await import('../electron/deletion-session.mjs');const dependencies={queue:{cancel:()=>{throw Error('must not cancel');}}};await quiesceSelectedDeletion({ids:['1'],files:false,records:true},dependencies);await quiesceSelectedDeletion({ids:['1'],files:false,nasOnly:true},dependencies);});

test('deletion drains selected preview file handles before allowing the destructive steps',async()=>{
 const {quiesceSelectedDeletion}=await import('../electron/deletion-session.mjs');const seen=[];
 await quiesceSelectedDeletion({ids:['1'],files:true},{previews:{closeSelected:async ids=>seen.push(['previews',...ids])},queue:{cancel:async()=>seen.push(['writers'])}});
 assert.deepEqual(seen,[['previews','1'],['writers']]);
});
test('stop can leave a stuck writer waiting without starting any destructive step',async()=>{const {quiesceSelectedDeletion}=await import('../electron/deletion-session.mjs'),controller=new AbortController();const running=quiesceSelectedDeletion({ids:['1'],files:true},{queue:{cancel:()=>new Promise(()=>{})},signal:controller.signal});setTimeout(()=>controller.abort(Error('test stopped')),20);await assert.rejects(Promise.race([running,new Promise((_,reject)=>setTimeout(()=>reject(Error('stop did not reach writer wait')),500))]),/test stopped/);});

test('independent audio removal drains previews before trash and always removes its audio-only gate',async()=>{
 const {withReleasedPreviews}=await import('../electron/deletion-session.mjs'),seen=[];
 const previews={block:(ids,kind)=>{seen.push(['block',...ids,kind]);return()=>seen.push(['release']);},closeSelected:async(ids,kind)=>seen.push(['close',...ids,kind])};
 await assert.rejects(withReleasedPreviews(['1'],previews,async()=>{seen.push(['trash']);throw Error('EPERM');},'audio'),/EPERM/);
 assert.deepEqual(seen,[['block','1','audio'],['close','1','audio'],['trash'],['release']]);
});

test('independent audio removal never starts trash when draining a preview fails',async()=>{
 const {withReleasedPreviews}=await import('../electron/deletion-session.mjs');let released=false,trashed=false;
 const previews={block:()=>()=>released=true,closeSelected:async()=>{throw Error('busy');}};
 await assert.rejects(withReleasedPreviews(['1'],previews,async()=>trashed=true,'audio'),/busy/);
 assert.equal(released,true);assert.equal(trashed,false);
});
