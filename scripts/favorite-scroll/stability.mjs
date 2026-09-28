export class ScrollStability{
  constructor(){this.crashed=false;this.epoch=0;this.crashes=[];this.samples=[];}
  crash({status,errorCode}={}){this.crashed=true;this.epoch++;const event={at:new Date().toISOString(),status:String(status||'renderer-crashed').slice(0,60),errorCode:Number.isFinite(errorCode)?errorCode:null};this.crashes.push(event);return event;}
  navigate(){this.crashed=false;this.epoch++;}
  sample({usedSize,totalSize,nodes,freeBytes,rssBytes,works}){const s={at:new Date().toISOString(),heapMiB:Math.round((usedSize||0)/1048576),heapTotalMiB:Math.round((totalSize||0)/1048576),nodes:Number(nodes)||0,freeMiB:Math.round((freeBytes||0)/1048576),recorderMiB:Math.round((rssBytes||0)/1048576),works:Number(works)||0};this.samples.push(s);if(this.samples.length>120)this.samples.shift();return s;}
}
