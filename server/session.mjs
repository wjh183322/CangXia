import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { contentHash } from '../shared/backup-protocol.mjs';
import { serverIdentity } from '../shared/server-identity.mjs';
import { isUuid } from './library.mjs';

export const ttlMs = 20_000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const stale = () => failure(403, 'SESSION_LOST', '使用权已失效，请重新连接。');
export function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
const invalid = () => failure(400, 'INVALID_REQUEST', '请求参数无效。');
const conflict = () => failure(409, 'OPERATION_CONFLICT', '操作标识已用于不同的请求。');
function receiptRow(db, accountId, operationId, digest) {
  if (!isUuid(operationId)) throw invalid();
  const row = db.prepare('SELECT * FROM command_receipts WHERE operation_id=?').get(operationId);
  if (!row) return null;
  if (row.account_id !== accountId) {
    if (digest) throw conflict();
    return null;
  }
  if (digest && row.digest !== digest) throw conflict();
  return JSON.parse(row.result);
}
function save(db, accountId, operationId, digest, result) {
  db.prepare('INSERT INTO command_receipts VALUES (?,?,?,?)').run(
    operationId,
    accountId,
    digest,
    JSON.stringify(result)
  );
  return result;
}
function setTags(db, { payload, entityVersion }) {
  const { id, tags } = payload;
  if (
    typeof id !== 'string' ||
    !Array.isArray(tags) ||
    tags.length > 100 ||
    tags.some((x) => typeof x !== 'string' || !x.trim() || x.length > 128)
  )
    throw invalid();
  if (!db.prepare('SELECT 1 FROM works WHERE id=?').get(id))
    throw failure(404, 'WORK_UNKNOWN', '找不到作品。');
  const entity = 'tags:' + id;
  const version = db.prepare('SELECT version FROM entity_versions WHERE entity=?').get(entity)?.version ?? 0;
  if (version !== entityVersion) throw failure(409, 'STALE_ENTITY', '作品标签已更新，请重新读取。');
  db.prepare('DELETE FROM work_tags WHERE work_id=?').run(id);
  const add = db.prepare('INSERT INTO work_tags VALUES (?,?)');
  for (const tag of new Set(tags)) add.run(id, tag);
  db.prepare('INSERT OR REPLACE INTO entity_versions VALUES (?,?)').run(entity, version + 1);
  return { id, entityVersion: version + 1 };
}
function initialState(db) {
  const count = db.prepare('SELECT count(*) AS n FROM works').get().n;
  return {
    version: serverIdentity.version,
    works: [],
    collections: [{ id: '__all__', name: '收藏', added: true, count }],
    members: { __all__: [] },
    queue: { jobs: [], paused: false },
    collector: { phase: 'idle', message: '已连接 NAS' },
    storage: { mode: 'server', connected: true, writable: true },
    account: null
  };
}

export function createSessionService({
  library,
  now = () => performance.now(),
  commands = {},
  queries = {}
}) {
  const bootId = randomUUID(),
    libraryId = library.libraryId;
  const mutations = new Map(Object.entries({ 'set-tags': setTags, ...commands }));
  const reads = new Map(Object.entries({ state: initialState, ...queries }));
  let localGrant,
    timer,
    closed = false;
  library.write((db) =>
    db
      .prepare(
        `INSERT INTO interactive_lease VALUES(1,?,0,NULL)
    ON CONFLICT(singleton) DO UPDATE SET boot_id=excluded.boot_id,holder=NULL`
      )
      .run(bootId)
  );
  function current(db) {
    if (closed) throw stale();
    const row = db.prepare('SELECT * FROM interactive_lease WHERE singleton=1').get();
    if (row.boot_id !== bootId) throw stale();
    const holder = JSON.parse(row.holder);
    return { generation: row.generation, holder: holder && now() < holder.until ? holder : null };
  }
  function checked(db, who, grant) {
    const { holder, generation } = current(db);
    if (
      !holder ||
      !grant ||
      grant.bootId !== bootId ||
      grant.libraryId !== libraryId ||
      grant.accountId !== who.accountId ||
      grant.deviceId !== who.deviceId ||
      grant.generation !== generation ||
      holder.deviceId !== who.deviceId ||
      holder.accountId !== who.accountId ||
      holder.instanceId !== grant.instanceId ||
      typeof grant.proof !== 'string' ||
      !/^[0-9a-f]{64}$/.test(grant.proof) ||
      !timingSafeEqual(Buffer.from(holder.digest, 'hex'), Buffer.from(hash(grant.proof), 'hex'))
    )
      throw stale();
    return holder;
  }
  function forget() {
    clearTimeout(timer);
    localGrant?.controller.abort();
    localGrant = null;
  }
  function watch(grant, until) {
    if (localGrant?.generation !== grant.generation) {
      forget();
      localGrant = { ...grant, controller: new AbortController() };
    }
    clearTimeout(timer);
    // Also notice a competing service boot while a stream is already open.
    function check() {
      try {
        library.read((db) => checked(db, grant, grant));
      } catch {
        forget();
        return;
      }
      timer = setTimeout(check, Math.max(1, Math.min(1000, until - now())));
      timer.unref();
    }
    timer = setTimeout(check, Math.max(1, Math.min(1000, until - now())));
    timer.unref();
  }
  const service = {
    status() {
      return {
        protocolVersion: serverIdentity.protocolVersion,
        occupied: library.read((db) => !!current(db).holder)
      };
    },
    acquire(who, { libraryId: expected, deviceId, instanceId, operationId }) {
      if (expected != null && expected !== libraryId)
        throw failure(409, 'LIBRARY_CHANGED', 'NAS 资料库身份已更换，请核对连接设置。');
      if (deviceId !== who.deviceId || !isUuid(instanceId) || !isUuid(operationId)) throw invalid();
      const digest = contentHash({ kind: 'acquire', deviceId, instanceId, libraryId });
      const result = library.write((db) => {
        const state = current(db);
        const saved = receiptRow(db, who.accountId, operationId, digest);
        if (saved) {
          if (
            !state.holder ||
            localGrant?.generation !== saved.generation ||
            state.generation !== saved.generation
          )
            throw stale();
          const { controller, ...grant } = localGrant;
          return {
            grant: { ...grant, ttlMs: Math.floor(state.holder.until - now()) },
            until: state.holder.until
          };
        }
        if (state.holder) throw failure(409, 'OCCUPIED', '另一台电脑正在使用资料库。');
        const generation = state.generation + 1,
          proof = randomBytes(32).toString('hex'),
          until = now() + ttlMs;
        const holder = { ...who, instanceId, digest: hash(proof), until };
        db.prepare('UPDATE interactive_lease SET generation=?,holder=? WHERE singleton=1').run(
          generation,
          JSON.stringify(holder)
        );
        save(db, who.accountId, operationId, digest, { generation });
        return { grant: { ...who, libraryId, bootId, generation, instanceId, proof, ttlMs }, until };
      });
      watch(result.grant, result.until);
      return result.grant;
    },
    renew(who, grant) {
      const until = library.write((db) => {
        const holder = checked(db, who, grant);
        holder.until = now() + ttlMs;
        db.prepare('UPDATE interactive_lease SET holder=? WHERE singleton=1').run(JSON.stringify(holder));
        return holder.until;
      });
      watch(grant, until);
      return { ...grant, ttlMs };
    },
    release(who, grant, operationId) {
      if (
        !grant ||
        grant.accountId !== who.accountId ||
        grant.deviceId !== who.deviceId ||
        grant.libraryId !== libraryId ||
        grant.bootId !== bootId ||
        typeof grant.proof !== 'string'
      )
        throw stale();
      const digest = contentHash({
        kind: 'release',
        accountId: who.accountId,
        deviceId: who.deviceId,
        instanceId: grant.instanceId,
        libraryId,
        bootId: grant.bootId,
        generation: grant.generation,
        proof: hash(grant.proof)
      });
      const result = library.write((db) => {
        current(db);
        const saved = receiptRow(db, who.accountId, operationId, digest);
        if (saved) return saved;
        checked(db, who, grant);
        db.exec('UPDATE interactive_lease SET holder=NULL WHERE singleton=1');
        return save(db, who.accountId, operationId, digest, { released: true });
      });
      if (localGrant?.generation === grant.generation) forget();
      return result;
    },
    read(who, grant, fn) {
      return library.read((db) => {
        checked(db, who, grant);
        const value = fn(db);
        checked(db, who, grant);
        return value;
      });
    },
    signal(who, grant) {
      service.read(who, grant, () => null);
      return localGrant.controller.signal;
    },
    query(who, grant, { kind, payload }) {
      return service.read(who, grant, (db) => {
        const run = reads.get(kind);
        if (!run) throw failure(404, 'UNKNOWN_QUERY', '服务不支持此查询。');
        return run(db, payload, { who, grant });
      });
    },
    command(who, grant, command) {
      return library.write((db) => {
        checked(db, who, grant);
        const { operationId, kind, payload, entityVersion } = command;
        if (
          !isUuid(operationId) ||
          typeof kind !== 'string' ||
          !payload ||
          Array.isArray(payload) ||
          typeof payload !== 'object' ||
          !Number.isSafeInteger(entityVersion) ||
          entityVersion < 0
        )
          throw invalid();
        const digest = contentHash({ kind: 'command', action: kind, payload, entityVersion });
        const saved = receiptRow(db, who.accountId, operationId, digest);
        if (saved) return saved;
        const run = mutations.get(kind);
        if (!run) throw failure(404, 'UNKNOWN_COMMAND', '服务不支持此操作。');
        const value = run(db, command, { who, grant });
        if (!value || typeof value.then === 'function') throw Error('Commands must commit synchronously.');
        checked(db, who, grant);
        return save(db, who.accountId, operationId, digest, { ...value, operationId, kind });
      });
    },
    receipt(who, grant, operationId) {
      return service.read(who, grant, (db) => receiptRow(db, who.accountId, operationId));
    },
    close() {
      closed = true;
      forget();
    }
  };
  return service;
}
