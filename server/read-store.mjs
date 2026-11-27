import { isUuid } from './library.mjs';
import { failure } from './service-error.mjs';
import { sourceKey, publishMemberships } from './memberships.mjs';
import { mergeAudioCandidates, mergeObservedWork } from './source-work-merge.mjs';
import { creatorKey, sameCreator, mergeCreator } from '../shared/creators.mjs';
import { contentHash } from '../shared/backup-protocol.mjs';
import {fenceUnavailable} from './download-records.mjs';

const stale = () => failure(409, 'STALE_SOURCE_READ', '读取身份、代际或断点已变化。');
const conflict = () => failure(409, 'OPERATION_CONFLICT', '分页操作与已保存的请求不一致。');
const invalid = () => failure(400, 'INVALID_SOURCE_PAGE', '来源页参数无效。');
const decimal = (value) => typeof value === 'string' && /^\d+$/.test(value);
const getRun = (db, id) => db.prepare('SELECT * FROM source_read_runs WHERE job_id=?').get(id);
const getOp = (db, id) => db.prepare('SELECT * FROM source_page_operations WHERE operation_id=?').get(id);

export function validatePage(ticket, page, bufferedCursor = null) {
  if (
    !page ||
    sourceKey(page.source) !== sourceKey(ticket.source) ||
    page.inputCursor !== ticket.inputCursor ||
    typeof page.terminal !== 'boolean' ||
    (page.terminal
      ? page.nextCursor !== null
      : !decimal(page.nextCursor) && !(bufferedCursor && page.nextCursor === bufferedCursor)) ||
    !Array.isArray(page.works) ||
    !Array.isArray(page.refs) ||
    page.uniqueCount !== page.works.length ||
    page.refs.length !== page.uniqueCount ||
    !Number.isSafeInteger(page.receivedCount) ||
    page.receivedCount < page.uniqueCount ||
    (!page.terminal && !page.uniqueCount) ||
    !Array.isArray(page.aux?.creatorProfiles) ||
    !Array.isArray(page.aux.audioSourceHints)
  )
    throw invalid();
  const ids = new Set();
  for (const [i, ref] of page.refs.entries()) {
    if (
      !decimal(ref.workId) ||
      ids.has(ref.workId) ||
      ref.workId !== page.works[i]?.id ||
      !Number.isSafeInteger(ref.rank) ||
      ref.rank < 0 ||
      ref.rank >= page.receivedCount ||
      (i && ref.rank <= page.refs[i - 1].rank)
    )
      throw invalid();
    ids.add(ref.workId);
  }
  if (page.aux.audioSourceHints.some((h) => !ids.has(h.workId))) throw invalid();
}

export function saveWorks(db, page) {
  const titles = new Map();
  const find = db.prepare('SELECT title,body FROM works WHERE id=?');
  const put = db.prepare(`INSERT INTO works VALUES(?,?,?) ON CONFLICT(id)
    DO UPDATE SET title=excluded.title,body=excluded.body`);
  const audio = db.prepare('SELECT body FROM source_audio_hints WHERE work_id=?');
  const saveAudio = db.prepare('INSERT OR REPLACE INTO source_audio_hints VALUES(?,?)');
  const hints = new Map(page.aux.audioSourceHints.map((h) => [h.workId, h]));
  for (const work of page.works) {
    const row = find.get(work.id);
    const old = row && JSON.parse(row.body);
    // Earlier formal rows may store the canonical name only in the title column.
    const previous = row && { ...old, id: work.id, name: old?.name || row.title };
    const merged = { ...work, ...mergeObservedWork(previous, work) };
    titles.set(work.id, merged.name);
    put.run(work.id, merged.name, JSON.stringify(merged));
    if (merged.remoteState==='unavailable')fenceUnavailable(db,work.id);
    const incoming = hints.get(work.id);
    const prior = JSON.parse(audio.get(work.id)?.body ?? 'null');
    if (!prior && !incoming) continue;
    const sources = new Map((prior?.sources ?? []).map((s) => [s.kind, s]));
    const accepted = mergeAudioCandidates(
      sources,
      prior?.music,
      merged.music,
      incoming?.music,
      incoming?.sources
    );
    if (!sources.size) db.prepare('DELETE FROM source_audio_hints WHERE work_id=?').run(work.id);
    else
      saveAudio.run(
        work.id,
        JSON.stringify({
          workId: work.id,
          music: merged.music,
          sources: [...sources.values()],
          observedAt: accepted ? incoming.observedAt : prior.observedAt
        })
      );
  }
  const profiles = db.prepare(
    "SELECT id,body FROM source_creator_profiles WHERE id=? OR (json_extract(body,'$.secUid')=? AND ?<>'')"
  );
  const putProfile = db.prepare('INSERT OR REPLACE INTO source_creator_profiles VALUES(?,?)');
  for (const person of page.aux.creatorProfiles) {
    let profile = person;
    const matches = profiles.all(creatorKey(person), person.secUid, person.secUid);
    for (const row of matches) {
      const known = JSON.parse(row.body);
      if (!sameCreator(known, profile)) continue;
      profile = mergeCreator(known, profile);
      if (row.id !== creatorKey(profile))
        db.prepare('DELETE FROM source_creator_profiles WHERE id=?').run(row.id);
    }
    putProfile.run(creatorKey(profile), JSON.stringify(profile));
  }
  return titles;
}

export function createReadStore({ session, browser }) {
  function account(db, authEpoch) {
    const current = browser.account();
    const bound = db.prepare('SELECT uid,profile_id FROM source_account WHERE singleton=1').get();
    if (
      !isUuid(authEpoch) ||
      current?.authEpoch !== authEpoch ||
      !bound?.profile_id ||
      bound.uid !== current.uid
    )
      throw stale();
    return current.uid;
  }
  function checked(db, input) {
    const uid = account(db, input.authEpoch);
    const run = getRun(db, input.jobId);
    if (
      !run?.active ||
      run.uid !== uid ||
      run.source_id !== sourceKey(input.source) ||
      run.auth_epoch !== input.authEpoch ||
      run.job_epoch !== input.jobEpoch
    )
      throw stale();
    return run;
  }
  function ticketFor(input, op) {
    return {
      jobId: op.job_id,
      jobEpoch: op.job_epoch,
      authEpoch: op.auth_epoch,
      source: input.source,
      inputCursor: op.input_cursor,
      operationId: op.operation_id,
      removalRevision: op.removal_revision
    };
  }
  const store = {
    startRead(input) {
      return session.write((db) => {
        const { jobId, jobEpoch, authEpoch, source } = input;
        const uid = account(db, authEpoch),
          key = sourceKey(source);
        if (!isUuid(jobId) || jobEpoch !== 1) throw invalid();
        const prior = getRun(db, jobId);
        if (prior) {
          checked(db, input);
          return { savedCursor: prior.cursor };
        }
        db.prepare('UPDATE source_read_runs SET active=0 WHERE source_id=? AND active=1').run(key);
        db.prepare(
          `INSERT INTO source_read_runs(job_id,job_epoch,auth_epoch,uid,source_id,active,cursor)
          VALUES(?,?,?,?,?,1,'0')`
        ).run(jobId, jobEpoch, authEpoch, uid, key);
        db.prepare(
          `INSERT INTO source_read_items(job_id,work_id,baseline)
          SELECT ?,work_id,row_number() OVER(ORDER BY order_generation DESC,position,work_id)-1
          FROM source_members WHERE source_id=?`
        ).run(jobId, key);
        return { savedCursor: '0' };
      });
    },
    resumeRead({ jobId, expectedEpoch, jobEpoch, authEpoch, source }) {
      return session.write((db) => {
        const uid = account(db, authEpoch),
          run = getRun(db, jobId);
        if (
          !run?.active ||
          run.uid !== uid ||
          run.source_id !== sourceKey(source) ||
          run.cursor === null ||
          run.job_epoch !== expectedEpoch ||
          jobEpoch !== expectedEpoch + 1
        )
          throw stale();
        // Retire the outstanding dispatch before handing the unchanged cursor to the new reader.
        db.prepare(
          'UPDATE source_page_operations SET abandoned=1 WHERE job_id=? AND result IS NULL AND abandoned=0'
        ).run(jobId);
        db.prepare('UPDATE source_read_runs SET job_epoch=?,auth_epoch=? WHERE job_id=?').run(
          jobEpoch,
          authEpoch,
          jobId
        );
        return { savedCursor: run.cursor };
      });
    },
    pageReceipt(jobId, operationId) {
      return session.read((db) => {
        const op = getOp(db, operationId);
        return op?.job_id === jobId && op.result ? JSON.parse(op.result) : null;
      });
    },
    checkpoint(jobId) {
      return session.read((db) => {
        const run = getRun(db, jobId);
        if (!run) return null;
        const pending = db
          .prepare(
            'SELECT operation_id FROM source_page_operations WHERE job_id=? AND result IS NULL AND abandoned=0'
          )
          .get(jobId);
        return {
          jobEpoch: run.job_epoch,
          savedCursor: run.cursor,
          received: run.received,
          active: !!run.active,
          pendingOperationId: pending?.operation_id ?? null
        };
      });
    },
    prepareSourcePage(input) {
      return session.write((db) => {
        const run = checked(db, input);
        if (!isUuid(input.operationId)) throw invalid();
        const prior = getOp(db, input.operationId);
        if (prior) {
          if (
            prior.abandoned ||
            prior.job_id !== run.job_id ||
            prior.job_epoch !== input.jobEpoch ||
            prior.input_cursor !== run.cursor ||
            prior.result
          )
            throw conflict();
          return ticketFor(input, prior);
        }
        if (
          run.cursor === null ||
          db
            .prepare('SELECT 1 FROM source_page_operations WHERE job_id=? AND input_cursor=? AND abandoned=0')
            .get(run.job_id, run.cursor)
        )
          throw stale();
        const revision = db
          .prepare('SELECT coalesce(max(revision),0) AS revision FROM membership_removals')
          .get().revision;
        db.prepare(
          `INSERT INTO source_page_operations(operation_id,job_id,job_epoch,auth_epoch,input_cursor,removal_revision)
          VALUES(?,?,?,?,?,?)`
        ).run(input.operationId, run.job_id, run.job_epoch, run.auth_epoch, run.cursor, revision);
        return ticketFor(input, getOp(db, input.operationId));
      });
    },
    commitSourcePage(input) {
      return session.write((db) => {
        const run = checked(db, input),
          op = getOp(db, input.operationId);
        if (
          !op ||
          op.abandoned ||
          op.job_id !== run.job_id ||
          op.job_epoch !== run.job_epoch ||
          op.auth_epoch !== run.auth_epoch ||
          op.input_cursor !== input.inputCursor ||
          op.removal_revision !== input.removalRevision
        )
          throw stale();
        const page = input.page;
        const buffer = db
          .prepare('SELECT cursor,offset FROM read_page_buffers WHERE run_id=?')
          .get(run.job_id);
        validatePage(input, page, buffer && buffer.cursor + '@' + buffer.offset);
        const digest = contentHash(page);
        if (op.result) {
          if (op.digest !== digest) throw conflict();
          return JSON.parse(op.result);
        }
        if (
          run.cursor !== input.inputCursor ||
          (page.nextCursor !== null &&
            db
              .prepare(
                'SELECT 1 FROM source_page_operations WHERE job_id=? AND input_cursor=? AND abandoned=0'
              )
              .get(run.job_id, page.nextCursor))
        )
          throw stale();
        const titles = saveWorks(db, page);
        const preserveNewerOrder = !!db
          .prepare('SELECT superseded FROM read_steps WHERE id=?')
          .get(run.job_id)?.superseded;
        const restoredIds = publishMemberships(db, run, input, page, titles, preserveNewerOrder);
        const result = { savedCursor: page.nextCursor, restoredIds };
        db.prepare('UPDATE source_read_runs SET cursor=?,received=received+? WHERE job_id=?').run(
          page.nextCursor,
          page.receivedCount,
          run.job_id
        );
        db.prepare(
          'UPDATE source_page_operations SET digest=?,received_count=?,ordered_refs=?,result=? WHERE operation_id=?'
        ).run(digest, page.receivedCount, JSON.stringify(page.refs), JSON.stringify(result), op.operation_id);
        return result;
      });
    },
    async readNextPage(input) {
      const saved = session.read((db) => {
        const run = checked(db, input),
          op = getOp(db, input.operationId);
        if (!op?.result) return null;
        if (op.job_id !== run.job_id || op.job_epoch !== run.job_epoch || op.auth_epoch !== run.auth_epoch)
          throw conflict();
        return JSON.parse(op.result);
      });
      if (saved) return saved;
      const ticket = store.prepareSourcePage(input);
      const page = await browser.readSourcePage({
        source: ticket.source,
        cursor: ticket.inputCursor,
        authEpoch: ticket.authEpoch,
        signal: session.signal
      });
      return store.commitSourcePage({ ...ticket, page });
    }
  };
  return store;
}
