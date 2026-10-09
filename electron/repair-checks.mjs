import {Worker} from 'node:worker_threads';import {randomUUID} from 'node:crypto';
export class RepairChecks{
 constructor(store,notify=()=>{}){this.store=store;this.notify=notify;}
 get running(){return !!this.job?.running;}
 state(){if(!this.job)return null;const {problems,resolve,...summary}=this.job;return {...summary,totalProblems:problems.length};}
 report(){const state=this.state();return state?{...state,items:this.job.problems.slice(0,50)}:null;}
 check(ids,{confirming=false}={}){
  if(this.running)throw Error('已有文件检查正在进行');
  const requested=[...new Set(ids)];this.job={token:randomUUID(),running:true,phase:confirming?'confirming':'checking',total:requested.length,checked:0,complete:0,missing:0,errors:0,current:'',problems:[],message:confirming?'正在后台重新确认缺失文件':'正在后台检查本地文件'};
  const job=this.job;this.notify();return new Promise(resolve=>{
   job.resolve=resolve;let worker;
   const finish=(phase,message)=>{if(!job.running)return;job.running=false;job.phase=phase;job.message=message;job.current='';clearInterval(this.watchdog);if(this.worker===worker)this.worker=null;this.notify();resolve(this.report());};
   try{
    worker=this.worker=new Worker(new URL('./repair-check-worker.mjs',import.meta.url),{workerData:{file:this.store.file,ids:requested},execArgv:[]});this.lastMessage=Date.now();
    this.watchdog=setInterval(()=>{if(Date.now()-this.lastMessage>15000){finish('failed','检查暂未返回结果，请检查磁盘连接后重试');void worker.terminate();}},1000);this.watchdog.unref();
    worker.on('message',message=>{
     if(this.job!==job||!job.running)return;this.lastMessage=Date.now();
     if(message.current){job.current=message.current;return;}if(message.heartbeat)return;
     if(message.results){for(const result of message.results){job.checked++;job[result.status==='complete'?'complete':result.status==='missing'?'missing':'errors']++;if(result.status!=='complete')job.problems.push(result);}this.notify();if(job.running)worker.postMessage({ack:message.sequence});}
     if(message.done)finish(message.cancelled?'cancelled':'done',message.cancelled?'已停止检查，已检查的结果保留':'检查完成');if(message.failure)finish('failed',message.failure);
    });worker.on('error',error=>finish('failed',error.message));worker.on('exit',code=>{if(job.running)finish('failed','后台检查已退出（'+code+'），已有结果保留');});
   }catch(error){finish('failed',error.message);}
  });
 }
 cancel(){if(this.running){const worker=this.worker;this.worker=null;clearInterval(this.watchdog);this.job.running=false;this.job.phase='cancelled';this.job.current='';this.job.message='已停止检查，已检查的结果保留；未检查的作品未改动';this.notify();this.job.resolve(this.report());this.terminating=worker?.terminate().catch(()=>{});}return this.report();}
 page(token,page=1){if(token!==this.job?.token)throw Error('检查结果已更新，请重新检查');if(!Number.isInteger(page)||page<1)throw Error('检查结果页码无效');const total=this.job.problems.length,pages=Math.max(1,Math.ceil(total/50)),current=Math.min(page,pages);return {items:this.job.problems.slice((current-1)*50,current*50),total,page:current,pages};}
 missingIds(token){if(this.running||token!==this.job?.token)throw Error('请等待当前检查完成，或重新检查');return this.job.problems.filter(i=>i.status==='missing').map(i=>i.id);}
 async close(){this.cancel();if(this.terminating){let timer;try{await Promise.race([this.terminating,new Promise(resolve=>{timer=setTimeout(resolve,1000);})]);}finally{clearTimeout(timer);}}}
}
