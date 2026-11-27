import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { ServerClient } from '../electron/server-client.mjs';
import { sealSource, digest, directory, disjoint } from './rehearsal-files.mjs';
import { writeDurably } from './library.mjs';

async function main([action, ...args]) {
  if (action === 'seal') {
    const options = Object.fromEntries(
      ['directory', 'kind', 'database', 'media', 'device', 'out'].map((k) => [k, { type: 'string' }])
    );
    const { values: v } = parseArgs({ args, options });
    const out = path.resolve(v.out);
    directory(path.dirname(out));
    disjoint(v.directory, out);
    const first = await sealSource(v),
      second = await sealSource(v);
    if (first.seal !== second.seal) throw Error('封存期间来源发生变化，请先将旧端停在一致边界。');
    const { directory: original, ...portable } = second,
      body = JSON.stringify(portable) + '\n';
    writeDurably(out, body);
    return { manifest: out, manifestSha256: digest(body), files: portable.files.length };
  }
  if (action !== 'request') throw Error('请选择 seal 或 request。');
  const { values: v } = parseArgs({
    args,
    options: { config: { type: 'string' }, input: { type: 'string' } }
  });
  const config = JSON.parse(fs.readFileSync(v.config, 'utf8')),
    input = JSON.parse(fs.readFileSync(v.input, 'utf8'));
  const client = new ServerClient();
  const status = await client.connect(config);
  await client.acquire(status.attempt);
  try {
    let result = await client.call('rehearsal', { input });
    if (result.state === 'running' && result.id) {
      const { id } = result;
      do {
        await wait(500);
        result = await client.call('rehearsal', { input: { action: 'status', id } });
      } while (result.state === 'running');
      return { id, ...result };
    }
    return result;
  } finally {
    await client.release();
  }
}
try {
  const result = await main(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
  if (['interrupted', 'failed'].includes(result.state)) process.exitCode = 1;
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
