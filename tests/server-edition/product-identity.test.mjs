import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../..', import.meta.url));
const baseline = '08e6436522a3828211e9c32b51f90d7d830b4fa8';
const baselineFile = file => git('show', baseline + ':' + file);
const read = file => readFileSync(path.join(root, file), 'utf8');
const readJSON = file => JSON.parse(read(file));
const expectedIdentity = {
  productName: '藏匣服务版',
  version: '0.4.1',
  appId: 'local.cangxia.server',
  protocolVersion: 1
};

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function loadPreload(source, ipcRenderer) {
  let api;
  runInNewContext(source, {
    require(dependency) {
      assert.equal(dependency, 'electron');
      return {
        contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'cangxia'); api = value; } },
        ipcRenderer
      };
    }
  });
  assert.ok(api);
  return api;
}

test('product-identity exposes the independent Windows and protocol identity', async () => {
  const { serverIdentity: info } = await import('../../shared/server-identity.mjs');
  const manifest = readJSON('package.json');
  const lock = readJSON('package-lock.json');
  const backup = JSON.parse(baselineFile('package.json'));
  assert.equal(info.version, '0.4.1');
  assert.deepEqual(info, expectedIdentity);
  assert.equal(manifest.version, info.version);
  assert.equal(manifest.build.productName, info.productName);
  assert.equal(manifest.build.appId, info.appId);
  assert.notEqual(manifest.name, backup.name);
  assert.notEqual(manifest.build.appId, backup.build.appId);
  assert.notEqual(manifest.build.nsis.shortcutName, backup.build.nsis.shortcutName);
  assert.equal(manifest.build.nsis.shortcutName, info.productName);
  assert.equal(manifest.build.nsis.artifactName, 'CangXia-Server-${version}-Setup-x64.exe');
  assert.equal(manifest.build.portable.artifactName, 'CangXia-Server-${version}-Windows-x64.exe');
  assert.equal(manifest.build.directories.output, 'release/server');
  assert.equal(manifest.build.nsis.oneClick, true);
  assert.equal(manifest.build.nsis.perMachine, false);
  assert.equal(manifest.build.nsis.createDesktopShortcut, true);
  assert.equal(manifest.build.nsis.createStartMenuShortcut, true);
  assert.equal(manifest.build.nsis.deleteAppDataOnUninstall, false);
  for (const spec of [lock, lock.packages['']]) {
    assert.equal(spec.name, manifest.name);
    assert.equal(spec.version, info.version);
  }
});

test('product-identity keeps the backup profile outside the server userData root', async t => {
  const { serverProfilePath } = await import('../../shared/server-identity.mjs');
  const appData = mkdtempSync(path.join(os.tmpdir(), 'cangxia-edition-profile-'));
  t.after(() => rmSync(appData, { recursive: true, force: true }));
  const backupProfile = path.join(appData, '藏匣备份版');
  mkdirSync(backupProfile);
  const backupSentinel = path.join(backupProfile, 'library.sqlite');
  writeFileSync(backupSentinel, 'isolated backup fixture');

  const serverProfile = serverProfilePath(appData);
  assert.notEqual(serverProfile, backupProfile);
  assert.equal(serverProfile, path.join(appData, '藏匣服务版'));
  mkdirSync(serverProfile);
  assert.equal(existsSync(path.join(serverProfile, 'library.sqlite')), false);
  assert.equal(readFileSync(backupSentinel, 'utf8'), 'isolated backup fixture');
});

test('product-identity works when packaging strips the build configuration', async t => {
  const packaged = mkdtempSync(path.join(os.tmpdir(), 'cangxia-edition-package-'));
  t.after(() => rmSync(packaged, { recursive: true, force: true }));
  const manifest = readJSON('package.json');
  delete manifest.build;
  writeFileSync(path.join(packaged, 'package.json'), JSON.stringify(manifest));
  mkdirSync(path.join(packaged, 'shared'));
  const entry = path.join(packaged, 'shared', 'server-identity.mjs');
  copyFileSync(path.join(root, 'shared', 'server-identity.mjs'), entry);
  const { serverIdentity: info } = await import(pathToFileURL(entry).href);
  assert.deepEqual(info, expectedIdentity);
});

test('product-identity is available through the renderer preload boundary', async () => {
  const api = loadPreload(read('electron/preload.cjs'), {
    async invoke(channel) {
      assert.equal(channel, 'cangxia:serverIdentity');
      return { ok: true, data: expectedIdentity };
    }
  });
  assert.equal(typeof api.serverIdentity, 'function');
  assert.deepEqual(await api.serverIdentity(), expectedIdentity);
});

test('compatibility matrix maps baseline page calls, handlers, and preload events', async () => {
  const main = baselineFile('electron/main.mjs');
  const quotedNames = source => [...source.matchAll(/['"]([A-Za-z][\w-]*)['"]/g)].map(match => match[1]);
  const handlerCalls = [...main.matchAll(/\bhandler\(['"]([A-Za-z]+)['"]/g)].map(match => match[1]);
  const handlerLoops = [...main.matchAll(/for\(const name of \[([^\]]+)\]\)handler\(name,/g)];
  const handlers = new Set([...handlerCalls, ...handlerLoops.flatMap(match => quotedNames(match[1]))]);
  // Fail if an unexamined registration form is added to the frozen baseline selection.
  assert.equal([...main.matchAll(/\bhandler\(/g)].length, handlerCalls.length + handlerLoops.length + 1);
  assert.equal([...main.matchAll(/\bipcMain\.handle\(/g)].length, 1);
  assert.ok(handlers.has('prepareNASRemoval'));
  assert.ok(handlers.has('confirmDelete'));

  const events = new Map();
  const invoked = new Set();
  const api = loadPreload(baselineFile('electron/preload.cjs'), {
    async invoke(channel) {
      invoked.add(channel.slice('cangxia:'.length));
      if (channel === 'cangxia:state') return { ok: true, data: { chunkedState: true, head: {}, total: 1 } };
      if (channel === 'cangxia:stateChunk') return { ok: true, data: { works: [{ id: '1' }] } };
      return { ok: true, data: null };
    },
    on(channel, listener) { events.set(channel, listener); },
    removeListener(channel, listener) { assert.equal(events.get(channel), listener); }
  });
  const apiEvents = [];
  for (const [name, invoke] of Object.entries(api)) {
    if (name.startsWith('on')) {
      apiEvents.push(name);
      invoke(() => {})();
    } else {
      await invoke();
    }
  }
  const mainEvents = new Set([...main.matchAll(/\.send\(['"](cangxia:[\w-]+)['"]/g)].map(match => match[1]));
  assert.deepEqual(invoked, handlers);
  assert.deepEqual(new Set(events.keys()), mainEvents);

  const pageCalls = new Set();
  const sourceFiles = git('ls-tree', '-r', '--name-only', baseline, 'src').trim().split(/\r?\n/);
  for (const file of sourceFiles.filter(file => file.endsWith('.jsx'))) {
    for (const [, name] of baselineFile(file).matchAll(/\b(?:api|window\.cangxia)(?:\?\.|\.)([A-Za-z]+)(?:\?\.)?\s*\(/g)) {
      pageCalls.add(name);
    }
  }
  const matrixPath = 'docs/server-edition/compatibility.md';
  assert.ok(existsSync(path.join(root, matrixPath)), 'expected the 0.3.46 compatibility matrix');
  const rows = read(matrixPath).split(/\r?\n/).filter(line => line.startsWith('| `'));
  const byEntry = new Map(rows.map(row => {
    const [, entry, ...columns] = row.split('|').map(cell => cell.trim());
    assert.equal(columns.length, 5, row);
    assert.ok(columns.slice(0, 4).every(Boolean), row);
    return [entry.slice(1, -1), columns];
  }));
  assert.equal(byEntry.size, rows.length, 'compatibility entries must be unique');
  const expectedEntries = new Set([
    ...handlers, ...apiEvents, ...pageCalls,
    ...[...main.matchAll(/\bprotocol\.handle\(['"]([\w-]+)['"]/g)].map(match => match[1]),
    'ui:workspace', 'ui:selection', 'ui:media', 'ui:settings', 'ui:close',
    'ui:cover-activation', 'ui:viewer-keys', 'ui:volume', 'ui:exclusive-playback', 'ui:page-jump'
  ]);
  const unmappedBaselineEntries = [...expectedEntries].filter(entry => !byEntry.has(entry)).sort();
  assert.deepEqual(unmappedBaselineEntries, []);
  const taskOwners = {
    setTags: ['07', '09'],
    repairVideoCover: ['09'],
    flatOpen: ['10'],
    confirmScopedDeletion: ['11'],
    exportWorkDiagnostic: ['12'],
    importExistingLibrary: ['13'],
    'ui:cover-activation': ['07', '10', '14'],
    'ui:viewer-keys': ['07', '10', '14'],
    'ui:volume': ['10', '14'],
    'ui:exclusive-playback': ['10', '14'],
    'ui:page-jump': ['07', '14']
  };
  for (const [entry, tasks] of Object.entries(taskOwners)) {
    assert.deepEqual(byEntry.get(entry)[3].split('：', 1)[0].split('、'), tasks, entry);
  }
});
