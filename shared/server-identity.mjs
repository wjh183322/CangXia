import { readFileSync } from 'node:fs';
import path from 'node:path';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const serverIdentity = Object.freeze({
  productName: '藏匣服务版',
  version,
  appId: 'local.cangxia.server',
  protocolVersion: 1
});

export function serverProfilePath(appData) {
  return path.join(appData, serverIdentity.productName);
}
