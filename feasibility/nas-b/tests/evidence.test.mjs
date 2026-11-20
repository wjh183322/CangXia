import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const groups = { ENV: 5, AUTH: 6, DATA: 10, TX: 6, LOCK: 6, DL: 7, PERF: 7, COMPAT: 3, DEPLOY: 3 };
const runId = 'synthetic-' + randomUUID();
const revision = '1'.repeat(40);
const configFingerprint = '2'.repeat(64);
const timestamp = '2026-01-02T03:04:05Z';
const root = fileURLToPath(new URL('../../../.evidence/', import.meta.url));
const cli = fileURLToPath(new URL('../scripts/run-cases.mjs', import.meta.url));
const result = (caseId, kind, fields = {}) => ({
  runId, revision, configFingerprint, timestamp, caseId, kind, status: 'passed', ...fields
});

async function assessment(evidence, options = {}) {
  const { assessRun, manifest } = await import('../assess.mjs');
  return assessRun({ manifest, evidence, ...options });
}
const row = (report, id) => report.cases.find(entry => entry.id === id);

function cliRun(command, id, input) {
  return spawnSync(process.execPath, [cli, command, id], { encoding: 'utf8', input });
}

test('lists all 53 design cases and marks an empty run unrun', async () => {
  const report = await assessment([]);
  const ids = Object.entries(groups).flatMap(([group, count]) =>
    Array.from({ length: count }, (_, index) => group + '-' + String(index + 1).padStart(2, '0')));
  assert.deepEqual(report.cases.map(entry => entry.id), ids);
  assert.equal(report.cases.every(entry => entry.status === 'unrun'), true);
  assert.equal(report.development.status, 'pending');
  assert.equal(report.release.status, 'pending');
});

test('fake browser, local tests and hosted Linux leave NAS hardware and real authentication unrun', async () => {
  const evidence = [
    result('ENV-01', 'hosted-linux'), result('AUTH-01', 'fake-browser'),
    result('AUTH-02', 'local-smoke'), result('AUTH-03', 'fake-browser', { checks: ['controlled-verification'] })
  ];
  const report = await assessment(evidence);
  for (const { caseId } of evidence) {
    assert.equal(row(report, caseId).status, 'unrun');
    assert.equal(row(report, caseId).attempts[0].status, 'passed');
    assert.ok(report.development.pending.includes(caseId));
  }
});

test('real NAS QR login requires an explicit account-binding check', async () => {
  assert.equal(row(await assessment([result('AUTH-01', 'nas-live')]), 'AUTH-01').status, 'blocked');
  const verified = await assessment([result('AUTH-01', 'nas-live', { checks: ['qr-account-verified'] })]);
  assert.equal(row(verified, 'AUTH-01').status, 'passed');
});

test('unavailable NAS QR testing is pending rather than a failed authentication', async () => {
  const report = await assessment([result('AUTH-01', 'nas-live', { status: 'blocked' })]);
  assert.equal(row(report, 'AUTH-01').status, 'blocked');
  assert.equal(report.development.status, 'pending');
  assert.deepEqual(report.blockers, []);
});

test('a challenge absent from an actual session stays unrun after controlled interaction succeeds', async () => {
  const report = await assessment([
    result('AUTH-03', 'nas-live', { checks: ['challenge-not-observed'] }),
    result('AUTH-03', 'nas-fault', { checks: ['controlled-verification'] })
  ]);
  assert.equal(row(report, 'AUTH-03').status, 'unrun');
  assert.equal(report.development.pending.includes('AUTH-03'), false);
  assert.equal(report.development.uncovered.includes('AUTH-03'), true);
});

test('a genuine failed challenge stays blocking after a newer controlled fallback', async () => {
  const report = await assessment([
    result('AUTH-03', 'nas-live', { status: 'failed', checks: ['challenge-observed'] }),
    result('AUTH-03', 'nas-live', { timestamp: '2026-01-02T04:00:00Z', checks: ['challenge-not-observed'] }),
    result('AUTH-03', 'nas-fault', { checks: ['controlled-verification'] })
  ]);
  assert.equal(row(report, 'AUTH-03').status, 'failed');
  assert.equal(report.development.status, 'blocked');
});

test('a newer failed controlled interaction revokes the waiver for an unobserved challenge', async () => {
  const report = await assessment([
    result('AUTH-03', 'nas-live', { checks: ['challenge-not-observed'] }),
    result('AUTH-03', 'nas-fault', { checks: ['controlled-verification'] }),
    result('AUTH-03', 'nas-fault', { timestamp: '2026-01-02T04:00:00Z', status: 'failed' })
  ]);
  assert.equal(row(report, 'AUTH-03').status, 'unrun');
  assert.equal(report.development.pending.includes('AUTH-03'), true);
  assert.deepEqual(report.development.uncovered, []);
});

test('failed actual NAS verification cannot be hidden by a later passing attempt', async () => {
  const report = await assessment([
    result('AUTH-03', 'nas-live', { status: 'failed' }),
    result('AUTH-03', 'nas-live', { timestamp: '2026-01-02T04:00:00Z', checks: ['genuine-challenge-completed'] })
  ]);
  assert.equal(row(report, 'AUTH-03').status, 'failed');
  assert.ok(report.blockers.some(entry => entry.caseId === 'AUTH-03'));
});

test('NAS protocol passes leave release double-Windows and sleep unrun', async () => {
  const report = await assessment(
    Array.from({ length: 6 }, (_, index) => result('LOCK-0' + (index + 1), 'nas-two-clients'))
  );
  assert.ok(report.cases.filter(entry => entry.id.startsWith('LOCK-')).every(entry => entry.status === 'passed'));
  assert.equal(report.release.gates['two-windows'], 'unrun');
  assert.equal(report.release.gates['windows-sleep'], 'unrun');
});

test('prototype control page is insufficient for the complete Windows UI gate', async () => {
  const report = await assessment([result('COMPAT-01', 'nas'), result('COMPAT-01', 'windows-product')]);
  assert.equal(row(report, 'COMPAT-01').status, 'blocked');
  assert.equal(report.release.gates['windows-product'], 'blocked');
});

test('core field loss, partial commit, unauthorized access and accidental deletion block later passes', async () => {
  const findings = [
    ['DATA-05', 'missing-core-fields'], ['TX-02', 'partial-page'],
    ['LOCK-02', 'unauthorized-access'], ['DL-06', 'wrong-deletion']
  ];
  const report = await assessment(findings.flatMap(([id, blocker]) => [
    result(id, 'unit', { status: 'failed', blockers: [blocker] }),
    result(id, 'unit', { timestamp: '2026-01-02T03:05:00Z' })
  ]));
  assert.equal(report.development.status, 'blocked');
  assert.equal(report.release.status, 'blocked');
  assert.equal(report.conclusion, 'not-feasible');
  assert.deepEqual(report.blockers.map(({ caseId, code }) => [caseId, code]), findings);
  for (const [id] of findings) assert.equal(row(report, id).status, 'failed');
});

test('golden vectors alone leave the NAS/Windows cover comparison unrun', async () => {
  assert.equal(row(await assessment([
    result('COMPAT-03', 'unit', { checks: ['cover-golden'] })
  ]), 'COMPAT-03').status, 'unrun');
  const compared = await assessment([
    result('COMPAT-03', 'nas', { checks: ['cover-golden', 'windows-cover-match'] })
  ]);
  assert.equal(row(compared, 'COMPAT-03').status, 'passed');
});

test('latency gate requires field measurements within the agreed targets', async () => {
  const report = await assessment([
    result('PERF-02', 'hosted-linux'), result('PERF-02', 'nas', { checks: ['lan-cold-warm'] }),
    result('PERF-06', 'nas', { checks: ['actual-wan-path'] })
  ]);
  assert.equal(row(report, 'PERF-02').status, 'blocked');
  assert.equal(report.release.gates['actual-wan'], 'unrun');
  const observations = ['cold-process', 'first-visit', 'cache-hit'].map(cacheState =>
    result('PERF-02', 'nas', {
      cacheState, checks: ['lan-cold-warm'], measurements: { lanListMs: 850, lanCoverMs: 1500, samples: 2 }
    }));
  assert.equal(row(await assessment(observations.slice(0, 2)), 'PERF-02').status, 'blocked');
  for (const [lanListMs, expected] of [[850, 'passed'], [1500, 'failed']]) {
    const evidence = structuredClone(observations);
    evidence[1].measurements.lanListMs = lanListMs;
    assert.equal(row(await assessment(evidence), 'PERF-02').status, expected);
  }
});

test('video startup requires repeated positive measurements for every cache state', async () => {
  const observations = ['cold-process', 'first-visit', 'cache-hit'].map(cacheState =>
    result('PERF-03', 'nas', {
      cacheState, checks: ['range-and-cancellation'], measurements: { videoStartMs: 2800, samples: 2 }
    }));
  assert.equal(row(await assessment(observations), 'PERF-03').status, 'passed');
  for (const [fields, expected] of [[{ samples: 1 }, 'failed'], [{ videoStartMs: 0 }, 'failed']]) {
    const evidence = structuredClone(observations);
    Object.assign(evidence[1].measurements, fields);
    const measured = await assessment(evidence);
    assert.equal(row(measured, 'PERF-03').status, expected);
  }
});

test('scale evidence requires the synthetic run and an independent representative copy', async () => {
  const synthetic = result('PERF-01', 'nas', {
    checks: ['representative-scale'], measurements: { workCount: 50000 }
  });
  assert.equal(row(await assessment([synthetic]), 'PERF-01').status, 'blocked');
  const both = { ...synthetic, checks: ['representative-scale', 'independent-representative-copy'],
    measurements: { workCount: 50000, copiedWorkCount: 300 } };
  assert.equal(row(await assessment([both]), 'PERF-01').status, 'passed');
});

test('WAN acceptance requires real network path, cache and positive measured quantities', async () => {
  const remote = result('PERF-06', 'wan', {
    checks: ['actual-wan-path', 'wan-cache-recorded', 'wan-source-playback-separated'],
    wanPath: 'tailscale-relay',
    measurements: { samples: 1, wanRttMs: 95, wanThroughputMbps: 19, mediaBitrateMbps: 5 }
  });
  assert.equal((await assessment([remote])).release.gates['actual-wan'], 'passed');
  const noPath = { ...remote };
  delete noPath.wanPath;
  assert.equal((await assessment([noPath])).release.gates['actual-wan'], 'blocked');
  for (const metric of ['wanRttMs', 'wanThroughputMbps', 'mediaBitrateMbps']) {
    const invalid = { ...remote, measurements: { ...remote.measurements, [metric]: 0 } };
    assert.equal((await assessment([invalid])).release.gates['actual-wan'], 'failed');
  }
});

test('registry approval and NAS pull require the same digest and optional policy approval', async () => {
  const approved = 'sha256:' + 'a'.repeat(64);
  const other = 'sha256:' + 'b'.repeat(64);
  const pulled = result('DEPLOY-01', 'nas', { imageDigest: approved, checks: ['ghcr-digest-pulled', 'complete-image'] });
  const reviewed = result('DEPLOY-03', 'registry', { imageDigest: approved, checks: ['reviewed-image', 'visibility-confirmed'] });
  const matched = await assessment([pulled, reviewed], { policy: { approvedImageDigest: approved } });
  assert.equal(row(matched, 'DEPLOY-01').status, 'passed');
  assert.equal(row(matched, 'DEPLOY-03').status, 'passed');
  for (const [observations, policy] of [
    [[pulled], {}],
    [[pulled, { ...reviewed, imageDigest: undefined }], {}],
    [[pulled, { ...reviewed, imageDigest: other }], {}],
    [[pulled, reviewed], { approvedImageDigest: other }],
    [[pulled, reviewed, { ...reviewed, imageDigest: other }], {}],
    [[pulled, reviewed, { ...reviewed, imageDigest: other, timestamp: '2026-01-02T04:00:00Z' }], {}]
  ]) {
    const report = await assessment(observations, { policy });
    assert.equal(row(report, 'DEPLOY-01').status, 'blocked');
    assert.notEqual(row(report, 'DEPLOY-03').status, 'passed');
    assert.equal(report.development.pending.includes('DEPLOY-01'), true);
    assert.notEqual(report.release.status, 'passed');
  }
});

test('refuses invalid dates, future clocks and mixed run fingerprints', async () => {
  await assert.rejects(() => assessment([result('ENV-01', 'unit', { timestamp: '2026-02-30T00:00:00Z' })]), /timestamp/);
  await assert.rejects(() => assessment([result('ENV-01', 'unit', { timestamp: '2099-01-01T00:00:00Z' })]), /timestamp/);
  await assert.rejects(() => assessment([
    result('ENV-01', 'nas'), result('ENV-02', 'nas', { configFingerprint: '3'.repeat(64) })
  ]), /fingerprint/);
});

test('CLI records structured evidence and renders its safe attachment index', async t => {
  const run = join(root, runId);
  t.after(() => rm(run, { recursive: true, force: true }));
  const recorded = cliRun('record', runId, JSON.stringify(result('AUTH-01', 'fake-browser')));
  assert.equal(recorded.status, 0, recorded.stderr);
  const index = JSON.parse(recorded.stdout);
  assert.match(index.name, /^record-[a-f0-9-]+\.json$/);
  assert.match(index.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual((await readdir(run)).sort(), [index.name, 'run.json']);
  const stored = JSON.parse(await readFile(join(run, index.name), 'utf8'));
  assert.equal(stored.revision, revision);
  assert.equal(stored.timestamp, '2026-01-02T03:04:05.000Z');
  const rendered = cliRun('report', runId);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /AUTH-01.*未测/);
  assert.match(rendered.stdout, /fake-browser/);
  assert.match(rendered.stdout, /America\/New_York/);
  assert.ok(rendered.stdout.includes(index.name));
});

test('CLI rejects secrets, arbitrary files, path escapes and symlinked run directories', async t => {
  const id = 'synthetic-' + randomUUID();
  const run = join(root, id);
  const scratch = await mkdtemp(join(tmpdir(), 'cangxia-evidence-'));
  t.after(async () => {
    const info = await lstat(run).catch(() => null);
    if (info?.isSymbolicLink()) await unlink(run);
    await rm(scratch, { recursive: true, force: true });
  });
  const secret = 'https://example.invalid/media?signature=PRIVATE_VALUE';
  for (const fields of [
    { token: secret }, { summary: secret }, { attachment: 'login.png' },
    { checks: [secret] }, { measurements: { rawBody: secret } }, { caseId: '../record' }
  ]) {
    const attempt = cliRun('record', id, JSON.stringify(result('AUTH-01', 'fake-browser', { runId: id, ...fields })));
    assert.equal(attempt.status, 1);
    assert.match(attempt.stderr, /Evidence rejected/);
    assert.doesNotMatch(attempt.stderr + attempt.stdout, /PRIVATE_VALUE|rawBody/);
  }
  assert.equal(cliRun('record', '../escape', '{}').status, 1);
  assert.equal(await lstat(run).catch(error => error.code), 'ENOENT');
  await mkdir(root, { recursive: true });
  await symlink(scratch, run, process.platform === 'win32' ? 'junction' : 'dir');
  const redirected = cliRun('record', id, JSON.stringify(result('AUTH-01', 'fake-browser', { runId: id })));
  assert.equal(redirected.status, 1);
  assert.deepEqual(await readdir(scratch), []);
});

test('the first record locks a private run to one revision and configuration', async t => {
  const id = 'synthetic-' + randomUUID();
  t.after(() => rm(join(root, id), { recursive: true, force: true }));
  const first = result('ENV-01', 'nas', { runId: id });
  assert.equal(cliRun('record', id, JSON.stringify(first)).status, 0);
  const mixed = cliRun('record', id, JSON.stringify({ ...first, configFingerprint: '3'.repeat(64) }));
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /fingerprint/);
  assert.equal(cliRun('report', id).status, 0);
  assert.equal((await readdir(join(root, id))).length, 2);
});

test('manual prototype claims leave the real release gates pending', async () => {
  const report = await assessment([
    result('COMPAT-01', 'windows-product', { checks: ['complete-windows-ui'] }),
    result('LOCK-06', 'two-windows', { checks: ['sleep-resumed'] }),
    result('PERF-06', 'wan', { checks: ['actual-wan-path'] }),
    result('MIGRATION', 'migration-rehearsal', { checks: ['migration-rehearsed'] })
  ]);
  assert.equal(report.release.gates['windows-product'], 'passed');
  assert.equal(report.release.gates['two-windows'], 'unrun');
  assert.equal(report.release.gates['windows-sleep'], 'passed');
  assert.equal(report.release.gates['actual-wan'], 'blocked');
  assert.equal(report.release.gates['migration-and-rollback'], 'blocked');
  assert.equal(report.release.status, 'pending');
});

test('reports reject changed records and unrelated files', async t => {
  const id = 'synthetic-' + randomUUID();
  const run = join(root, id);
  t.after(() => rm(run, { recursive: true, force: true }));
  const recorded = cliRun('record', id, JSON.stringify(result('ENV-01', 'nas', { runId: id })));
  assert.equal(recorded.status, 0, recorded.stderr);
  const { name } = JSON.parse(recorded.stdout);
  const privateValue = 'PRIVATE_BODY_VALUE';
  await writeFile(join(run, 'login.png'), privateValue);
  const other = cliRun('report', id);
  assert.equal(other.status, 1);
  assert.doesNotMatch(other.stdout + other.stderr, /PRIVATE_BODY_VALUE|login\.png/);
  await unlink(join(run, 'login.png'));
  const entry = join(run, name);
  const raw = await readFile(entry, 'utf8');
  await writeFile(entry, raw.replace('"nas"', '"unit"'));
  const replaced = cliRun('report', id);
  assert.equal(replaced.status, 1);
  assert.doesNotMatch(replaced.stdout + replaced.stderr, /PRIVATE_BODY_VALUE/);
});

test('a process interruption after publishing a hard link leaves the run readable and retryable', async t => {
  const id = 'synthetic-' + randomUUID();
  const run = join(root, id);
  t.after(() => rm(run, { recursive: true, force: true }));
  const input = JSON.stringify(result('ENV-01', 'nas', { runId: id }));
  const recorded = cliRun('record', id, input);
  assert.equal(recorded.status, 0, recorded.stderr);
  const { name } = JSON.parse(recorded.stdout);
  for (const file of ['run.json', name]) {
    await link(join(run, file), join(run, '.pending-' + file + '-' + randomUUID()));
  }
  const report = cliRun('report', id);
  assert.equal(report.status, 0, report.stderr);
  assert.ok(report.stdout.includes(name));
  assert.equal(cliRun('record', id, input).status, 0);
});

test('an unrelated hard link is rejected even with an unrelated well-named stage file', async t => {
  const id = 'synthetic-' + randomUUID();
  const run = join(root, id);
  const external = await mkdtemp(join(root, 'synthetic-inode-'));
  t.after(async () => {
    await rm(run, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  });
  const recorded = cliRun('record', id, JSON.stringify(result('ENV-01', 'nas', { runId: id })));
  assert.equal(recorded.status, 0, recorded.stderr);
  const { name } = JSON.parse(recorded.stdout);
  const raw = await readFile(join(run, name));
  await link(join(run, name), join(external, 'external'));
  await writeFile(join(run, '.pending-' + name + '-' + randomUUID()), raw, { mode: 0o600 });
  assert.equal(cliRun('report', id).status, 1);
});

test('assess and render cannot emit untrusted attachment paths or signed URLs', async () => {
  const secretUrl = 'https://example.invalid?signature=PRIVATE_VALUE';
  const index = { caseId: 'ENV-01', kind: 'nas', timestamp, sha256: '3'.repeat(64), name: secretUrl };
  const report = await assessment([result('ENV-01', 'nas')], { indexes: [index] });
  assert.deepEqual(report.indexes, []);
  const { renderReport } = await import('../assess.mjs');
  assert.doesNotMatch(renderReport({ ...report, indexes: [index] }), /PRIVATE_VALUE/);
  const mismatched = { ...index, name: 'record-' + index.sha256 + '.json' };
  assert.deepEqual((await assessment([result('ENV-01', 'nas')], { indexes: [mismatched] })).indexes, []);
});
