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
  prepareRecovery({dir,accountId,env});
  const file=path.join(dir,'rehearsal.json'),before=fs.readFileSync(file,'utf8');
  assert.equal(JSON.parse(before).restores.test.manifestSha256,env.CANGXIA_RESTORE_SHA256);
  assert.throws(()=>prepareRecovery({dir,accountId,env:{...env,CANGXIA_RESTORE_SHA256:'0'.repeat(64)}}));
  assert.throws(()=>prepareRecovery({dir,accountId:'other',env}));
  assert.equal(fs.readFileSync(file,'utf8'),before);
});
test('Docker context only accepts named repository inputs, excluding private runtime state',()=>{
  const rules=readFileSync(new URL('../../server/Dockerfile.dockerignore',import.meta.url),'utf8').trim().split(/\r?\n/).filter(x=>!x.startsWith('#'));
  assert.equal(rules.shift(),'**');
  for(const rule of rules) assert.match(rule,/^![a-zA-Z0-9./_-]+$/);
  assert.ok(rules.includes('!server/cover-helper.py'));
  assert.ok(!rules.some(x=>/\.(sqlite|pem|key|mp4)$|\.evidence|node_modules|backup-server\//.test(x)));
});
