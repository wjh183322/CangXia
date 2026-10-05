import path from 'node:path';import {validHome} from '../shared/backup-protocol.mjs';import {requireInside} from './model.mjs';
export function importDestination(store,source,record){
 if(!record.home&&!record.collectionId?.startsWith('author:'))return store.destination(record.id);
 const id=record.collectionId,home=record.home||{kind:'author',id:id.slice(7),folder:path.relative(source.root,path.dirname(record.path)).split(path.sep).join('/'),workFolder:path.basename(record.path)};
 if(!validHome(home)||(home.kind==='author'&&!store.authorSources.get(home.id)))throw Error('来源的作者目录归属不完整，未复制文件');
 const dir=requireInside(store.root,path.join(store.root,home.folder,home.workFolder));store.assertDirectory(dir);if(dir.length>235)throw Error('导入路径过长，请选择较短的本机下载目录');return {dir,collectionId:(home.kind==='author'?'author:':'')+home.id,home};
}
