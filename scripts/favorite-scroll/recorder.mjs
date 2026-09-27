import {parsePlatformJSON} from '../../electron/model.mjs';

export class FavoriteRecorder{
  constructor(){this.startedAt=new Date().toISOString();this.pages=new Map();this.works=new Map();this.errors=[];this.requests=0;this.lastPageAt=null;}
  accept(cursor,text){
    if(typeof text!=='string'||text.length>8*1024*1024)throw Error('收藏响应过大，已暂停');
    const data=parsePlatformJSON(text),body=data?.data&&typeof data.data==='object'?data.data:data;
    if(Number(data.status_code||body?.status_code||0)!==0)throw Error('抖音返回访问提示，请检查网页登录或验证状态');
    if(!Array.isArray(body?.aweme_list))throw Error('网页没有返回预期收藏列表');
    if(typeof cursor!=='string'||!/^\d{1,32}$/.test(cursor))throw Error('未能识别本页收藏翻页位置');
    const flag=body.has_more??data.has_more,complete=flag===0||flag===false,nextValue=body.cursor??body.max_cursor??data.cursor??data.max_cursor;
    const next=nextValue===undefined?null:String(nextValue);if(next!==null&&!/^\d{1,32}$/.test(next))throw Error('网页返回了无法识别的翻页位置');
    const parsed=body.aweme_list.map(raw=>{const id=String(raw.aweme_id||'');if(!/^\d+$/.test(id))throw Error('作品 ID 无法准确识别，已暂停');return {id,title:String(raw.item_title||raw.desc||'').slice(0,160),url:`https://www.douyin.com/video/${id}`};});
    const ids=parsed.map(w=>w.id),old=this.pages.get(cursor);
    if(old&&JSON.stringify([old.ids,old.next,old.complete])!==JSON.stringify([ids,next,complete]))throw Error('同一翻页位置的内容发生变化；请暂停新增/取消收藏后重新开始核对');
    this.pages.set(cursor,{cursor,next,complete,ids});for(const w of parsed)this.works.set(w.id,w);this.requests++;this.lastPageAt=Date.now();return this.summary();
  }
  summary(){
    let cursor='0',end=false,cycle=false;const visited=new Set(),ids=[],seen=new Set();
    while(cursor!==null&&this.pages.has(cursor)){if(visited.has(cursor)){cycle=true;break;}visited.add(cursor);const page=this.pages.get(cursor);for(const id of page.ids)if(!seen.has(id)){seen.add(id);ids.push(id);}if(page.complete){end=true;break;}cursor=page.next;}
    return {uniqueWorks:this.works.size,pages:this.pages.size,responses:this.requests,hasFirstPage:this.pages.has('0'),continuousWorks:ids.length,continuousPages:visited.size,serverEnd:end&&!cycle,cycle,missingCursor:end?null:cursor,lastPageAt:this.lastPageAt,lastWorks:ids.slice(-10).map(id=>this.works.get(id))};
  }
  export(reason,dom={}){return {schemaVersion:1,tool:'收藏网页自动翻页',scope:'总收藏中的作品',startedAt:this.startedAt,savedAt:new Date().toISOString(),reason,...this.summary(),domObservedCount:dom.observedCount||0,scrollSteps:dom.steps||0,limits:'统计网页当前返回的作品；即使从第一页连续到末页，也不能证明被平台隐藏或失效的历史收藏均可访问。DOM 观察数仅供参考，不与接口作品数相加。',errors:this.errors,works:[...this.works.values()],pages:[...this.pages.values()]};}
}
