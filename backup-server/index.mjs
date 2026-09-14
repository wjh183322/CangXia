import fs from 'node:fs';import path from 'node:path';import {randomBytes,X509Certificate} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {createBackupServer} from './server.mjs';
const dir=path.resolve(process.env.DATA_DIR||'./backup-data');fs.mkdirSync(dir,{recursive:true});const tokenFile=path.join(dir,'access-token');if(!fs.existsSync(tokenFile))fs.writeFileSync(tokenFile,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
const key=path.join(dir,'tls-key.pem'),cert=path.join(dir,'tls-cert.pem');if(!fs.existsSync(key)||!fs.existsSync(cert)){execFileSync('openssl',['req','-x509','-newkey','rsa:3072','-sha256','-nodes','-keyout',key,'-out',cert,'-days','3650','-subj','/CN=CangXia Backup Service'],{stdio:'ignore'});fs.chmodSync(key,0o600);}
const token=fs.readFileSync(tokenFile,'utf8').trim(),certificate=fs.readFileSync(cert);const service=createBackupServer({dataDir:dir,token,tls:{key:fs.readFileSync(key),cert:certificate}});
await service.listen(Number(process.env.PORT||8443),'0.0.0.0');
console.log('CangXia Backup Service ready (HTTPS)');console.log('Access token:',token);console.log('Certificate SHA256:',new X509Certificate(certificate).fingerprint256);console.log('Copy these credentials into your own CangXia Backup client settings.');
for(const name of ['SIGTERM','SIGINT'])process.on(name,()=>{void service.close().then(()=>process.exit(0));});
