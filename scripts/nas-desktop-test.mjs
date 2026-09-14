import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';
import {Store} from '../electron/store.mjs';
const require=createRequire(import.meta.url),base=fs.mkdtempSync(path.join(os.tmpdir(),'cangxia-native-'));
const store=await Store.open(path.join(base,'profile','library.sqlite'),path.join(base,'original'));
store.upsertWork({aweme_id:'123',desc:'NAS 桌面测试',author:{nickname:'测试作者'},video:{play_addr:{url_list:[]}}});
const dir=store.destination('123').dir;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'video.mp4'),'test-content');
store.put('downloads','123',{id:'123',path:dir,collectionId:'__all__',state:'partial',assets:[{key:'video',file:'video.mp4',kind:'video',size:12}]});store.close();
fs.mkdirSync('.test-output',{recursive:true});fs.rmSync('.test-output/nas-desktop-result.json',{force:true});
const proc=spawn(require('electron'),['tests/nas-desktop.mjs'],{stdio:'inherit',windowsHide:true,env:{...process.env,CANGXIA_NAS_TEST_PROFILE:base}});
const code=await new Promise(resolve=>proc.on('exit',resolve));
let result;try{result=JSON.parse(fs.readFileSync('.test-output/nas-desktop-result.json','utf8'));}catch{}
assert.equal(path.dirname(base),os.tmpdir());assert.ok(path.basename(base).startsWith('cangxia-native-'));fs.rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:200});
if(code!==0||!result?.ok)process.exitCode=1;
