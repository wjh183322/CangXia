import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),asar=require('@electron/asar');
const archive=path.resolve(process.argv[2]||'release/backup/win-unpacked/resources/app.asar');
const source=path.resolve('.');
const files=[];
function collect(relative){
  for(const entry of fs.readdirSync(path.join(source,relative),{withFileTypes:true})){
    const name=path.posix.join(relative,entry.name);
    if(entry.isDirectory())collect(name);else if(entry.isFile())files.push(name);
  }
}
for(const dir of ['electron','shared','dist'])collect(dir);
files.push('assets/icon.ico');
const missing=[],different=[];
for(const file of files){
  let bytes;try{bytes=asar.extractFile(archive,path.normalize(file));}catch{missing.push(file);continue;}
  if(!bytes.equals(fs.readFileSync(path.join(source,file))))different.push(file);
}
assert.deepEqual(missing,[],'Runtime files missing from app.asar');
assert.deepEqual(different,[],'Packaged runtime differs from the tested source');
const manifest=JSON.parse(asar.extractFile(archive,'package.json'));
const expected=JSON.parse(fs.readFileSync('package.json','utf8'));
assert.equal(manifest.version,expected.version);
for(const key of ['name','main','type','dependencies'])assert.deepEqual(manifest[key],expected[key],`Packaged manifest ${key}`);
assert.ok(asar.extractFile(archive,path.normalize('node_modules/ws/package.json')).length,'WebSocket dependency included');
assert.ok(fs.existsSync(path.join(path.dirname(archive),'cover-helper','CangXiaCover.exe')),'Matching component included');
console.log(`Package archive verified: ${files.length} runtime files, version ${manifest.version}`);
