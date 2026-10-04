import {app,net,session} from 'electron';import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {redirectHeaders} from '../electron/redirect-headers.mjs';import {resolveAuthorLink} from '../electron/author-sources.mjs';
app.setPath('userData',path.resolve('.test-output/redirect-profile'));app.disableHardwareAcceleration();
const timeout=setTimeout(()=>{console.error('redirect test timed out');app.exit(1);},40000);
void app.whenReady().then(async()=>{const profile=session.fromPartition('author-redirect-fixture');let server;
try{
  let destinationHits=0,cookieSeen=false;
  server=http.createServer((req,res)=>{cookieSeen ||= !!req.headers.cookie;if(req.url==='/start'){res.writeHead(302,{location:'/destination'});res.end();}else{destinationHits++;res.end('not needed');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  await profile.cookies.set({url:origin,name:'synthetic',value:'DO_NOT_SEND'});
  await assert.rejects(profile.fetch(origin+'/start',{redirect:'manual',signal:AbortSignal.timeout(5000)}),/Redirect was cancelled/i);
  cookieSeen=false;const result=await redirectHeaders(net,profile)(origin+'/start',{signal:AbortSignal.timeout(5000)});assert.equal(result.status,302);assert.equal(result.headers.get('location'),origin+'/destination');assert.equal(destinationHits,0);assert.equal(cookieSeen,false);
  const report={ok:true,reproducedOldError:true,newRedirectStatus:result.status,destinationNotFetched:destinationHits===0,credentialsNotSent:!cookieSeen};
  if(process.env.CANGXIA_AUTHOR_LINK){const resolved=await resolveAuthorLink(process.env.CANGXIA_AUTHOR_LINK,redirectHeaders(net,profile),AbortSignal.timeout(25000));report.live={url:resolved.url,id:resolved.id};}
  fs.mkdirSync('.test-output',{recursive:true});fs.writeFileSync('.test-output/redirect-desktop-result.json',JSON.stringify(report,null,2));console.log(report);clearTimeout(timeout);await new Promise(r=>server.close(r));app.quit();
}catch(e){console.error(e);server?.close();clearTimeout(timeout);app.exit(1);}

});
