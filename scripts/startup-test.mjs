import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';
import {Store} from '../electron/store.mjs';
const require=createRequire(import.meta.url),base=fs.mkdtempSync(path.join(os.tmpdir(),'cangxia-startup-')),profile=path.join(base,'profile');
const s=await Store.open(path.join(profile,'library.sqlite'),path.join(base,'media'));s.db.run('BEGIN');const ids=[];for(let i=1;i<=20000;i++){const id=String(i);ids.push(id);s.upsertWork({aweme_id:id,desc:'启动测试 '+id,author:{uid:'1',nickname:'测试作者'}});}s.ingestMembers('__all__',ids,true);s.db.run('COMMIT');s.close();
const child=spawn(require('electron'),['tests/startup-desktop.mjs'],{stdio:'inherit',windowsHide:true,env:{...process.env,CANGXIA_LOCAL_TEST_PROFILE:profile}});
const code=await new Promise(resolve=>child.on('exit',resolve));
if(!code){const result=fs.readFileSync(path.join(profile,'startup-result.json'));fs.mkdirSync('.test-output',{recursive:true});fs.writeFileSync(path.join('.test-output','startup-'+(process.env.CANGXIA_STARTUP_LABEL||'current')+'.json'),result);}
assert.equal(path.dirname(base),os.tmpdir());assert.ok(path.basename(base).startsWith('cangxia-startup-'));fs.rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:200});if(code)process.exitCode=1;
