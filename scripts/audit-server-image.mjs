import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {BASE_IMAGE} from '../feasibility/nas-b/scripts/image-inputs.mjs';
import {validateBuild} from '../server/build-info.mjs';
import assert from 'node:assert/strict';
const inspect=image=>JSON.parse(execFileSync('docker',['image','inspect',image]))[0];
const [image,revision,listing] = process.argv.slice(2);
const candidate=inspect(image), base=inspect(BASE_IMAGE);
const info=validateBuild(revision),config=candidate.Config;
assert.deepEqual(candidate.RootFS.Layers.slice(0,base.RootFS.Layers.length),base.RootFS.Layers);
assert.equal(candidate.Architecture,'amd64');assert.equal(candidate.Os,'linux');
assert.equal(config.User,'1000:1000');
assert.equal(config.Labels['org.opencontainers.image.revision'],info.sourceRevision);
assert.equal(config.Labels['org.opencontainers.image.version'],info.version);
assert.equal(config.Labels['org.opencontainers.image.source'],'https://github.com/wjh183322/CangXia');
assert.deepEqual(config.Entrypoint,['node','/opt/cangxia/server/deployment.mjs']);
const required=new Set(readFileSync('server/Dockerfile.dockerignore','utf8').split(/\r?\n/).filter(s=>s.startsWith('!'))
  .map(s=>s.slice(1)).filter(s=>!s.startsWith('tests/')&&!s.startsWith('feasibility/')));
required.add('build-info.json');required.add('cover-runtime.lock');
const found=new Set();
for(const raw of readFileSync(listing,'utf8').split('\n')){
  const p=raw.replace(/^\.\//,'');
  assert.ok(!/^(?:opt\/cangxia|root|home|tmp|library|config|rehearsal)\/(?:.*\/)?(?:\.git|\.evidence|\.ssh|\.env|cookies|credentials\.json|server\.key|devices\.json|[^/]*\.sqlite)(?:\/|$)/i.test(p),'private content in image');
  if(!p.startsWith('opt/cangxia/')||p.endsWith('/'))continue;
  const rel=p.slice(12);
  if(required.has(rel)){found.add(rel);continue;}
  assert.match(rel,/^server\/node_modules\/(?:jsonc-parser\/|playwright-core\/|\.bin\/playwright-core$|\.package-lock\.json$)/);
}
assert.deepEqual([...required].filter(p=>!found.has(p)),[]);
console.log(base.RootFS.Layers.length);
