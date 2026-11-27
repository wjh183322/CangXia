import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { catalogueRevision, confirmedSelection } from './catalogue.mjs';
import { removeMembership } from './memberships.mjs';
import { createTrashAdapter } from './trash.mjs';
import { registeredAssetProof, withWorkFiles } from './files.mjs';
import { failure } from './service-error.mjs';
import { writeDurably } from './library.mjs';

const error = (message) => failure(409, 'REMOVAL_REVIEW', message);
const stale = () => error('资料、选择或删除回执已变化，请重新预览。');
const checkBin = '请在 NAS 设置中核对共享文件夹的回收站、权限和保留期限，再用绿联回收站还原验证样本。';
const parse = (row) => row && { ...row, body: JSON.parse(row.body) };
const sourceOf = (key) =>
  key === 'total'
    ? { kind: 'total', id: '__all__' }
    : key?.startsWith('folder:')
      ? { kind: 'collection', id: key.slice(7) }
      : key?.startsWith('author:')
        ? { kind: 'author', id: key.slice(7) }
        : null;
const belongs = (owner, b) =>
  b.body.boot === owner.grant.bootId && b.body.generation === owner.grant.generation;
const sourceAccount = (db) =>
  db.prepare('SELECT uid FROM source_account WHERE singleton=1').get()?.uid ?? null;
const previewOwner = (owner) => ({ boot: owner.grant.bootId, generation: owner.grant.generation });
const allItems = (db, token) =>
  db.prepare('SELECT * FROM removal_items WHERE token=? ORDER BY ordinal').all(token).map(parse);
const putItem = (db, token, ordinal, id, body) =>
  db
    .prepare("INSERT INTO removal_items VALUES(?,?,?,'ready',?)")
    .run(token, ordinal, id, JSON.stringify(body));
function batch(db, token, owner) {
  const b = parse(
    db.prepare('SELECT * FROM removal_batches WHERE token=? AND account=?').get(token, owner.who.accountId)
  );
  if (!b) throw stale();
  return b;
}
function mark(db, token, state, body) {
  db.prepare('UPDATE removal_batches SET state=?,body=? WHERE token=?').run(
    state,
    JSON.stringify(body),
    token
  );
}
function newBatch(db, owner, scope, body) {
  const token = randomUUID(),
    revision = catalogueRevision(db);
  db.prepare("INSERT INTO removal_batches VALUES(?,?,?,?,'preview',?,?)").run(
    token,
    owner.who.accountId,
    scope,
    revision,
    Date.now(),
    JSON.stringify({ ...body, ...previewOwner(owner) })
  );
  return token;
}
function fileBusy(db, id, except = '') {
  return !!db
    .prepare(
      `SELECT 1 FROM download_jobs WHERE work_id=? AND state NOT IN ('complete','cancelled','failed')
    UNION ALL SELECT 1 FROM file_commits WHERE work_id=? AND stage NOT IN ('registered','cleaned','cancelled')
    UNION ALL SELECT 1 FROM archive_state WHERE work_id=? AND revision<>completed
    UNION ALL SELECT 1 FROM removal_items i JOIN removal_batches b ON b.token=i.token WHERE i.work_id=? AND b.token<>?
    AND b.scope IN ('files','restore-files') AND b.state IN ('running','paused','restoring') AND i.state='ready' LIMIT 1`
    )
    .get(id, id, id, id, except);
}
export function removalOwnsFiles(db, id) {
  return !!db
    .prepare(
      `SELECT 1 FROM removal_items i JOIN removal_batches b ON b.token=i.token WHERE i.work_id=?
    AND b.scope IN ('files','restore-files') AND b.state IN ('running','paused','restoring') AND i.state='ready' LIMIT 1`
    )
    .get(id);
}
function resource(db, file) {
  const row = db.prepare('SELECT * FROM archive_resources WHERE id=?').get(file.id);
  if (
    !row ||
    ['key', 'kind', 'mime', 'revision', 'work_id', 'relative_path', 'size', 'sha256'].some(
      (k) => row[k] !== file[k]
    )
  )
    throw stale();
  const proof = registeredAssetProof(db, file.work_id, row);
  if (!proof || JSON.stringify(proof.identity) !== JSON.stringify(file.identity)) throw stale();
}
function free(db, file) {
  if (
    db
      .prepare(
        `SELECT 1 FROM media_files WHERE id=? OR relative_path=? UNION ALL SELECT 1 FROM archive_resources
    WHERE work_id=? AND key=? LIMIT 1`
      )
      .get(file.id, file.relative_path, file.work_id, file.key)
  )
    throw error('文件登记或原路径已有新版本，请保留两个版本并核对。');
}
function summary(db, b, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw stale();
  const { total, done, restorable } = db
    .prepare(
      "SELECT count(*) total,count(*) FILTER(WHERE state IN ('done','restored')) done,count(*) FILTER(WHERE state='done') restorable FROM removal_items WHERE token=?"
    )
    .get(b.token);
  const items = db
    .prepare('SELECT work_id,state,body FROM removal_items WHERE token=? ORDER BY ordinal LIMIT 20 OFFSET ?')
    .all(b.token, offset)
    .map((row) => {
      const data = JSON.parse(row.body);
      return {
        workId: row.work_id,
        state: row.state,
        title: data.title,
        path: data.file?.relative_path ?? null,
        ...(data.file && {
          sha256: data.file.sha256,
          original: b.body.binding ? path.join(b.body.binding.media.path, data.file.relative_path) : null,
          recycled: b.body.binding ? path.join(b.body.binding.recycle.path, data.file.relative_path) : null
        }),
        size: data.file?.size ?? null
      };
    });
  const { count, files, relations, source, reason, parent } = b.body;
  return {
    token: b.token,
    scope: b.scope,
    state: b.state,
    revision: b.revision,
    count,
    files,
    relations,
    source,
    reason,
    parent: parent ?? null,
    total,
    done,
    restorable,
    cancelling: !!b.body.cancelling,
    cancelled: db
      .prepare("SELECT count(*) n FROM removal_items WHERE token=? AND state='cancelled'")
      .get(b.token).n,
    offset,
    items,
    created: b.created
  };
}
export function createRemovalService({ library, files }) {
  const adapter =
    files &&
    createTrashAdapter({ layout: files.layout, bin: files.bin ?? process.env.CANGXIA_RECYCLE_MEDIA_ROOT });
  const probe = (db) =>
    JSON.parse(db.prepare('SELECT body FROM trash_probe WHERE singleton=1').get()?.body || 'null');
  const saveProbe = (db, p) =>
    db.prepare('INSERT OR REPLACE INTO trash_probe VALUES(1,?)').run(JSON.stringify(p));
  function verified(db) {
    const p = probe(db);
    if (!adapter || !p || p.phase !== 'verified') throw error(checkBin);
    adapter.check(p.binding);
    return p.binding;
  }
  function preview(db, { payload: { scope, selection } }, owner) {
    if (!['membership', 'records', 'files'].includes(scope)) throw stale();
    if (!selection || typeof selection.source !== 'string') throw stale();
    const source = selection.source;
    if (scope === 'membership' && !sourceOf(source))
      throw error('请从总收藏、指定收藏夹或作者来源选择作品。');
    const { count } = confirmedSelection(db, selection, owner);
    const ids = confirmedSelection(db, { ...selection, confirmedCount: count }, owner, { collect: true });
    if (!count) throw stale();
    const token = newBatch(db, owner, scope, {});
    let reason = '',
      binding,
      ordinal = 0,
      files = 0,
      relations = 0;
    if (scope === 'files')
      try {
        binding = verified(db);
      } catch (e) {
        reason = e.message;
      }
    for (const id of ids) {
      const work = db.prepare('SELECT title,body FROM works WHERE id=?').get(id);
      const members = db.prepare('SELECT * FROM source_members WHERE work_id=? ORDER BY source_id').all(id);
      const media = db.prepare('SELECT * FROM media_files WHERE work_id=? ORDER BY relative_path').all(id);
      const tags = db
        .prepare('SELECT tag FROM work_tags WHERE work_id=? ORDER BY tag')
        .all(id)
        .map((r) => r.tag);
      files += media.length;
      relations += scope === 'membership' ? 1 : members.length;
      if (scope === 'files') {
        const home = JSON.parse(
          db.prepare('SELECT body FROM archive_homes WHERE work_id=?').get(id)?.body || 'null'
        );
        if (fileBusy(db, id)) reason = '请先处理此作品正在运行或尚未核对的下载、归档或删除任务。';
        for (const m of media) {
          const row = db.prepare('SELECT * FROM archive_resources WHERE id=?').get(m.id);
          const proof = row && registeredAssetProof(db, id, row);
          if (!proof?.identity || !home?.identity) reason = '文件缺少已登记的归档身份，请先核对 NAS 文件。';
          putItem(db, token, ordinal++, id, {
            title: work.title,
            file: { ...m, ...row, identity: proof?.identity, mtimeNs: proof?.mtimeNs, parent: home?.identity }
          });
        }
      } else {
        const version =
          db
            .prepare('SELECT version FROM membership_removals WHERE source_id=? AND work_id=?')
            .get(source, id)?.version || 0;
        if (scope === 'records' && db.prepare('SELECT 1 FROM removed_work_records WHERE work_id=?').get(id))
          throw stale();
        putItem(db, token, ordinal++, id, {
          title: work.title,
          work: JSON.parse(work.body),
          members,
          tags,
          media,
          version
        });
      }
    }
    if (scope === 'files' && !files) reason = '所选作品没有已登记文件。';
    mark(db, token, 'preview', {
      ...previewOwner(owner),
      count,
      files,
      relations,
      source,
      protocol: 2,
      sourceUid: sourceAccount(db),
      binding,
      reason
    });
    return summary(db, batch(db, token, owner));
  }
  function checkReady(db, b, owner) {
    if (
      b.body.sourceUid !== sourceAccount(db) ||
      b.state !== 'preview' ||
      b.revision !== catalogueRevision(db) ||
      !belongs(owner, b)
    )
      throw stale();
    if (b.body.reason) throw error(b.body.reason);
  }
  function confirm(db, { payload: { token } }, owner) {
    const b = batch(db, token, owner);
    checkReady(db, b, owner);
    if (b.scope.startsWith('restore-')) throw stale();
    for (const item of allItems(db, token)) {
      if (b.scope === 'files') {
        adapter.check(verified(db));
        adapter.check(b.body.binding);
        if (fileBusy(db, item.work_id)) throw stale();
        resource(db, item.body.file);
      } else {
        if (b.scope === 'membership')
          removeMembership(db, {
            workId: item.work_id,
            source: sourceOf(b.body.source),
            expectedVersion: item.body.version
          });
        else db.prepare('INSERT INTO removed_work_records VALUES(?,?)').run(item.work_id, token);
        db.prepare("UPDATE removal_items SET state='done' WHERE token=? AND ordinal=?").run(
          token,
          item.ordinal
        );
      }
    }
    mark(db, token, b.scope === 'files' ? 'running' : 'done', b.body);
    return summary(db, batch(db, token, owner));
  }
  function previewRestore(db, { payload: { token } }, owner) {
    const prior = batch(db, token, owner);
    if (prior.body.sourceUid !== sourceAccount(db)) throw stale();
    if (prior.scope === 'membership')
      throw error('请重新读取对应来源；只有该来源返回作品并提交该页后才会恢复归属。');
    if (
      !['done', 'paused', 'cancelled'].includes(prior.state) ||
      (prior.state === 'paused' && active.has(token)) ||
      !['records', 'files'].includes(prior.scope)
    )
      throw stale();
    const completed = allItems(db, token).filter((i) => i.state === 'done');
    if (!completed.length) throw stale();
    const scope = 'restore-' + prior.scope,
      body = { ...prior.body, parent: token, priorState: prior.state, cancelling: false, reason: '' };
    if (prior.scope === 'files') {
      body.files = completed.length;
      body.count = new Set(completed.map((i) => i.work_id)).size;
    }
    if (prior.scope === 'files')
      try {
        verified(db);
        adapter.check(body.binding);
      } catch (e) {
        body.reason = e.message;
      }
    if (prior.scope === 'files' && !body.reason) {
      for (const i of completed)
        try {
          free(db, i.body.file);
          if (adapter.originalOccupied(i.body.file, body.binding))
            throw error('原路径已被占用，请保留两份文件并核对：' + i.body.file.relative_path);
        } catch (e) {
          body.reason = e.status ? e.message : '无法验证原目录，请核对原路径和挂载。';
          break;
        }
    }
    const next = newBatch(db, owner, scope, body);
    for (const item of completed) {
      const { attempt, ...saved } = item.body;
      putItem(db, next, item.ordinal, item.work_id, saved);
    }
    return summary(db, batch(db, next, owner));
  }
  function restore(db, { payload: { token } }, owner) {
    const b = batch(db, token, owner);
    if (b.scope === 'membership') throw error('请重新读取对应来源以恢复归属。');
    checkReady(db, b, owner);
    if (
      !b.scope.startsWith('restore-') ||
      batch(db, b.body.parent, owner).state !== b.body.priorState ||
      (b.body.priorState === 'paused' && active.has(b.body.parent))
    )
      throw stale();
    for (const item of allItems(db, token)) {
      if (b.scope === 'restore-records') {
        if (
          !db
            .prepare('DELETE FROM removed_work_records WHERE work_id=? AND token=?')
            .run(item.work_id, b.body.parent).changes
        )
          throw stale();
        db.prepare("UPDATE removal_items SET state='done' WHERE token=? AND ordinal=?").run(
          token,
          item.ordinal
        );
      } else {
        verified(db);
        adapter.check(b.body.binding);
        if (fileBusy(db, item.work_id, b.body.parent)) throw stale();
        free(db, item.body.file);
        if (
          db
            .prepare('SELECT state FROM removal_items WHERE token=? AND ordinal=?')
            .get(b.body.parent, item.ordinal)?.state !== 'done'
        )
          throw stale();
      }
    }
    mark(db, token, b.scope === 'restore-files' ? 'running' : 'done', b.body);
    db.prepare('UPDATE removal_batches SET state=? WHERE token=?').run(
      b.scope === 'restore-files' ? 'restoring' : 'restored',
      b.body.parent
    );
    return summary(db, batch(db, token, owner));
  }
  const active = new Map();
  let closed = false;
  async function run(token) {
    const b = library.read((db) =>
      parse(db.prepare('SELECT * FROM removal_batches WHERE token=?').get(token))
    );
    if (!b || b.state !== 'running') return;
    while (!closed) {
      const item = library.read((db) => {
        if (db.prepare('SELECT state FROM removal_batches WHERE token=?').get(token)?.state !== 'running')
          return;
        return parse(
          db
            .prepare("SELECT * FROM removal_items WHERE token=? AND state='ready' ORDER BY ordinal LIMIT 1")
            .get(token)
        );
      });
      if (!item) {
        library.write((db) => {
          if (db.prepare("SELECT 1 FROM removal_items WHERE token=? AND state='ready' LIMIT 1").get(token))
            return;
          mark(db, token, b.body.cancelling ? 'cancelled' : 'done', { ...b.body, reason: '' });
          if (b.scope === 'restore-files') {
            const remaining = db
              .prepare("SELECT 1 FROM removal_items WHERE token=? AND state='ready' LIMIT 1")
              .get(b.body.parent);
            db.prepare('UPDATE removal_batches SET state=? WHERE token=?').run(
              remaining
                ? 'paused'
                : db
                      .prepare("SELECT 1 FROM removal_items WHERE token=? AND state='done' LIMIT 1")
                      .get(b.body.parent)
                  ? b.body.priorState === 'cancelled'
                    ? 'cancelled'
                    : 'done'
                  : 'restored',
              b.body.parent
            );
          }
        });
        return;
      }
      const f = item.body.file;
      try {
        await withWorkFiles(files.layout, item.work_id, async () => {
          const restoring = b.scope === 'restore-files';
          function guard(db) {
            if (b.body.sourceUid !== sourceAccount(db)) throw stale();
            verified(db);
            adapter.check(b.body.binding);
            const currentHome = JSON.parse(
              db.prepare('SELECT body FROM archive_homes WHERE work_id=?').get(item.work_id)?.body || 'null'
            );
            if (JSON.stringify(currentHome?.identity) !== JSON.stringify(f.parent)) throw stale();
            if (restoring) free(db, f);
            else resource(db, f);
          }
          const previous = item.body.attempt || item.body.receiptPaths;
          const options = {
            paths: previous,
            rebound: !!b.body.previousBinding,
            allowSettled: !!item.body.attempt || b.body.protocol !== 2,
            beforeMove(paths) {
              library.write((db) => {
                guard(db);
                item.body.attempt = paths;
                db.prepare('UPDATE removal_items SET body=? WHERE token=? AND ordinal=?').run(
                  JSON.stringify(item.body),
                  token,
                  item.ordinal
                );
              });
            }
          };
          let observed;
          if (b.body.cancelling) {
            if (!restoring) {
              const intact = await adapter.intactOriginal(f, b.body.binding, previous);
              if (intact) {
                library.write((db) => {
                  intact();
                  db.prepare("UPDATE removal_items SET state='cancelled' WHERE token=? AND ordinal=?").run(
                    token,
                    item.ordinal
                  );
                });
                return;
              }
            }
            observed = await adapter.inspect(f, b.body.binding, options);
            const origin = restoring ? observed.recycled : observed.original,
              destination = restoring ? observed.original : observed.recycled;
            if (origin === 'owned') {
              library.write((db) => {
                adapter.assertObserved(f, b.body.binding, observed);
                db.prepare("UPDATE removal_items SET state='cancelled' WHERE token=? AND ordinal=?").run(
                  token,
                  item.ordinal
                );
              });
              return;
            }
            if (origin !== 'missing' || destination !== 'owned')
              throw error('上次移动的结果仍待核对，请恢复原目录或回收位置后再次核对。');
          } else {
            library.read(guard);
            observed = await adapter[restoring ? 'restore' : 'trash'](f, b.body.binding, options);
            files.store.fileHook('afterRemovalMove', { token, file: f, restoring });
          }
          library.write((db) => {
            guard(db);
            adapter.assertObserved(f, b.body.binding, observed);
            if (restoring) {
              db.prepare("UPDATE removal_items SET state='restored' WHERE token=? AND ordinal=?").run(
                b.body.parent,
                item.ordinal
              );
              db.prepare('INSERT INTO media_files VALUES(?,?,?,?,?)').run(
                f.id,
                f.work_id,
                f.relative_path,
                f.size,
                f.sha256
              );
              const version = db
                .prepare('UPDATE download_options SET revision=max(revision,?)+1 RETURNING revision')
                .get(f.revision).revision;
              db.prepare('INSERT INTO archive_assets VALUES(?,?,?,?,?)').run(
                f.id,
                f.key,
                f.kind,
                f.mime,
                version
              );
              db.prepare(
                "UPDATE file_commits SET body=json_remove(body,'$.registeredChangeNs') WHERE work_id=? AND resource_id=? AND stage='registered'"
              ).run(f.work_id, f.id);
            } else {
              db.prepare('DELETE FROM archive_assets WHERE id=?').run(f.id);
              db.prepare('DELETE FROM media_files WHERE id=?').run(f.id);
            }
            db.prepare("UPDATE removal_items SET state='done',body=? WHERE token=? AND ordinal=?").run(
              JSON.stringify({ ...item.body, receiptPaths: observed.paths }),
              token,
              item.ordinal
            );
          });
        });
      } catch (e) {
        library.write((db) =>
          mark(db, token, 'paused', {
            ...b.body,
            reason:
              f.relative_path +
              ' — ' +
              (e.status ? e.message : '文件处理暂停，请检查回收位置、磁盘权限和路径冲突。')
          })
        );
        return;
      }
    }
  }
  function control(db, { payload: { token, action } }, owner) {
    const b = batch(db, token, owner);
    if (action === 'rebind') {
      if (
        !['files', 'restore-files'].includes(b.scope) ||
        !['paused', 'done', 'cancelled'].includes(b.state) ||
        active.has(token)
      )
        throw stale();
      const current = verified(db),
        previous = b.body.binding;
      if (!adapter.sameVolume(previous, current) || JSON.stringify(previous) === JSON.stringify(current))
        throw error('只能重新绑定已完成新验证的同一卷、原媒体目录、回收目录及服务身份。');
      mark(db, token, b.state, { ...b.body, previousBinding: previous, binding: current });
      return { token };
    }
    if (
      !['files', 'restore-files'].includes(b.scope) ||
      !['running', 'paused'].includes(b.state) ||
      !['pause', 'resume', 'cancel'].includes(action)
    )
      throw stale();
    if (action === 'cancel') {
      if (b.state !== 'paused' || active.has(token)) throw error('请先暂停并等待当前文件完成核对。');
      if (b.body.protocol === 2)
        db.prepare(
          "UPDATE removal_items SET state='cancelled' WHERE token=? AND state='ready' AND json_extract(body,'$.attempt') IS NULL"
        ).run(token);
      b.body.cancelling = true;
    }
    mark(db, token, action === 'pause' ? 'paused' : 'running', { ...b.body, reason: '' });
    return { token };
  }
  function startProbe(db, { payload }, owner) {
    if (
      !adapter ||
      payload.supported !== true ||
      typeof payload.reference !== 'string' ||
      !payload.reference.trim() ||
      payload.reference.length > 400 ||
      typeof payload.retention !== 'string' ||
      !payload.retention.trim() ||
      payload.retention.length > 160
    )
      throw error('请填写厂商对当前机型、固件和服务端映射的支持文档或工单编号，以及已核对的清理期限。');
    const binding = adapter.binding(),
      old = probe(db);
    if (old && !['verified', 'failed'].includes(old.phase)) throw error('请先完成已有验证或明确结束该验证。');
    const token = randomUUID(),
      relative_path = '藏匣回收验证-' + token + '/样本-' + token + '.txt';
    saveProbe(db, {
      token,
      account: owner.who.accountId,
      phase: 'create',
      binding,
      relative_path,
      reference: payload.reference.trim(),
      retention: payload.retention.trim()
    });
    return { probeToken: token };
  }
  function controlProbe(db, { payload: { token, action, observed } }, owner) {
    const p = probe(db);
    if (!p || p.token !== token || p.account !== owner.who.accountId || active.has(token)) throw stale();
    if (action === 'end') {
      saveProbe(db, {
        ...p,
        phase: 'failed',
        reason: '验证已结束；样本保留，可按上述文件名在原路径或回收站找回。'
      });
      return {};
    }
    adapter.check(p.binding);
    if (action === 'verify' && p.phase === 'await-native' && observed === true) {
      p.phase = 'check-native';
      p.observed = true;
    } else if (
      action !== 'retry' ||
      !['create', 'move', 'check-native', 'second-trash', 'second-restore'].includes(p.phase)
    )
      throw stale();
    delete p.reason;
    saveProbe(db, p);
    return { probeToken: token };
  }
  async function runProbe(token) {
    let p = library.read(probe);
    if (!p || p.token !== token) return;
    const save = (phase) => {
      p = { ...p, phase };
      library.write((db) => saveProbe(db, p));
    };
    try {
      adapter.check(p.binding);
      if (p.phase === 'create') {
        const bytes = Buffer.from('Cangxia NAS recovery test ' + token),
          file = path.join(files.layout.media, p.relative_path);
        fs.mkdirSync(path.dirname(file), { mode: 0o700 });
        writeDurably(file, bytes);
        const stat = fs.lstatSync(file, { bigint: true });
        const parent = fs.lstatSync(path.dirname(file), { bigint: true });
        p.file = {
          relative_path: p.relative_path,
          identity: { dev: String(stat.dev), ino: String(stat.ino) },
          parent: { dev: String(parent.dev), ino: String(parent.ino) },
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex')
        };
        save('move');
      }
      if (p.phase === 'move') {
        await adapter.trash(p.file, p.binding);
        save('await-native');
        return;
      }
      if (p.phase === 'check-native') {
        const status = await adapter.inspect(p.file, p.binding);
        if (status.original !== 'owned' || status.recycled !== 'missing') {
          save('await-native');
          throw error('绿联还原后的原路径、文件身份或 SHA-256 尚未通过核对。');
        }
        save('second-trash');
      }
      if (p.phase === 'second-trash') {
        await adapter.trash(p.file, p.binding);
        save('second-restore');
      }
      if (p.phase === 'second-restore') {
        await adapter.restore(p.file, p.binding);
        save('verified');
      }
    } catch (e) {
      p.reason =
        e.code === 'TRASH_REVIEW' || e.status
          ? e.message
          : '样本操作未完成，请检查共享目录映射、权限和样本位置。';
      library.write((db) => saveProbe(db, p));
    }
  }
  const commands = {
    'preview-removal': preview,
    'confirm-removal': confirm,
    'preview-restore': previewRestore,
    'restore-removal': restore,
    'control-removal': control,
    'start-trash-probe': startProbe,
    'control-trash-probe': controlProbe
  };
  function receiptView(db, b, offset) {
    const value = summary(db, b, offset);
    if (
      !b.body.binding ||
      !['files', 'restore-files'].includes(b.scope) ||
      !['done', 'paused', 'cancelled'].includes(b.state)
    )
      return value;
    try {
      const current = verified(db);
      if (JSON.stringify(current) !== JSON.stringify(b.body.binding)) {
        value.rebindRequired = !!adapter.sameVolume(b.body.binding, current);
        value.reason = value.rebindRequired
          ? '已验证同一个卷和目录的新挂载。请明确重新绑定此回执，处理文件时将再次核对身份和内容。'
          : '卷、原目录、回收目录或服务身份不符，请找回原位置。';
      }
    } catch (e) {
      value.reason = value.reason || e.message;
    }
    return value;
  }
  const queries = {
    'removal-status': (db, { token, offset }, owner) => receiptView(db, batch(db, token, owner), offset),
    'removal-history': (db, { offset = 0 }, owner) => {
      if (!Number.isSafeInteger(offset) || offset < 0) throw stale();
      return db
        .prepare(
          "SELECT * FROM removal_batches WHERE account=? AND state<>'preview' ORDER BY created DESC,rowid DESC LIMIT 20 OFFSET ?"
        )
        .all(owner.who.accountId, offset)
        .map((row) => receiptView(db, parse(row)));
    },
    'trash-status': (db, input, owner) => {
      const p = probe(db);
      let verifiedNow = false,
        reason = '';
      try {
        verified(db);
        verifiedNow = true;
      } catch (e) {
        reason = e.message;
      }
      if (!p || p.account !== owner.who.accountId) return { verified: verifiedNow, reason };
      return {
        token: p.token,
        phase: p.phase,
        verified: verifiedNow,
        reason: p.reason || reason,
        sample: p.relative_path,
        original: path.join(p.binding.media.path, p.relative_path),
        bin: path.join(p.binding.recycle.path, p.relative_path),
        sha256: p.file?.sha256,
        retention: p.retention,
        reference: p.reference,
        busy: active.has(p.token)
      };
    }
  };
  return {
    commands,
    queries,
    wake(receipt) {
      const token = receipt.probeToken || receipt.token;
      if (['confirm-removal', 'restore-removal'].includes(receipt.kind) && receipt.state !== 'running')
        return;
      if (
        !token ||
        active.has(token) ||
        ![
          'confirm-removal',
          'control-removal',
          'restore-removal',
          'start-trash-probe',
          'control-trash-probe'
        ].includes(receipt.kind)
      )
        return;
      const job = Promise.resolve()
        .then(() => (receipt.probeToken ? runProbe(token) : run(token)))
        .finally(() => active.delete(token));
      active.set(token, job);
      job.catch(() => {});
    },
    close() {
      closed = true;
      return Promise.allSettled([...active.values()]).finally(() => adapter?.close());
    }
  };
}
