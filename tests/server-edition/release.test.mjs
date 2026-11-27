import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {serverIdentity} from '../../shared/server-identity.mjs';
import {deploymentImage, validateBuild} from '../../server/build-info.mjs';

test('candidate records complete source identity and preserves the daily deployment reference', () => {
  const revision = 'a'.repeat(40);
  assert.deepEqual(validateBuild(revision), {sourceRevision:revision,version:'0.4.1',protocolVersion:serverIdentity.protocolVersion});
  assert.throws(() => validateBuild('main'));
  assert.equal(deploymentImage,'ghcr.io/wjh183322/cangxia-server:latest');
  const compose = readFileSync(new URL('../../server/compose.yaml',import.meta.url),'utf8');
  assert.ok(compose.includes(deploymentImage));
  assert.ok(compose.includes('create_host_path: false'));
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareRecovery} from '../../server/deployment-recovery.mjs';

test('registration uses an independently supplied recovery seal and never retargets an existing name',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cangxia-deployment-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const accountId='owner';
  const env={CANGXIA_SOURCE_UID:'99',CANGXIA_DEPLOYED_DIGEST:'sha256:'+'5'.repeat(64),
    CANGXIA_RESTORE_NAME:'test',CANGXIA_RESTORE_LIBRARY:randomUUID(),CANGXIA_RESTORE_SHA256:'f'.repeat(64)};
  const inputsDir=path.join(dir,'approved');fs.mkdirSync(inputsDir);
  for(const n of ['sources','manifests','restores'])fs.mkdirSync(path.join(inputsDir,n));
  const file=path.join(inputsDir,'rehearsal.json');
  const before=JSON.stringify({accountId,uid:'99',imageDigest:env.CANGXIA_DEPLOYED_DIGEST,sources:{},restores:{}});
  fs.writeFileSync(file,before);
  fs.writeFileSync(path.join(dir,'rehearsal.json'),JSON.stringify({accountId:'malicious',sources:{fake:'f'.repeat(64)}}));
  const cfg=prepareRecovery({dir,inputsDir,accountId,env});
  assert.deepEqual(cfg.sources,{});assert.equal(cfg.restores.test.manifestSha256,env.CANGXIA_RESTORE_SHA256);
  assert.throws(()=>prepareRecovery({dir,inputsDir,accountId,env:{...env,CANGXIA_RESTORE_SHA256:'0'.repeat(64)}}));
  assert.throws(()=>prepareRecovery({dir,inputsDir,accountId:'other',env}));
  assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.deepEqual(fs.readdirSync(inputsDir).sort(),['manifests','rehearsal.json','restores','sources']);
});
test('Docker context only accepts named repository inputs, excluding private runtime state',()=>{
  const rules=readFileSync(new URL('../../server/Dockerfile.dockerignore',import.meta.url),'utf8').trim().split(/\r?\n/).filter(x=>!x.startsWith('#'));
  assert.equal(rules.shift(),'**');
  for(const rule of rules) assert.match(rule,/^![a-zA-Z0-9./_-]+$/);
  assert.ok(rules.includes('!server/cover-helper.py'));
  assert.ok(!rules.some(x=>/\.(sqlite|pem|key|mp4)$|\.evidence|node_modules|backup-server\//.test(x)));
});

test('ordinary verification only uploads exact JSON records and owner approval separates public distribution from stable',()=>{
  const read=(f)=>readFileSync(new URL('../../'+f,import.meta.url),'utf8');
  const normal=read('.github/workflows/server-edition-full.yml');
  assert.deepEqual([...normal.matchAll(/^          path: (.+)$/gm)].map(m=>m[1].trim()),
    ['release/server/candidate.json','release/server-linux/candidate.json']);
  assert.doesNotMatch(normal,/packages: write|promote-server-image|windows-.*\.exe/);
  const approval=read('.github/workflows/server-edition-approval.yml');
  assert.match(approval,/github\.actor == 'wjh183322'/);
  assert.match(approval,/if: needs\.approval\.outputs\.action == 'candidate' && needs\.approval\.outputs\.visibility == 'public'/);
  assert.doesNotMatch(approval,/path: .*image\.tar/);
  const promote=read('scripts/promote-server-image.sh');
  assert.doesNotMatch(promote,/gh run download/);
  assert.ok(promote.includes('check "docker://$registry:$version"')&&promote.includes('check "docker://$registry:latest"'));
});

import {completedCandidate} from '../../scripts/server-distribution-ready.mjs';
test('promotable status requires the completed public Windows delivery and the matching registered attempt',()=>{
  const revision='a'.repeat(40), run='9';
  function needs(visibility,windows){
    const receipt=JSON.stringify({sourceRevision:revision,run,attempt:'1',version:'0.4.1',protocolVersion:1,
      action:'candidate',visibility,tag:'0.4.1-rc.9.1',digest:'sha256:'+'e'.repeat(64),configDigest:'sha256:'+'b'.repeat(64)});
    return {approval:{result:'success',outputs:{action:'candidate',visibility}},registry:{result:'success',outputs:{receipt}},
      'public-windows':{result:windows}};
  }
  const check=n=>completedCandidate(n,{revision,run});
  for(const state of ['failure','skipped','cancelled'])assert.throws(()=>check(needs('public',state)));
  assert.throws(()=>check(needs('private','success')));
  assert.equal(check(needs('private','skipped')).attempt,'1');
  assert.equal(check(needs('public','success')).digest,'sha256:'+'e'.repeat(64));
  const failed=needs('private','skipped');failed.registry.result='failure';assert.throws(()=>check(failed));
});
