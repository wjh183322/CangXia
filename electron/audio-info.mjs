import fs from 'node:fs/promises';
const fail=()=>{throw Error('未取得完整、可识别的纯音频，已有图片保留');};
// Bounded structural validation. Browser metadata is used for the final playback
// clock; encoded durations can include padding. Never trust filename or MIME.
export async function audioInfo(file,signal){
 const f=await fs.open(file,'r');try{const stat=await f.stat();if(!stat.isFile()||stat.size<12||stat.size>256*1024*1024)fail();
 const read=async(at,n)=>{signal?.throwIfAborted();const b=Buffer.alloc(n),{bytesRead}=await f.read(b,0,n,at);if(bytesRead!==n)fail();return b;};
 const head=await read(0,12);
 if(head.subarray(4,8).toString()==='ftyp'){
  let duration=0,audio=0,video=0;
  const walk=async(start,end,depth=0)=>{if(depth>8)fail();let at=start;while(at<end){if(end-at<8)fail();const h=await read(at,Math.min(16,end-at));let size=h.readUInt32BE(),header=8;const type=h.subarray(4,8).toString();if(size===1){if(h.length<16)fail();const large=h.readBigUInt64BE(8);if(large>BigInt(Number.MAX_SAFE_INTEGER))fail();size=Number(large);header=16;}if(size===0)size=end-at;if(size<header||at+size>end)fail();const begin=at+header;
   if(['moov','trak','mdia','minf','stbl'].includes(type))await walk(begin,at+size,depth+1);
   if(type==='hdlr'){if(size<header+12)fail();const v=await read(begin,12),handler=v.subarray(8,12).toString();if(handler==='soun')audio++;if(handler==='vide')video++;}
   if(type==='mdhd'){const v=await read(begin,Math.min(36,size-header));let scale,ticks;if(v[0]===1){if(v.length<32)fail();scale=v.readUInt32BE(20);ticks=Number(v.readBigUInt64BE(24));}else{if(v.length<20)fail();scale=v.readUInt32BE(12);ticks=v.readUInt32BE(16);}if(scale>0&&Number.isFinite(ticks))duration=Math.max(duration,ticks/scale);}
   at+=size;
  }};await walk(0,stat.size);if(!audio||video||!duration)fail();return {format:'m4a',duration};
 }
 if(head.subarray(0,4).toString()==='RIFF'&&head.subarray(8,12).toString()==='WAVE'){
  if(head.readUInt32LE(4)+8>stat.size)fail();let at=12,rate=0,bytes=0;while(at+8<=stat.size){const h=await read(at,8),size=h.readUInt32LE(4),type=h.subarray(0,4).toString();if(at+8+size>stat.size)fail();if(type==='fmt '){const b=await read(at+8,Math.min(size,16));if(b.length<16)fail();rate=b.readUInt32LE(8);}if(type==='data')bytes+=size;at+=8+size+(size%2);}if(!rate||!bytes)fail();return {format:'wav',duration:bytes/rate};
 }
 let at=0;if(head.subarray(0,3).toString()==='ID3'){if([...head.subarray(6,10)].some(x=>x>127))fail();at=10+head[6]*2097152+head[7]*16384+head[8]*128+head[9]+(head[5]&16?10:0);if(at>=stat.size)fail();}
 let frames=0,duration=0,format;
 const rates=[44100,48000,32000],bitrates=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320],lowRates=[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
 while(at+4<=stat.size){const b=await read(at,Math.min(7,stat.size-at));
  if(stat.size-at===128&&b.subarray(0,3).toString()==='TAG'){at=stat.size;break;}
  const word=b.readUInt32BE();let length,samples,rate;
  if((word>>>21)===0x7ff){const version=(word>>>19)&3,layer=(word>>>17)&3,bi=(word>>>12)&15,ri=(word>>>10)&3;if(version===1||layer!==1||!bi||bi===15||ri===3)fail();rate=rates[ri]/(version===3?1:version===2?2:4);const bit=(version===3?bitrates:lowRates)[bi]*1000;length=Math.floor((version===3?144:72)*bit/rate)+((word>>>9)&1);samples=version===3?1152:576;format='mp3';}
  else if(b.length>=7&&b[0]===255&&(b[1]&0xf6)===0xf0){const ri=(b[2]>>>2)&15;rate=[96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350][ri];length=((b[3]&3)<<11)|(b[4]<<3)|(b[5]>>>5);samples=1024*(1+(b[6]&3));if(!rate||length<7)fail();format='aac';}
  else fail();
  if(length<4||at+length>stat.size)fail();duration+=samples/rate;frames++;at+=length;
  if(frames%500===0)await new Promise(resolve=>setImmediate(resolve));
 }
 if(at!==stat.size||frames<3||!duration)fail();return {format,duration};
 }finally{await f.close();}
}
