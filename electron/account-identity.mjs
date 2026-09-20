import {parsePlatformJSON} from './model.mjs';
import {pageResult,normalizeCollections} from './api-pagination.mjs';

export function validAccountIdentity(value){return !!value&&typeof value.uid==='string'&&/^\d{1,30}$/.test(value.uid)&&value.uid!=='0';}

// Only the authenticated self endpoint identifies the signed-in account.
// A rotating Cookie value or the author of a displayed work is not an account ID.
export async function verifyAccountIdentity(profile,userAgent,{legacyCollections=[],signal}={}){
  const read=async(route,params={})=>{
    const url=new URL(route,'https://www.douyin.com');
    for(const [key,value]of Object.entries({device_platform:'webapp',aid:'6383',channel:'channel_pc_web',...params}))url.searchParams.set(key,String(value));
    signal?.throwIfAborted();
    const response=await profile.fetch(url.href,{redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000),headers:{Referer:'https://www.douyin.com/user/self','User-Agent':userAgent,Accept:'application/json'}});
    if(!response.ok)throw new Error('暂时无法核实抖音账号，请在登录窗口完成验证后重试');
    const text=await response.text();if(text.length>4*1024*1024)throw new Error('账号验证响应过大');
    let data;try{data=parsePlatformJSON(text);}catch{throw new Error('抖音未返回账号验证信息，请稍后重试');}
    if(Number(data.status_code??data.data?.status_code??0)!==0)throw new Error('抖音暂未确认登录状态，请在登录窗口完成验证');return data;
  };
  const data=await read('/aweme/v1/web/user/profile/self/');const user=data.user??data.data?.user;
  const identity={uid:String(user?.uid_str??user?.uid??''),nickname:typeof user?.nickname==='string'?user.nickname.slice(0,100):''};
  if(!validAccountIdentity(identity))throw new Error('未取得当前登录账号的稳定标识，请完成抖音登录验证');
  if(!legacyCollections.length)return identity;
  const expected=new Set(legacyCollections),seen=new Set();let cursor='0';
  for(let page=0;page<20;page++){
    if(seen.has(cursor))break;seen.add(cursor);
    const result=pageResult(await read('/aweme/v1/web/collects/list/',{count:30,cursor}),'collects_list');
    if(normalizeCollections(result.items).some(c=>expected.has(c.collects_id)))return {...identity,ownsLegacyCollection:true};
    if(result.complete||!result.items.length||result.next===null)break;
    cursor=result.next;await new Promise(resolve=>setTimeout(resolve,1100));
  }
  return {...identity,ownsLegacyCollection:false};
}
