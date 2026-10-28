import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';
import {checkStorageSizeDesktop} from './storage-size-desktop-checks.mjs';
test('desktop storage refresh waits for an enabled renderer control after the IPC result arrives',async()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'cangxia-backup-desktop-')),root=path.join(base,'media'),old=process.env.CANGXIA_BACKUP_TEST_PROFILE;process.env.CANGXIA_BACKUP_TEST_PROFILE=path.join(base,'profile');let timer,scan={root,running:false,phase:'idle',result:null},clicks=0,premature=0;
 const refresh=()=>{const folder=path.join(root,'.owned-directory-size-fixture');scan={root,running:false,phase:'done',result:{root,bytes:fs.statSync(path.join(folder,'临时.part')).size+16,files:4,scannedAt:new Date().toISOString()}};return structuredClone(scan);};
 const button={disabled:true,click(){if(this.disabled){premature++;return;}clicks++;refresh();}};
 const call=async name=>{if(name==='state')return {root,contentRevision:0,works:[],storage:{writable:false,pending:false,directorySize:structuredClone(scan)}};if(name==='refreshStorageSize'){const result=refresh();timer=setTimeout(()=>button.disabled=false,150);return result;}if(name==='cancelStorageSize')return true;throw Error('unexpected '+name);};
 const win={webContents:{executeJavaScript:async code=>vm.runInNewContext(code,{document:{querySelector:()=>button}})}},checks=[];
 try{await checkStorageSizeDesktop({win,call,check:(name,value)=>{assert.ok(value,name);checks.push(name);}});assert.equal(premature,0);assert.equal(clicks,1);assert.equal(checks.length,3);}
 finally{clearTimeout(timer);if(old===undefined)delete process.env.CANGXIA_BACKUP_TEST_PROFILE;else process.env.CANGXIA_BACKUP_TEST_PROFILE=old;assert.equal(path.dirname(base),os.tmpdir());assert.ok(path.basename(base).startsWith('cangxia-backup-desktop-'));fs.rmSync(base,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
