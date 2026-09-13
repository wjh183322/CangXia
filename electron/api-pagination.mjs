export function pageResult(data,key){
  const body=data?.data && typeof data.data==='object'&&!Array.isArray(data.data)?data.data:data;
  const items=body?.[key]??(key==='collects_list'?body?.collects:undefined);
  if(!Array.isArray(items))throw new Error('抖音未返回预期列表，可能需要重新连接登录，已有数据已保留');
  const flag=body.has_more??data.has_more;
  const next=body.cursor??body.max_cursor??data.cursor??data.max_cursor;
  const complete=flag===0||flag===false;
  return {items,next:next===undefined?null:String(next),complete,unknown:flag===undefined};
}
export function normalizeCollections(items){return items.map(item=>({...item,collects_id:String(item.collects_id_str||item.collects_id||item.id||''),collects_name:String(item.collects_name||item.name||item.title||'未命名收藏夹')})).filter(c=>/^\d+$/.test(c.collects_id));}
export async function paginate(fetchPage,onPage,{signal,delay=()=>Promise.resolve(),limit=10000}={}){
  const seen=new Set();const items=[];let cursor='0';
  for(let page=0;page<limit;page++){
    if(signal?.aborted)throw new Error('读取已停止');
    if(seen.has(cursor))throw new Error('分页游标重复，读取未完成，已有数据已保留');seen.add(cursor);
    const result=await fetchPage(cursor);items.push(...result.items);await onPage(items,result.complete);
    if(result.complete)return {items,complete:true};
    if(result.next===null||result.next===cursor||!result.items.length)return {items,complete:false};
    cursor=result.next;await delay();
  }
  return {items,complete:false};
}
