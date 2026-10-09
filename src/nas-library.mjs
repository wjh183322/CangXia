const TOTAL='__all__';
export function nasLibrary(data){
 const all=data.works.filter(w=>w.backedUp&&w.backupRecord?.assets?.length),byId=new Map(all.map(w=>[w.id,w]));
 const collectionInfo=new Map((data.collections||[]).map(c=>[c.id,c]));
 const authorInfo=new Map([...(data.authors||[]),...(data.backupAuthors||[])].map(a=>[a.id,a]));
 const collectionIds=new Map(),authorIds=new Map(),collectionAll=new Set(),authorAll=new Set();
 const add=(map,group,id,union)=>{if(!byId.has(id))return;if(!map.has(group))map.set(group,new Set());map.get(group).add(id);union.add(id);};
 // Relations survive removed folders and hidden/archived authors. Creator names
 // alone do not mean a work was read through the author feature.
 for(const [id,works]of Object.entries(data.localMembers||data.members||{}))for(const wid of works)add(collectionIds,id,wid,collectionAll);
 for(const field of ['backupAuthorMembers','authorMembers'])for(const [id,works]of Object.entries(data[field]||{}))for(const wid of works)add(authorIds,id,wid,authorAll);
 for(const w of all){const d=w.backupRecord,home=d.home;const source=home?.kind==='author'?'author:'+home.id:home?.kind==='collection'?home.id:d.collectionId;
  if(source?.startsWith('author:')){const id=source.slice(7);add(authorIds,id,w.id,authorAll);if(!authorInfo.has(id))authorInfo.set(id,{id,name:w.author?.nickname||'已移除作者',archived:true});}
  else if(source){add(collectionIds,source,w.id,collectionAll);if(!collectionInfo.has(source))collectionInfo.set(source,{id:source,name:home?.folder||'已移除收藏夹',remoteMissing:true});}
  // Legacy collection backups predate saved directory/source metadata.
  else if(!authorAll.has(w.id))add(collectionIds,TOTAL,w.id,collectionAll);
 }
 const collections=[...collectionIds].filter(([id])=>id!==TOTAL).map(([id,ids])=>{const c=collectionInfo.get(id);return {id,name:c?.name||'已移除收藏夹',removed:!c||!!c.remoteMissing,count:ids.size,ids:[...ids],rank:c?.rank??Infinity};}).sort((a,b)=>Number(a.removed)-Number(b.removed)||a.rank-b.rank||a.name.localeCompare(b.name,'zh-CN')||a.id.localeCompare(b.id));
 const authors=[...authorIds].map(([id,ids])=>{const a=authorInfo.get(id),work=byId.get(ids.values().next().value);return {id,name:a?.name||work?.author?.nickname||'已移除作者',uniqueId:a?.uniqueId||'',removed:!a||!!a.archived,count:ids.size,ids:[...ids]};}).sort((a,b)=>Number(a.removed)-Number(b.removed)||a.name.localeCompare(b.name,'zh-CN')||a.id.localeCompare(b.id));
 const ordered=[],seen=new Set();for(const id of [...(data.localMembers||data.members||{})[TOTAL]||[],...all.map(w=>w.id)])if(byId.has(id)&&!seen.has(id)){ordered.push(byId.get(id));seen.add(id);}
 const objects=new Map();for(const w of all)for(const asset of [...w.backupRecord.assets,w.backupCover].filter(Boolean))if(asset.sha256&&!objects.has(asset.sha256))objects.set(asset.sha256,asset.size||0);
 return {all:ordered,byId,collections,authors,collectionAll,authorAll,counts:{all:all.length,collection:collectionAll.size,author:authorAll.size},bytes:data.nasOverview?.bytes??[...objects.values()].reduce((n,size)=>n+size,0)};
}
export function nasWorks(library,tab,{collection='',author=''}={}){
 let ids;if(tab==='author')ids=author?new Set(library.authors.find(a=>a.id===author)?.ids||[]):library.authorAll;
 else if(tab==='collection'||collection)ids=collection&&collection!==TOTAL?new Set(library.collections.find(c=>c.id===collection)?.ids||[]):library.collectionAll;
 if(tab==='author'&&author)return [...ids].map(id=>library.byId.get(id)).filter(Boolean);
 return ids?library.all.filter(w=>ids.has(w.id)):library.all;
}
