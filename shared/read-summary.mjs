const count=value=>Number.isFinite(value)&&value>=0?value:0;

// Version 1 included previously known returns in `filled` and excluded them
// from `existing`. Preserve the stored evidence; normalize only the summary.
export function normalizeReadSummary(summary){
 const next={...summary};
 const checked=count(next.checked??next.count),added=Number.isFinite(next.added)?count(next.added):null,returned=count(next.reappeared);
 next.checked=checked;
 if(next.countsVersion!==2){
  next.frontAdded=Number.isFinite(next.frontAdded)?next.frontAdded:null;
  next.filled=Number.isFinite(next.filled)?Math.max(0,next.filled-returned):null;
  next.added=added;
  next.existing=added===null?null:Math.max(0,checked-added);
  next.countsVersion=2;
 }
 if(typeof next.message==='string')next.message=next.message.replaceAll('本轮取得','本轮读取').replace(/补齐记录\s*\d+\s*条/g,`本轮补齐 ${count(next.filled)} 条`);
 return next;
}
