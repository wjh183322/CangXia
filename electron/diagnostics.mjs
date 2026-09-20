import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
export function createDiagnostics(profile){
 const dir=path.join(profile,'diagnostics'),file=path.join(dir,'events.jsonl');fs.mkdirSync(dir,{recursive:true});
 const record=input=>{try{if(fs.existsSync(file)&&fs.statSync(file).size>1024*1024){fs.copyFileSync(file,file+'.previous');fs.truncateSync(file,0);}const allowed=['event','path','httpStatus','businessCode','reason','exitCode','name','code','rssMiB','heapMiB','freeMiB','version','count'];const clean={time:new Date().toISOString()};for(const k of allowed)if(input[k]!==undefined)clean[k]=typeof input[k]==='string'?input[k].replace(/https?:\/\/\S+/g,'[url]').slice(0,180):input[k];fs.appendFileSync(file,JSON.stringify(clean)+'\n');}catch{}};
 const memory=()=>record({event:'memory',rssMiB:Math.round(process.memoryUsage().rss/1048576),heapMiB:Math.round(process.memoryUsage().heapUsed/1048576),freeMiB:Math.round(os.freemem()/1048576)});
 const timer=setInterval(memory,60000);timer.unref();memory();return {record,dir,close:()=>clearInterval(timer)};
}
