import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { types } from 'node:util';
import { contentHash } from '../../../shared/backup-protocol.mjs';
import { creatorKey, mergeCreator, sameCreator } from '../../../shared/creators.mjs';
import { LIMITS, PROBE, ProbeError } from './contracts.mjs';
import { mergeObservedWork } from './work-merge.mjs';

const APPLICATION_ID = 0x43585042;
const SCHEMA_VERSION = 1;
const PAGE_SIZE = 20;
const workFields = [
  'id', 'name', 'title', 'caption', 'description', 'tags', 'rawTags', 'author', 'coAuthors',
  'coAuthorsState', 'creatorInfoVersion', 'creatorsCheckedAt', 'type', 'images', 'videoUrls',
  'coverVariants', 'coverUrls', 'coverSource', 'thumbnail', 'duration', 'width', 'height',
  'music', 'publishedAt', 'url', 'remoteState', 'sourceStatus', 'checkedAt', 'observedFields', 'mediaQuality'
];

const schema = `
  CREATE TABLE probe_identity (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), service TEXT NOT NULL, library_id TEXT NOT NULL
  ) STRICT;
  CREATE TABLE runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value))) STRICT;
  INSERT INTO runtime_meta VALUES ('revision', '0'), ('lease', 'null');

  CREATE TABLE records (
    kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT CHECK(body IS NULL OR json_valid(body)),
    revision INTEGER NOT NULL, PRIMARY KEY(kind,id)
  ) STRICT;
  CREATE TABLE source_jobs (
    id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_id TEXT NOT NULL, mode TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK(epoch>=0), auth_epoch INTEGER NOT NULL CHECK(auth_epoch>=0),
    state TEXT NOT NULL, cursor TEXT,
    saved_pages INTEGER NOT NULL DEFAULT 0 CHECK(saved_pages>=0),
    saved_received INTEGER NOT NULL DEFAULT 0 CHECK(saved_received>=0),
    saved_unique INTEGER NOT NULL DEFAULT 0 CHECK(saved_unique>=0),
    pause_requested INTEGER NOT NULL DEFAULT 0 CHECK(pause_requested IN (0,1)),
    finalization_pending INTEGER NOT NULL DEFAULT 0 CHECK(finalization_pending IN (0,1))
  ) STRICT;
  CREATE INDEX source_jobs_source ON source_jobs(source_kind,source_id);
  CREATE TABLE operations (
    operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, command_hash TEXT NOT NULL,
    revision INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body))
  ) STRICT;
  CREATE TABLE read_pages (
    operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id),
    job_id TEXT NOT NULL REFERENCES source_jobs(id), source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
    epoch INTEGER NOT NULL, auth_epoch INTEGER NOT NULL, input_cursor TEXT NOT NULL, next_cursor TEXT,
    digest TEXT NOT NULL, revision INTEGER NOT NULL, observed_at TEXT NOT NULL,
    received_count INTEGER NOT NULL, unique_count INTEGER NOT NULL,
    UNIQUE(job_id,input_cursor), UNIQUE(job_id,digest)
  ) STRICT;
  CREATE INDEX read_pages_head ON read_pages(source_kind,source_id,revision DESC);
  CREATE TABLE read_job_works (
    job_id TEXT NOT NULL REFERENCES source_jobs(id), work_id TEXT NOT NULL, PRIMARY KEY(job_id,work_id)
  ) STRICT;
  CREATE TABLE work_refs (
    source_kind TEXT NOT NULL, source_id TEXT NOT NULL, work_id TEXT NOT NULL, rank INTEGER NOT NULL,
    job_id TEXT NOT NULL REFERENCES source_jobs(id), revision INTEGER NOT NULL,
    PRIMARY KEY(source_kind,source_id,work_id)
  ) STRICT;
  CREATE INDEX work_refs_page ON work_refs(source_kind,source_id,rank,work_id);
  CREATE INDEX work_refs_work ON work_refs(work_id);
  CREATE TABLE creator_profiles (
    id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)), revision INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX creator_profiles_sec ON creator_profiles(json_extract(body,'$.secUid'));
  CREATE TABLE audio_source_hints (
    work_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
    revision INTEGER NOT NULL, PRIMARY KEY(work_id,kind)
  ) STRICT;
  CREATE TABLE scope_state (
    work_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL,
    generation INTEGER NOT NULL, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), revision INTEGER NOT NULL,
    PRIMARY KEY(work_id,kind,source_id)
  ) STRICT;
  CREATE TABLE download_jobs (
    id TEXT PRIMARY KEY, work_id TEXT NOT NULL, state TEXT NOT NULL,
    body TEXT NOT NULL CHECK(json_valid(body)), revision INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX download_jobs_state ON download_jobs(state,id);
  CREATE TABLE resources (
    id TEXT PRIMARY KEY, work_id TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL,
    relative_path TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, mime TEXT NOT NULL,
    state TEXT NOT NULL, revision INTEGER NOT NULL, UNIQUE(work_id,key)
  ) STRICT;
  CREATE TABLE file_commits (
    id TEXT PRIMARY KEY, work_id TEXT NOT NULL, resource_id TEXT, stage TEXT NOT NULL,
    body TEXT NOT NULL CHECK(json_valid(body)), revision INTEGER NOT NULL
  ) STRICT;
`;
const schemaTables = [
  'probe_identity', 'runtime_meta', 'records', 'source_jobs', 'operations', 'read_pages',
  'read_job_works', 'work_refs', 'creator_profiles', 'audio_source_hints', 'scope_state',
  'download_jobs', 'resources', 'file_commits'
];

const error = (code, message) => new ProbeError(code, message);
const unsafeDb = () => error('UNSAFE_PROBE_DB', 'Probe database path or sidecar is unsafe.');
const foreignDb = () => error('FOREIGN_PROBE_DB', 'The existing database does not identify this probe library and schema.');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCursor = value => typeof value === 'string' && /^\d+$/.test(value);
const isWorkId = value => isCursor(value) && /[1-9]/.test(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const isTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const bodyOf = row => row?.body == null ? null : JSON.parse(row.body);
const select = (record, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));

export function normalizeSource(source) {
  const { kind, id } = source ?? {};
  const valid = kind === 'total' && id === '__all__' ||
    kind === 'collection' && isWorkId(id) ||
    kind === 'author' && typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) && id !== '__all__';
  if (!valid) throw error('INVALID_PROBE_SOURCE', 'Source identity is invalid.');
  return { kind, id };
}

function assertCallback(callback) {
  if (typeof callback !== 'function' || types.isAsyncFunction(callback)) {
    throw error('PROBE_SYNC_REQUIRED', 'A synchronous probe transaction callback is required.');
  }
}

function synchronousResult(result) {
  if (typeof result?.then === 'function') {
    if (types.isPromise(result)) result.catch(() => {});
    throw error('PROBE_SYNC_REQUIRED', 'A probe transaction callback returned an asynchronous result.');
  }
  return result;
}

function withTransaction(db, mode, callback) {
  db.exec(mode);
  try {
    const result = synchronousResult(callback(db));
    db.exec('COMMIT');
    return result;
  } catch (cause) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw cause;
  }
}

function sameFile(actual, expected) {
  return actual?.dev === expected.dev && actual?.ino === expected.ino;
}

function checkPaths(file, { expected, empty = false } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file) throw unsafeDb();
  const seen = {};
  try {
    for (let directory = path.dirname(file); directory !== path.dirname(directory); directory = path.dirname(directory)) {
      if (!lstatSync(directory).isDirectory()) throw unsafeDb();
    }
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const stat = lstatSync(file + suffix, { bigint: true, throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.nlink !== 1n)) throw unsafeDb();
      seen[suffix] = stat;
    }
  } catch {
    throw unsafeDb();
  }
  const stat = seen[''];
  const hasSidecars = seen['-wal'] || seen['-shm'] || seen['-journal'];
  if ((!stat && hasSidecars) || (expected && !sameFile(stat, expected)) ||
      (empty && (stat?.size !== 0n || hasSidecars))) throw unsafeDb();
  return stat;
}

function verifyHeader(file, expected) {
  const handle = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(handle, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || !sameFile(stat, expected)) throw unsafeDb();
    // The identity header is written in rollback-journal mode on first initialization.
    const header = Buffer.alloc(72);
    if (readSync(handle, header, 0, header.length, 0) !== header.length ||
        header.subarray(0, 16).toString('ascii') !== 'SQLite format 3\0' ||
        header.readUInt32BE(68) !== APPLICATION_ID) throw foreignDb();
  } finally {
    closeSync(handle);
  }
}

function verifyIdentity(db, libraryId) {
  const application = db.prepare('PRAGMA application_id').get();
  const tag = db.prepare('PRAGMA user_version').get();
  if (application.application_id !== APPLICATION_ID || tag.user_version !== SCHEMA_VERSION) throw foreignDb();
  const identity = db.prepare('SELECT service,library_id FROM probe_identity WHERE singleton=1').get();
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all();
  const names = new Set(tables.map(({ name }) => name));
  if (identity?.service !== PROBE.service ||
      identity.library_id !== libraryId || !schemaTables.every(name => names.has(name))) throw foreignDb();
}

function createDatabaseFile(file) {
  const descriptor = openSync(file, 'wx', 0o600);
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== 0n) throw unsafeDb();
    return stat;
  } finally {
    closeSync(descriptor);
  }
}

function openDatabase(file, libraryId, initialize) {
  let expected = checkPaths(file);
  if (initialize && expected) throw error('PROBE_DB_EXISTS', 'The probe database path already exists.');
  if (!initialize && !expected) throw error('PROBE_DB_MISSING', 'The existing probe database is missing.');
  const uri = pathToFileURL(file).href;
  if (initialize) {
    try {
      expected = createDatabaseFile(file);
    } catch (cause) {
      if (cause instanceof ProbeError) throw cause;
      if (cause.code === 'EEXIST') throw error('PROBE_DB_EXISTS', 'The probe database path already exists.');
      throw error('PROBE_DB_OPEN_FAILED', 'The probe database could not be initialized.');
    }
  } else {
    try {
      verifyHeader(file, expected);
      checkPaths(file, { expected });
      const inspection = new DatabaseSync(uri + '?mode=ro', { readOnly: true, timeout: 1000 });
      try {
        checkPaths(file, { expected });
        verifyIdentity(inspection, libraryId);
      } finally {
        inspection.close();
      }
    } catch (cause) {
      throw cause instanceof ProbeError ? cause : foreignDb();
    }
  }

  let db;
  try {
    // Recheck path identity at SQLite's file-open boundaries on the dedicated mount.
    const pathCheck = { expected, empty: initialize };
    checkPaths(file, pathCheck);
    // mode=rw makes SQLite refuse a path that disappears during recovery.
    db = new DatabaseSync(uri + '?mode=rw', { timeout: 1000 });
    checkPaths(file, pathCheck);
    db.exec('PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF');
    if (initialize) {
      checkPaths(file, pathCheck);
      withTransaction(db, 'BEGIN IMMEDIATE', () => {
        // SQLite may have created the rollback journal when it acquired its write lock.
        if (checkPaths(file, { expected }).size !== 0n) throw unsafeDb();
        db.exec(schema);
        db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}`);
        db.prepare('INSERT INTO probe_identity VALUES (1,?,?)').run(PROBE.service, libraryId);
      });
    }
    verifyIdentity(db, libraryId);
    checkPaths(file, { expected });
    if (db.prepare('PRAGMA journal_mode=WAL').get().journal_mode !== 'wal') {
      throw error('PROBE_DB_OPEN_FAILED', 'The probe database requires WAL mode.');
    }
    checkPaths(file, { expected });
    return db;
  } catch (cause) {
    db?.close();
    throw cause instanceof ProbeError
      ? cause : error('PROBE_DB_OPEN_FAILED', 'The probe database could not be opened.');
  }
}

function jobFrom(row) {
  if (!row) return null;
  return {
    id: row.id, source: { kind: row.source_kind, id: row.source_id }, mode: row.mode,
    epoch: row.epoch, authEpoch: row.auth_epoch, state: row.state, cursor: row.cursor,
    savedPages: row.saved_pages, savedReceived: row.saved_received, savedUnique: row.saved_unique,
    pauseRequested: Boolean(row.pause_requested), finalizationPending: Boolean(row.finalization_pending)
  };
}

function validatePage(page) {
  const invalid = () => error('SOURCE_PAGE_INVALID', 'The source page is incomplete or inconsistent.');
  if (!isRecord(page)) throw invalid();
  const {
    inputCursor, nextCursor, terminal, receivedCount, uniqueCount, works, refs,
    aux, digest, observedAt
  } = page;
  let source;
  try {
    source = normalizeSource(page.source);
  } catch {
    throw invalid();
  }
  if (!isCursor(inputCursor) || typeof terminal !== 'boolean' ||
      (terminal ? nextCursor !== null : !isCursor(nextCursor)) ||
      !isCount(receivedCount) || receivedCount > LIMITS.receivedRows || !isCount(uniqueCount) ||
      uniqueCount > receivedCount || (!terminal && !uniqueCount) || (!uniqueCount && receivedCount) ||
      !Array.isArray(works) || works.length !== uniqueCount || !Array.isArray(refs) ||
      refs.length !== uniqueCount || !isRecord(aux) || !Array.isArray(aux.creatorProfiles) ||
      !Array.isArray(aux.audioSourceHints) || typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest) || !isTime(observedAt)) throw invalid();

  const seen = new Set();
  let lastRank = -1;
  for (const [index, work] of works.entries()) {
    const ref = refs[index];
    if (!isRecord(work) || !isWorkId(work.id) || seen.has(work.id) || typeof work.name !== 'string' ||
        !['video', 'images'].includes(work.type) || !isRecord(work.author) ||
        !Array.isArray(work.images) || !Array.isArray(work.videoUrls) || !Array.isArray(work.coverVariants) ||
        !Array.isArray(work.observedFields) || !Array.isArray(work.tags) ||
        (work.coAuthors !== undefined && (!Array.isArray(work.coAuthors) || !work.coAuthors.every(isRecord))) ||
        (work.observedFields.includes('coAuthors') && !Array.isArray(work.coAuthors)) ||
        !isRecord(ref) || ref.workId !== work.id || !isCount(ref.rank) ||
        (index === 0 && ref.rank !== 0) || ref.rank <= lastRank || ref.rank >= receivedCount) throw invalid();
    seen.add(work.id);
    lastRank = ref.rank;
  }
  if (aux.creatorProfiles.some(profile => !isRecord(profile) ||
      !['uid', 'secUid', 'uniqueId', 'nickname'].every(key => typeof profile[key] === 'string') ||
      (!profile.uid && !profile.secUid) || (profile.uid && !isCursor(profile.uid)) ||
      (profile.secUid && !/^[A-Za-z0-9_-]+$/.test(profile.secUid)))) throw invalid();
  const hinted = new Set();
  for (const hint of aux.audioSourceHints) {
    if (!isRecord(hint) || !seen.has(hint.workId) || hinted.has(hint.workId) ||
        hint.observedAt !== observedAt || !Array.isArray(hint.sources) || !hint.sources.length ||
        new Set(hint.sources.map(item => item?.kind)).size !== hint.sources.length ||
        hint.sources.some(item => !isRecord(item) || !['music', 'work'].includes(item.kind) ||
          !Array.isArray(item.urls) || !item.urls.length || !item.urls.every(url => typeof url === 'string') ||
          typeof item.signature !== 'string')) throw invalid();
    hinted.add(hint.workId);
  }
  return {
    source, inputCursor, nextCursor, terminal, receivedCount, uniqueCount, digest, observedAt,
    works: works.map(work => select(work, workFields)),
    refs: refs.map(({ workId, rank }) => ({ workId, rank })),
    aux: {
      creatorProfiles: aux.creatorProfiles.map(profile => select(profile, ['uid', 'secUid', 'uniqueId', 'nickname'])),
      audioSourceHints: aux.audioSourceHints.map(({ workId, music, sources }) => ({
        workId, observedAt, ...(music ? { music } : {}),
        sources: sources.map(({ kind, urls, signature }) => ({ kind, urls, signature }))
      }))
    }
  };
}

function saveCreator(db, profile, revision) {
  const key = creatorKey(profile);
  const exact = db.prepare('SELECT id,body FROM creator_profiles WHERE id=?').get(key);
  const alternate = profile.secUid ? db.prepare(`
    SELECT id,body FROM creator_profiles WHERE json_extract(body,'$.secUid')=? AND id<>?
    ORDER BY id LIMIT 1
  `).get(profile.secUid, key) : undefined;
  const previous = exact ?? (sameCreator(bodyOf(alternate), profile) ? alternate : undefined);
  const body = bodyOf(previous);
  if (body && !sameCreator(body, profile)) return;
  db.prepare('INSERT OR REPLACE INTO creator_profiles VALUES (?,?,?)')
    .run(previous?.id ?? key, JSON.stringify(body ? mergeCreator(body, profile) : profile), revision);
}

const musicIdentity = music => music?.id && music.id !== '0' ? music.id : '';

function saveAudio(db, previous, work, hint, revision) {
  const musicId = musicIdentity(work.music);
  if (musicIdentity(previous?.music) !== musicId) {
    db.prepare("DELETE FROM audio_source_hints WHERE work_id=? AND kind='music'").run(work.id);
  }
  const save = db.prepare('INSERT OR REPLACE INTO audio_source_hints VALUES (?,?,?,?)');
  for (const source of hint?.sources ?? []) {
    if (source.kind === 'music' && musicIdentity(hint.music) !== musicId) continue;
    const body = { ...source, observedAt: hint.observedAt, ...(source.kind === 'music' ? { music: work.music } : {}) };
    save.run(work.id, source.kind, JSON.stringify(body), revision);
  }
}

const deletedWork = "NOT EXISTS(SELECT 1 FROM scope_state s WHERE s.work_id=w.id AND s.kind='work' AND s.source_id='' AND s.deleted=1)";
const deletedRef = `NOT EXISTS(SELECT 1 FROM scope_state s WHERE s.work_id=w.id AND s.deleted=1 AND (
  (s.kind=r.source_kind AND s.source_id=r.source_id) OR
  (s.kind='account' AND s.source_id='__all__' AND r.source_kind IN ('total','collection'))
))`;

class ProbeStore {
  #testHooks;

  constructor(db, testHooks) {
    this.db = db;
    this.#testHooks = testHooks;
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }

  withWrite(callback) {
    assertCallback(callback);
    return withTransaction(this.db, 'BEGIN IMMEDIATE', callback);
  }

  nextRevision() {
    if (!this.db.isTransaction) throw error('PROBE_TRANSACTION_REQUIRED', 'Revision allocation requires a transaction.');
    return this.db.prepare(`
      UPDATE runtime_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision' RETURNING CAST(value AS INTEGER) n
    `).get().n;
  }

  createReadJob({ id = randomUUID(), source, epoch = 1, authEpoch = 0, cursor = '0', state = 'reading', mode = 'sample' }) {
    source = normalizeSource(source);
    if (!isKey(id) || !isCount(epoch) || !isCount(authEpoch) || !isCursor(cursor) || !isKey(state) || mode !== 'sample') {
      throw error('INVALID_PROBE_JOB', 'Read job identity or initial state is invalid.');
    }
    const inserted = this.db.prepare(`
      INSERT INTO source_jobs(id,source_kind,source_id,mode,epoch,auth_epoch,state,cursor)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING *
    `).get(id, source.kind, source.id, mode, epoch, authEpoch, state, cursor);
    if (!inserted) throw error('PROBE_JOB_EXISTS', 'The read job already exists.');
    return jobFrom(inserted);
  }

  readJob(id) {
    if (!isKey(id)) return null;
    const row = this.db.prepare(`
      SELECT j.*, m.value AS read_details FROM source_jobs j
      LEFT JOIN runtime_meta m ON m.key='read:job:' || j.id WHERE j.id=?
    `).get(id);
    const job = jobFrom(row);
    return row?.read_details ? { ...job, ...JSON.parse(row.read_details) } : job;
  }

  readHead(source) {
    const { kind, id } = normalizeSource(source);
    const row = this.db.prepare(`
      SELECT o.body FROM read_pages p JOIN operations o USING(operation_id)
      WHERE p.source_kind=? AND p.source_id=? ORDER BY p.revision DESC LIMIT 1
    `).get(kind, id);
    const receipt = bodyOf(row);
    return receipt ? { ...receipt, cursor: receipt.nextCursor, terminal: receipt.nextCursor === null } : null;
  }

  operation(id) {
    if (!isKey(id)) return null;
    return bodyOf(this.db.prepare('SELECT body FROM operations WHERE operation_id=?').get(id));
  }

  work(id) {
    if (!isWorkId(id)) return null;
    const row = this.db.prepare(`
      SELECT w.body, EXISTS(SELECT 1 FROM scope_state s WHERE s.work_id=w.id AND s.kind='files' AND
        s.source_id='' AND s.deleted=1) hide_cover FROM records w
      WHERE w.kind='works' AND w.id=? AND ${deletedWork}
    `).get(id);
    const work = bodyOf(row);
    if (work && row.hide_cover) delete work.backupCover;
    return work;
  }

  listWorks({ source, page = 1, pageSize = PAGE_SIZE } = {}) {
    const invalidPage = () => error('INVALID_PROBE_PAGE', 'Use a valid page number with 20 items per page.');
    if (!Number.isSafeInteger(page) || page < 1 || pageSize !== PAGE_SIZE) throw invalidPage();
    const args = [];
    let from = `FROM records w WHERE w.kind='works' AND w.body IS NOT NULL AND ${deletedWork}`;
    let order = 'w.id';
    if (source !== undefined) {
      const { kind, id } = normalizeSource(source);
      args.push(kind, id);
      from = `FROM work_refs r JOIN records w ON w.id=r.work_id AND w.kind='works'
        WHERE r.source_kind=? AND r.source_id=? AND w.body IS NOT NULL AND ${deletedWork} AND ${deletedRef}`;
      order = 'r.rank,w.id';
    }

    const read = () => {
      const total = this.db.prepare('SELECT COUNT(*) AS n ' + from).get(...args).n;
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (page > pages) throw invalidPage();
      const items = this.db.prepare(`
        SELECT w.id, json_extract(w.body,'$.name') name, json_extract(w.body,'$.type') type,
          json_extract(w.body,'$.author.nickname') author, json_extract(w.body,'$.remoteState') remoteState,
          json_extract(w.body,'$.publishedAt') publishedAt, COALESCE(json_array_length(w.body,'$.images'),0) imageCount
        ${from} ORDER BY ${order} LIMIT ? OFFSET ?
      `).all(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE).map(row => ({ ...row }));
      return { page, pageSize, pages, total, items };
    };
    return this.db.isTransaction ? read() : withTransaction(this.db, 'BEGIN', read);
  }

  commitPage({ jobId, epoch, authEpoch, operationId, page }, guard) {
    assertCallback(guard);
    if (!isKey(jobId) || !isKey(operationId) || !isCount(epoch) || !isCount(authEpoch)) {
      throw error('INVALID_PROBE_JOB', 'Page command identity is invalid.');
    }
    page = validatePage(page);

    let replay = false;
    const receipt = this.withWrite(db => {
      const job = this.readJob(jobId);
      if (!job) throw error('PROBE_JOB_UNKNOWN', 'The read job does not exist.');
      if (epoch !== job.epoch || authEpoch !== job.authEpoch) throw error('STALE_JOB_EPOCH', 'The read job generation changed.');
      const kind = 'page';
      const commandHash = contentHash({ kind, jobId, epoch, authEpoch, operationId, page });
      const saved = db.prepare('SELECT kind,command_hash,body FROM operations WHERE operation_id=?').get(operationId);
      if (saved && (saved.kind !== kind || saved.command_hash !== commandHash)) {
        throw error('PROBE_OPERATION_CONFLICT', 'The operation ID belongs to a different command.');
      }
      if (job.source.kind !== page.source.kind || job.source.id !== page.source.id) {
        throw error('PROBE_PAGE_CONFLICT', 'The page source differs from the job source.');
      }
      if (!saved && job.cursor !== page.inputCursor) throw error('STALE_PAGE_CURSOR', 'The read job cursor changed.');
      replay = Boolean(saved);
      synchronousResult(guard({
        jobId, epoch, authEpoch, inputCursor: job.cursor, pageInputCursor: page.inputCursor,
        job: { ...job, source: { ...job.source } }, replay
      }));
      if (saved) return bodyOf(saved);

      const seen = db.prepare(`
        SELECT 1 FROM read_pages WHERE job_id=? AND (input_cursor=? OR input_cursor=? OR digest=?)
      `).get(jobId, page.inputCursor, page.nextCursor, page.digest);
      if (seen || page.nextCursor === page.inputCursor) {
        throw error('PROBE_PAGE_CONFLICT', 'The page digest or cursor was already visited.');
      }

      const revision = this.nextRevision();
      const savedUnique = job.savedUnique + this.#saveObservations(job, page, revision);
      const savedPages = job.savedPages + 1;
      const savedReceived = job.savedReceived + page.receivedCount;
      const result = {
        operationId, kind, revision, jobId, epoch, authEpoch, source: page.source, inputCursor: page.inputCursor,
        nextCursor: page.nextCursor, savedPages, savedReceived, savedUnique
      };
      db.prepare('INSERT INTO operations VALUES (?,?,?,?,?)').run(operationId, kind, commandHash, revision, JSON.stringify(result));
      db.prepare(`
        INSERT INTO read_pages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(operationId, jobId, page.source.kind, page.source.id, epoch, authEpoch, page.inputCursor,
        page.nextCursor, page.digest, revision, page.observedAt, page.receivedCount, page.uniqueCount);
      db.prepare(`
        UPDATE source_jobs SET state=?,cursor=?,saved_pages=?,saved_received=?,saved_unique=?,finalization_pending=?
        WHERE id=?
      `).run(page.terminal ? 'finalizing' : job.state, page.nextCursor, savedPages, savedReceived, savedUnique,
        page.terminal ? 1 : Number(job.finalizationPending), jobId);
      return result;
    });
    if (!replay && this.#testHooks.afterPageCommit) synchronousResult(this.#testHooks.afterPageCommit(receipt));
    return receipt;
  }

  #saveObservations(job, page, revision) {
    const { db } = this;
    const protectedScope = db.prepare('SELECT 1 FROM scope_state WHERE work_id=? AND kind=? AND source_id=? AND deleted=1');
    const previousWork = db.prepare("SELECT body FROM records WHERE kind='works' AND id=?");
    const putWork = db.prepare("INSERT OR REPLACE INTO records VALUES ('works',?,?,?)");
    const putRef = db.prepare(`
      INSERT INTO work_refs VALUES (?,?,?,?,?,?) ON CONFLICT(source_kind,source_id,work_id) DO UPDATE SET
        rank=excluded.rank,job_id=excluded.job_id,revision=excluded.revision WHERE work_refs.job_id<>excluded.job_id
    `);
    const remember = db.prepare('INSERT INTO read_job_works VALUES (?,?) ON CONFLICT DO NOTHING');
    const hints = new Map(page.aux.audioSourceHints.map(hint => [hint.workId, hint]));
    const people = [];
    const { kind, id } = page.source;
    const coordinated = db.prepare("SELECT 1 FROM runtime_meta WHERE key='read:job:' || ?").get(job.id);
    const sourceRank = coordinated ? db.prepare(`
      SELECT COALESCE(SUM(received_count),0) AS count FROM read_pages WHERE source_kind=? AND source_id=?
    `).get(kind, id).count : job.savedReceived;
    const keepRef = coordinated ? db.prepare('INSERT INTO work_refs VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING') : putRef;
    let added = 0;
    for (const [index, observed] of page.works.entries()) {
      const { id: workId } = observed;
      if (protectedScope.get(workId, 'work', '')) continue;
      const previous = bodyOf(previousWork.get(workId));
      const work = mergeObservedWork(previous, observed);
      if (protectedScope.get(workId, 'files', '')) delete work.backupCover;
      putWork.run(workId, JSON.stringify(work), revision);
      if (this.#testHooks.afterWorkWrite) synchronousResult(this.#testHooks.afterWorkWrite({ workId, index }));
      const accountProtected = kind !== 'author' && protectedScope.get(workId, 'account', '__all__');
      if (!accountProtected && !protectedScope.get(workId, kind, id)) {
        keepRef.run(kind, id, workId, sourceRank + page.refs[index].rank, job.id, revision);
      }
      added += remember.run(job.id, workId).changes;
      people.push(observed.author, ...(observed.coAuthors ?? []));
      saveAudio(db, previous, work, hints.get(workId), revision);
    }
    for (const profile of page.aux.creatorProfiles) {
      if (people.some(person => sameCreator(person, profile))) saveCreator(db, profile, revision);
    }
    return added;
  }
}

export function openProbeStore({ file, libraryId, initialize = false, testHooks = {} }) {
  if (typeof libraryId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(libraryId)) {
    throw error('INVALID_PROBE_ID', 'The probe requires a valid library identity.');
  }
  for (const hook of [testHooks.afterWorkWrite, testHooks.afterPageCommit]) {
    if (hook !== undefined) assertCallback(hook);
  }
  return new ProbeStore(openDatabase(file, libraryId, initialize === true), testHooks);
}
