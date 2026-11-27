import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {build,Platform,Arch} from 'electron-builder';
import {validateBuild} from '../server/build-info.mjs';
const sourceRevision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if (process.env.GITHUB_SHA && sourceRevision!==process.env.GITHUB_SHA) throw Error('Checked-out revision differs from CI.');
const info=validateBuild(sourceRevision);
const files=await build({targets:Platform.WINDOWS.createTarget(['nsis','portable'],Arch.x64),publish:'never',
  config:{extraMetadata:{sourceRevision,protocolVersion:info.protocolVersion}}});
const executables=files.filter(p=>p.endsWith('.exe'));
if (executables.length!==2) throw Error('Both Windows x64 executables are required.');
writeFileSync('release/server/candidate.json',JSON.stringify({...info,files:Object.fromEntries(executables.map(p=>
  [path.basename(p),createHash('sha256').update(readFileSync(p)).digest('hex')]))},null,2)+'\n');

const kit = 'release/server/CangXia-Server-0.4.1-NAS.zip';
execFileSync('tar.exe',['-a','-cf',kit,
  '-C',path.resolve('server'),'compose.yaml',
  '-C',path.resolve('feasibility/nas-b'),'chromium-seccomp.json','chromium-seccomp.LICENSE',
  '-C',path.resolve('docs/server-edition'),'release-acceptance.md','migration-rehearsal.md'],{windowsHide:true});
