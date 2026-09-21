import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),base=fs.mkdtempSync(path.join(os.tmpdir(),'cangxia-request-probe-'));
fs.mkdirSync('.test-output',{recursive:true});fs.rmSync('.test-output/request-probe-desktop-result.json',{force:true});
const child=spawn(require('electron'),['tests/request-probe-desktop.mjs'],{windowsHide:true,stdio:'inherit',env:{...process.env,CANGXIA_PROBE_TEST_PROFILE:path.join(base,'profile')}});
const code=await new Promise(resolve=>child.on('exit',resolve));let result;try{result=JSON.parse(fs.readFileSync('.test-output/request-probe-desktop-result.json','utf8'));}catch{}
assert.equal(path.dirname(base),os.tmpdir());assert.ok(path.basename(base).startsWith('cangxia-request-probe-'));fs.rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:300});if(code!==0||!result?.ok)process.exitCode=1;
