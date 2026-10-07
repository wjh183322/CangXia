import fs from 'node:fs';
import path from 'node:path';
import {generate} from 'selfsigned';
export async function writeTestCertificate(directory){
 const pems=await generate([{name:'commonName',value:'localhost'}],{keySize:2048,algorithm:'sha256',notAfterDate:new Date(Date.now()+86400000)});
 fs.writeFileSync(path.join(directory,'key.pem'),pems.private,{mode:0o600});fs.writeFileSync(path.join(directory,'cert.pem'),pems.cert);
}
