import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {Store} from '../electron/store.mjs';

const base=fs.mkdtempSync(path.join(os.tmpdir(),'cangxia-package-smoke-'));
const profile=path.join(base,'profile');
const store=await Store.open(path.join(profile,'library.sqlite'),path.join(base,'media'));store.close();
try{
  const proc=spawn(path.resolve('release/backup/win-unpacked/藏匣备份版.exe'),['--package-smoke'],{windowsHide:true,stdio:'inherit',env:{...process.env,CANGXIA_BACKUP_TEST_PROFILE:profile}});
  const code=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{proc.kill();reject(new Error('Packaged executable startup timed out'));},45000);
    proc.once('error',error=>{clearTimeout(timeout);reject(error);});
    proc.once('exit',code=>{clearTimeout(timeout);resolve(code);});
  });
  assert.equal(code,0,'Packaged executable exited successfully');
  const result=JSON.parse(fs.readFileSync(path.join(profile,'package-smoke.json'),'utf8'));
  assert.deepEqual(result,{ok:true,version:JSON.parse(fs.readFileSync('package.json','utf8')).version,packaged:true,preload:true});
  console.log('Actual packaged executable started with isolated empty profile:',result);
}finally{
  assert.equal(path.dirname(base),os.tmpdir());
  fs.rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
