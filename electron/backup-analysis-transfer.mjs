// Transfer bounded JSON packets and wait for consumption before sending more.
// A full library can exceed V8's maximum string length even though every row is small.
export async function sendAnalysisResult(port,id,result,{maxBytes=1024*1024}={}){
 let sequence=0;
 async function send(packet){
  const payload=new TextEncoder().encode(packet),current=++sequence;
  await new Promise(resolve=>{
   const acknowledge=message=>{if(message.ack===id&&message.sequence===current){port.off('message',acknowledge);resolve();}};
   port.on('message',acknowledge);port.postMessage({id,sequence:current,payload},[payload.buffer]);
  });
 }
 for(const [field,value] of Object.entries(result)){
  const kind=Array.isArray(value)?'array':value&&typeof value==='object'?'object':'value';
  if(kind==='value'){await send(JSON.stringify({field,kind,value}));continue;}
  const source=kind==='array'?value:Object.entries(value);let parts=[],bytes=0;
  const flush=async()=>{await send('{"field":'+JSON.stringify(field)+',"kind":'+JSON.stringify(kind)+',"values":['+parts.join(',')+']}');parts=[];bytes=0;};
  for(const item of source){const part=JSON.stringify(item),size=Buffer.byteLength(part)+1;if(parts.length&&bytes+size>maxBytes)await flush();parts.push(part);bytes+=size;}
  await flush();
 }
 port.postMessage({id,done:true});
}

export function receiveAnalysisPart(result,payload){
 const part=JSON.parse(new TextDecoder().decode(payload));
 if(part.kind==='value')result[part.field]=part.value;
 else if(part.kind==='array'){const target=result[part.field]||=[];for(const value of part.values)target.push(value);}
 else{const target=result[part.field]||={};for(const [key,value] of part.values)Object.defineProperty(target,key,{value,writable:true,enumerable:true,configurable:true});}
}
