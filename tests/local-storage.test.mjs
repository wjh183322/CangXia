import test from 'node:test';import assert from 'node:assert/strict';
import path from 'node:path';import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';import {promisify} from 'node:util';

test('Windows local storage verification gives cold PowerShell a bounded startup budget without accepting network drives',{skip:process.platform!=='win32'},async t=>{
 const original=childProcess.execFile,calls=[];let driveType='Fixed',failure;
 const stub=()=>{throw Error('expected promisified execution');};
 stub[promisify.custom]=async(exe,args,options)=>{calls.push({exe,args,options});if(failure)throw failure;return {stdout:driveType,stderr:''};};
 childProcess.execFile=stub;syncBuiltinESMExports();
 t.after(()=>{childProcess.execFile=original;syncBuiltinESMExports();});
 const {requireLocalStorage}=await import('../electron/local-storage.mjs?cold-start-budget-test');
 const target=path.resolve('fixture-local-media');
 await t.test('a fixed drive is checked invisibly with a 15-second cold-start allowance',async()=>{
  assert.equal(await requireLocalStorage(target),target);assert.equal(calls.length,1);
  assert.equal(calls[0].options.windowsHide,true);assert.equal(calls[0].options.timeout,15000);
 });
 await t.test('network and unknown drive types still fail closed',async()=>{
  for(const value of ['Network','Unknown','NoRootDirectory','']){driveType=value;await assert.rejects(requireLocalStorage(target),/本机磁盘|NAS 映射盘/);}
 });
 await t.test('failure or timeout cannot silently approve a drive',async()=>{
  failure=Object.assign(Error('fixture process timeout'),{killed:true,signal:'SIGTERM'});
  await assert.rejects(requireLocalStorage(target),/fixture process timeout/);failure=undefined;
 });
 await t.test('UNC paths are rejected without starting a process',async()=>{
  const before=calls.length;await assert.rejects(requireLocalStorage('\\\\fixture-nas\\media'),/本机磁盘/);assert.equal(calls.length,before);
 });
});
