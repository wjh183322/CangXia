import {creatorIndex,workCreators,sameCreator,normalizeCreator,mergeCreator,CREATOR_INFO_VERSION} from '../shared/creators.mjs';
const fresh=time=>!!time&&Date.now()-Date.parse(time)<7*86400000;
export class CreatorDetails{
 constructor(collector){this.collector=collector;this.store=collector.store;this.attempts=new Map();this.running=false;}
 cancel(id){if(this.activeId===id)this.controller?.abort(new Error('作者信息更新已停止'));return true;}
 async refresh(id,{force=false}={}){
  const c=this.collector;let work=this.store.work(id);if(!work)throw Error('作品不存在');
  if(!force&&Date.now()-(this.attempts.get(id)||0)<60000)return {workId:id,message:'已保留最近取得的作者信息'};
  await c.ready;c.assertNotCoolingDown();if(!await c.isAuthenticated())throw Error('连接抖音账号后可补充作者信息');this.attempts.set(id,Date.now());c.cancelled=false;
  const controller=new AbortController(),key='creators:'+id,previousController=c.syncController;c.syncController=controller;this.running=true;this.controller=controller;this.activeId=id;
  try{
  const messages=[];if(force||work.coAuthorsState==='unknown'||work.creatorInfoVersion!==CREATOR_INFO_VERSION||!fresh(work.creatorsCheckedAt))try{work=await c.resolveWork(id,{backgroundOnly:true,signal:controller.signal});}catch(error){messages.push(error.message);if(!c.status.connected||c.cancelled||controller.signal.aborted)throw error;}
  if(work.coAuthorsState==='unknown')messages.push('当前接口未返回共创信息，已有共创记录已保留');
  c.waiters.set(key,{reject:()=>controller.abort(new Error('作者信息更新已停止'))});
  const creators=workCreators(work,creatorIndex(this.store.creatorProfiles())),resolved=[];let requested=0;
  for(const person of creators){
   const cached=this.store.cachedCreator(person);if(!force&&(person.uniqueId||fresh(cached?.fetchedAt))){resolved.push(person);continue;}
   if(!/^MS4wLjAB[A-Za-z0-9_-]{8,240}$/.test(person.secUid)){resolved.push(person);continue;}
   try{
    controller.signal.throwIfAborted();if(requested++)await c.delay?.();controller.signal.throwIfAborted();const data=await c.request('/aweme/v1/web/user/profile/other/',{params:{sec_user_id:person.secUid,publish_video_strategy_type:2},quiet:true,signal:controller.signal});
    const profile=normalizeCreator(data.user||data.data?.user||{});if(!sameCreator(person,profile)||profile.secUid!==person.secUid)throw Error('作者主页身份不匹配，未覆盖原信息');
    this.store.rememberCreator(profile);resolved.push(mergeCreator(person,profile));
   }catch(error){resolved.push(person);messages.push(error.message);if(!c.status.connected||c.cancelled||controller.signal.aborted)break;}
  }
  const current=this.store.work(id);if(current){const merged=workCreators(current).map(person=>{const p=resolved.find(a=>sameCreator(a,person));return p?mergeCreator(person,p):person;});this.store.put('works',id,{...current,author:merged[0],coAuthors:merged.slice(1)});this.store.save();c.notify();}
  return {workId:id,message:messages.length?'部分信息暂未取得：'+[...new Set(messages)].join('；'):resolved.some(a=>!a.uniqueId)?'已更新；部分作者的公开信息暂未返回抖音号':'作者信息已更新'};
  }finally{this.running=false;this.controller=null;this.activeId=null;c.waiters.delete(key);if(c.syncController===controller)c.syncController=previousController;c.scheduleBrowserIdle();}
 }
}
