import { pathToFileURL } from 'node:url';
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
