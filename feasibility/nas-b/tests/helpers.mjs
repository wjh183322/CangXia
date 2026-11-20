
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareDataRoot, readProbeConfig } from '../src/config.mjs';

export async function makeSandbox(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'cangxia-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));

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
  return {
    now: () => time,
    advance: milliseconds => { time += milliseconds; return time; }
  };
}

export function sourceFixture(kind) {
  if (kind !== 'unsafe-integer') throw new Error('Unknown source fixture kind.');
  return {
    source: { kind: 'total', id: '__all__' },
    inputCursor: '0',
    status: 200,
    text: '{"status_code":0,"aweme_list":[{"aweme_id":9007199254740993,"desc":"Fixture"}],"has_more":1,"cursor":9007199254740995}',
    observedAt: '2026-01-01T00:00:00.000Z'
  };
}
