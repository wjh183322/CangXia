import fs from 'node:fs/promises';
import path from 'node:path';
export function absolutePath(value){
  if(typeof value!=='string'||value.length>30000||value.includes('\0')||!path.isAbsolute(value))throw new Error('请输入完整的文件夹路径');
  return path.resolve(value);
}
export async function listDirectory(value,mode='directory'){
  if(!['directory','json'].includes(mode))throw new Error('文件选择类型无效');
  if(!value){
    const roots=process.platform==='win32'?Array.from({length:26},(_,i)=>String.fromCharCode(65+i)+':\\'):['/'];
    const entries=(await Promise.all(roots.map(async p=>{try{await fs.access(p);return {name:p,path:p,directory:true};}catch{return null;}}))).filter(Boolean);
    return {path:'',parent:null,entries};
  }
  const dir=absolutePath(value);const list=await fs.readdir(dir,{withFileTypes:true});
  const entries=list.filter(e=>!e.isSymbolicLink()&&(e.isDirectory()||(mode==='json'&&e.isFile()&&e.name.toLowerCase().endsWith('.json')))).map(e=>({name:e.name,path:path.join(dir,e.name),directory:e.isDirectory()}));
  entries.sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
  let next=0;await Promise.all(Array.from({length:Math.min(12,entries.length)},async()=>{while(next<entries.length){const entry=entries[next++];try{entry.modified=(await fs.stat(entry.path)).mtime.toISOString();}catch{entry.modified=null;}}}));
  return {path:dir,parent:path.dirname(dir)===dir?'':path.dirname(dir),entries};
}
export async function makeDirectory(parent,name){
  const dir=absolutePath(parent);
  if(typeof name!=='string'||!name.trim()||name.length>100||/[<>:"/\\|?*\x00-\x1f]/.test(name)||/[. ]$/.test(name)||name==='.'||name==='..'||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))throw new Error('文件夹名称无效');
  const target=path.join(dir,name);await fs.mkdir(target);return target;
}
