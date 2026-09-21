import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parseReferenceConfig, validateAuth, AuthVault } from '../electron/auth-data.mjs';
import { pageResult, paginate, normalizeCollections } from '../electron/api-pagination.mjs';
import { validateDebugURL } from '../electron/system-browser.mjs';
import { Collector } from '../electron/account-collector.mjs';
import { Store } from '../electron/store.mjs';
import { DownloadQueue } from '../electron/downloads.mjs';
import { TOTAL } from '../electron/model.mjs';

const config=()=>JSON.stringify({cookie:'sessionid=TEST_COOKIE_NOT_REAL; ttwid=test',user_agent:'TestBrowser/150',collects_id:'99'});
const raw=id=>({aweme_id:id,desc:'测试 #cos',author:{uid:'7',nickname:'测试作者'},video:{play_addr:{url_list:['https://v3.douyinvod.com/example.mp4']}}});
async function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cangxia-account-test-'));const store=await Store.open(path.join(dir,'library.sqlite'),path.join(dir,'media'));t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,store};}
function adapter(store,fetcher=async()=>{throw new Error('Unexpected request');}){
  let cookies=[],ua='';const calls=[];let saved=null;
  const profile={clearStorageData:async()=>{cookies=[];},setUserAgent:value=>{ua=value;},getUserAgent:()=>ua,cookies:{get:async()=>cookies,set:async c=>cookies.push(c)},fetch:async(url,options)=>{calls.push({url,options});return fetcher(url,options);}};
  const browser=new EventEmitter();browser.openLogin=async()=>{browser.opened=true;return 'chrome';};browser.close=async()=>{};
  const collector=new Collector(store,()=>{},{profile,browser,vault:{load:()=>null,save:a=>{saved=a;}},delay:async()=>{}});
  return {collector,calls,browser,get saved(){return saved;}};
}
test('reference configuration requires a genuine session cookie, not anonymous ttwid',()=>{
  assert.equal(parseReferenceConfig(config()).cookies[0].name,'sessionid');
  assert.throws(()=>parseReferenceConfig(JSON.stringify({cookie:'ttwid=anonymous',user_agent:'Browser'})),/不含有效登录会话/);
});
test('configuration validation excludes other sites and rejects header injection',()=>{
  const auth=parseReferenceConfig(config());auth.cookies.push({name:'secret',value:'unrelated',domain:'.douyin.com.evil.test'});assert.equal(validateAuth(auth).cookies.length,2);
  auth.userAgent='Browser\r\nAuthorization: injected';assert.throws(()=>validateAuth(auth),/浏览器信息/);
  assert.throws(()=>parseReferenceConfig('{bad json'),/JSON/);
});
test('irrelevant malformed cookies no longer reject a valid login session',()=>{
  const auth=parseReferenceConfig(config());auth.cookies.push({name:'',value:'auxiliary',domain:'.douyin.com'},{name:'sdk:temporary',value:'auxiliary',domain:'.douyin.com'});
  const result=validateAuth({...auth,source:'popup'});assert.equal(result.cookies.length,2);assert.equal(result.ignoredCookies,2);assert.equal(result.source,'popup');
  auth.cookies[0].value='bad\r\nvalue';assert.throws(()=>validateAuth(auth),/关键登录会话/);
});
test('credential vault persists encrypted bytes and safely rejects corrupted state',async t=>{
  const {dir}=await setup(t);const secrets=new Map();const cipher=Buffer.from('ciphertext-not-credentials');
  const crypto={isEncryptionAvailable:()=>true,encryptString:text=>{secrets.set(cipher.toString(),text);return cipher;},decryptString:b=>{if(!secrets.has(b.toString()))throw new Error('invalid');return secrets.get(b.toString());}};
  const file=path.join(dir,'auth.bin');const vault=new AuthVault(file,crypto);vault.save(parseReferenceConfig(config()));assert.ok(!fs.readFileSync(file).includes(Buffer.from('TEST_COOKIE')));assert.equal(vault.load().source,'config');fs.writeFileSync(file,'corrupted');assert.equal(vault.load(),null);
});
test('credential vault never falls back to plaintext when encryption is unavailable',async t=>{
  const {dir}=await setup(t);const file=path.join(dir,'auth.bin');const vault=new AuthVault(file,{isEncryptionAvailable:()=>false});assert.throws(()=>vault.save(parseReferenceConfig(config())),/加密/);assert.equal(fs.existsSync(file),false);
});
test('debug transport accepts only the allocated loopback browser endpoint',()=>{
  assert.equal(validateDebugURL('ws://127.0.0.1:34567/devtools/browser/abc-123',34567),'ws://127.0.0.1:34567/devtools/browser/abc-123');
  for(const url of ['ws://localhost:34567/devtools/browser/x','ws://192.168.1.2:34567/devtools/browser/x','ws://127.0.0.1:9222/devtools/browser/x'])assert.throws(()=>validateDebugURL(url,34567));
});
test('pagination reads beyond seventeen pages using returned cursors',async()=>{
  let count=0;const result=await paginate(async cursor=>{count++;const i=Number(cursor);return {items:[String(i)],complete:i===19,next:String(i+1)};},async()=>{});assert.equal(count,20);assert.equal(result.items.length,20);assert.equal(result.complete,true);
});
test('unknown pagination is partial and never inferred complete from a short page',async()=>{
  const p=pageResult({aweme_list:[raw('1')]},'aweme_list');assert.equal(p.complete,false);const result=await paginate(async()=>p,async()=>{});assert.equal(result.complete,false);
  assert.throws(()=>pageResult({status_code:0},'aweme_list'),/未返回预期列表/);
});
test('nested collection formats preserve exact string IDs',()=>{
  const p=pageResult({data:{collects:[{collects_id_str:'9007199254740993001',title:'自建夹'}],has_more:0}},'collects_list');assert.equal(p.complete,true);const c=normalizeCollections(p.items)[0];assert.equal(c.collects_id,'9007199254740993001');assert.equal(c.collects_name,'自建夹');
});
test('unconnected sync never starts a browser or sends account requests',async t=>{
  const {store}=await setup(t);const a=adapter(store);await a.collector.sync();assert.equal(a.calls.length,0);assert.equal(a.browser.opened,undefined);assert.match(a.collector.status.message,/先点击/);
});
test('importing a verified config connects locally without downloading or sending requests',async t=>{
  const {store}=await setup(t);const a=adapter(store);await a.collector.importConfig(config());assert.equal(a.calls.length,0);assert.ok(await a.collector.isAuthenticated());assert.ok(a.saved);assert.equal(store.all('downloads').length,0);assert.equal(store.collection('99'),null);
});
test('total favorite fetch uses POST, retained browser UA, and leaves downloads separate',async t=>{
  const {store}=await setup(t);const a=adapter(store,async()=>new Response(JSON.stringify({status_code:0,aweme_list:[raw('3'),raw('2')],cursor:30,has_more:0}),{headers:{'content-type':'application/json'}}));await a.collector.importConfig(config());await a.collector.sync();
  assert.equal(a.calls[0].options.method,'POST');assert.equal(a.calls[0].options.headers['User-Agent'],'TestBrowser/150');assert.equal(new URLSearchParams(a.calls[0].options.body).get('cursor'),'0');assert.deepEqual(store.snapshot().members[TOTAL],['3','2']);assert.equal(store.all('downloads').length,0);assert.equal(a.collector.status.phase,'done');
});
test('rate limiting stops the read and preserves the prior full collection',async t=>{
  const {store}=await setup(t);store.upsertWork(raw('1'));store.ingestMembers(TOTAL,['1'],true);
  const a=adapter(store,async()=>new Response('limited',{status:429,headers:{'retry-after':'120'}}));await a.collector.importConfig(config());let paused=false;a.collector.onAccessHold=()=>{paused=true;};await a.collector.sync();assert.equal(a.calls.length,1);assert.equal(paused,true);assert.deepEqual(store.snapshot().members[TOTAL],['1']);assert.ok(store.getSetting('accessHoldUntil')>Date.now()+110000);
});

test('partial reads count globally new works, stop within a page and update only selected folder',async t=>{
  const {store}=await setup(t);
  store.discoverCollections([{collects_id:'9',collects_name:'A'},{collects_id:'10',collects_name:'B'}]);store.setAdded(['9','10']);
  for(const id of ['1','2','3'])store.upsertWork(raw(id));store.ingestMembers(TOTAL,['3','2','1'],true);
  const a=adapter(store,async url=>{
    assert.equal(new URL(url).searchParams.get('collects_id'),'9');
    return new Response(JSON.stringify({aweme_list:['1','4','2','5','6'].map(raw),has_more:0}));
  });
  await a.collector.importConfig(config());await a.collector.sync({collectionId:'9',maxNew:2});
  assert.equal(a.calls.length,1);assert.equal(store.work('6'),null);assert.equal(store.getSetting('readLimit'),2);
  assert.deepEqual(store.snapshot().members['9'],['1','4','2','5']);assert.deepEqual(store.snapshot().members['10'],[]);
  assert.deepEqual(store.snapshot().pendingMembers[TOTAL],['4','5']);assert.equal(store.collection('9').complete,false);
  assert.match(a.collector.status.message,/新增 2 个/);
});

test('known pages are skipped for quota, scanning until exhaustion or enough new IDs',async t=>{
  const {store}=await setup(t);for(const id of ['1','2','3'])store.upsertWork(raw(id));
  const a=adapter(store,async(_url,options)=>{
    const cursor=new URLSearchParams(options.body).get('cursor');
    return new Response(JSON.stringify(cursor==='0'?{aweme_list:['3','2'].map(raw),cursor:42,has_more:1}:{aweme_list:['1','4'].map(raw),has_more:0}));
  });await a.collector.importConfig(config());await a.collector.sync({maxNew:20});
  assert.equal(a.calls.length,2);assert.equal(store.collection(TOTAL).complete,true);
  assert.deepEqual(store.snapshot().members[TOTAL],['3','2','1','4']);assert.match(a.collector.status.message,/新增 1 个/);
});

test('read all ignores quota and retains actual source order',async t=>{
  const {store}=await setup(t);const a=adapter(store,async()=>new Response(JSON.stringify({aweme_list:['9','8','7'].map(raw),has_more:0})));
  await a.collector.importConfig(config());await a.collector.sync({maxNew:1,readAll:true});
  assert.deepEqual(store.snapshot().members[TOTAL],['9','8','7']);assert.equal(store.collection(TOTAL).complete,true);
});

test('deleted records count as new when reread even if metadata and local membership remain',async t=>{
  const {store}=await setup(t);store.upsertWork(raw('1'));store.upsertWork(raw('2'));store.ingestMembers(TOTAL,['2','1'],true);store.deleteReadRecords(['1']);
  const a=adapter(store,async()=>new Response(JSON.stringify({aweme_list:['2','1','3'].map(raw),has_more:0})));
  await a.collector.importConfig(config());await a.collector.sync({maxNew:1});
  assert.equal(store.work('3'),null);assert.equal(store.hasRead('1'),true);assert.deepEqual(store.snapshot().members[TOTAL],['2','1']);assert.match(a.collector.status.message,/新增 1 个/);
});
test('largest single image is selected by downloaded pixels, preserving bytes and source',async t=>{
  const {dir,store}=await setup(t);
  function png(w,h){const b=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);return b;}
  const bodies={a:png(360,640),b:png(400,700),c:png(1080,1920)};
  const q=new DownloadQueue(store,{},async url=>new Response(bodies[url.slice(-1)],{headers:{'content-type':'image/png'}}),()=>{});
  const variants=['origin_cover','cover_original_scale','cover'].map((source,i)=>({source,width:9999-i,height:9999-i,urls:['https://p3.douyinpic.com/'+['a','b','c'][i]]}));
  const asset=await q.saveBestCover(dir,variants,new AbortController().signal,()=>{});assert.equal(asset.source,'cover');assert.equal(asset.width,1080);assert.equal(asset.comparisons.length,3);assert.deepEqual(fs.readFileSync(path.join(dir,asset.file)),bodies.c);assert.ok(!fs.readdirSync(dir).some(n=>n.startsWith('.cangxia-')));
});

test('one-off media resolution reads resources without storing works, history or diagnostic requests',async t=>{
 const {store}=await setup(t);const a=adapter(store,async()=>new Response(JSON.stringify({status_code:0,aweme_detail:raw('999')})));await a.collector.importConfig(config());const revision=store.revision;const events=[];a.collector.onDiagnostic=e=>events.push(e);const work=await a.collector.resolveMediaOnly('999',new AbortController().signal);assert.equal(work.id,'999');assert.equal(store.work('999'),null);assert.equal(store.revision,revision);assert.equal(store.all('downloads').length,0);assert.deepEqual(events,[]);assert.deepEqual(a.collector.diagnostics,[]);await a.collector.dispose();
});
