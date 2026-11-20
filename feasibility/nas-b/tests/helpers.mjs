import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareDataRoot, readProbeConfig } from '../src/config.mjs';
import { createLeaseManager } from '../src/lease.mjs';
import { openProbeStore } from '../src/store.mjs';

export async function makeSandbox(t) {
  const temporaryDirectory = await realpath(tmpdir());
  const root = await mkdtemp(path.join(temporaryDirectory, 'cangxia-probe-'));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    assert.equal(path.dirname(root), temporaryDirectory);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const config = Object.freeze({
    ...readProbeConfig({
      PROBE_MODE: 'feasibility', PROBE_ROOT: '/probe', PROBE_PORT: '8443',
      PROBE_RUN_ID: 'fixture-run', PROBE_LIBRARY_ID: 'fixture-library'
    }),
    root
  });

  function target(relative) {
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) throw new Error('Fixture item must stay in the sandbox.');
    return file;
  }

  async function exists(relative) {
    try {
      await access(target(relative));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  return {
    root,
    config,
    onCleanup: cleanup => cleanups.push(cleanup),
    prepare: changes => prepareDataRoot({ ...config, ...changes }, { fixtureRoot: root }),
    exists,
    read: relative => readFile(target(relative), 'utf8'),
    async write(relative, content) {
      const file = target(relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, 'utf8');
    },
    async assertUninitialized() {
      for (const name of ['state/library.sqlite', 'state/server.key', 'state/server.pem', 'browser']) {
        assert.equal(await exists(name), false, name);
      }
    }
  };
}

export function fakeClock(start = 0) {
  let time = start;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(callback, delay) {
      const id = Symbol();
      timers.set(id, { callback, deadline: time + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    advance(milliseconds) {
      time += milliseconds;
      for (const [id, { callback, deadline }] of timers) {
        if (deadline > time) continue;
        timers.delete(id);
        callback();
      }
      return time;
    }
  };
}

export function sourceFixture(kind) {
  if (!Object.hasOwn(sourcePages, kind)) throw new Error('Unknown source fixture kind.');
  return {
    source: { kind: 'total', id: '__all__' },
    inputCursor: '0',
    status: 200,
    text: JSON.stringify(sourcePages[kind]),
    observedAt: '2026-01-01T00:00:00.000Z'
  };
}

export async function makeStoreFixture(t, { testHooks, source = { kind: 'total', id: '__all__' } } = {}) {
  const sandbox = await makeSandbox(t);
  const layout = await sandbox.prepare();
  const file = path.join(layout.state, 'library.sqlite');
  const libraryId = sandbox.config.libraryId;
  const reopen = options => {
    const opened = openProbeStore({ file, libraryId, ...options });
    sandbox.onCleanup(() => opened.close());
    return opened;
  };
  const store = reopen({ initialize: true, testHooks });
  const job = store.createReadJob({ id: 'fixture-job', source, epoch: 1, authEpoch: 2 });
  const opId = 'fixture-page';
  const command = page => ({ jobId: job.id, epoch: job.epoch, authEpoch: job.authEpoch, operationId: opId, page });
  return { store, file, libraryId, job, opId, command, reopen };
}

export async function makeLeaseFixture(t) {
  const fixture = await makeStoreFixture(t);
  const clock = fakeClock();
  const manager = (store = fixture.store, bootId = 'fixture-boot') => createLeaseManager({ store, clock, bootId });
  const client = name => ({ deviceId: 'same-device', instanceId: name, operationId: 'acquire-' + name });
  return { ...fixture, clock, manager, client, leases: manager() };
}

const sourcePages = JSON.parse(
  readFileSync(new URL('../fixtures/source-pages.json', import.meta.url), 'utf8'),
  (key, value, context) => typeof value === 'number' && !Number.isSafeInteger(value)
    ? JSON.rawJSON(context.source) : value
);
