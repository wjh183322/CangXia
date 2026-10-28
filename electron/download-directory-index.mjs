import path from 'node:path';

export const directoryKey=file=>path.resolve(file).toLowerCase();
export function buildDirectoryIndex(rows){
 const index=new Map();
 for(const row of rows){if(typeof row.path!=='string'||!row.path)continue;const key=directoryKey(row.path);if(!index.has(key))index.set(key,new Set());index.get(key).add(String(row.id));}
 return index;
}
export class DirectoryReservations{
 constructor(index=new Map()){this.index=new Map([...index].map(([key,ids])=>[key,new Set(ids)]));this.reserved=new Map();this.paths=new Map();for(const [key,ids]of this.index)for(const id of ids)this.paths.set(id,key);}
 owners(file){const key=directoryKey(file);return new Set([...(this.index.get(key)||[]),...(this.reserved.get(key)||[])]);}
 reserve(file,id){const key=directoryKey(file);if(!this.reserved.has(key))this.reserved.set(key,new Set());this.reserved.get(key).add(String(id));}
 release(id){id=String(id);for(const [key,ids]of this.reserved){ids.delete(id);if(!ids.size)this.reserved.delete(key);}}
 update({id,oldPath,path:file}){id=String(id);const previous=this.paths.get(id)||(oldPath?directoryKey(oldPath):null);if(previous){this.index.get(previous)?.delete(id);if(!this.index.get(previous)?.size)this.index.delete(previous);}this.paths.delete(id);if(file){const key=directoryKey(file);if(!this.index.has(key))this.index.set(key,new Set());this.index.get(key).add(id);this.paths.set(id,key);}}
}
