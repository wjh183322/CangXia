import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { createHttpsService } from './http.mjs';
import { createSourceBrowser } from './source-browser.mjs';
import { createSessionService } from './session.mjs';
import { parseArgs } from 'node:util';
import { openLibrary } from './library.mjs';
import { applyUpgrade, inspectUpgrade } from './upgrade.mjs';

export function startServer({ root, expectedId }) {
  return openLibrary({ root, expectedId, mode: 'open' });
}

async function main([action = 'start', ...args]) {
  const options = { root: { type: 'string' }, 'library-id': { type: 'string' } };
  if (action === 'upgrade') {
    for (const key of ['from', 'to', 'image-digest', 'approval']) options[key] = { type: 'string' };
  }
  const { values } = parseArgs({ args, options });
  const root = values.root ?? process.env.CANGXIA_LIBRARY_ROOT;
  const expectedId = values['library-id'] ?? process.env.CANGXIA_LIBRARY_ID;
  if (!root) throw Error('Set --root or CANGXIA_LIBRARY_ROOT to the dedicated volume.');
  if (action === 'inspect') return inspectUpgrade(root, expectedId);
  if (action === 'upgrade')
    return applyUpgrade({
      root,
      expectedId,
      from: Number(values.from),
      to: Number(values.to),
      imageDigest: values['image-digest'],
      approval: JSON.parse(values.approval ?? 'null')
    });
  if (action !== 'start' && action !== 'init') throw Error('Choose start, inspect, init, or upgrade.');
  const library =
    action === 'init' ? openLibrary({ root, expectedId, mode: 'init' }) : startServer({ root, expectedId });
  if (action === 'start' && library.state === 'ready') {
    try {
      if (!expectedId) throw Error('Set the expected CANGXIA_LIBRARY_ID before serving the volume.');
      const {
        CANGXIA_TLS_KEY_FILE: keyFile,
        CANGXIA_TLS_CERT_FILE: certFile,
        CANGXIA_DEVICES_FILE: devices
      } = process.env;
      if (!keyFile || !certFile || !devices)
        throw Error('Set CANGXIA_TLS_KEY_FILE, CANGXIA_TLS_CERT_FILE and CANGXIA_DEVICES_FILE.');
      const config = {
        key: fs.readFileSync(keyFile),
        cert: fs.readFileSync(certFile),
        credentials: JSON.parse(fs.readFileSync(devices, 'utf8'))
      };
      const server = createHttpsService(config);
      const port = Number(process.env.CANGXIA_PORT ?? 9443);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, process.env.CANGXIA_HOST ?? '0.0.0.0', () => {
          try {
            config.source = createSourceBrowser({ library, root });
            config.sessions = createSessionService({ library, source: config.source });
            resolve();
          } catch (error) {
            server.close();
            reject(error);
          }
        });
      });
      const stop = async () => {
        config.sessions.close();
        server.closeAllConnections();
        await config.source.close();
        server.close(() => library.close());
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      return { state: 'serving', libraryId: library.libraryId, port: server.address().port };
    } catch (error) {
      library.close();
      throw error;
    }
  }
  library.close?.();
  return library;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await main(process.argv.slice(2))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
