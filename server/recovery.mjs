import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { connect, describe, inspectLayout, isUuid, verifyIdentity } from './library.mjs';
import { inventory, verifiedSnapshot } from './upgrade.mjs';
import { child, directory, disjoint, fileProof } from './rehearsal-files.mjs';

export async function verifyRestore({ snapshot, mediaRoot, manifestSha256, guard = () => {} }) {
  directory(snapshot);
  directory(mediaRoot);
  disjoint(snapshot, mediaRoot);
  guard();
  if (
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    fs.readdirSync(snapshot).sort().join() !== 'library.sqlite,manifest.json'
  )
    throw Error('需要已封存的快照、独立媒体目录及原始清单摘要。');
  const manifestFile = child(snapshot, 'manifest.json'),
    file = child(snapshot, 'library.sqlite');
  if ((await fileProof(manifestFile)).sha256 !== manifestSha256) throw Error('恢复清单与原始摘要不符。');
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (
    !isUuid(m.libraryId) ||
    !isUuid(m.operationId) ||
    !/^sha256:[a-f0-9]{64}$/.test(m.imageDigest) ||
    (await fileProof(file)).sha256 !== m.databaseSha256
  )
    throw Error('恢复数据库身份或文件摘要不符。');
  const db = new DatabaseSync(pathToFileURL(file).href + '?mode=ro&immutable=1', { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema=OFF');
    if (
      verifyIdentity(db, m.libraryId) !== m.from ||
      db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').get()
    )
      throw Error('恢复数据库结构或完整性不符。');
    const actual = inventory(db);
    if (
      JSON.stringify(actual.counts) !== JSON.stringify(m.counts) ||
      JSON.stringify(actual.media) !== JSON.stringify(m.media)
    )
      throw Error('快照中的业务记录与媒体清单不符。');
  } finally {
    db.close();
  }
  const matched = [],
    missing = [],
    changed = [],
    extra = [];
  const listed = new Set(m.media.map((i) => i.relative_path));
  async function scan(dir, prefix = '') {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      guard();
      const rel = prefix + entry.name;
      if (entry.isDirectory()) await scan(directory(path.join(dir, entry.name)), rel + '/');
      else if (!listed.has(rel)) extra.push(rel);
    }
  }
  await scan(mediaRoot);
  for (const item of m.media) {
    guard();
    try {
      const proof = await fileProof(child(mediaRoot, item.relative_path));
      if (proof.size === item.size && proof.sha256 === item.sha256) matched.push(item.relative_path);
      else changed.push(item.relative_path);
    } catch (e) {
      if (e.code === 'ENOENT') missing.push(item.relative_path);
      else changed.push(item.relative_path);
    }
  }
  guard();
  if (
    (await fileProof(file)).sha256 !== m.databaseSha256 ||
    (await fileProof(manifestFile)).sha256 !== manifestSha256
  )
    throw Error('核验期间恢复点发生变化。');
  return {
    matched,
    missing,
    changed,
    extra,
    libraryId: m.libraryId,
    schema: m.from,
    imageDigest: m.imageDigest,
    createdAt: m.createdAt,
    counts: m.counts,
    databaseVerified: true,
    verified: !missing.length && !changed.length && !extra.length
  };
}
export async function preserveBeforeRollback({
  root,
  libraryId,
  imageDigest,
  confirmed,
  guard = () => {},
  operationId = randomUUID()
}) {
  if (
    confirmed !== true ||
    !isUuid(libraryId) ||
    !isUuid(operationId) ||
    !/^sha256:[a-f0-9]{64}$/.test(imageDigest)
  )
    throw Error('请明确确认要封存的资料库、版本及镜像摘要。');
  const layout = inspectLayout(root, libraryId),
    writer = connect(layout, { writable: true });
  try {
    writer.exec('BEGIN IMMEDIATE');
    guard();
    const status = describe(layout, writer);
    const s = fs.statfsSync(root, { bigint: true });
    if (
      s.bavail * s.bsize <
      BigInt(writer.prepare('PRAGMA page_count').get().page_count) *
        BigInt(writer.prepare('PRAGMA page_size').get().page_size) *
        2n +
        1048576n
    )
      throw Error('快照空间不足。');
    const receipt = await verifiedSnapshot(layout, status, {
      imageDigest,
      rehearsal: true,
      approval: { operationId }
    });
    const snapshot = path.join(layout.dir, receipt.snapshot),
      mediaRoot = path.join(layout.dir, 'media');
    const verification = await verifyRestore({
      snapshot,
      mediaRoot,
      manifestSha256: receipt.manifestSha256,
      guard
    });
    return {
      ...receipt,
      snapshot,
      mediaRoot,
      verified: verification.verified,
      verification,
      requiresExternalCopy: true
    };
  } finally {
    writer.close();
  }
}
