import https from 'node:https';
import {X509Certificate} from 'node:crypto';
import fs from 'node:fs';
const cert=fs.readFileSync('/config/identity/server.crt');
const request=https.get('https://127.0.0.1:9443/',{ca:cert,checkServerIdentity:(_host,peer)=>peer.raw.equals(new X509Certificate(cert).raw)?undefined:Error('pin mismatch'),timeout:3000},res=>{
  res.resume(); process.exitCode=res.statusCode===401?0:1;
});
request.on('error',()=>{process.exitCode=1;});
request.on('timeout',()=>request.destroy());
