import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {parseWork} from '../electron/model.mjs';import {selectWorks} from '../electron/filter.mjs';import {Store} from '../electron/store.mjs';import {CreatorDetails} from '../electron/creator-details.mjs';import {normalizeCreator,creatorKey,creatorIndex,workCreators} from '../shared/creators.mjs';import {exportRecords,applyChanges} from '../electron/backup-model.mjs';
const raw=JSON.parse(fs.readFileSync(new URL('./fixtures/coauthor-work.json',import.meta.url))),co=raw.cooperation_info.co_creators[0];
async function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx-creators-')),store=await Store.open(path.join(root,'db.sqlite'),path.join(root,'media'));t.after(()=>{store.close();assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});return store;}
test('actual shared work preserves its publisher and accepted co-creator role, not ordinary mentions',()=>{
 const w=parseWork({...raw,text_extra:[{user_id:'999',nickname:'普通提及'}]});assert.equal(w.author.nickname,'白起.');assert.equal(w.author.uniqueId,'ffff1111fff');assert.equal(w.coAuthors.length,1);assert.equal(w.coAuthors[0].nickname,'偷懒噜');assert.equal(w.coAuthors[0].roleTitle,'出镜');assert.equal(w.coAuthors[0].uniqueId,'');
 const pending=parseWork({...raw,cooperation_info:{co_creators:[...raw.cooperation_info.co_creators,{...co,uid:'999',sec_uid:'different',invite_status:0},raw.author]}});assert.equal(pending.coAuthors.length,1);assert.equal(normalizeCreator({short_id:'0'}).uniqueId,'');
});
test('stable-ID filtering includes co-created work and ignores same-nickname strangers',()=>{
 const w=parseWork(raw),other=parseWork({...raw,aweme_id:'2',author:{uid:'333',nickname:co.nickname},cooperation_info:{co_creators:[]}}),profiles=creatorIndex([{...co,unique_id:'37386365831'}]);
 assert.deepEqual(selectWorks([w,other],{author:creatorKey(normalizeCreator(co)),creators:profiles}).map(w=>w.id),[w.id]);assert.deepEqual(selectWorks([w,other],{query:'37386365831',creators:profiles}).map(w=>w.id),[w.id]);assert.equal(workCreators(w,profiles)[1].uniqueId,'37386365831');
});
test('partial list refresh preserves co-creators and cached handles; verified detail can remove an old co-creator',async t=>{
 const s=await setup(t);s.upsertWork(raw);s.rememberCreator({...co,unique_id:'37386365831'});s.upsertWork({aweme_id:raw.aweme_id,author:{uid:raw.author.uid}});assert.equal(s.work(raw.aweme_id).coAuthors.length,1);assert.equal(s.work(raw.aweme_id).author.uniqueId,'ffff1111fff');assert.equal(workCreators(s.work(raw.aweme_id),creatorIndex(s.creatorProfiles()))[1].uniqueId,'37386365831');
 s.upsertWork({aweme_id:raw.aweme_id,author:raw.author},{fullDetail:true});assert.deepEqual(s.work(raw.aweme_id).coAuthors,[]);
});
test('co-creator homepage membership accepts the shared item without altering collections',async t=>{
 const s=await setup(t);s.authorSources.add(co.sec_uid,{user:{...co,unique_id:'37386365831'}});const source=s.authorSources.start(co.sec_uid);s.authorSources.apply(source,{items:[raw],next:null,complete:true});assert.deepEqual(s.authorSources.snapshot().authorMembers[co.sec_uid],[raw.aweme_id]);assert.deepEqual(s.snapshot().members.__all__,[]);assert.equal(s.snapshot().creatorProfiles.find(a=>a.secUid===co.sec_uid).uniqueId,'37386365831');
});
test('opening one detail refreshes one work and only missing profile; cache avoids rescanning or repeat profile requests',async t=>{
 const s=await setup(t);s.upsertWork({aweme_id:raw.aweme_id,author:{uid:raw.author.uid,sec_uid:raw.author.sec_uid,nickname:raw.author.nickname}});let detailCalls=0,profileCalls=0;
 const c={store:s,ready:Promise.resolve(),status:{connected:true},waiters:new Map(),assertNotCoolingDown(){},isAuthenticated:async()=>true,notify(){},scheduleBrowserIdle(){},resolveWork:async id=>{assert.equal(id,raw.aweme_id);detailCalls++;return s.upsertWork(raw,{fullDetail:true});},request:async(route,options)=>{profileCalls++;assert.equal(options.params.sec_user_id,co.sec_uid);return {user:{...co,unique_id:'37386365831'}};}};
 const resolver=new CreatorDetails(c);await resolver.refresh(raw.aweme_id);assert.equal(detailCalls,1);assert.equal(profileCalls,1);assert.equal(s.work(raw.aweme_id).coAuthors[0].uniqueId,'37386365831');await new CreatorDetails(c).refresh(raw.aweme_id);assert.equal(detailCalls,1);assert.equal(profileCalls,1);assert.equal(c.waiters.size,0);
 const entries=exportRecords(s);assert.ok(!entries.some(e=>e.table==='creator_profiles'));assert.equal(entries.find(e=>e.table==='works').body.coAuthors[0].uniqueId,'37386365831');const restored=await setup(t);applyChanges(restored,entries);assert.equal(restored.work(raw.aweme_id).coAuthors[0].roleTitle,'出镜');
});
test('mismatched profile cannot overwrite co-creator identity or account handle',async t=>{
 const s=await setup(t);s.upsertWork(raw,{fullDetail:true});const c={store:s,ready:Promise.resolve(),status:{connected:true},waiters:new Map(),assertNotCoolingDown(){},isAuthenticated:async()=>true,notify(){},scheduleBrowserIdle(){},request:async()=>({user:{uid:'999',sec_uid:co.sec_uid,unique_id:'WRONG'}})};
 const result=await new CreatorDetails(c).refresh(raw.aweme_id);assert.match(result.message,/身份不匹配/);assert.equal(s.work(raw.aweme_id).coAuthors[0].uniqueId,'');assert.equal(s.all('creator_profiles').some(p=>p.uniqueId==='WRONG'),false);
});
test('stopping a profile update aborts its request and preserves known author data',async t=>{
 const s=await setup(t);s.upsertWork(raw,{fullDetail:true});let started;const begun=new Promise(r=>started=r);
 const c={store:s,ready:Promise.resolve(),status:{connected:true},waiters:new Map(),assertNotCoolingDown(){},isAuthenticated:async()=>true,notify(){},scheduleBrowserIdle(){},request:async(_route,{signal})=>{started();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('作者信息更新已停止')),{once:true}));}};
 const resolver=new CreatorDetails(c),pending=resolver.refresh(raw.aweme_id);await begun;resolver.cancel('other');assert.equal(c.syncController.signal.aborted,false);resolver.cancel(raw.aweme_id);const result=await pending;assert.match(result.message,/已停止/);assert.equal(c.waiters.size,0);assert.equal(c.syncController,undefined);assert.equal(resolver.running,false);assert.equal(s.work(raw.aweme_id).author.uniqueId,'ffff1111fff');assert.equal(s.work(raw.aweme_id).coAuthors[0].roleTitle,'出镜');
});
