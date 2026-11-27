import assert from 'node:assert/strict';
import fs from 'node:fs';

const doc = (name) => fs.readFileSync(new URL('../../docs/server-edition/' + name, import.meta.url), 'utf8');
const rows = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('| `'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())
    );
const names = (field) => [...field.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const migration = new Set([
  'prepareNASRestore',
  'confirmNASRestore',
  'stopNASCatalogue',
  'confirmLegacyAccount',
  'acceptRemoteBackup',
  'openBackupRecovery',
  'previewExistingLibrary',
  'importExistingLibrary'
]);

export function auditEntrypoints(registered, exposed) {
  const expected = rows(doc('compatibility.md'))
    .map((row) => names(row[0])[0])
    .sort();
  const maps = rows(doc('compatibility-runtime.md'));
  assert.deepEqual(maps.map((r) => names(r[0])[0]).sort(), expected);
  const calls = new Set(exposed);
  const unverified = [];
  for (const [entry, status, field] of maps) {
    const [name] = names(entry),
      targets = names(field);
    if (migration.has(name) && (status !== '迁移彩排' || !targets.includes('serverRehearsal'))) unverified.push(name + ' rehearsal');
    if (!targets.length) unverified.push(name + ' missing target');
    if (status === '事件' && !calls.has(name)) unverified.push(name + ' missing subscription');
    if (status === '移除' && (registered.has(name) || calls.has(name)))
      unverified.push(name + ' retired method exposed');
    if (['直连', '同类入口'].includes(status) && (!registered.has(name) || !calls.has(name)))
      unverified.push(name + ' original handler');
    for (const target of targets)
      if (!registered.has(target) || !calls.has(target)) unverified.push(name + ' -> ' + target);
  }
  const events = new Set(['onChange', 'onNotice', 'onServerSession']);
  for (const method of calls)
    if (!events.has(method) && !registered.has(method)) unverified.push('dangling preload ' + method);
  for (const method of registered) if (!calls.has(method)) unverified.push('missing preload ' + method);
  assert.deepEqual(unverified, []);
  return { rows: maps.length, handlers: registered.size, migration: migration.size };
}
