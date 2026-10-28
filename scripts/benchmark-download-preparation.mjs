import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {pathToFileURL} from 'node:url';import {execFileSync} from 'node:child_process';import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {createPreparationFixture} from '../tests/download-preparation-fixture.mjs';
const args=process.argv.slice(2),arg=(name,fallback)=>{const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];},variant=arg('variant','optimized'),savedCount=Number(arg('saved','31542')),newCount=Number(arg('new','775')),runs=Number(arg('runs','1')),output=arg('output','.test-output/responsiveness-'+variant+'.json');
if(!['baseline','optimized'].includes(variant)||![savedCount,newCount,runs].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('Invalid benchmark arguments');
let source,types={};const ref='08e6436522a3828211e9c32b51f90d7d830b4fa8';
if(variant==='baseline'){source=fs.mkdtempSync(path.join(os.tmpdir(),'cx-baseline-source-'));const archive=path.join(source,'source.tar');execFileSync('git',['archive','--format=tar','--output',archive,ref,'electron','shared']);execFileSync('tar',['-xf',archive,'-C',source]);fs.writeFileSync(path.join(source,'package.json'),'{"type":"module"}');types={StoreType:(await import(pathToFileURL(path.join(source,'electron/store.mjs')))).Store,QueueType:(await import(pathToFileURL(path.join(source,'electron/downloads.mjs')))).DownloadQueue};}
const reports=[];fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});
const save=()=>fs.writeFileSync(output,JSON.stringify({variant,baselineRef:ref,node:process.versions.node,platform:process.platform,peakRssScope:'process lifetime, includes fixture setup',reports},null,2));
try{
 for(let run=0;run<runs;run++)for(const count of [...new Set([1,5,20,newCount])]){
  const f=await createPreparationFixture(null,{savedCount,unsavedCount:count,...types}),selected=f.ids.slice(savedCount),all=f.store.all.bind(f.store);let fullManifestScans=0,manifestRows=0;
  f.store.all=table=>{const rows=all(table);if(table==='downloads'){fullManifestScans++;manifestRows+=rows.length;}return rows;};
  try{for(const phase of variant==='optimized'?['cold','service-warm']:['cold']){
   if(phase==='service-warm'){f.queue.jobs=[];f.queue.taskRows.flush();f.queue.cursor=0;}fullManifestScans=0;manifestRows=0;
   const hist=monitorEventLoopDelay({resolution:10});hist.enable();await new Promise(r=>setTimeout(r,20));let firstPulse,result,helperMetrics,ownershipBuilds;
   const start=performance.now(),timer=setTimeout(()=>firstPulse=performance.now()-start,0);
   try{if(variant==='baseline')result=f.queue.enqueue(selected);else{const {DownloadPreparation}=await import('../electron/download-preparation.mjs');f.queue.preparation ||= new DownloadPreparation({store:f.store,queue:f.queue});const before=f.queue.preparation.stats.ownershipBuilds;result=await f.queue.preparation.submit({ids:selected,source:'douyin',kind:'exact'});ownershipBuilds=f.queue.preparation.stats.ownershipBuilds-before;helperMetrics=f.queue.preparation.stats.helperMetrics;}
    const elapsedMs=performance.now()-start;await new Promise(r=>setTimeout(r,20));reports.push({run,phase,newTasks:count,savedCount,elapsedMs,firstPulseMs:firstPulse,eventLoopP95Ms:hist.percentile(95)/1e6,eventLoopMaxMs:hist.max/1e6,fullManifestScans,manifestRows,ownershipBuilds,admitted:typeof result==='number'?result:result.queued,rssMiB:process.memoryUsage().rss/1048576,peakRssMiB:process.resourceUsage().maxRSS/1024,helperMetrics});console.log(JSON.stringify(reports.at(-1)));save();
   }finally{clearTimeout(timer);hist.disable();}
  }}finally{await f.close();}
 }
}finally{save();if(source){if(path.dirname(source)!==os.tmpdir()||!path.basename(source).startsWith('cx-baseline-source-'))throw Error('Unsafe benchmark cleanup');fs.rmSync(source,{recursive:true,force:true,maxRetries:5,retryDelay:100});}}
