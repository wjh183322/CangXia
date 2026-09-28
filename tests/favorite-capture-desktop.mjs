import {app,BrowserWindow} from 'electron';import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {gzipSync} from 'node:zlib';
import {ResponseCapture} from '../scripts/favorite-scroll/response-capture.mjs';
app.disableHardwareAcceleration();app.setPath('userData',path.resolve('.test-output/capture-profile'));const deadline=setTimeout(()=>app.exit(1),30000);
void app.whenReady().then(async()=>{let server,win;try{
  const body=JSON.stringify({aweme_list:Array.from({length:500},(_,i)=>({aweme_id:String(900000+i),desc:'合成收藏响应，中文边界验证 '.repeat(15)})),has_more:0});const bytes=gzipSync(Buffer.from(body));
  server=http.createServer((req,res)=>{if(req.url.startsWith('/api')){res.writeHead(200,{'Content-Type':'application/json','Content-Encoding':'gzip'});res.write(bytes.subarray(0,Math.floor(bytes.length/2)));setTimeout(()=>res.end(bytes.subarray(Math.floor(bytes.length/2))),20);}else{res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Local capture fixture</title>');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true}});const wc=win.webContents;await win.loadURL(`http://127.0.0.1:${server.address().port}`);wc.debugger.attach('1.3');let lookups=0;const capture=new ResponseCapture((method,params)=>{if(method==='Network.getResponseBody')lookups++;return wc.debugger.sendCommand(method,params);});const ids=new Set(),results=[];
  let done;const complete=new Promise(resolve=>done=resolve);wc.debugger.on('message',(_event,method,p)=>{
    if(method==='Network.responseReceived'&&new URL(p.response.url).pathname==='/api'){ids.add(p.requestId);capture.start(p.requestId);}
    if(method==='Network.dataReceived')capture.data(p.requestId,p.data);
    if(method==='Network.loadingFinished'&&ids.has(p.requestId)){const captured=capture.finish(p.requestId);void captured.then(result=>{results.push(result);if(results.length===12)done();});}
  });await wc.debugger.sendCommand('Network.enable',{maxTotalBufferSize:16*1024*1024,maxResourceBufferSize:4*1024*1024});
  await wc.executeJavaScript(`Promise.all(Array.from({length:12},(_,i)=>fetch('/api?i='+i).then(r=>r.text()))).then(()=>true)`);await complete;
  for(const r of results){assert.equal(r.error,undefined);assert.equal(r.text,body);assert.equal(r.mode,'stream');}assert.equal(lookups,0);
  fs.writeFileSync('.test-output/favorite-capture-desktop.json',JSON.stringify({ok:true,responses:results.length,bodyBytes:Buffer.byteLength(body),streamed:true,cacheLookups:lookups},null,2));console.log({ok:true,responses:results.length,cacheLookups:lookups});clearTimeout(deadline);win.destroy();await new Promise(r=>server.close(r));app.quit();
}catch(e){console.error(e);server?.close();clearTimeout(deadline);app.exit(1);}});
