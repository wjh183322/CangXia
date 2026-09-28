// Capture the body immediately; UI updates and disk writes must never delay it.
export class ResponseCapture{
  constructor(send,{limit=8*1024*1024,maxPending=12}={}){this.send=send;this.limit=limit;this.maxPending=maxPending;this.items=new Map();}
  start(id){
    if(this.items.has(id))return;
    if(this.items.size>=this.maxPending)throw Error('待保存响应过多，已暂停以保留记录');
    const item={chunks:[],bytes:0,error:null};this.items.set(id,item);
    item.ready=this.send('Network.streamResourceContent',{requestId:id}).then(result=>{
      const prefix=Buffer.from(result.bufferedData||'','base64');item.bytes+=prefix.length;if(item.bytes>this.limit)item.error=Error('收藏响应过大，已暂停');return {prefix};
    },error=>({fallback:true,error}));
  }
  data(id,base64){const item=this.items.get(id);if(!item||!base64||item.error)return;const chunk=Buffer.from(base64,'base64');item.bytes+=chunk.length;if(item.bytes>this.limit){item.error=Error('收藏响应过大，已暂停');item.chunks=[];return;}item.chunks.push(chunk);}
  finish(id){
    const item=this.items.get(id);if(!item)return Promise.resolve({error:Error('未捕获到收藏响应开始，已暂停')});
    // Start this promise at loadingFinished, outside the serial processing queue.
    return (async()=>{
      try{const started=await item.ready;if(item.error)throw item.error;
        if(started.fallback){const result=await this.send('Network.getResponseBody',{requestId:id});const body=Buffer.from(result.body,result.base64Encoded?'base64':'utf8');if(body.length>this.limit)throw Error('收藏响应过大，已暂停');return {text:body.toString('utf8'),mode:'immediate-fallback'};}
        return {text:Buffer.concat([started.prefix,...item.chunks],item.bytes).toString('utf8'),mode:'stream'};
      }catch(error){return {error};}finally{this.items.delete(id);}
    })();
  }
  discard(id){this.items.delete(id);}
}
