// Capability parameters observed on Douyin's normal web detail request. Without
// them the same successful response can omit cooperation_info entirely.
const creatorRoutes=new Set(['/aweme/v1/web/aweme/detail/','/aweme/v1/web/aweme/listcollection/','/aweme/v1/web/collects/video/list/','/aweme/v1/web/aweme/post/']);
export function webCreatorParams(route,params={}){
 return creatorRoutes.has(route)?{...params,update_version_code:'170400',pc_client_type:'1',version_code:'190500',version_name:'19.5.0'}:params;
}
