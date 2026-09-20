export const PROBE_VERSION='0.1.0';
export const ENDPOINT='/aweme/v1/web/aweme/listcollection/';
export const REQUEST_URL='https://www.douyin.com'+ENDPOINT+'?device_platform=webapp&aid=6383&channel=channel_pc_web';
export const FORM='cursor=0&count=10';
export const MAX_BYTES=2*1024*1024;
export const SIGNATURE_KEYS=['a_bogus','X-Bogus','_signature'];

export function signatureNames(url){
 try{const u=new URL(url);if(u.origin!=='https://www.douyin.com'||u.pathname!==ENDPOINT)return [];return SIGNATURE_KEYS.filter(key=>u.searchParams.has(key));}catch{return [];}
}

// Only aggregate response facts leave this module. No response content or IDs enter reports.
export function summarize({status=0,text='',durationMs=0,error=null,signatureKeys=[]}={}){
 const result={httpStatus:Number(status)||0,durationMs:Math.max(0,Math.round(durationMs)),signatureKeys:SIGNATURE_KEYS.filter(k=>signatureKeys.includes(k)),businessCode:null,items:null,hasMore:null,format:'unknown',outcome:'error'};
 if(error){result.error=['cancelled','timeout','too-large','redirect','network','page-changed'].includes(error)?error:'network';return result;}
 if(status===429){result.outcome='limited';return result;}
 let data;try{data=JSON.parse(text);result.format='json';}catch{result.format=/^\s*</.test(text)?'html':'other';}
 if(data&&typeof data==='object'){
  const code=data.status_code;
  if(typeof code==='number'&&Number.isFinite(code))result.businessCode=code;
  else if(typeof code==='string'&&/^-?\d{1,12}$/.test(code))result.businessCode=Number(code);
  const message=String(data.status_msg||data.message||data.data?.status_msg||data.data?.message||'');
  if(/访问太频繁|访问过于频繁|操作频繁|请求过于频繁|too many requests/i.test(message)){result.outcome='limited';return result;}
  const items=data.aweme_list??data.data?.aweme_list;
  if(Array.isArray(items))result.items=items.length;
  const more=data.has_more??data.data?.has_more;
  if([true,false,0,1,'0','1'].includes(more))result.hasMore=[true,1,'1'].includes(more);
 }
 if(status===401||status===403)result.outcome='denied';
 else if(status>=200&&status<300&&result.businessCode===0&&result.items!==null)result.outcome='success';
 else if(status>=300&&status<400)result.outcome='redirect';
 else if(result.businessCode!==null&&result.businessCode!==0)result.outcome='business-error';
 return result;
}

export function conclusion(results){
 const direct=results.find(r=>r.route==='direct'),page=results.find(r=>r.route==='page');
 if(results.some(r=>r.outcome==='limited'))return '检测到访问频率限制，已停止，未切换方式继续请求。请等待平台恢复后再手动测试。';
 if(direct?.outcome==='denied'&&page?.outcome==='success')return '已复现：直接请求被拒绝，浏览器页面请求成功。支持继续评估浏览器请求方式；这不能单独证明原因就是签名。';
 if(direct?.outcome==='success'&&page?.outcome==='success')return '本次两种方式都成功，未复现 403。请在曾出现问题的电脑上测试。';
 if(direct?.outcome==='success'&&page&&page.outcome!=='success')return '直接请求成功，浏览器页面请求未成功。目前没有证据支持替换原请求方式。';
 if(direct&&page)return '两种方式都未获得有效收藏列表。请保存报告，继续检查页面运行环境、会话和请求参数，不能直接认定是签名问题。';
 return '测试尚未完成。';
}

export async function limitedText(response,signal){
 const reader=response.body?.getReader();if(!reader)return '';
 const parts=[];let size=0;
 try{while(true){signal?.throwIfAborted();const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>MAX_BYTES)throw Object.assign(new Error('too-large'),{code:'too-large'});parts.push(chunk.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const out=new Uint8Array(size);let offset=0;for(const p of parts){out.set(p,offset);offset+=p.byteLength;}return new TextDecoder().decode(out);
}

// Executed in the already-loaded official page, so its own fetch wrappers may run.
// It does not call a signature algorithm, request another page, or submit any login form.
export function pageFetch({url,form,key,maxBytes,timeout}){
 if(location.origin!=='https://www.douyin.com')return Promise.resolve({error:'page-changed'});
 const control=new AbortController();window[key]=control;
 const timer=setTimeout(()=>control.abort('timeout'),timeout);
 return (async()=>{try{
  const response=await fetch(url,{method:'POST',credentials:'include',redirect:'error',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:form,signal:control.signal});
  const reader=response.body?.getReader();let text='';
  if(reader){const decoder=new TextDecoder();let size=0;try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>maxBytes)return {status:response.status,error:'too-large'};text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
  return {status:response.status,text};
 }catch{return {error:control.signal.aborted?(control.signal.reason==='timeout'?'timeout':'cancelled'):'network'};}
 finally{clearTimeout(timer);delete window[key];}})();
}
export function pageFetchScript(key,timeout=12000){return `(${pageFetch.toString()})(${JSON.stringify({url:REQUEST_URL,form:FORM,key,maxBytes:MAX_BYTES,timeout})})`;}

export async function compareOnce({direct,page,signal,delay,onResult=()=>{}}){
 const results=[];
 for(const [route,run] of [['direct',direct],['page',page]]){
  if(signal.aborted)break;
  const result={route,...await run()};results.push(result);onResult(result);
  if(result.outcome==='limited'||result.error==='cancelled'||signal.aborted)break;
  if(route==='direct')try{await delay(signal);}catch{break;}
 }
 return results;
}
