import https from 'node:https';
import tls from 'node:tls';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeFingerprint } from './backup-transport.mjs';
import { serverIdentity } from '../shared/server-identity.mjs';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validated(input) {
  const url = new URL(input.url);
  const fingerprint = normalizeFingerprint(input.fingerprint);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !fingerprint
  )
    throw Error('请输入 HTTPS 服务地址和 SHA256 证书指纹。');
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.deviceId ?? '') ||
    !/^[A-Za-z0-9._~-]{32,256}$/.test(input.token ?? '')
  )
    throw Error('设备标识或服务访问凭据无效。');
  return {
    url: url.origin,
    fingerprint,
    deviceId: input.deviceId,
    token: input.token,
    libraryId: input.libraryId ?? null
  };
}
export async function pinnedRequest(input, route, body, signal) {
  const config = validated(input);
  const agent = new https.Agent({ keepAlive: false });
  const timeout = AbortSignal.timeout(8000);
  const stop = signal ? AbortSignal.any([timeout, signal]) : timeout;
  agent.createConnection = (options, ready) => {
    const socket = tls.connect({
      ...options,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: false,
      signal: stop
    });
    const failed = (error) => ready(error);
    socket.once('error', failed);
    socket.once('secureConnect', () => {
      socket.removeListener('error', failed);
      const raw = socket.getPeerCertificate().raw;
      if (!raw || createHash('sha256').update(raw).digest('hex') !== config.fingerprint) {
        socket.destroy();
        ready(Object.assign(Error('NAS 服务证书指纹已更换，请核对。'), { code: 'PIN_CHANGED' }));
      } else ready(null, socket);
    });
  };
  try {
    return await new Promise((resolve, reject) => {
      const req = https.request(
        new URL('/v1/' + route, config.url),
        {
          agent,
          signal: stop,
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + config.token,
            'x-cangxia-device': config.deviceId,
            'x-cangxia-protocol': String(serverIdentity.protocolVersion),
            'content-type': 'application/json'
          }
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('error', reject);
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > 4 * 1024 * 1024) {
              res.destroy(Error('NAS 响应过大。'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            try {
              const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (res.statusCode !== 200)
                throw Object.assign(Error(result.message ?? 'NAS 请求失败。'), {
                  status: res.statusCode,
                  code: result.code
                });
              resolve(result);
            } catch (error) {
              reject(error);
            }
          });
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  } finally {
    agent.destroy();
  }
}
export function connectionProfile(profile, safeStorage) {
  const file = path.join(profile, 'nas-connection.dpapi');
  function check() {
    if (!safeStorage.isEncryptionAvailable()) throw Error('Windows 凭据加密不可用。');
  }
  return {
    load() {
      if (!fs.existsSync(file)) return {};
      check();
      return JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
    },
    save(value) {
      check();
      const temp = file + '.' + randomUUID();
      try {
        fs.writeFileSync(temp, safeStorage.encryptString(JSON.stringify(value)), {
          flag: 'wx',
          mode: 0o600,
          flush: true
        });
        fs.renameSync(temp, file);
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }
  };
}
const locked = () => Object.assign(Error('资料库已锁定，请重新连接。'), { status: 403 });

export class ServerClient {
  constructor({
    request = pinnedRequest,
    profile = null,
    onChange = () => {},
    now = () => performance.now()
  } = {}) {
    this.request = request;
    this.profile = profile;
    this.onChange = onChange;
    this.now = now;
    this.saved = profile?.load() ?? {};
    this.pending = this.saved.pending ?? {};
    this.epoch = 0;
    this.reason = '请连接 NAS 取得使用权。';
    this.scope = new AbortController();
    this.scope.abort();
    this.inFlight = new Set();
  }
  settings() {
    const { url = '', fingerprint = '', deviceId = '', libraryId = null } = this.saved.config ?? {};
    return { url, fingerprint, deviceId, libraryId };
  }
  save() {
    this.profile?.save({ config: this.saved.config, pending: this.pending });
  }
  state() {
    const owned = !!this.grant && this.now() < this.deadline;
    return {
      owned,
      epoch: this.epoch,
      reason: this.reason,
      settings: this.settings(),
      ...(owned
        ? { libraryId: this.grant.libraryId, reconciling: !!this.reconciling, recent: this.recent ?? null }
        : {})
    };
  }
  emit() {
    this.onChange(this.state());
  }
  lock(reason = '资料库已锁定。') {
    ++this.epoch;
    clearTimeout(this.expiry);
    clearTimeout(this.heartbeat);
    this.scope.abort();
    this.scope = new AbortController();
    this.grant = null;
    this.deadline = 0;
    this.reason = reason;
    this.reconciling = false;
    this.recent = null;
    this.closing = false;
    this.emit();
  }
  assert(epoch = this.epoch) {
    if (epoch !== this.epoch || !this.grant) throw locked();
    if (this.now() >= this.deadline) {
      this.lock('NAS 使用权已到期。');
      throw locked();
    }
  }
  signal() {
    this.assert();
    return this.scope.signal;
  }
  async connect(input = {}) {
    this.lock();
    this.config = null;
    const epoch = this.epoch,
      previous = this.saved.config;
    const config = validated({ ...previous, ...input, token: input.token || previous?.token });
    // A stored credential and library binding belong to their verified endpoint.
    if (
      previous &&
      (previous.url !== config.url ||
        previous.deviceId !== config.deviceId ||
        previous.fingerprint !== config.fingerprint) &&
      !input.token
    )
      throw Error('更换连接时请重新输入服务访问凭据。');
    const status = await this.request(config, 'status', {}, this.scope.signal);
    if (epoch !== this.epoch) throw locked();
    if (status.protocolVersion !== serverIdentity.protocolVersion)
      throw Error('服务协议不兼容，请核对版本。');
    this.config = config;
    // Persist the new binding only after acquire identifies the actual library.
    this.saved.config = { ...config, libraryId: config.libraryId ?? previous?.libraryId ?? null };
    this.save();
    this.reason = status.occupied ? '另一台电脑正在使用资料库。' : '可以取得使用权。';
    this.emit();
    return status;
  }
  schedule(grant, start) {
    if (
      !grant ||
      !Number.isInteger(grant.ttlMs) ||
      grant.ttlMs <= 0 ||
      grant.ttlMs > 20000 ||
      !grant.libraryId ||
      this.now() >= start + grant.ttlMs
    )
      throw locked();
    this.grant = grant;
    this.deadline = start + grant.ttlMs;
    clearTimeout(this.expiry);
    clearTimeout(this.heartbeat);
    this.expiry = setTimeout(() => this.lock('NAS 使用权已到期。'), Math.max(1, this.deadline - this.now()));
    this.expiry.unref?.();
    this.heartbeat = setTimeout(
      () => void this.renew().catch(() => {}),
      Math.max(1, Math.min(6000, (this.deadline - this.now()) / 2))
    );
    this.heartbeat.unref?.();
  }
  async acquire() {
    if (!this.config) throw locked();
    this.lock();
    const epoch = this.epoch,
      start = this.now(),
      instanceId = randomUUID(),
      operationId = randomUUID();
    try {
      const grant = await this.request(
        this.config,
        'acquire',
        { libraryId: this.config.libraryId, deviceId: this.config.deviceId, instanceId, operationId },
        this.scope.signal
      );
      if (epoch !== this.epoch) throw locked();
      if (
        !grant ||
        !uuidPattern.test(grant.libraryId) ||
        !uuidPattern.test(grant.bootId) ||
        !Number.isSafeInteger(grant.generation) ||
        grant.generation < 1 ||
        grant.instanceId !== instanceId ||
        grant.deviceId !== this.config.deviceId ||
        typeof grant.accountId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(grant.accountId) ||
        !/^[0-9a-f]{64}$/.test(grant.proof)
      )
        throw locked();
      if (this.config.libraryId && grant.libraryId !== this.config.libraryId)
        throw Error('NAS 资料库身份已更换。');
      this.config.libraryId = grant.libraryId;
      this.saved.config = this.config;
      this.save();
      this.schedule(grant, start);
      this.reason = '已取得使用权。';
      await this.reconcile();
      this.assert(epoch);
      this.emit();
      return this.state();
    } catch (e) {
      if (epoch === this.epoch) this.lock(e.message);
      throw e;
    }
  }
  async call(route, body) {
    this.assert();
    const epoch = this.epoch;
    try {
      const value = await this.request(this.config, route, { ...body, grant: this.grant }, this.scope.signal);
      this.assert(epoch);
      return value;
    } catch (error) {
      if (
        epoch === this.epoch &&
        (!error.status || [401, 403, 426].includes(error.status) || error.status >= 500)
      )
        this.lock('NAS 使用权未能确认。' + error.message);
      throw error;
    }
  }
  async renew() {
    const start = this.now(),
      epoch = this.epoch;
    try {
      const grant = await this.call('renew', {});
      this.assert(epoch);
      for (const field of [
        'deviceId',
        'accountId',
        'libraryId',
        'instanceId',
        'bootId',
        'generation',
        'proof'
      ]) {
        if (grant?.[field] !== this.grant[field]) throw locked();
      }
      this.schedule(grant, start);
    } catch (error) {
      if (epoch === this.epoch) this.lock(error.message);
      throw error;
    }
  }
  query(kind, payload = {}) {
    return this.call('query', { kind, payload });
  }
  receipt(operationId) {
    return this.call('receipt', { operationId });
  }
  get scopeKey() {
    return JSON.stringify([this.grant.libraryId, this.grant.accountId]);
  }
  async reconcile() {
    this.assert();
    const epoch = this.epoch,
      key = this.scopeKey;
    const ids = this.pending[key] ?? [];
    if (!ids.length) return;
    this.reconciling = true;
    this.emit();
    for (const id of [...ids]) {
      const result = await this.receipt(id);
      this.assert(epoch);
      this.recent = { operationId: id, confirmed: !!result };
      this.pending[key] = this.pending[key].filter((x) => x !== id);
      this.save();
    }
    this.reconciling = false;
    this.emit();
  }
  async command(command) {
    this.assert();
    if (this.closing) throw Error('正在交接使用权。');
    const epoch = this.epoch,
      key = this.scopeKey,
      id = command.operationId;
    if (!id) throw Error('缺少操作标识。');
    this.pending[key] = [...new Set([...(this.pending[key] ?? []), id])];
    this.save();
    const pending = this.call('command', command);
    this.inFlight.add(pending);
    try {
      const receipt = await pending;
      this.assert(epoch);
      this.pending[key] = this.pending[key].filter((x) => x !== id);
      this.save();
      this.recent = { operationId: id, confirmed: true };
      this.emit();
      return receipt;
    } catch (error) {
      if (epoch === this.epoch && error.status >= 400 && error.status < 500) {
        this.pending[key] = this.pending[key].filter((x) => x !== id);
        this.save();
      }
      throw error;
    } finally {
      this.inFlight.delete(pending);
    }
  }
  async release() {
    this.assert();
    const epoch = this.epoch;
    this.closing = true;
    try {
      await Promise.allSettled([...this.inFlight]);
      this.assert(epoch);
      await this.reconcile();
      await this.call('release', { operationId: randomUUID() });
    } finally {
      if (epoch === this.epoch) this.lock('已释放使用权。');
    }
  }
}
