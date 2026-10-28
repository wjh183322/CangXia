import {setImmediate as yieldLoop} from 'node:timers/promises';
import {compareLocalSizes} from '../shared/local-size.mjs';
export async function orderSizeEntries(entries,sort,{signal}={}){
 signal?.throwIfAborted();
 let from=entries.slice(),to=new Array(from.length),operations=0;
 for(let width=1;width<from.length;width*=2){for(let start=0;start<from.length;start+=width*2){const middle=Math.min(start+width,from.length),end=Math.min(start+width*2,from.length);let a=start,b=middle;for(let at=start;at<end;at++){to[at]=a<middle&&(b>=end||compareLocalSizes(from[a],from[b],sort)<=0)?from[a++]:from[b++];if(++operations%2048===0){signal?.throwIfAborted();await yieldLoop();signal?.throwIfAborted();}}}[from,to]=[to,from];}
 signal?.throwIfAborted();
 return from.map(row=>row.id);
}
