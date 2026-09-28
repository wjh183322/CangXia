import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {SystemBrowser} from '../../electron/system-browser.mjs';
import {installFavoriteScroller} from './page-ui.mjs';

const profile=path.join(process.env.LOCALAPPDATA||os.tmpdir(),'CangXia-FavoriteScroll');fs.mkdirSync(profile,{recursive:true});
const lock=path.join(profile,'runner.lock');let lockHandle;
try{lockHandle=fs.openSync(lock,'wx');fs.writeFileSync(lockHandle,String(process.pid));}
catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(fs.readFileSync(lock,'utf8'));let alive=Number.isSafeInteger(pid)&&pid>0;try{if(alive)process.kill(pid,0);}catch{alive=false;}if(alive)throw Error('翻页工具已经打开，请使用原来的浏览器窗口。');fs.unlinkSync(lock);lockHandle=fs.openSync(lock,'wx');fs.writeFileSync(lockHandle,String(process.pid));}
const browser=new SystemBrowser(profile);let closed=false,finishing;
function finish(){if(finishing)return finishing;closed=true;finishing=(async()=>{try{await browser.close();}catch{}if(lockHandle!==undefined){fs.closeSync(lockHandle);lockHandle=undefined;try{if(fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);}catch{}}})();return finishing;}
process.on('SIGINT',()=>{void finish().then(()=>process.exit(0));});process.on('SIGTERM',()=>{void finish().then(()=>process.exit(0));});
try{
  await browser.launch('https://www.douyin.com/user/self');const target=await browser.target(),sid=await browser.attach(target.targetId);
  browser.on('closed',()=>{closed=true;});
  const script=`(${installFavoriteScroller.toString()})();`;
  await browser.connection.send('Page.addScriptToEvaluateOnNewDocument',{source:script},sid);
  await browser.connection.send('Runtime.evaluate',{expression:script},sid);
  console.log('翻页窗口已打开。进入收藏后点击开始；到达底部持续没有变化时会暂停，页面保留用于比对。');
  // Only check whether our tab still exists. No network/response/DOM inspection.
  while(!closed){await new Promise(r=>setTimeout(r,2000));if(closed)break;const connection=browser.connection;if(!connection)break;const {targetInfos}=await connection.send('Target.getTargets');if(!targetInfos.some(t=>t.targetId===target.targetId))break;}
}catch(e){console.error(e.message);process.exitCode=1;}
finally{await finish();}
