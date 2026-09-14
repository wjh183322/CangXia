import fs from 'node:fs/promises';
import path from 'node:path';

// Cover reads are allowed on a read-only client and never create download records.
export class BackupCovers {
  constructor(client){this.client=client;this.pending=new Map();this.active=0;this.waiters=[];this.controller=new AbortController();}
  async slot(action){
    if(this.active<3)this.active++;else await new Promise(resolve=>this.waiters.push(resolve));
    try{return await action();}finally{const next=this.waiters.shift();if(next)next();else this.active--;}
  }
  async get(id){
    const assets=this.client.store.get('backup_downloads',id)?.assets||[];
    const candidates=[assets.find(a=>a.key==='cover'),assets.find(a=>a.key==='image-0'),...assets.filter(a=>a.kind==='image')];
    const asset=candidates.find(a=>a?.kind==='image'&&/^[a-f0-9]{64}$/.test(a.sha256)&&Number.isSafeInteger(a.size)&&a.size>0&&a.size<=20*1024*1024);
    if(!asset)return null;
    const extension=path.extname(asset.file||'').toLowerCase();
    const suffix=['.jpg','.jpeg','.png','.webp','.gif','.avif'].includes(extension)?extension:'.img';
    const directory=path.join(this.client.profile,'covers','backup');
    const file=path.join(directory,asset.sha256+suffix);
    try{if((await fs.stat(file)).size===asset.size)return file;}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!this.client.status.connected||!this.client.transport)return null;
    if(!this.pending.has(file))this.pending.set(file,this.slot(async()=>{
      this.controller.signal.throwIfAborted();
      if(!this.client.status.connected||!this.client.transport)return null;
      await fs.mkdir(directory,{recursive:true});
      await this.client.transport.download(asset,file,{signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(60000)])});
      return file;
    }).finally(()=>this.pending.delete(file)));
    return this.pending.get(file);
  }
  async close(){this.controller.abort();await Promise.allSettled([...this.pending.values()]);}
}
