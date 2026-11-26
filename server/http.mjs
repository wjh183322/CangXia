import https from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { failure } from './session.mjs';
import { serverIdentity } from '../shared/server-identity.mjs';

const digest = (value) => createHash('sha256').update(value).digest();
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function createHttpsService(options) {
  const { credentials, key, cert } = options;
  const devices = new Map(),
    tokens = new Set();
  for (const [deviceId, { accountId, token }] of Object.entries(credentials)) {
    if (
      !validId(deviceId) ||
      !validId(accountId) ||
      typeof token !== 'string' ||
      !/^[A-Za-z0-9._~-]{32,256}$/.test(token) ||
      tokens.has(token)
    )
      throw Error('Configure an independent, unique service credential for each desktop.');
    tokens.add(token);
    devices.set(deviceId, { accountId, digest: digest(token) });
  }
  if (!devices.size) throw Error('Service credentials are required.');
  return https.createServer(
    { key, cert, minVersion: 'TLSv1.2', headersTimeout: 10000, requestTimeout: 15000 },
    async (req, res) => {
      const reply = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(value));
      };
      try {
        const deviceId = req.headers['x-cangxia-device'];
        const device = devices.get(deviceId),
          header = req.headers.authorization ?? '';
        if (
          !device ||
          !header.startsWith('Bearer ') ||
          !timingSafeEqual(device.digest, digest(header.slice(7)))
        )
          throw failure(401, 'UNAUTHORIZED', '服务访问凭据无效。');
        if (req.headers['x-cangxia-protocol'] !== String(serverIdentity.protocolVersion))
          throw failure(426, 'PROTOCOL_CHANGED', '服务协议不兼容，请核对版本。');
        if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json')
          throw failure(400, 'INVALID_REQUEST', '请求格式无效。');
        let n = 0;
        const chunks = [];
        for await (const chunk of req) {
          n += chunk.length;
          if (n > 256 * 1024) throw failure(413, 'TOO_LARGE', '请求过大。');
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {}
        if (!body || Array.isArray(body) || typeof body !== 'object')
          throw failure(400, 'INVALID_REQUEST', '请求格式无效。');
        const who = { deviceId, accountId: device.accountId };
        const { sessions } = options;
        let result;
        switch (req.url) {
          case '/v1/status':
            result = sessions.status();
            break;
          case '/v1/acquire':
            result = sessions.acquire(who, body);
            break;
          case '/v1/renew':
            result = sessions.renew(who, body.grant);
            break;
          case '/v1/release':
            result = sessions.release(who, body.grant, body.operationId);
            break;
          case '/v1/query':
            result = sessions.query(who, body.grant, body);
            break;
          case '/v1/command':
            result = sessions.command(who, body.grant, body);
            break;
          case '/v1/receipt':
            result = sessions.receipt(who, body.grant, body.operationId);
            break;
          default:
            throw failure(404, 'UNKNOWN_ROUTE', '无此服务接口。');
        }
        reply(200, result);
      } catch (error) {
        reply(error.status ?? 500, {
          code: error.status ? error.code : 'SERVER_ERROR',
          message: error.status ? error.message : 'NAS 当前无法完成请求。'
        });
      }
    }
  );
}
