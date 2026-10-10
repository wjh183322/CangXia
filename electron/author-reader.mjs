import {authorId,resolveAuthorLink} from './author-sources.mjs';
import {pageResult} from './api-pagination.mjs';

export class AuthorReader{
  constructor(collector,{fetchLink}={}){this.collector=collector;this.store=collector.store;this.fetchLink=fetchLink||((url,options)=>collector.profile.fetch(url,options));}
  async operation(name,goal,fn){
    const c=this.collector;if(c.busy||c.waiters.size)throw new Error('请先停止其他读取任务');
    const epoch=c.cancelEpoch;await c.ready;c.assertNotCoolingDown();
    if(!(await c.isAuthenticated()))throw new Error('请先连接抖音账号，再读取作者作品');
    if(epoch!==c.cancelEpoch)throw new Error('读取已取消');
    c.status.readSummary=null;c.busy=true;c.cancelled=false;c.stopRequested=false;c.syncController=new AbortController();
    c.status.readProgress={mode:goal?'partial':'all',source:'author',name,goal,checked:0,processed:0,added:0,startedAt:Date.now(),stage:'preparing'};c.update('syncing',`正在读取「${name}」`,0);
    try{return await fn(c.syncController.signal);}catch(e){if(c.stopRequested&&(e.name==='AbortError'||e.message==='读取已暂停'))return {stopped:true};if(!c.cancelled)c.update('attention',e.message);throw e;}
    finally{c.busy=false;c.syncController=null;if(c.stopRequested)c.update('idle','已停止，已提交的作者记录和进度保留');if(c.status.readSummary)try{c.status.readSummary.message=c.status.message;this.store.readHistory.write(c.status.readSummary);}catch(error){c.onDiagnostic({event:'read-history-failed',reason:error.message});}c.readProgress({stage:'finished',finishedAt:Date.now(),stopped:c.cancelled});c.scheduleBrowserIdle();c.notify();}
  }
  async add(text){return this.operation('作者信息',null,async signal=>{
    const {id}=await resolveAuthorLink(text,this.fetchLink,signal);
    const data=await this.collector.request('/aweme/v1/web/user/profile/other/',{params:{sec_user_id:id,publish_video_strategy_type:2},signal});signal.throwIfAborted();
    const a=this.store.authorSources.add(id,data);this.collector.update('done',`已添加「${a.name}」，可选择读取范围`);return {id:a.id};
  });}
  async read({id,limit=20,readAll=false,resume=false}={}){
    authorId(id);if(!Number.isSafeInteger(limit)||limit<1||limit>100000||typeof readAll!=='boolean'||typeof resume!=='boolean')throw new Error('读取数量须为 1 到 100000 的整数');
    const sources=this.store.authorSources,author=sources.get(id);if(!author)throw new Error('请先添加作者');
    return this.operation(author.name,readAll?null:limit,async signal=>{
      const c=this.collector;let a,processed=0,added=0,limited=false;
      try{
        a=sources.start(id,{resume,readAll});
        for(let page=0;page<10000;page++){
          signal.throwIfAborted();if(c.cancelled)throw new Error('读取已暂停');
          const cursor=a.run.nextCursor;
          if(cursor===null)throw new Error('平台未提供下一页位置，请从头核对');
          if(sources.seen(id,cursor)){a.run.nextCursor=null;throw new Error('平台重复返回翻页位置，已保留作者记录，请从头核对');}
          const data=await c.request('/aweme/v1/web/aweme/post/',{params:{sec_user_id:id,max_cursor:cursor,count:30,locate_query:false,publish_video_strategy_type:2},signal});
          signal.throwIfAborted();const pageData=pageResult(data,'aweme_list');
          const result=sources.apply(a,pageData,{limit:readAll?Infinity:limit-processed,signal});
          processed+=result.taken;added+=result.added;limited=!readAll&&processed>=limit;
          c.readProgress({stage:'reading',checked:a.run.count,processed,added});c.update('syncing',`「${a.name}」 · 本次读取 ${processed} 条，新增 ${added} 条`,a.run.count);
          if(result.complete||limited)break;
          if(!pageData.items.length)throw new Error('本页为空，但平台没有确认结束；已保留进度');
          if(a.run.nextCursor===null)throw new Error('平台未提供完整分页依据，已保留作者记录');
          if(page===9999)throw new Error('达到单次读取页数上限，已保留进度，可手动续读');
          await c.delay();
        }
        signal.throwIfAborted();const message=`「${a.name}」${a.run.status==='complete'?'已到达当前可访问列表末尾':limited?'本次读取完成':'已暂停'} · 本次读取 ${processed} 条，新增 ${added} 条`;
        sources.pause(a,message,limited?'limit':'paused');c.update('done',message,a.run.count);return {id,processed,added,complete:a.run.status==='complete'};
      }catch(e){if(a)sources.pause(a,c.cancelled?'读取已暂停':e.message,c.cancelled?'paused':'error');throw e;}
      finally{if(a)try{c.status.readSummary={...sources.summary(a),message:c.status.message};this.store.readHistory.write(c.status.readSummary);}catch(error){c.onDiagnostic({event:'read-history-failed',reason:error.message});}}
    });
  }
}
