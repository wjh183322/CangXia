export function localSize(work){
 if(!work||work.audioOnly)return {bytes:0,known:false};
 if(typeof work.localBytesKnown==='boolean')return {bytes:Number.isSafeInteger(work.localBytes)&&work.localBytes>=0?work.localBytes:0,known:work.localBytesKnown&&Number.isSafeInteger(work.localBytes)&&work.localBytes>=0};
 const assets=work.localRecord?.assets;if(!assets?.length)return {bytes:0,known:false};const present=assets.filter(a=>a.exists===true),known=assets.every(a=>a.exists!==undefined)&&present.some(a=>a.kind!=='metadata')&&present.every(a=>Number.isSafeInteger(a.size)&&a.size>=0),bytes=present.reduce((n,a)=>n+(a.size||0),0);return {bytes:Number.isSafeInteger(bytes)?bytes:0,known:known&&Number.isSafeInteger(bytes)};
}
export function compareLocalSizes(a,b,sort){if(a.known!==b.known)return a.known?-1:1;if(a.known&&a.bytes!==b.bytes)return sort==='size-desc'?b.bytes-a.bytes:a.bytes-b.bytes;return a.rank-b.rank;}
export function orderLocalWorks(works,sort){if(sort==='original')return works;return works.map((work,rank)=>({work,rank,...localSize(work)})).sort((a,b)=>compareLocalSizes(a,b,sort)).map(row=>row.work);}
