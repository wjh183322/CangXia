import path from 'node:path';
import fs from 'node:fs';
import {
  validCollection,
  validId,
  validAuthor,
  validHome,
  contentHash,
  authorPublic
} from '../shared/backup-protocol.mjs';
import { readLegacyOrder } from './legacy-order.mjs';
import { normalizeScope, validateScopeCommand } from '../shared/backup-scopes.mjs';
import { memberScopeKey, pastMemberDeletes, earlierMemberDelete } from './legacy-deletion-evidence.mjs';
import { child, readCopy, segment, digest } from './rehearsal-files.mjs';

const pick = (value, fields) =>
  Object.fromEntries(
    fields
      .split(' ')
      .filter((k) => value?.[k] !== undefined)
      .map((k) => [k, value[k]])
  );
const allowedWork =
  'name title caption description type author coAuthors coAuthorsState tags rawTags images videoUrls coverVariants coverUrls coverSource thumbnail duration width height publishedAt url music creatorInfoVersion creatorsCheckedAt checkedAt remoteState sourceStatus sourceAttempt mediaQuality';
const allowedSource =
  'id name folder rank added archived remoteMissing uid uniqueId avatar url reportedCount readSummary updatedAt';
const allowedRun =
  'scope source startedAt endedAt finishedAt mode name status phase count checked rawCount countsVersion existing newWorks pages total oldCount newCount added restored filled frontAdded initialAdded reappeared notReturned historyCount hasPrevious baselineKnown warning outcome succeeded failed skipped paused pending complete running processed includeTotal batchState batchMessage hasReadSummary reason message readPhase saveFailed';
const allowedNested = new Set(
  'index urls width height source id uid secUid uniqueId nickname roleTitle avatar name state method checkedAt version title author duration mixPending clip begin end volume unit textExtra challenges hashtag_name hashtagName hashtag_id hashtagId start end type user_id text challenge_name cha_name cid desc sec_uid is_commerce count complete pages time identities imageOriginals imageCount videoPixels videoRanked videoBitRate videoObservedAt kind position reason code at status original url music signature observedAt value'.split(
    ' '
  )
);
const withheldDiagnostic = '旧端诊断明细已隐去';
function privateDiagnostic(text) {
  return (
    Buffer.byteLength(text, 'utf8') > 512 ||
    /[\x00-\x08\x0b-\x1f\\/]/.test(text) ||
    /(?:\b(?:bearer|basic)\s+[a-z0-9+._~=:-]+|\b(?:authorization|proxy-authorization|cookie|set-cookie|passw(?:or)?d|token|api[-_ ]?key|session[-_ ]?(?:id|key))\s*[:=]\s*\S|(?:令牌|口令|密码|凭据)\s*[:：=]\s*\S)/i.test(
      text
    )
  );
}
function safe(value) {
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => allowedNested.has(k))
        .map(([k, v]) => [
          k,
          k === 'reason' && typeof v === 'string' && privateDiagnostic(v) ? withheldDiagnostic : safe(v)
        ])
    );
  if (typeof value === 'string' && /^https?:/i.test(value)) {
    try {
      const u = new URL(value);
      if (u.username || u.password) return '';
    } catch {
      return '';
    }
  }
  return value;
}
function publicFields(body, keys) {
  return Object.fromEntries(Object.entries(pick(body, keys)).map(([k, v]) => [k, safe(v)]));
}
const sourceKey = (id, author = false) =>
  author ? 'author:' + id : id === '__all__' ? 'total' : 'folder:' + id;
const ident = (type, key) => JSON.stringify([type, key]);
const hashRe = /^[a-f0-9]{64}$/;
const metadataFields = new Set(
  'schemaVersion workId workName title caption description author coAuthors tags rawTags localTags publishedAt originalURL music collection collectionId savedAt remoteState sourceStatus sourceAttempt checkedAt hdCover coverSource assets'.split(
    ' '
  )
);
const nestedMetadata = new Set([
  ...allowedNested,
  ...'textExtra challenges key file size width height source comparisons match score confidence algorithm seconds frame crop correlation videoWidth videoHeight frameIndex frameTime distance status mode method sha256'.split(
    ' '
  )
]);
function projectMetadata(source, proof, workId) {
  if (proof.size > 8 * 1024 * 1024) return { why: '作品信息 JSON 超过核验上限' };
  let value;
  const bytes = fs.readFileSync(child(source.directory, proof.relative));
  if (bytes.length !== proof.size || digest(bytes) !== proof.sha256)
    throw Error('旧作品信息 JSON 与封存摘要不符。');
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { why: '作品信息 JSON 无法解析' };
  }
  if (value?.schemaVersion !== 1 || value.workId !== workId)
    return { why: '作品信息 JSON 的格式版本或作品身份不符' };
  const redacted = [];
  for (const [parent, leaf] of [
    ['hdCover', 'message'],
    ['sourceStatus', 'reason'],
    ['sourceAttempt', 'reason']
  ]) {
    const object = value[parent];
    if (!object || !Object.hasOwn(object, leaf)) continue;
    if (typeof object[leaf] !== 'string')
      return { why: '作品信息 JSON 诊断字段类型无效 ' + parent + '.' + leaf };
    if (privateDiagnostic(object[leaf])) {
      object[leaf] = withheldDiagnostic;
      redacted.push(parent + '.' + leaf);
    }
  }
  function inspect(v, field, allowed) {
    if (Array.isArray(v)) {
      for (const item of v) {
        const why = inspect(item, field + '[]', nestedMetadata);
        if (why) return why;
      }
    } else if (v && typeof v === 'object') {
      for (const [key, x] of Object.entries(v)) {
        const label =
          (field ? field + '.' : '') + (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) ? key : '[未知字段]');
        if (!allowed.has(key) && !(label === 'hdCover.message' && value.hdCover.status === 'failed'))
          return '作品信息 JSON 未支持字段 ' + label;
        const why = inspect(x, label, nestedMetadata);
        if (why) return why;
      }
    } else if (
      typeof v === 'string' &&
      (/^(?:[a-z]:[\\/]|file:|\\\\)/i.test(v) ||
        /^https?:\/\/[^/]*@/.test(v) ||
        /\bBearer\s+[\w.-]+/i.test(v))
    ) {
      return '作品信息 JSON 字段含设备路径或认证信息 ' + field;
    }
    return null;
  }
  const why = inspect(value, '', metadataFields);
  if (why) return { why };
  if (value.assets !== undefined) {
    if (!Array.isArray(value.assets)) return { why: '作品信息 JSON 的 assets 清单无效' };
    for (const row of value.assets) {
      try {
        segment(row.file);
      } catch {
        return { why: '作品信息 JSON 的 assets[].file 文件名不安全' };
      }
    }
  }
  return redacted.length ? { redacted, body: JSON.stringify(value, null, 2) } : {};
}

export async function reconcile(sources, uid) {
  const groups = new Map(),
    denied = new Map(),
    conflicts = [],
    identities = [],
    fileClaims = [],
    objectFiles = new Map(),
    unlinked = new Map(),
    versions = new Map(),
    legacyFlags = [],
    membershipMarkers = [],
    positiveMemberships = new Map(),
    localCommands = new Map();
  function issue(source, type, key, reason) {
    conflicts.push({ source, type, key: String(key), reason });
  }
  function protect(type, key, reason) {
    denied.set(ident(type, key), reason);
  }
  function scope(s, reason) {
    normalizeScope(s);
    if (s.kind === 'files') protect('files', s.workId, reason);
    if (s.kind === 'account') protect('account', s.workId, reason);
    if (s.kind === 'author') protect('member', sourceKey(s.sourceId, true) + '/' + s.workId, reason);
  }
  function version(s, record, lineage, origin) {
    normalizeScope(s);
    if (
      !Number.isSafeInteger(record.revision) ||
      record.revision < 1 ||
      !Number.isSafeInteger(record.generation) ||
      record.generation < 1
    )
      throw Error('旧库删除范围版本无效。');
    const key = JSON.stringify([lineage, s.workId, s.kind, s.sourceId]),
      list = versions.get(key) ?? [];
    list.push({
      scope: s,
      revision: record.revision,
      generation: record.generation,
      deleted: !!record.deleted,
      dataRevision: record.dataRevision ?? null,
      lineage,
      origin
    });
    versions.set(key, list);
  }
  for (const [index, source] of sources.entries()) {
    const origin = source.kind + '#' + (index + 1),
      historical = source.kind === 'recovery';
    const files = new Map(source.files.map((f) => [f.relative, f]));
    for (const f of source.files)
      if (f.relative.includes('/')) unlinked.set(index + '/' + f.relative, { origin, path: f.relative });
    function add(type, key, value, work = null) {
      const id = ident(type, key);
      if (!groups.has(id)) groups.set(id, { type, key, work, variants: [] });
      groups.get(id).variants.push({ origin, historical, value });
    }
    function asset(id, a, home, fromObject = false, localRelative = null, musicId = null) {
      fileClaims.push({
        id,
        a,
        home,
        fromObject,
        localRelative,
        musicId,
        source,
        index,
        origin,
        historical,
        files
      });
    }
    function entry(table, key, b, recordRevision) {
      if (recordRevision !== undefined && ['members', 'author_members'].includes(table)) {
        const data = { table, key, origin, historical, lineage: sourceId, recordRevision };
        if (!b) {
          membershipMarkers.push(data);
          return;
        }
        if (!historical) positiveMemberships.set(ident(origin, ident(table, key)), data);
      }
      if (!b) {
        protect(table, key, '旧备份含删除回执');
        issue(origin, table, key, '旧备份显式删除，其他副本同项暂存候选');
        return;
      }
      if (
        table === 'works' &&
        validId(key) &&
        typeof b.name === 'string' &&
        ['video', 'images'].includes(b.type)
      ) {
        if (b.readHidden)
          legacyFlags.push({ origin, s: { workId: key, kind: 'account', sourceId: '__all__' } });
        const publicWork = publicFields(b, allowedWork);
        for (const field of Object.keys(b)) {
          if (['id', 'readHidden', 'backupCover'].includes(field)) continue;
          if (contentHash({ v: b[field] }) !== contentHash({ v: publicWork[field] }))
            issue(origin, 'workField', key + '/' + field, '设备或未识别字段仅留原库，未复制其内容');
        }
        add('work', key, { ...publicWork, id: key }, key);
        if (b.backupCover)
          asset(
            key,
            {
              ...b.backupCover,
              key: 'thumbnail',
              kind: 'image',
              file: b.backupCover.file || 'preview.' + (b.backupCover.format || 'jpg')
            },
            null,
            true
          );
      } else if (
        (table === 'collections' && validCollection(key)) ||
        (table === 'authors' && validAuthor(key))
      ) {
        const normalized = table === 'authors' ? authorPublic({ ...b, id: key }) : b;
        add('source', sourceKey(key, table === 'authors'), {
          ...publicFields(normalized, allowedSource),
          id: key
        });
      } else if (table === 'members' || table === 'author_members') {
        const author = table === 'author_members',
          sid = author ? b.authorId : b.collectionId,
          id = b.workId,
          pos = author ? b.position : b.rank;
        if (!validId(id) || !(author ? validAuthor(sid) : validCollection(sid)) || key !== sid + ':' + id)
          throw Error('旧来源归属标识无效。');
        const sk = sourceKey(sid, author),
          k = sk + '/' + id;
        if (b.hidden) legacyFlags.push({ origin, s: { workId: id, kind: 'author', sourceId: sid } });
        if (pos === null || !Number.isSafeInteger(pos) || pos < 0) {
          issue(origin, 'member', k, '旧库未确认排序，保留待核对');
          return;
        }
        add('member', k, { source: sk, position: pos, table, oldKey: key }, id);
      } else if (
        table === 'local_tags' &&
        validId(key) &&
        Array.isArray(b.tags) &&
        b.tags.every((s) => typeof s === 'string')
      ) {
        add('tags', key, [...new Set(b.tags)].sort(), key);
      } else if (['downloads', 'backup_downloads'].includes(table) && validId(key)) {
        if (b.backupDeleted || b.backupRemoved)
          legacyFlags.push({ origin, s: { workId: key, kind: 'files', sourceId: '' } });
        if (table === 'downloads' && source.kind !== 'nas' && b.path) {
          const rel =
            typeof originalRoot === 'string' &&
            path.win32.isAbsolute(originalRoot) &&
            path.win32.isAbsolute(b.path)
              ? path.win32.relative(originalRoot, b.path).replaceAll('\\', '/')
              : '';
          const parts = rel.split('/'),
            sid = b.collectionId || '__all__';
          const inferred = {
            kind: sid.startsWith('author:') ? 'author' : 'collection',
            id: sid.replace(/^author:/, ''),
            folder: parts.slice(0, -1).join('/'),
            workFolder: parts.at(-1)
          };
          if (
            !validHome(inferred) ||
            (b.home && (b.home.folder + '/' + b.home.workFolder).toLowerCase() !== rel.toLowerCase())
          ) {
            issue(origin, 'home', key, '旧本机绝对路径与归档登记不一致，资源保留候选');
            return;
          }
          if (!b.home) b = { ...b, home: inferred };
        }
        add(
          'download',
          key,
          {
            state: typeof b.state === 'string' ? b.state : null,
            requiredKeys: Array.isArray(b.requiredKeys) ? [...new Set(b.requiredKeys)].sort() : null,
            recordedKeys: (b.assets ?? []).map((a) => a.key).sort()
          },
          key
        );
        if (validHome(b.home)) add('home', key, b.home, key);
        else issue(origin, 'home', key, '未确认原归档位置，保留候选');
        for (const a of b.assets ?? [])
          asset(key, a, b.home, table === 'backup_downloads' || source.kind === 'nas');
        if (b.audio?.object) {
          const a = b.audio.object;
          asset(
            key,
            { ...a, key: 'audio', kind: 'audio', file: a.file || '配乐.' + (a.format || 'm4a') },
            b.home,
            true,
            null,
            b.audio.musicId
          );
        }
        for (const k of b.requiredKeys ?? [])
          if (!b.assets?.some((a) => a.key === k))
            issue(origin, 'asset', key + '/' + k, '旧清单缺少必需文件');
      } else issue(origin, table, key, '旧端记录保留供核对');
    }
    let sourceId, account, originalRoot;
    await readCopy(source, source.database, (db) => {
      const names = db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name"
        )
        .all()
        .map((r) => r.name);
      if (names.includes('library_identity')) throw Error('正式卷不能作为旧库来源。');
      const touched = new Set();
      function rows(table, sql, fn) {
        if (!names.includes(table)) return;
        if (!db.prepare('SELECT 1 FROM pragma_table_list WHERE name=? AND type=?').get(table, 'table'))
          throw Error('旧库表格式无效。');
        touched.add(table);
        for (const r of db.prepare(sql).iterate()) fn(r);
      }
      if (names.includes('records')) {
        if (
          source.kind === 'windows' ||
          !names.includes('meta') ||
          !names.includes('objects') ||
          !names.includes('scope_state')
        )
          throw Error('旧 NAS 库身份或删除范围缺失。');
        const meta = (k) =>
          JSON.parse(db.prepare('SELECT value FROM meta WHERE key=?').get(k)?.value ?? 'null');
        sourceId = meta('libraryId');
        if (meta('schemaVersion') !== 4) throw Error('未识别的旧 NAS 资料版本。');
        rows('records', 'SELECT * FROM records ORDER BY kind,id', (r) => {
          const b = JSON.parse(r.body);
          if (r.kind === 'settings') {
            if (r.id === 'account') account = b?.value;
            return;
          }
          entry(r.kind, r.id, b, r.revision);
        });
        rows('objects', 'SELECT * FROM objects ORDER BY sha', (r) => {
          const f = files.get('objects/' + r.sha);
          if (hashRe.test(r.sha) && f?.sha256 === r.sha && f.size === r.size && !historical)
            objectFiles.set(r.sha, { ...f, index });
          else if (!f || f.sha256 !== r.sha || f.size !== r.size)
            issue(origin, 'object', r.sha, '已登记的对象缺失或变动');
        });
        // Scope revisions and catalogue revisions are independent counters. The operation ID
        // in the actual backup commit is the durable link from a scope decision to its data write.
        const hasRequests =
          names.includes('commits') &&
          db.prepare("SELECT 1 FROM pragma_table_info('commits') WHERE name='request'").get();
        const scopeRows = hasRequests
          ? 'SELECT s.*,c.revision dataRevision FROM scope_state s LEFT JOIN commits c ON c.request=s.operation_id'
          : 'SELECT * FROM scope_state';
        rows('scope_state', scopeRows, (r) => {
          version({ workId: r.work_id, kind: r.kind, sourceId: r.source_id }, r, sourceId, origin);
        });
      } else {
        if (
          source.kind === 'nas' ||
          !['works', 'members', 'settings', 'local_identity'].every((n) => names.includes(n))
        )
          throw Error('未识别的 Windows 资料库。');
        sourceId = db.prepare('SELECT value FROM local_identity WHERE id=1').get()?.value;
        account = JSON.parse(
          db.prepare("SELECT value FROM settings WHERE key='account'").get()?.value ?? 'null'
        );
        originalRoot = JSON.parse(
          db.prepare("SELECT value FROM settings WHERE key='root'").get()?.value ?? 'null'
        );
        for (const t of ['works', 'authors', 'collections', 'downloads', 'backup_downloads', 'local_tags']) {
          rows(t, 'SELECT id,body FROM ' + t + ' ORDER BY id', (r) => entry(t, r.id, JSON.parse(r.body)));
        }
        for (const name of ['members', 'author_members']) touched.add(name);
        readLegacyOrder(db, names, entry, (source, id, pos) => {
          protect('member', source + '/' + id, '原来源中多件作品占用同一顺序 ' + pos);
          issue(origin, 'member', source + '/' + id, '原来源顺序冲突 ' + pos);
        });
        rows('creator_profiles', 'SELECT * FROM creator_profiles', (r) =>
          add(
            'profile',
            r.id,
            publicFields(JSON.parse(r.body), 'uid secUid uniqueId nickname avatar roleTitle')
          )
        );
        rows('audio_source_hints', 'SELECT * FROM audio_source_hints', (r) =>
          add('audioHint', r.work, publicFields(JSON.parse(r.body), 'music sources at'), r.work)
        );
        if (names.includes('audio_objects'))
          rows(
            'audio_refs',
            'SELECT r.*,o.body FROM audio_refs r LEFT JOIN audio_objects o ON o.sha=r.sha',
            (r) => {
              const o = JSON.parse(r.body ?? 'null');
              if (!r.local_saved || !o?.relative || !hashRe.test(r.sha)) {
                issue(origin, 'audioRef', r.work, '配乐仅缓存、缺少对象或保存状态未确认');
                return;
              }
              const rel = o.relative.replaceAll('\\', '/');
              try {
                rel.split('/').forEach(segment);
              } catch {
                issue(origin, 'audioRef', r.work, '旧配乐路径不安全');
                return;
              }
              asset(
                r.work,
                { key: 'audio', kind: 'audio', sha256: r.sha, size: o.size, file: path.posix.basename(rel) },
                null,
                false,
                source.media + '/' + rel,
                r.music_id
              );
            }
          );
        rows('download_tasks', 'SELECT id,state,rank,body FROM download_tasks', (r) => {
          const legacy = publicFields(JSON.parse(r.body), 'title progress coverOnly');
          add('task', r.id, { state: r.state, rank: r.rank, ...legacy }, r.id);
          issue(
            origin,
            'taskState',
            r.id,
            '旧任务状态 ' + r.state + '，顺序 ' + r.rank + '，彩排后须重新选择才会执行'
          );
        });
        const parents = new Map();
        rows('read_history_children', 'SELECT batch_id,run_id,position FROM read_history_children', (r) =>
          parents.set(r.run_id, { batchId: r.batch_id, batchPosition: r.position })
        );
        rows('read_history_runs', 'SELECT id,started_at,body FROM read_history_runs', (r) =>
          add('run', r.id, {
            started: r.started_at,
            summary: { ...publicFields(JSON.parse(r.body), allowedRun), ...parents.get(r.id) }
          })
        );
        rows('read_history_items', 'SELECT * FROM read_history_items', (r) =>
          add('logItem', JSON.stringify([r.session_id, r.work_id]), {
            run: r.session_id,
            kind: r.kind,
            position: r.position,
            body: publicFields(
              JSON.parse(r.body),
              'id name type author publishedAt foundAt position kind reappeared afterId'
            )
          })
        );
      }
      if (!sourceId || !validId(account?.uid) || account.uid !== uid)
        throw Error('旧库账号或库身份未核实，无法合并。');
      identities.push({
        source: origin,
        sourceId,
        uid,
        lineage: names.includes('records') ? sourceId : null
      });
      for (const t of names.filter((t) => !touched.has(t))) {
        if (!/^[a-z][a-z0-9_]*$/.test(t)) throw Error('旧库包含未识别表。');
        const privateTable =
          /settings|meta|device|grant|session|auth|receipt|operation|journal|hash|cache|upload|local_identity/.test(
            t
          );
        const keys = db.prepare('SELECT name FROM pragma_table_info(?) WHERE pk>0 ORDER BY pk').all(t);
        const order = keys.length
          ? keys.map((k) => '"' + k.name.replaceAll('"', '""') + '"').join(',')
          : 'rowid';
        let ordinal = 0;
        for (const row of db.prepare('SELECT ' + order + ' FROM "' + t + '" ORDER BY ' + order).iterate())
          issue(
            origin,
            t,
            privateTable ? ++ordinal : contentHash(row).slice(0, 24),
            privateTable ? '设备、状态或校验记录，仅留原库' : '辅助记录或任务断点，保留原库供人工核对'
          );
      }
    });
    if (source.files.some((f) => f.relative === source.device))
      await readCopy(source, source.device, (db) => {
        const binding = db.prepare('SELECT library_id FROM device_scope_meta WHERE local_id=?').get(sourceId);
        if (!binding) throw Error('设备删除范围与 Windows 库身份不符。');
        identities.at(-1).boundLibrary = binding.library_id;
        const params = [sourceId, binding.library_id];
        if (
          db
            .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='local_deletion_commands'")
            .get()
        ) {
          for (const row of db
            .prepare(
              'SELECT operation_id,body FROM local_deletion_commands WHERE local_id=? AND library_id=?'
            )
            .iterate(...params)) {
            try {
              const c = validateScopeCommand(JSON.parse(row.body));
              if (c.libraryId === binding.library_id) localCommands.set(contentHash(c), c);
            } catch {
              issue(
                origin,
                'deletionCommand',
                row.operation_id,
                '旧设备删除命令无法核实，未用作摘要回执的证明'
              );
            }
          }
        }
        for (const t of ['scope_versions', 'pending_deletions']) {
          for (const r of db
            .prepare('SELECT body FROM ' + t + ' WHERE local_id=? AND library_id=?')
            .iterate(...params)) {
            const b = JSON.parse(r.body);
            version(
              b.scope,
              { ...b, deleted: t === 'pending_deletions' || b.deleted },
              binding.library_id === 'unbound' ? 'device:' + sourceId : binding.library_id,
              origin
            );
          }
        }
        if (
          db.prepare("SELECT 1 FROM sqlite_schema WHERE name='local_deletion_items' AND type='table'").get()
        ) {
          for (const r of db
            .prepare(
              'SELECT i.work_id,i.body,o.body op FROM local_deletion_items i JOIN local_operations o USING(local_id,library_id,operation_id) WHERE i.local_id=? AND i.library_id=?'
            )
            .iterate(...params)) {
            const op = JSON.parse(r.op);
            if (op.confirmed && !['done', 'cancelled'].includes(op.phase)) {
              const item = JSON.parse(r.body);
              if (!item.scopes?.length) throw Error('已确认的删除操作缺少范围，需回到旧端核对。');
              for (const s of item.scopes) {
                if (s.workId !== r.work_id) throw Error('设备删除操作与作品不符。');
                scope(s, '旧端已批准的删除操作尚未完成');
              }
            }
            issue(origin, 'deletionIntent', r.work_id, '设备删除操作 ' + op.phase);
          }
        }
        for (const r of db
          .prepare('SELECT * FROM local_masks WHERE local_id=? AND library_id=?')
          .iterate(...params))
          scope({ workId: r.work_id, kind: r.kind, sourceId: r.source_id }, '本机隐藏，需确认');
        for (const r of db
          .prepare(
            'SELECT scope_key,table_name,record_key FROM held_records WHERE local_id=? AND library_id=?'
          )
          .iterate(...params))
          issue(origin, r.table_name, r.record_key, '设备删除待处理副本');
      });
  }
  const nasIds = identities.filter((i) => i.source.startsWith('nas#')).map((i) => i.sourceId);
  if (
    new Set(nasIds).size > 1 ||
    identities.some(
      (i) =>
        i.boundLibrary && i.boundLibrary !== 'unbound' && nasIds.length && !nasIds.includes(i.boundLibrary)
    )
  )
    throw Error('旧设备绑定的 NAS 库身份不一致。');
  const restored = new Set();
  for (const [key, list] of versions) {
    list.sort((a, b) => b.revision - a.revision || b.generation - a.generation);
    const latest = list[0];
    const historicalRelease =
      !latest.deleted &&
      latest.origin.startsWith('recovery#') &&
      list.some((r) => r.deleted && !r.origin.startsWith('recovery#')) &&
      !list.some((r) => !r.origin.startsWith('recovery#') && r.revision === latest.revision && !r.deleted);
    if (
      historicalRelease ||
      list.some(
        (r) =>
          r.generation > latest.generation ||
          (r.generation === latest.generation && r.deleted !== latest.deleted) ||
          (r.revision === latest.revision &&
            (r.deleted !== latest.deleted || r.generation !== latest.generation))
      )
    ) {
      scope(latest.scope, '旧库删除代际或同版本决定冲突');
      continue;
    }
    if (latest.deleted) scope(latest.scope, '明确删除或设备持有的删除范围');
    else restored.add(key);
    for (const old of list.slice(1))
      if (old.deleted !== latest.deleted)
        issue(
          old.origin,
          'scopeHistory',
          latest.scope.workId,
          '已按同库较新的范围版本 ' + latest.revision + ' 判定'
        );
  }
  const pastDeletes = await pastMemberDeletes({
    sources,
    identities,
    markers: membershipMarkers,
    versions,
    restored,
    localCommands,
    issue
  });
  for (const marker of membershipMarkers) {
    const { table, key, origin, lineage, recordRevision } = marker;
    const scopeId = memberScopeKey(marker);
    const observations = versions.get(scopeId) ?? [];
    const deletion =
      marker.historical &&
      Number.isSafeInteger(recordRevision) &&
      (observations.find((v) => v.origin === origin && v.deleted && v.dataRevision === recordRevision) ??
        earlierMemberDelete(pastDeletes, marker));
    const replacement =
      deletion &&
      restored.has(scopeId) &&
      observations.find((v) => {
        if (
          v.deleted ||
          !v.origin.startsWith('nas#') ||
          v.generation <= deletion.generation ||
          v.revision <= deletion.revision ||
          !Number.isSafeInteger(v.dataRevision) ||
          v.dataRevision <= recordRevision
        )
          return false;
        const positive = positiveMemberships.get(ident(v.origin, ident(table, key)));
        return (
          positive &&
          positive.lineage === lineage &&
          Number.isSafeInteger(positive.recordRevision) &&
          positive.recordRevision >= v.dataRevision
        );
      });
    if (replacement) {
      issue(origin, 'scopeHistory', key, '旧空记录与删除提交对应；同库较新恢复及当前归属已核实');
    } else {
      protect(table, key, '旧备份含未被证实覆盖的删除回执');
      issue(origin, table, key, '旧备份显式删除或恢复来源未核实，保留候选');
    }
  }
  for (const { origin, s } of legacyFlags) {
    const identity = identities.find((i) => i.source === origin);
    const liveBinding = identities.find(
      (i) => i.source.startsWith('windows#') && i.sourceId === identity.sourceId
    )?.boundLibrary;
    const bound = identity.boundLibrary || liveBinding;
    const lineage =
      identity.lineage || (bound && bound !== 'unbound' && bound) || 'device:' + identity.sourceId;
    if (!restored.has(JSON.stringify([lineage, s.workId, s.kind, s.sourceId])))
      scope(s, '旧端隐藏或显式删除');
    else issue(origin, 'scopeHistory', s.workId, '旧标记已由同一库较新的明确恢复覆盖');
  }
  const output = new Map();
  const legacyTable = { work: 'works', tags: 'local_tags', home: 'downloads', download: 'downloads' };
  for (const [id, g] of groups) {
    const variants = g.variants.filter((v) => !v.historical),
      v = variants[0];
    if (g.type === 'download' && v) {
      const observations = variants.map((x) => ({ source: x.origin, ...x.value }));
      const states = new Set(observations.map((x) => x.state));
      const merged = {
        state: states.size === 1 ? v.value.state : 'partial',
        requiredKeys: [...new Set(observations.flatMap((x) => x.requiredKeys ?? []))],
        recordedKeys: [...new Set(observations.flatMap((x) => x.recordedKeys))],
        observations
      };
      if (states.size > 1) issue('合并', 'download', g.key, '旧下载状态不同，按未完整保留并核对文件');
      for (const row of variants) row.value = merged;
    }
    let reason = denied.get(id) || denied.get(ident(legacyTable[g.type], g.key));
    if (g.type === 'source')
      reason ||= denied.get(
        ident(
          g.key.startsWith('author:') ? 'authors' : 'collections',
          g.key === 'total' ? '__all__' : g.key.split(':')[1]
        )
      );
    if (['work', 'member', 'tags', 'task', 'home', 'audioHint'].includes(g.type))
      reason ||= denied.get(ident('works', g.work));
    if (g.type === 'member')
      reason ||=
        denied.get(ident(v?.value.table, v?.value.oldKey)) ||
        (!v?.value.source.startsWith('author:') && denied.get(ident('account', g.work)));
    if (['home', 'task', 'download'].includes(g.type)) reason ||= denied.get(ident('files', g.work));
    // Account deletion covers account collections. An independently verified author membership may still own the work.
    const contributors = new Set(g.variants.map((x) => x.origin));
    for (const identity of identities.filter((i) => contributors.has(i.source))) {
      identity.inventory ??= {};
      const stat = (identity.inventory[g.type] ??= { records: 0, unique: 0 });
      stat.records++;
      if (contributors.size === 1) stat.unique++;
    }
    if (!v) reason ||= '历史恢复副本独有，保留候选';
    if (v && variants.some((x) => contentHash(x.value) !== contentHash(v.value)))
      reason ||= '活动来源内容或次序冲突';
    if (reason) {
      for (const x of g.variants) {
        const detail =
          g.type === 'member'
            ? ' · 顺序 ' + x.value.position
            : g.type === 'tags'
              ? ' · ' + x.value.join('、')
              : '';
        issue(x.origin, g.type, g.key, reason + detail + ' · ' + contentHash(x.value).slice(0, 12));
      }
      continue;
    }
    for (const x of g.variants.filter((x) => x.historical && contentHash(x.value) !== contentHash(v.value)))
      issue(x.origin, g.type, g.key, '历史版本与活动来源不同');
    output.set(id, { type: g.type, key: g.key, work: g.work, value: v.value, origin: v.origin });
  }
  const ordered = new Map();
  for (const g of output.values())
    if (g.type === 'member') {
      const k = ident(g.value.source, g.value.position),
        other = ordered.get(k);
      if (other) {
        for (const row of [other, g]) {
          issue(row.origin, 'member', row.key, '合并后多个作品占用同一顺序 ' + row.value.position);
          output.delete(ident('member', row.key));
        }
      } else ordered.set(k, g);
    }
  for (const g of output.values())
    if (
      g.type === 'run' &&
      g.value.summary.batchId &&
      output.get(ident('run', g.value.summary.batchId))?.value.summary.source !== 'batch'
    ) {
      issue(g.origin, 'run', g.key, '历史批次缺失，子日志独立保留');
      delete g.value.summary.batchId;
      delete g.value.summary.batchPosition;
    }
  const authorOwned = new Set(
    [...output.values()]
      .filter(
        (g) =>
          g.type === 'member' &&
          g.value.source.startsWith('author:') &&
          output.has(ident('source', g.value.source))
      )
      .map((g) => g.work)
  );
  // Retain the work body while resolving an independent files scope. Account-only removal
  // suppresses every collection relation, including total, while leaving author/verified media usable.
  for (const [id, g] of output) {
    if (
      (g.work && !output.has(ident('work', g.work))) ||
      (g.type === 'member' && g.value.source !== 'total' && !output.has(ident('source', g.value.source))) ||
      (g.type === 'logItem' && !output.has(ident('run', g.value.run)))
    ) {
      issue(g.origin, g.type, g.key, '关联主体未核实');
      output.delete(id);
    }
  }
  const homeOwners = new Map();
  for (const g of output.values())
    if (g.type === 'home') {
      const label = (g.value.folder + '/' + g.value.workFolder).normalize('NFC').toLowerCase();
      const owners = homeOwners.get(label) ?? [];
      owners.push(g);
      homeOwners.set(label, owners);
    }
  for (const owners of homeOwners.values())
    if (owners.length > 1)
      for (const g of owners) {
        output.delete(ident('home', g.key));
        issue(g.origin, 'home', g.key, '同一归档目录有多个所有者');
      }
  const candidates = new Map(),
    expectedHashes = new Map(),
    occupied = new Map();
  for (const {
    id,
    a,
    home,
    fromObject,
    localRelative,
    musicId,
    source,
    index,
    origin,
    historical,
    files
  } of fileClaims) {
    const key = id + '/' + a.key,
      h = output.get(ident('home', id))?.value;
    const reason = denied.get(ident('files', id)) || denied.get(ident('downloads', id));
    if (
      reason ||
      historical ||
      !output.has(ident('work', id)) ||
      !h ||
      (home && contentHash(home) !== contentHash(h))
    ) {
      issue(origin, 'asset', key, reason || '缺少已核实的活动作品或原归档位置');
      continue;
    }
    if (a.key === 'audio' && (!musicId || musicId !== output.get(ident('work', id)).value.music?.id)) {
      issue(origin, 'asset', key, '旧配乐和作品音乐身份不符');
      continue;
    }
    if (!/^(?:video|cover|thumbnail|audio|metadata|image-\d+)$/.test(a.key)) {
      issue(origin, 'asset', key, '未知资源类型');
      continue;
    }
    try {
      segment(a.file);
    } catch {
      issue(origin, 'asset', key, '文件名不安全');
      continue;
    }
    const relative = h.folder + '/' + h.workFolder + '/' + a.file;
    const hashes = expectedHashes.get(key) ?? new Set();
    if (a.sha256) hashes.add(a.sha256);
    expectedHashes.set(key, hashes);
    let proof;
    if (fromObject) proof = objectFiles.get(a.sha256);
    else {
      const f = files.get(localRelative ?? source.media + '/' + relative);
      if (f) proof = { ...f, index };
    }
    if (
      !proof ||
      (a.sha256 && a.sha256 !== proof.sha256) ||
      (a.size != null && a.size !== proof.size) ||
      !proof.size
    ) {
      issue(origin, 'asset', key, '文件缺失、大小或哈希不匹配');
      continue;
    }
    let projection;
    if (a.key === 'metadata') {
      projection = projectMetadata(sources[proof.index], proof, id);
      if (projection.why) {
        issue(origin, 'asset', key, projection.why);
        continue;
      }
      if (projection.redacted)
        issue(
          origin,
          'metadataProjection',
          key,
          '已隐去 ' +
            projection.redacted.join('、') +
            '。原始 SHA-256 ' +
            proof.sha256 +
            '，移交 SHA-256 ' +
            digest(projection.body)
        );
    }
    hashes.add(proof.sha256);
    unlinked.delete(proof.index + '/' + proof.relative);
    const value = {
      key: a.key,
      work: id,
      kind: ['audio', 'video', 'metadata'].includes(a.key) ? a.key : 'image',
      relative,
      size: projection?.redacted ? Buffer.byteLength(projection.body) : proof.size,
      sha256: projection?.redacted ? digest(projection.body) : proof.sha256,
      ...(projection?.redacted ? { metadataJSON: projection.body } : {}),
      ...(musicId ? { musicId } : {}),
      from: proof
    };
    const list = candidates.get(key) ?? [];
    list.push(value);
    candidates.set(key, list);
    const portable = relative.normalize('NFC').toLowerCase(),
      owners = occupied.get(portable) ?? new Set();
    owners.add(key);
    occupied.set(portable, owners);
  }
  const assets = [];
  for (const [key, options] of candidates) {
    const a = options[0];
    if (
      expectedHashes.get(key).size !== 1 ||
      options.some((x) => x.sha256 !== a.sha256 || x.relative !== a.relative) ||
      occupied.get(a.relative.normalize('NFC').toLowerCase()).size !== 1
    ) {
      issue('合并', 'asset', key, '归档路径或文件内容冲突');
      continue;
    }
    assets.push(a);
  }
  const fileOwned = new Set(assets.map((a) => a.work));
  const heldWorks = new Set(
    [...output.values()]
      .filter(
        (g) =>
          g.type === 'work' &&
          denied.has(ident('account', g.key)) &&
          !authorOwned.has(g.key) &&
          !fileOwned.has(g.key)
      )
      .map((g) => g.key)
  );
  for (const [k, g] of output)
    if (heldWorks.has(g.work)) {
      issue(g.origin, g.type, g.key, '账号范围已删除，未核实独立的作者归属或媒体');
      output.delete(k);
    }
  for (const { origin, path } of unlinked.values())
    issue(origin, 'file', path, '文件未关联到已核实的活动资源');
  for (const identity of identities) {
    identity.mediaClaims = fileClaims.filter((c) => c.origin === identity.source).length;
    identity.held = conflicts.filter((c) => c.source === identity.source).length;
  }
  return { rows: [...output.values()], assets, conflicts, identities };
}
