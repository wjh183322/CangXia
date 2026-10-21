// Only explicit removal or work-bound JSON evidence retires a work.
// A bare empty detail or a failed request stays uncertain.
export const sourceState=work=>work?.remoteState==='unavailable'?'unavailable':work?.sourceStatus?.state||'unchecked';
export const goneMessage=value=>{const text=String(value||'');return !/权限|私密|私享|好友可见|仅.*可见|登录|验证码|访问受限|暂时|可能|或者/.test(text)&&/作品已删除|视频已删除|作品不存在|视频不存在|作品已被删除|视频已被删除|作品已下架|视频已下架/.test(text);};
export function filteredSourceState(data,id){
 if(data?.aweme_detail||data?.data?.aweme_detail)return null;
 const envelope=data?.filter_detail?data:data?.data,filter=envelope?.filter_detail;
 const success=code=>code===0||code==='0';
 if(!success(envelope?.status_code??data?.status_code)||(data?.status_code!==undefined&&!success(data.status_code)))return null;
 if(data?.data?.status_code!==undefined&&!success(data.data.status_code))return null;
 // Supported responses have one filter envelope. Do not select one side of
 // a duplicated or contradictory wrapper to retire a download.
 if(data?.filter_detail&&data?.data?.filter_detail)return null;
 if(!filter||typeof filter.aweme_id!=='string'||filter.aweme_id!==id)return null;
 const message=String(filter.detail_msg||'').trim(),notice=String(filter.notice||'').trim();
 const statusMessages=[data?.status_msg,data?.message,data?.data?.status_msg,data?.data?.message].map(value=>String(value??'').trim()).filter(Boolean);
 if(/登录|验证|访问受限|频繁|稍后|可能|重试|异常|错误|失败|login|captcha|challenge|rate.?limit|too many|timeout|network|error|retry|try again/i.test([...statusMessages,message,notice].join(' ')))return null;
 // Supplied privacy responses prove inaccessibility for this account, not deletion.
 if(['author_secret','status_friend_see'].includes(filter.filter_reason)&&envelope.aweme_detail===null&&notice==='作品暂时无法查看'&&/^由于对方隐私设置[，,]\s*无法查看(?:[，,。]|$)/.test(message))return {state:'unavailable',reason:'隐私限制，当前账号无法查看此作品。平台提示：'+message};
 // This empty-text audit tuple is another supplied, work-bound real response.
 // It proves current inaccessibility, not deletion or a particular audit result.
 if(filter.filter_reason==='status_audit_self_see'&&envelope.aweme_detail===null&&!message&&!notice)return {state:'unavailable',reason:'原作品当前不可访问，平台未提供具体原因'};
 // The official web detail converter maps a successful missing detail to its
 // internal 404. Require the matching empty filter tuple observed in research;
 // a bare null, malformed response or access warning is not this evidence.
 if(filter.filter_reason===''&&envelope.aweme_detail===null&&!message&&!notice&&statusMessages.every(value=>/^(?:ok|success|成功|请求成功)$/i.test(value)))return {state:'unavailable',reason:'原作品当前不可访问，平台未提供作品详情'};
 // These tuples are grounded in supplied real responses. Do not infer deletion
 // from an undocumented filter code or a permission hint on its own.
 if(!['status_self_see','status_deleted'].includes(filter.filter_reason)||envelope.aweme_detail!==null||notice!=='抱歉，作品不见了'||!/^因作品权限或已被删除[，,]\s*无法观看(?:[，,。]|$)/.test(message))return null;
 return {state:'unavailable',reason:'权限限制或已删除，当前无法观看。平台提示：'+message};
}
export function detailSourceState(raw,id,parsed){
 if(!raw||String(raw.aweme_id??raw.awemeId??'')!==id)return {state:'unknown',reason:'接口未返回对应作品详情，暂无法确认原作品状态'};
 if(raw.is_delete===true||raw.is_delete===1||raw.status?.is_delete===true||raw.status?.is_delete===1)return {state:'unavailable',reason:'平台返回明确的作品删除标记'};
 if(raw.status?.is_private===true||raw.status?.is_private===1||raw.is_private===true||raw.is_private===1)return {state:'unknown',reason:'作品访问受限，暂无法确认原作品状态'};
 return parsed?.videoUrls?.length||parsed?.images?.some(i=>i.urls?.length)?{state:'available',reason:'平台返回对应作品详情和媒体资源'}:{state:'unknown',reason:'作品详情缺少可用媒体资源，暂无法确认原作品状态'};
}
export const sourceError=reason=>Object.assign(Error(reason||'原作品已失效，已停止自动下载与补齐'),{code:'SOURCE_UNAVAILABLE',sourceDeleted:true});
