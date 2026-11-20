import assert from 'node:assert/strict';
import test from 'node:test';
import { assertJobEpoch } from '../src/lease.mjs';
import { parseSourcePage } from '../src/page-parser.mjs';
import { makeLeaseFixture, sourceFixture } from './helpers.mjs';

test('independent SQLite connections grant only one instance, even on the same device', async t => {
  const f = await makeLeaseFixture(t);
  const other = f.manager(f.reopen());
  assert.deepEqual(other.status(), { occupied: false });
  const first = f.leases.acquire(f.client('a'));
  assert.deepEqual(other.status(), { occupied: true });
  assert.throws(() => other.acquire(f.client('b')), { code: 'LIBRARY_IN_USE' });
  assert.throws(() => other.assertLease({ ...first, instanceId: 'b' }), { code: 'STALE_LEASE' });
  const otherProof = (first.proof[0] === '0' ? '1' : '0') + first.proof.slice(1);
  assert.throws(() => other.assertLease({ ...first, proof: otherProof }), { code: 'STALE_LEASE' });
  assert.doesNotThrow(() => other.assertLease(first));
});

test('expiry at twenty seconds cancels once and fences the old instance before handoff', async t => {
  const f = await makeLeaseFixture(t);
  const lost = [];
  f.leases.onLost(info => {
    assert.equal(f.store.db.isTransaction, false);
    lost.push(info.generation);
  });
  const draft = { ...f.client('a'), ttlMs: 300_000, expiresAt: 300_000 };
  const first = f.leases.acquire(draft);
  assert.equal(first.ttlMs, 20_000);
  f.clock.advance(19_999);
  assert.doesNotThrow(() => f.leases.assertLease(first));
  assert.deepEqual(lost, []);
  f.store.withWrite(() => {
    f.clock.advance(1);
    assert.deepEqual(lost, []);
  });
  await Promise.resolve();
  assert.deepEqual(lost, [first.generation]);
  assert.deepEqual(f.leases.status(), { occupied: false });
  f.clock.advance(-5_000);
  assert.throws(() => f.leases.renew({ ...first, expiresAt: 300_000 }), { code: 'STALE_LEASE' });
  const second = f.leases.acquire(f.client('b'));
  assert.ok(second.generation > first.generation);
  assert.throws(() => f.leases.release(first, 'stale-release'), { code: 'STALE_LEASE' });
  assert.doesNotThrow(() => f.leases.assertLease(second));
  await Promise.resolve();
  assert.deepEqual(lost, [first.generation]);
});

test('renewal supersedes the previously scheduled expiration', async t => {
  const f = await makeLeaseFixture(t);
  const lost = [];
  f.leases.onLost(info => lost.push(info.generation));
  const first = f.leases.acquire(f.client('a'));
  f.clock.advance(5_000);
  const renewed = f.leases.renew({ ...first, expiresAt: 300_000 });
  assert.equal(renewed.expiresAt, 25_000);
  assert.equal(renewed.generation, first.generation);
  f.clock.advance(15_000);
  assert.doesNotThrow(() => f.leases.assertLease(renewed));
  await Promise.resolve();
  assert.deepEqual(lost, []);
  f.clock.advance(5_000);
  await Promise.resolve();
  assert.deepEqual(lost, [first.generation]);
});

test('a fresh boot invalidates a persisted grant and preserves generation on a reopened store', async t => {
  const f = await makeLeaseFixture(t);
  const first = f.leases.acquire(f.client('a'));
  const fresh = f.manager(f.reopen(), 'fixture-reboot');
  assert.deepEqual(fresh.status(), { occupied: false });
  assert.throws(() => f.leases.assertLease(first), { code: 'STALE_LEASE' });
  assert.throws(() => f.leases.acquire(f.client('c')), { code: 'STALE_LEASE' });
  assert.throws(() => fresh.renew(first), { code: 'STALE_LEASE' });
  assert.throws(() => fresh.acquire(f.client('a')), { code: 'STALE_LEASE' });
  assert.equal(fresh.acquire(f.client('b')).generation, first.generation + 1);
});

test('acquire confirmation replay is scoped to the original live operation', async t => {
  const f = await makeLeaseFixture(t);
  const intent = f.client('a');
  const first = f.leases.acquire(intent);
  assert.deepEqual(f.leases.acquire(intent), first);
  assert.throws(() => f.leases.acquire({ ...intent, deviceId: 'another-device' }), {
    code: 'PROBE_OPERATION_CONFLICT'
  });
  assert.throws(() => f.leases.acquire({ ...intent, instanceId: 'another-instance' }), {
    code: 'PROBE_OPERATION_CONFLICT'
  });
  assert.throws(() => f.leases.acquire({ ...intent, operationId: 'different-acquire' }), {
    code: 'LIBRARY_IN_USE'
  });
  const receipt = f.store.operation(intent.operationId);
  assert.equal(receipt.operationId, intent.operationId);
  assert.ok(!JSON.stringify(receipt).includes(first.proof));
  assert.equal(f.store.operation('different-acquire'), null);
  const metadata = f.store.db.prepare('SELECT value FROM runtime_meta').all();
  assert.ok(!JSON.stringify(metadata).includes(first.proof));
});

test('release confirmation replay returns the original receipt without affecting a successor', async t => {
  const f = await makeLeaseFixture(t);
  const lost = [];
  f.leases.onLost(info => lost.push(info.generation));
  const first = f.leases.acquire(f.client('a'));
  const receipt = f.leases.release(first, 'release-a');
  assert.deepEqual(receipt, f.store.operation('release-a'));
  assert.ok(!JSON.stringify(receipt).includes(first.proof));
  const second = f.leases.acquire(f.client('b'));
  assert.deepEqual(f.leases.release(first, 'release-a'), receipt);
  assert.throws(() => f.leases.release(second, 'release-a'), { code: 'PROBE_OPERATION_CONFLICT' });
  assert.throws(() => f.leases.release(first, f.client('a').operationId), { code: 'PROBE_OPERATION_CONFLICT' });
  assert.doesNotThrow(() => f.leases.assertLease(second));
  await Promise.resolve();
  assert.deepEqual(lost, [first.generation]);
});

test('release rejects malformed holder identity before hashing the command', async t => {
  const f = await makeLeaseFixture(t);
  const lease = f.leases.acquire(f.client('a'));
  const malformed = {};
  malformed.self = malformed;
  assert.throws(() => f.leases.release({ ...lease, generation: malformed }, 'bad-release'), {
    code: 'STALE_LEASE'
  });
  assert.equal(f.store.operation('bad-release'), null);
  assert.doesNotThrow(() => f.leases.assertLease(lease));
});

test('source page guards enforce job identity and cursor after the interactive lease ends', async t => {
  const f = await makeLeaseFixture(t);
  const interactive = f.leases.acquire(f.client('a'));
  f.leases.release(interactive, 'release-a');
  const page = parseSourcePage(sourceFixture('two-works'));
  const command = f.command(page);
  const guard = identity => assertJobEpoch(f.store, identity);
  assert.throws(() => f.store.commitPage({ ...command, epoch: command.epoch + 1 }, guard), {
    code: 'STALE_JOB_EPOCH'
  });
  assert.throws(() => f.store.commitPage({ ...command, authEpoch: command.authEpoch - 1 }, guard), {
    code: 'STALE_JOB_EPOCH'
  });
  assert.throws(() => f.store.commitPage({ ...command, authEpoch: undefined }, guard), {
    code: 'INVALID_PROBE_JOB'
  });
  const identity = { jobId: command.jobId, epoch: command.epoch, authEpoch: command.authEpoch, inputCursor: '0' };
  assert.throws(() => guard({ ...identity, inputCursor: '1' }), { code: 'STALE_PAGE_CURSOR' });
  assert.throws(() => guard({ ...identity, jobId: 'unknown' }), { code: 'PROBE_JOB_UNKNOWN' });
  const committed = f.store.commitPage(command, guard);
  assert.equal(committed.savedPages, 1);
  assert.deepEqual(f.store.commitPage(command, guard), committed);
  f.store.withWrite(db => db.prepare('UPDATE source_jobs SET auth_epoch=auth_epoch+1 WHERE id=?').run(command.jobId));
  assert.throws(() => guard(identity), { code: 'STALE_JOB_EPOCH' });
  assert.throws(() => f.store.commitPage(command, guard), { code: 'STALE_JOB_EPOCH' });
});
