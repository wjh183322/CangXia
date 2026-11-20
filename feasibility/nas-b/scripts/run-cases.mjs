import { stdin, stderr, stdout } from 'node:process';
import { assessRun, manifest, renderReport } from '../assess.mjs';
import { maxEvidenceBytes, readEvidence, recordCase, validateRunId } from '../src/evidence.mjs';

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    size += chunk.length;
    if (size > maxEvidenceBytes) throw new Error('Evidence rejected: input JSON exceeds the size limit.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Evidence rejected: invalid input JSON.');
  }
}

async function main() {
  const [command, runId, ...extra] = process.argv.slice(2);
  if (command === 'list' && runId === undefined) {
    stdout.write(JSON.stringify(manifest, null, 2) + '\n');
    return;
  }
  if (extra.length || !['record', 'assess', 'report'].includes(command)) {
    throw new Error('Usage: run-cases.mjs list | (record | assess | report) <run-id>. Record reads structured JSON from stdin.');
  }
  validateRunId(runId);
  if (command === 'record') {
    const entry = await readInput();
    if (entry?.runId !== runId) throw new Error('Evidence rejected: input run ID must match the requested run.');
    stdout.write(JSON.stringify(await recordCase(entry)) + '\n');
    return;
  }
  const records = await readEvidence(runId);
  const assessment = assessRun({ manifest, evidence: records.map(row => row.evidence), indexes: records.map(row => row.index) });
  stdout.write(command === 'report' ? renderReport(assessment) : JSON.stringify(assessment, null, 2) + '\n');
}

try {
  await main();
} catch (error) {
  const known = /^(Evidence rejected:|Usage:)/.test(error.message);
  stderr.write((known ? error.message : 'Unable to access the private evidence run.') + '\n');
  process.exitCode = 1;
}
