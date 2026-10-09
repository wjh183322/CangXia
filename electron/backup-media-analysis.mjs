import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import {contentHash} from '../shared/backup-protocol.mjs';import {requireInside} from './model.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');let cached;
export async function analyzeMedia(db,message){
 const root=JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get('root')?.value||'null');
 const sequence=db.prepare("SELECT COALESCE(MAX(seq),0) value FROM backup_changes WHERE kind IN ('local_downloads','downloads')").get().value,epoch=db.prepare('SELECT value FROM backup_hash_epoch WHERE id=1').get().value;
 const key=[message.file,sequence,epoch,root,message.fileGeneration,!!message.watchAvailable].join('|');if(cached?.key===key&&!message.force&&Date.now()-cached.at<60000)return cached.result;
 const ids=new Set(),parts=[];let unknown=0;
 let rootAvailable=false;try{rootAvailable=(await fs.stat(root)).isDirectory();}catch{}
 const manifests=new Map(db.prepare('SELECT id,body FROM backup_downloads').all().map(r=>[r.id,JSON.parse(r.body)]));
 const states=new Map(db.prepare('SELECT id,body FROM file_states').all().map(r=>[r.id,JSON.parse(r.body)]));
 for(const row of db.prepare('SELECT id,body FROM downloads').iterate()){
  const d=JSON.parse(row.body),remote=manifests.get(d.id),state=states.get(d.id),current=state?.signature===hash(row.body)&&state.root===root;let uncertain=!rootAvailable;
  if(remote?.backupDeleted)continue;
  let available=false;for(const a of d.assets||[]){if(a.kind==='metadata')continue;let stamp,exists=false,file;
   try{file=requireInside(root,path.join(d.path,a.file));if(!rootAvailable){parts.push([d.id,a.key,'unknown']);continue;}const known=current?state.assets[a.key]:null;
    if(known&&message.watchAvailable&&Date.now()-state.checkedAt<300000){stamp=known.stamp;exists=known.exists;uncertain||=known.state==='unknown';}
    else{const stat=await fs.lstat(file);stamp=[stat.size,stat.mtimeMs,stat.ctimeMs];exists=stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&(!a.size||stat.size===a.size);}
   }catch(e){uncertain||=e.code!=='ENOENT';}
   parts.push(stamp?[d.id,a.key,file,...stamp]:[d.id,a.key,uncertain?'unknown':'missing']);
   if(exists){available=true;const proof=db.prepare('SELECT stamp,sha FROM backup_file_hashes WHERE file=?').get(file),asset=remote?.assets?.find(v=>v.key===a.key);if(!proof||proof.stamp!==stamp?.join(':')||!asset||proof.sha!==asset.sha256)ids.add(d.id);}
  }
  if(available&&remote){const source=d.collectionId||'__all__',home=d.home||{kind:source.startsWith('author:')?'author':'collection',id:source.startsWith('author:')?source.slice(7):source,folder:path.relative(root,path.dirname(d.path)).split(path.sep).join('/'),workFolder:path.basename(d.path)};const desired={...d,collectionId:source,home};if(['home','collectionId','hdCover','coverSource','savedAt'].some(field=>JSON.stringify(desired[field])!==JSON.stringify(remote[field])))ids.add(d.id);}
  if(uncertain)unknown++;
 }
 const result={ids:[...ids],signature:contentHash(parts),unknown};cached={key,at:Date.now(),result};return result;
}
