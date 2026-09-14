import fs from 'node:fs';
import path from 'node:path';
import {requireInside} from './model.mjs';
export function inspectWorkFiles(store,id){
  const w=store.work(id),d=store.download(id);
  if(!w)return {id,status:'error',name:id,error:'作品信息不存在',missing:[]};
  const result={id,name:w.name,status:'complete',missing:[],error:''};
  const expected=w.type==='video'?[['video','视频'],['cover','高清单图']]:w.images.map(im=>[`image-${im.index}`,`图片 ${im.index+1}`]);
  expected.push(['metadata','作品信息']);
  try {
    // ENOENT on the volume/share must not be confused with a deleted media file.
    fs.statSync(path.parse(path.resolve(store.root)).root);
    if(d)store.assertDirectory(d.path);
    if(w.type==='images'&&!w.images.length)throw new Error('缺少原始图片数量，无法判断完整性');
    for(const [key,label] of expected){
      const asset=d?.assets?.find(a=>a.key===key);
      if(!asset){result.missing.push({key,label,reason:'尚未保存'});continue;}
      const file=requireInside(d.path,path.join(d.path,asset.file));
      let stat;try{stat=fs.lstatSync(file);}catch(e){if(e.code==='ENOENT'){result.missing.push({key,label,reason:'文件不存在'});continue;}throw e;}
      if(stat.isSymbolicLink())throw new Error('文件是链接，无法安全检查');
      if(!stat.isFile()||stat.size===0||(asset.size&&asset.size!==stat.size))result.missing.push({key,label,reason:'文件大小异常'});
    }
    if(result.missing.length)result.status='missing';
  }catch(e){result.status='error';result.error=e.message;}
  return result;
}
export function inspectRepairs(store,ids){
  const items=[...new Set(ids)].map(id=>inspectWorkFiles(store,id));
  return {items,complete:items.filter(i=>i.status==='complete').length,missing:items.filter(i=>i.status==='missing').length,errors:items.filter(i=>i.status==='error').length};
}
