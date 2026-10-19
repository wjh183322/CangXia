// Only explicit removal or work-bound unavailability evidence retires a work.
// Empty details and network errors stay uncertain.
export const sourceState=work=>work?.remoteState==='unavailable'?'unavailable':work?.sourceStatus?.state||'unchecked';
export const goneMessage=value=>{const text=String(value||'');return !/权限|私密|私享|好友可见|仅.*可见|登录|验证码|访问受限|暂时|可能|或者/.test(text)&&/作品已删除|视频已删除|作品不存在|视频不存在|作品已被删除|视频已被删除|作品已下架|视频已下架/.test(text);};
export function filteredSourceState(data,id){
 if(data?.aweme_detail||data?.data?.aweme_detail)return null;
 const envelope=data?.filter_detail?data:data?.data,filter=envelope?.filter_detail;
 const success=code=>code===0||code==='0';
 if(!success(envelope?.status_code??data?.status_code)||(data?.status_code!==undefined&&!success(data.status_code)))return null;
 if(!filter||typeof filter.aweme_id!=='string'||filter.aweme_id!==id)return null;
 const message=String(filter.detail_msg||'').trim(),notice=String(filter.notice||'').trim();
 const accessWarning=String(data?.status_msg||data?.message||data?.data?.status_msg||data?.data?.message||'');
 if(/登录|验证码|安全验证|访问受限|频繁|稍后|可能/.test(accessWarning+' '+message))return null;
 // This tuple is grounded in the supplied real response. Do not infer deletion
 // from an undocumented filter code or a permission hint on its own.
 if(filter.filter_reason!=='status_self_see'||notice!=='抱歉，作品不见了'||!/^因作品权限或已被删除[，,]\s*无法观看(?:[，,。]|$)/.test(message))return null;
 return {state:'unavailable',reason:'权限限制或已删除，当前无法观看。平台提示：'+message};
}
export function detailSourceState(raw,id,parsed){
 if(!raw||String(raw.aweme_id??raw.awemeId??'')!==id)return {state:'unknown',reason:'接口未返回对应作品详情，暂无法确认原作品状态'};
 if(raw.is_delete===true||raw.is_delete===1||raw.status?.is_delete===true||raw.status?.is_delete===1)return {state:'unavailable',reason:'平台返回明确的作品删除标记'};
 if(raw.status?.is_private===true||raw.status?.is_private===1||raw.is_private===true||raw.is_private===1)return {state:'unknown',reason:'作品访问受限，暂无法确认原作品状态'};
 return parsed?.videoUrls?.length||parsed?.images?.some(i=>i.urls?.length)?{state:'available',reason:'平台返回对应作品详情和媒体资源'}:{state:'unknown',reason:'作品详情缺少可用媒体资源，暂无法确认原作品状态'};
}
export const sourceError=reason=>Object.assign(Error(reason||'原作品已失效，已停止自动下载与补齐'),{code:'SOURCE_UNAVAILABLE',sourceDeleted:true});
