import fs from 'node:fs/promises';
import path from 'node:path';
import {requireInside} from './model.mjs';

// Only absence is deletion evidence. Damaged, inaccessible and untracked files stay.
export async function findDeletedDownloads(records,{probe,validate}){
 await probe();const deleted=[];
 for(const d of records){
  if(!d.assets?.length)continue;
  try{
   await validate(d.path);let absent=true;
   for(const a of d.assets){const file=requireInside(d.path,path.join(d.path,a.file));try{await fs.lstat(file);absent=false;break;}catch(e){if(e.code!=='ENOENT')throw e;}}
   if(!absent)continue;
   try{if((await fs.readdir(d.path)).length)continue;}catch(e){if(e.code!=='ENOENT')throw e;}
   deleted.push(d.id);
  }catch{/* Unavailable paths are deliberately retained. */}
 }
 await probe();return deleted;
}
