import {createRemovalService} from './removal.mjs';
import {catalogueRevision,listWorks,catalogueChoices,cataloguePosition,catalogueDetail,confirmedSelection,confirmedPage} from './catalogue.mjs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { contentHash } from '../shared/backup-protocol.mjs';
import { serverIdentity } from '../shared/server-identity.mjs';
import { createReadJobs, readState } from './read-jobs.mjs';
import { historyRuns, historyItems, jobSummary } from './read-history.mjs';
import { archiveAuthor, boundIdentity, createSourceOperations } from './read-sources.mjs';
import { createReadStore } from './read-store.mjs';
import { failure } from './service-error.mjs';
import { isUuid } from './library.mjs';

export const ttlMs = 20_000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const stale = () => failure(403, 'SESSION_LOST', '使用权已失效，请重新连接。');
export { failure } from './service-error.mjs';
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
    tags.some((x) => typeof x !== 'string' || !x.trim() || x.length > 80)
  )
    throw invalid();
  if (!db.prepare('SELECT 1 FROM works WHERE id=?').get(id))
    throw failure(404, 'WORK_UNKNOWN', '找不到作品。');
  const entity = 'tags:' + id;
  const version = db.prepare('SELECT version FROM entity_versions WHERE entity=?').get(entity)?.version ?? 0;
  if (version !== entityVersion) throw failure(409, 'STALE_ENTITY', '作品标签已更新，请重新读取。');
  db.prepare('DELETE FROM work_tags WHERE work_id=?').run(id);
  const add = db.prepare('INSERT INTO work_tags VALUES (?,?)');
  for (const tag of new Set(tags.map(t=>t.trim().replace(/^#/,'')).filter(Boolean))) add.run(id, tag);
  db.prepare('INSERT OR REPLACE INTO entity_versions VALUES (?,?)').run(entity, version + 1);
  return { id, entityVersion: version + 1 };
}
function initialState(db) {
  const count = db.prepare("SELECT count(*) AS n FROM source_members m WHERE source_id='total' AND NOT EXISTS(SELECT 1 FROM removed_work_records r WHERE r.work_id=m.work_id)").get().n;
  return {
    version: serverIdentity.version,
    works: [],
    libraryRevision: catalogueRevision(db),
    contentRevision: catalogueRevision(db),
    mediaCount:db.prepare("SELECT count(DISTINCT work_id) AS n FROM media_files WHERE lower(relative_path) NOT LIKE '%.json'").get().n,
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
  source,
  readDelay,
  downloads,
  removalFiles,
  commands = {},
  catalogueActions = {},
  queries = {}
}) {
  const bootId = randomUUID(),
    libraryId = library.libraryId;
  const removal=createRemovalService({library,files:removalFiles??(downloads?.store&&downloads)});
  const discovery = createSourceOperations();
  const jobs = createReadJobs({ source, readDelay, archive: downloads?.archive });
  const exportsByGrant = new Map();
  function exportWork(db,id){
    const work=catalogueDetail(db,{id});
    if(!work)throw invalid();
    const positions=new Set(work.images.map((image,i)=>image.index??i));
    for(const asset of work.media)if(/^image-\d+$/.test(asset.key))positions.add(Number(asset.key.slice(6)));
    const images=[...positions].sort((a,b)=>a-b).map(index=>({index}));
    return {id,name:work.name,type:work.type,author:work.author,images,media:work.media.filter(m=>/^(video|cover|image-\d+)$/.test(m.key))};
  }
  function confirmExport(db,query,{grant}) {
    const token=randomUUID();
    exportsByGrant.set(token,{generation:grant.generation,query});
    return {token,count:query.count,revision:query.revision};
  }
  if(downloads) catalogueActions={download:(db,ids)=>downloads.enqueue(db,ids,'unsaved'),
    'flat-download':confirmExport, 'download-missing':(db,ids)=>downloads.enqueue(db,ids,'missing'),repair:(db,ids)=>downloads.enqueue(db,ids,'repair'),'repair-cover':(db,ids)=>downloads.enqueue(db,ids,'repair-cover'),audio:(db,ids)=>downloads.enqueue(db,ids,'audio'),...catalogueActions};
  const mutations = new Map(
    Object.entries({
      'start-read': jobs.start,
      'control-read': jobs.control,
      'clear-read-history': (db) => {
        db.exec(
          "UPDATE read_batches SET hidden=1 WHERE status IN ('complete','stopped','continued'); DELETE FROM read_legacy_runs"
        );
        return { cleared: true };
      },
      'add-folders': (db, { payload }) => {
        const { uid } = boundIdentity(db, source);
        if (!Array.isArray(payload.ids) || !payload.ids.length) throw invalid();
        for (const id of payload.ids) {
          if (
            typeof id !== 'string' ||
            !/^\d+$/.test(id) ||
            !db
              .prepare('UPDATE read_sources SET added=1 WHERE source_id=? AND uid=? AND NOT missing')
              .run('folder:' + id, uid).changes
          )
            throw invalid();
        }
        return { added: true };
      },
      ...(downloads&&{
        'enqueue-download':(db,{payload})=>{
          if(Object.keys(payload).some(k=>!['workIds','selection','revision'].includes(k)))throw invalid();
          if(payload.revision!==undefined&&catalogueRevision(db)!==payload.revision)throw failure(409,'STALE_SELECTION','作品列表已更新，请重新确认。');
          return downloads.enqueue(db,payload.workIds,payload.selection);
        },
        'control-audio':(db,{payload:{action}})=>{
          if(!['pause','resume','cancel'].includes(action))throw invalid();
          const ids=db.prepare("SELECT id FROM download_manifests WHERE hidden=0 AND id LIKE 'audio:%'").all().map(r=>r.id);
          return downloads.control(db,{action,ids});
        },
        'control-download':(db,{payload})=>downloads.control(db,payload)
      }),
      'set-tags': setTags,
      'archive-author':archiveAuthor,
      'catalogue-action': (db,command,owner)=>{
        const {action,selection}=command.payload;
        if(catalogueActions[action]===confirmExport){
          const query=confirmedSelection(db,selection,owner,{paged:true});
          return confirmExport(db,query,owner);
        }
        const ids=confirmedSelection(db,selection,owner,{collect:true});
        if(!Object.hasOwn(catalogueActions,action))throw failure(409,'ACTION_UNAVAILABLE','当前服务尚未启用此操作，未处理任何作品。');
        return catalogueActions[action](db,ids,{...owner,selection,operationId:command.operationId});
      },
      ...removal.commands,
      ...commands
    })
  );
  const reads = new Map(
    Object.entries({
      ...(downloads&&{'download-selection':(db,input,owner)=>{
        const {count}=confirmedSelection(db,input,owner);
        const ids=confirmedSelection(db,{...input,confirmedCount:count},owner,{collect:true});
        return downloads.preview(db,ids);
      },'download-page':downloads.page,'preview-download':(db,{workIds})=>({...downloads.preview(db,workIds),revision:catalogueRevision(db)})}),
      ...(downloads && {'audio-page':downloads.audioPage}),
      'export-page': (db,{token,offset},{grant})=>{
        const batch=exportsByGrant.get(token);
        if(!batch || batch.generation!==grant.generation || !Number.isSafeInteger(offset) || offset<0) throw invalid();
        const page=confirmedPage(db,batch.query,offset).map(({id})=>exportWork(db,id));
        if(offset+page.length>=batch.query.count)exportsByGrant.delete(token);
        return page;
      },
      'work-detail': catalogueDetail,
      'list-works': listWorks,
      'catalogue-position': cataloguePosition,
      'catalogue-choices': catalogueChoices,
      'resolve-selection': confirmedSelection,
      'read-job': (db, { jobId }) => jobSummary(db, jobId),
      'history-runs': historyRuns,
      'history-items': historyItems,
      state: (db) => {
        const state = initialState(db);
        if(downloads){state.queue=downloads.state(db);state.audioQueue=downloads.audioState(db);state.storage.sharedAudio=true;}
        const identity = source?.account();
        if (identity) {
          state.account = { uid: identity.uid, nickname: identity.nickname };
          state.collector.connected = true;
        }
        return readState(db, state);
      },
      ...removal.queries,
      ...queries
    })
  );
  let localGrant,
    timer,
    closed = false;
  library.write(db=>db.exec("UPDATE removal_batches SET state='paused' WHERE state='running'; UPDATE removal_batches SET state=json_extract(body,'$.manual.prior'),body=json_set(json_remove(body,'$.manual'),'$.reason','上次原位核对中断，请打开文件清单重新核对该项。') WHERE state='checking'"));
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
    exportsByGrant.clear();
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
        jobs.stopExpired(db, { bootId, generation });
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
    readStore(who, grant) {
      return createReadStore({ session: service.sourceSession(who, grant), browser: source });
    },
    sourceOperation(who, grant, action, payload) {
      return discovery.call(source, service.sourceSession(who, grant), action, payload).then(result => {
        const {archiveChanged,...response}=result;
        if(downloads && (archiveChanged || ['creator-profiles','author'].includes(action))) void downloads.run().catch(()=>{});
        return response;
      });
    },
    sourceSession(who, grant) {
      const signal = service.signal(who, grant);
      return {
        signal,
        guard: (db) => checked(db, who, grant),
        read: (fn) => service.read(who, grant, fn),
        write: (fn) =>
          library.write((db) => {
            checked(db, who, grant);
            const result = fn(db);
            checked(db, who, grant);
            return result;
          })
      };
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
      const receipt = library.write((db) => {
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
        if (
          (kind === 'archive-author' || kind === 'start-read' || (kind === 'control-read' && payload.action !== 'stop')) &&
          discovery.busy(localGrant.controller.signal)
        )
          throw failure(409, 'READ_CONFLICT', '已有来源读取正在进行。');
        const value = run(db, command, { who, grant });
        if (!value || typeof value.then === 'function') throw Error('Commands must commit synchronously.');
        checked(db, who, grant);
        return save(db, who.accountId, operationId, digest, { ...value, operationId, kind });
      });
      removal.wake(receipt);
      if (['start-read', 'control-read'].includes(command.kind))
        jobs.wake(service.sourceSession(who, grant), grant, receipt.jobId);
      if(downloads && !(command.kind==='catalogue-action' && command.payload.action==='flat-download') && ['enqueue-download','control-audio','control-download','catalogue-action','set-tags','archive-author','add-folders'].includes(command.kind))void downloads.run().catch(()=>{});
      return receipt;
    },
    receipt(who, grant, operationId) {
      return service.read(who, grant, (db) => receiptRow(db, who.accountId, operationId));
    },
    close() {
      closed = true;
      forget();
      return removal.close();
    }
  };
  return service;
}
