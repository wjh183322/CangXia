// Design contracts only. These helpers are NOT wired into the product.
// Running these tests does not establish that production playback/cache works.
import test from 'node:test';import assert from 'node:assert/strict';

function clip(raw,duration,{unitConfirmed=true,boundaryAllowance=0}={}){
 const original={...raw};if(!unitConfirmed||!Number.isFinite(duration)||duration<=0)return {state:'unknown',original};
 const begin=raw?.begin_time,end=raw?.end_time;if(!Number.isSafeInteger(begin)||!Number.isSafeInteger(end)||begin<0||end<=begin)return {state:'unknown',original};
 const start=begin/1000,stop=end/1000;if(start>=duration||stop>duration+boundaryAllowance)return {state:'inconsistent',original};
 return {state:'valid',start,end:Math.min(stop,duration),original};
}
class Budget{
 constructor(limit){this.limit=limit;this.reservations=new Map();this.used=0;this.peak=0;}
 reserve(id,size){if(!Number.isSafeInteger(size)||size<0)throw Error('invalid-size');const old=this.reservations.get(id)||0;if(this.used-old+size>this.limit)return false;this.used+=size-old;this.reservations.set(id,size);this.peak=Math.max(this.peak,this.used);return true;}
 release(id){this.used-=this.reservations.get(id)||0;this.reservations.delete(id);}
}
const evictable=o=>o.cacheOnly&&o.localSaveRefs===0&&o.activeUses===0&&o.pendingCommitRefs===0&&o.incomplete===false;
function responseAppendable({requestedStart,expectedSize,expectedEtag},{status,contentRange,etag}){
 if(status!==206||!expectedEtag||expectedEtag.startsWith('W/')||etag!==expectedEtag)return false;
 const m=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange||'');return !!m&&Number(m[1])===requestedStart&&Number(m[2])>=requestedStart&&Number(m[2])<expectedSize&&Number(m[3])===expectedSize;
}

test('negative legacy clip stays unknown instead of silently becoming zero/full source',()=>{assert.equal(clip({begin_time:-1,end_time:-1},45).state,'unknown');});
test('unit not confirmed cannot silently interpret timing fields',()=>{assert.equal(clip({begin_time:1000,end_time:3000},5,{unitConfirmed:false}).state,'unknown');});
test('nonzero clip semantic model preserves source offset and does not shorten source file',()=>{const c=clip({begin_time:12000,end_time:29000},60);assert.deepEqual([c.state,c.start,c.end],['valid',12,29]);});
test('same source can carry independent work clips',()=>{const a=clip({begin_time:0,end_time:29000},29.01),b=clip({begin_time:4000,end_time:10000},29.01);assert.equal(a.end,29);assert.equal(b.start,4);assert.notDeepEqual(a,b);});
test('small boundary allowance clamps playback while retaining platform raw value',()=>{const c=clip({begin_time:0,end_time:29023},29.01,{boundaryAllowance:.024});assert.equal(c.end,29.01);assert.equal(c.original.end_time,29023);});
test('large out-of-bounds or reversed range does not get guessed into a valid clip',()=>{assert.equal(clip({begin_time:0,end_time:90000},29.01).state,'inconsistent');assert.equal(clip({begin_time:30000,end_time:10000},29.01).state,'unknown');});
test('music integer duration is not a clipping or file integrity rule',()=>{const c=clip({begin_time:0,end_time:33671,musicDuration:33},33.6718);assert.equal(c.end,33.671);});
test('parallel reservations cannot independently overfill one cache budget',()=>{const b=new Budget(10);assert.equal(b.reserve('a',6),true);assert.equal(b.reserve('b',6),false);assert.equal(b.used,6);});
test('unknown-length write growth must acquire budget before adding more bytes',()=>{const b=new Budget(10);assert.ok(b.reserve('a',4));assert.ok(b.reserve('a',8));assert.equal(b.reserve('a',12),false);assert.equal(b.used,8);});
test('30000 admission decisions retain a bounded byte ledger and reject oversized source',()=>{const b=new Budget(256);for(let i=0;i<30000;i++){const key='slot-'+(i%8);b.release(key);b.reserve(key,32);}assert.equal(b.peak,256);assert.equal(b.used,256);assert.equal(b.reserve('oversize',257),false);});
test('cancellation releases a reservation without evicting formal media',()=>{const b=new Budget(10);b.reserve('job',8);b.release('job');assert.equal(b.used,0);assert.equal(evictable({cacheOnly:false,localSaveRefs:1,activeUses:0,pendingCommitRefs:0,incomplete:false}),false);});
test('uploaded but receipt-unknown object remains protected',()=>{assert.equal(evictable({cacheOnly:true,localSaveRefs:0,activeUses:0,pendingCommitRefs:1,incomplete:false}),false);});
test('active playback and incomplete cached files remain protected',()=>{for(const o of [{activeUses:1,incomplete:false},{activeUses:0,incomplete:true}])assert.equal(evictable({cacheOnly:true,localSaveRefs:0,pendingCommitRefs:0,...o}),false);});
test('metadata association alone does not make cache permanent',()=>{assert.ok(evictable({cacheOnly:true,localSaveRefs:0,activeUses:0,pendingCommitRefs:0,incomplete:false,metadataRefs:30000}));});
test('206 with changed response ETag is rejected even when If-Range was sent',()=>{assert.equal(responseAppendable({requestedStart:1024,expectedSize:471324,expectedEtag:'"old"'},{status:206,contentRange:'bytes 1024-2047/471324',etag:'"new"'}),false);});
test('full 200 response and inconsistent 206 range cannot be appended',()=>{const p={requestedStart:1024,expectedSize:471324,expectedEtag:'"ok"'};assert.equal(responseAppendable(p,{status:200,etag:'"ok"'}),false);assert.equal(responseAppendable(p,{status:206,etag:'"ok"',contentRange:'bytes 0-1023/471324'}),false);});
test('matching response version and exact range permit bounded continuation',()=>{assert.equal(responseAppendable({requestedStart:1024,expectedSize:471324,expectedEtag:'"ok"'},{status:206,etag:'"ok"',contentRange:'bytes 1024-2047/471324'}),true);});
test('weak or absent validator cannot authorize reuse across sessions',()=>{for(const expectedEtag of ['W/"ok"',null])assert.equal(responseAppendable({requestedStart:1024,expectedSize:471324,expectedEtag},{status:206,etag:expectedEtag,contentRange:'bytes 1024-2047/471324'}),false);});
