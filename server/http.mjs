import { refreshAudio,serveMedia } from './media.mjs';
import https from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { failure } from './session.mjs';
import { serverIdentity } from '../shared/server-identity.mjs';

const digest = (value) => createHash('sha256').update(value).digest();
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sourceActions = new Map([
  ['/v1/source/open', ['openLogin']],
  ['/v1/source/view', ['loginView', 'viewId']],
  ['/v1/source/refresh', ['refreshLogin', 'viewId']],
  ['/v1/source/shown', ['qrShown', 'viewId', 'token']],
  ['/v1/source/manual', ['manualLogin', 'viewId', 'input']],
  ['/v1/source/cancel', ['cancelLogin', 'viewId']],
  ['/v1/source/logout', ['logout']],
  ['/v1/identity/verify', ['verifyAccount']],
  ['/v1/identity/recover', ['recover']]
]);
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
        const who = { deviceId, accountId: device.accountId };
        const { sessions } = options;
        if (['GET','HEAD'].includes(req.method) && req.url.startsWith('/v1/media?')) {
          const params=new URL(req.url,'https://localhost').searchParams;
          let grant;
          try{grant=JSON.parse(Buffer.from(req.headers['x-cangxia-grant'],'base64url').toString('utf8'));}catch{}
          const session=sessions.sourceSession(who,grant);
          if(!options.downloads)throw failure(404,'MEDIA_UNAVAILABLE','此媒体暂不可读取。');
          await serveMedia(req,res,{downloads:options.downloads,session,body:{
            resourceId:params.get('id'),version:params.get('version'),head:req.method==='HEAD'
          }});
          return;
        }
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
        let result;
        switch (req.url) {
          case '/v1/media/refresh-audio':
            result=await refreshAudio({downloads:options.downloads,session:sessions.sourceSession(who,body.grant),id:body.id});
            break;
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
          case '/v1/source/begin':
          case '/v1/source/stop':
          case '/v1/source/folders':
          case '/v1/source/author':
          case '/v1/source/creator-profiles':
          case '/v1/source/resolve-work': {
            result = await sessions.sourceOperation(who, body.grant, req.url.split('/').pop(), body);
            break;
          }
          default: {
            const action = sourceActions.get(req.url);
            if (!action) throw failure(404, 'UNKNOWN_ROUTE', '无此服务接口。');
            const session = sessions.sourceSession(who, body.grant);
            const [method, ...keys] = action;
            if (
              Object.keys(body).some((key) => key !== 'grant' && !keys.includes(key)) ||
              keys.some((key) => !Object.hasOwn(body, key))
            )
              throw failure(400, 'INVALID_REQUEST', '请求参数无效。');
            result = await options.source[method](session, ...keys.map((key) => body[key]));
            session.read(() => null);
          }
        }
        reply(200, result);
      } catch (error) {
        if (res.headersSent || res.destroyed) {res.destroy();return;}
        reply(error.status ?? 500, {
          code: error.status ? error.code : 'SERVER_ERROR',
          message: error.status ? error.message : 'NAS 当前无法完成请求。'
        });
      }
    }
  );
}
