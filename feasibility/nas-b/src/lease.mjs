import { randomBytes, timingSafeEqual } from 'node:crypto';
import { contentHash, sha256 } from '../../../shared/backup-protocol.mjs';
import { ProbeError, SESSION } from './contracts.mjs';

const isId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const isEpoch = value => Number.isSafeInteger(value) && value >= 0;
const stale = () => new ProbeError('STALE_LEASE', 'The interactive lease is no longer valid.');

function readState(db) {
  const row = db.prepare("SELECT value FROM runtime_meta WHERE key='lease'").get();
  return row ? JSON.parse(row.value) : null;
}

function saveState(db, state) {
  db.prepare(`
    INSERT INTO runtime_meta VALUES ('lease',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(JSON.stringify(state));
}

function readReceipt(db, operationId, kind, commandHash) {
  const row = db.prepare('SELECT kind,command_hash,body FROM operations WHERE operation_id=?').get(operationId);
  if (!row) return null;
  if (row.kind !== kind || row.command_hash !== commandHash) {
    throw new ProbeError('PROBE_OPERATION_CONFLICT', 'The operation ID belongs to a different command.');
  }
  return JSON.parse(row.body);
}

function saveReceipt(store, db, operationId, kind, commandHash, result) {
  const revision = store.nextRevision();
  const receipt = { operationId, kind, revision, ...result };
  db.prepare('INSERT INTO operations VALUES (?,?,?,?,?)')
    .run(operationId, kind, commandHash, revision, JSON.stringify(receipt));
  return receipt;
}

function proofDigest(grant) {
  if (!grant || !isId(grant.bootId) || !isId(grant.deviceId) || !isId(grant.instanceId) ||
      !isEpoch(grant.generation) || typeof grant.proof !== 'string' || !/^[0-9a-f]{64}$/.test(grant.proof)) {
    throw stale();
  }
  return sha256(grant.proof);
}

function requireHolder(state, grant, digest) {
  const holder = state?.holder;
  if (!holder || grant.bootId !== state.bootId || grant.generation !== state.generation ||
      grant.deviceId !== holder.deviceId || grant.instanceId !== holder.instanceId ||
      !timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(holder.proofHash, 'hex'))) throw stale();
}

export function createLeaseManager({ store, clock = performance, bootId, ttlMs = SESSION.ttlMs }) {
  if (!isId(bootId) || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > SESSION.ttlMs) {
    throw new ProbeError('INVALID_PROBE_LEASE', 'Lease boot identity or lifetime is invalid.');
  }
  const schedule = clock.setTimeout?.bind(clock) ?? setTimeout;
  const unschedule = clock.clearTimeout?.bind(clock) ?? clearTimeout;
  const listeners = new Set();
  let lastTime = -Infinity;
  let observed;
  let timer;
  let privateGrant;

  function now() {
    const time = clock.now();
    if (!Number.isFinite(time)) throw new ProbeError('INVALID_PROBE_CLOCK', 'The lease clock is invalid.');
    lastTime = Math.max(lastTime, time);
    return lastTime;
  }

  store.withWrite(db => {
    const state = readState(db);
    if (state?.bootId !== bootId) saveState(db, { bootId, generation: state?.generation ?? 0, holder: null });
  });

  function active(state, time) {
    return state?.bootId === bootId && state.holder && time < state.holder.expiresAt ? state : null;
  }

  function observe(state, time) {
    if (privateGrant && privateGrant.generation !== state?.generation) privateGrant = undefined;
    if (observed && observed.generation !== state?.generation) {
      const loss = Object.freeze({ bootId, generation: observed.generation });
      for (const listener of listeners) {
        queueMicrotask(() => {
          if (listeners.has(listener)) listener(loss);
        });
      }
    }
    if (timer !== undefined && observed?.generation === state?.generation &&
        observed?.holder.expiresAt === state?.holder.expiresAt) return;
    if (timer !== undefined) unschedule(timer);
    observed = state;
    timer = state ? schedule(() => {
      timer = undefined;
      current();
    }, Math.ceil(state.holder.expiresAt - time)) : undefined;
    timer?.unref?.();
  }

  function current() {
    const time = now();
    const state = store.db.isOpen ? active(readState(store.db), time) : null;
    observe(state, time);
    return state;
  }

  function write(callback) {
    try {
      return store.withWrite(db => {
        const state = readState(db);
        if (state.bootId !== bootId) throw stale();
        const time = now();
        return callback(db, state, time);
      });
    } finally {
      current();
    }
  }

  function grantFor(state, proof) {
    const { deviceId, instanceId, expiresAt } = state.holder;
    return { deviceId, instanceId, generation: state.generation, bootId, proof, ttlMs, expiresAt };
  }

  return {
    acquire({ deviceId, instanceId, operationId }) {
      if (![deviceId, instanceId, operationId].every(isId)) {
        throw new ProbeError('INVALID_PROBE_LEASE', 'Lease holder or operation identity is invalid.');
      }
      const kind = 'lease-acquire';
      const commandHash = contentHash({ deviceId, instanceId });
      const grant = write((db, state, time) => {
        const saved = readReceipt(db, operationId, kind, commandHash);
        const live = active(state, time);
        if (saved) {
          if (!live || saved.generation !== live.generation || privateGrant?.generation !== live.generation) {
            throw stale();
          }
          return grantFor(live, privateGrant.proof);
        }
        if (live) throw new ProbeError('LIBRARY_IN_USE', 'The library already has an interactive holder.');
        const proof = randomBytes(32).toString('hex');
        state.generation++;
        state.holder = { deviceId, instanceId, expiresAt: time + ttlMs, proofHash: sha256(proof) };
        saveState(db, state);
        saveReceipt(store, db, operationId, kind, commandHash, { generation: state.generation });
        return grantFor(state, proof);
      });
      privateGrant = { generation: grant.generation, proof: grant.proof };
      return grant;
    },

    renew(grant) {
      const digest = proofDigest(grant);
      return write((db, state, time) => {
        requireHolder(active(state, time), grant, digest);
        state.holder.expiresAt = time + ttlMs;
        saveState(db, state);
        return grantFor(state, grant.proof);
      });
    },

    release(grant, operationId) {
      if (!isId(operationId)) throw new ProbeError('INVALID_PROBE_LEASE', 'Lease release operation is invalid.');
      const digest = proofDigest(grant);
      if (grant.bootId !== bootId) throw stale();
      const { deviceId, instanceId, generation } = grant;
      const kind = 'lease-release';
      const commandHash = contentHash({ deviceId, instanceId, generation, bootId, proofHash: digest });
      return write((db, state, time) => {
        const saved = readReceipt(db, operationId, kind, commandHash);
        if (saved) return saved;
        requireHolder(active(state, time), grant, digest);
        state.holder = null;
        saveState(db, state);
        return saveReceipt(store, db, operationId, kind, commandHash, { released: true });
      });
    },

    assertLease(grant) {
      requireHolder(current(), grant, proofDigest(grant));
    },

    status() {
      return { occupied: Boolean(current()) };
    },

    onLost(listener) {
      listeners.add(listener);
      current();
      return () => listeners.delete(listener);
    }
  };
}

export function assertJobEpoch(store, { jobId, epoch, authEpoch, inputCursor }) {
  if (!isId(jobId) || !isEpoch(epoch) || !isEpoch(authEpoch)) {
    throw new ProbeError('INVALID_PROBE_JOB', 'Page command identity is invalid.');
  }
  const job = store.readJob(jobId);
  if (!job) throw new ProbeError('PROBE_JOB_UNKNOWN', 'The read job does not exist.');
  if (job.epoch !== epoch || job.authEpoch !== authEpoch) {
    throw new ProbeError('STALE_JOB_EPOCH', 'The read job generation changed.');
  }
  if (job.cursor !== inputCursor) throw new ProbeError('STALE_PAGE_CURSOR', 'The read job cursor changed.');
}
