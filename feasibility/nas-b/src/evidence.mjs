import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../case-manifest.json' with { type: 'json' };

const evidenceRoot = resolve(fileURLToPath(new URL('../../../.evidence/', import.meta.url)));
const recordFile = /^record-([a-f0-9]{64})\.json$/;
const pendingFile = /^\.pending-[a-f0-9-]{36}$/;
const hexDigest = /^[a-f0-9]{64}$/;
const sourceRevision = /^[a-f0-9]{40}$/;
const runPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const windowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const identityFields = ['runId', 'revision', 'configFingerprint'];
const recordFields = new Set([
  ...identityFields, 'timestamp', 'caseId', 'kind', 'status', 'checks', 'blockers',
  'measurements', 'imageDigest', 'dependencyFingerprint'
]);
const extraCases = { MIGRATION: ['migration-rehearsal'] };
const cases = new Set([...manifest.map(row => row.id), ...Object.keys(extraCases)]);
const kinds = new Set([
  ...manifest.flatMap(row => row.kinds), ...Object.values(extraCases).flat(),
  'fake-browser', 'local-smoke', 'hosted-linux'
]);
const statuses = new Set(['passed', 'failed', 'blocked']);
const checks = new Set([
  ...manifest.flatMap(row => row.checks ?? []),
  'challenge-not-observed', 'challenge-observed', 'controlled-verification',
  'sleep-resumed', 'migration-rehearsed', 'rollback-rehearsed'
]);
const blockerCodes = new Set([
  'auth-verification-failed', 'missing-core-fields', 'partial-page', 'skipped-page', 'unauthorized-access',
  'stale-generation-write', 'false-download-completion', 'wrong-deletion', 'volume-identity-mismatch',
  'production-touched', 'sustained-playback-degradation'
]);
const integerMeasurements = new Set(['samples', 'workCount']);
const measurementNames = new Set([
  ...manifest.flatMap(row => Object.keys(row.measurements ?? {})),
  'cpuPercent', 'memoryMiB', 'availableMiB', 'mediaMiB'
]);
export const maxEvidenceBytes = 8192;

function reject(reason) {
  // These messages only contain static text, even when input contained sensitive material.
  throw new Error('Evidence rejected: ' + reason + '.');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export function validateRunId(runId) {
  if (typeof runId !== 'string' || !runPattern.test(runId) || windowsReserved.test(runId)) reject('invalid run ID');
  return runId;
}

function validateIdentity(value) {
  validateRunId(value.runId);
  if (typeof value.revision !== 'string' || !sourceRevision.test(value.revision)) reject('invalid source revision');
  if (typeof value.configFingerprint !== 'string' || !hexDigest.test(value.configFingerprint)) reject('invalid configuration fingerprint');
  return { runId: value.runId, revision: value.revision, configFingerprint: value.configFingerprint };
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    reject('invalid UTC timestamp');
  }
  const date = new Date(value);
  const canonical = value.length === 20 ? value.replace('Z', '.000Z') : value;
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== canonical || date.valueOf() > Date.now()) {
    reject('invalid or future UTC timestamp');
  }
  return canonical;
}

function validateList(values, allowed) {
  if (!Array.isArray(values) || values.length > allowed.size ||
      values.some(value => !allowed.has(value)) || new Set(values).size !== values.length) {
    reject('invalid checks or blocking findings');
  }
  return [...values].sort();
}

function validateMeasurements(value) {
  if (!isPlainObject(value)) reject('invalid measurements');
  for (const [key, number] of Object.entries(value)) {
    if (!measurementNames.has(key) || !Number.isFinite(number) || number < 0 ||
      number > Number.MAX_SAFE_INTEGER || (integerMeasurements.has(key) && !Number.isInteger(number))) {
      reject('invalid measurements');
    }
  }
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

export function validateCaseEvidence(value) {
  if (!isPlainObject(value) || Object.keys(value).some(key => !recordFields.has(key))) {
    reject('only structured evidence fields are allowed');
  }
  const identity = validateIdentity(value);
  const { caseId, kind, status } = value;
  if (!cases.has(caseId) || !kinds.has(kind) || !statuses.has(status) ||
      (caseId === 'MIGRATION' && !extraCases.MIGRATION.includes(kind))) reject('invalid case, evidence kind or result');

  const findings = validateList(value.blockers ?? [], blockerCodes);
  if (findings.length && status !== 'failed') reject('blocking findings require a failed result');
  const recordedChecks = validateList(value.checks ?? [], checks);
  const observed = ['genuine-challenge-completed', 'challenge-observed'].some(check => recordedChecks.includes(check));
  if (observed && recordedChecks.includes('challenge-not-observed')) reject('conflicting verification checks');

  const safe = {
    ...identity, timestamp: normalizeTimestamp(value.timestamp), caseId, kind, status,
    checks: recordedChecks, blockers: findings, measurements: validateMeasurements(value.measurements ?? {})
  };
  if (value.imageDigest !== undefined) {
    if (typeof value.imageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.imageDigest)) reject('invalid image digest');
    safe.imageDigest = value.imageDigest;
  }
  if (value.dependencyFingerprint !== undefined) {
    if (typeof value.dependencyFingerprint !== 'string' || !hexDigest.test(value.dependencyFingerprint)) reject('invalid dependency fingerprint');
    safe.dependencyFingerprint = value.dependencyFingerprint;
  }
  return safe;
}

export function assertSameRun(identity, entry) {
  if (identityFields.some(key => identity[key] !== entry[key])) reject('run ID, revision or configuration fingerprint mismatch');
}

async function privateDirectory(path, create) {
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path ||
      (process.getuid && ((info.mode & 0o077) || info.uid !== process.getuid()))) {
    reject('unsafe private evidence directory');
  }
}

async function runDirectory(runId, create) {
  const directory = join(evidenceRoot, validateRunId(runId));
  await privateDirectory(evidenceRoot, create);
  await privateDirectory(directory, create);
  return directory;
}

async function checkedRead(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > maxEvidenceBytes ||
      (process.getuid && ((info.mode & 0o077) || info.uid !== process.getuid()))) {
    reject('unsafe evidence file');
  }
  return readFile(path, 'utf8');
}

async function writeOnce(directory, name, contents) {
  const target = join(directory, name);
  const pending = join(directory, '.pending-' + randomUUID());
  await writeFile(pending, contents, { flag: 'wx', mode: 0o600 });
  try {
    await link(pending, target).catch(error => { if (error.code !== 'EEXIST') throw error; });
  } finally {
    await unlink(pending);
  }
  return target;
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

function parseEvidenceJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    reject('invalid evidence JSON');
  }
}

function attachmentIndex(entry, name, sha256) {
  return { caseId: entry.caseId, kind: entry.kind, timestamp: entry.timestamp, name, sha256 };
}

export async function recordCase(input) {
  const entry = validateCaseEvidence(input);
  const directory = await runDirectory(entry.runId, true);
  const identityText = JSON.stringify(validateIdentity(entry)) + '\n';
  const identityPath = await writeOnce(directory, 'run.json', identityText);
  if (await checkedRead(identityPath) !== identityText) reject('run ID, revision or configuration fingerprint mismatch');

  const serialized = JSON.stringify(entry) + '\n';
  const sha256 = digest(serialized);
  const name = 'record-' + sha256 + '.json';
  const path = await writeOnce(directory, name, serialized);
  if (await checkedRead(path) !== serialized) reject('record digest mismatch');
  return attachmentIndex(entry, name, sha256);
}

export async function readEvidence(runId) {
  const directory = await runDirectory(runId, false).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!directory) return [];
  const entries = await readdir(directory);
  const identity = validateIdentity(parseEvidenceJson(await checkedRead(join(directory, 'run.json'))));
  assertSameRun(identity, { ...identity, runId });

  const records = [];
  for (const name of entries.sort()) {
    if (name === 'run.json' || pendingFile.test(name)) continue;
    const match = name.match(recordFile);
    if (!match) reject('unexpected file in evidence directory');
    const raw = await checkedRead(join(directory, name));
    if (digest(raw) !== match[1]) reject('record digest mismatch');
    const evidence = validateCaseEvidence(parseEvidenceJson(raw));
    assertSameRun(identity, evidence);
    records.push({ evidence, index: attachmentIndex(evidence, name, match[1]) });
  }
  return records;
}
