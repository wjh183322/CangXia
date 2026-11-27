import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export function completedCandidate(needs,{revision,run}) {
  const approval=needs.approval,registry=needs.registry;
  assert.equal(approval.result,'success');assert.equal(approval.outputs.action,'candidate');
  assert.equal(registry.result,'success');
  const {visibility}=approval.outputs;
  assert.ok(['private','public'].includes(visibility));
  assert.equal(needs['public-windows'].result,visibility==='public'?'success':'skipped');
  const record=JSON.parse(registry.outputs.receipt);
  assert.equal(record.action,'candidate');assert.equal(record.sourceRevision,revision);
  assert.equal(record.run,run);assert.match(record.attempt,/^[1-9]\d*$/);
  assert.equal(record.version,'0.4.1');assert.equal(record.protocolVersion,1);
  assert.equal(record.visibility,visibility);assert.equal(record.tag,'0.4.1-rc.'+run+'.'+record.attempt);
  assert.match(record.digest,/^sha256:[0-9a-f]{64}$/);assert.match(record.configDigest,/^sha256:[0-9a-f]{64}$/);
  return record;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const r=completedCandidate(JSON.parse(process.env.JOB_RESULTS),{revision:process.env.GITHUB_SHA,run:process.env.GITHUB_RUN_ID});
  appendFileSync(process.env.GITHUB_OUTPUT,'digest='+r.digest+'\ncontext=cangxia-server/candidate/'+r.run+'/'+r.attempt+'/'+r.visibility+'\n');
}
