
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { readProbeConfig, validateAccessHost } from '../src/config.mjs';

try {
  const config = readProbeConfig(process.env);
  const accessHost = validateAccessHost(config.accessHost);
  const ca = await readFile(config.root + '/state/server.pem');
  const signal = AbortSignal.timeout(4000);
  await new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port: config.port, path: '/', ca, signal,
      servername: isIP(accessHost) ? '' : accessHost,
      checkServerIdentity: (_, certificate) => checkServerIdentity(accessHost, certificate)
    }, response => {
      if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('text/html')) {
        response.destroy();
        reject(new Error('Invalid health response.'));
        return;
      }
      response.resume();
      response.on('error', reject);
      response.on('end', resolve);
    });
    req.on('error', reject);
    req.end();
  });
} catch {
  process.exitCode = 1;
}
