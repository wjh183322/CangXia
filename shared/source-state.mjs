// Only explicit removal evidence retires a work. Empty details and network errors stay uncertain.
export const sourceState=work=>work?.remoteState==='unavailable'?'unavailable':work?.sourceStatus?.state||'unchecked';
export const goneMessage=value=>{const text=String(value||'');return !/权限|私密|私享|好友可见|仅.*可见|登录|验证码|访问受限|暂时|可能|或者/.test(text)&&/作品已删除|视频已删除|作品不存在|视频不存在|作品已被删除|视频已被删除|作品已下架|视频已下架/.test(text);};
export function detailSourceState(raw,id,parsed){
 if(!raw||String(raw.aweme_id??raw.awemeId??'')!==id)return {state:'unknown',reason:'接口未返回对应作品详情，暂无法确认原作品状态'};
 if(raw.is_delete===true||raw.is_delete===1||raw.status?.is_delete===true||raw.status?.is_delete===1)return {state:'unavailable',reason:'平台返回明确的作品删除标记'};
 if(raw.status?.is_private===true||raw.status?.is_private===1||raw.is_private===true||raw.is_private===1)return {state:'unknown',reason:'作品访问受限，暂无法确认原作品状态'};
 return parsed?.videoUrls?.length||parsed?.images?.some(i=>i.urls?.length)?{state:'available',reason:'平台返回对应作品详情和媒体资源'}:{state:'unknown',reason:'作品详情缺少可用媒体资源，暂无法确认原作品状态'};
}
export const sourceError=reason=>Object.assign(Error(reason||'原作品已失效，已停止自动下载与补齐'),{code:'SOURCE_UNAVAILABLE',sourceDeleted:true});
