import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' });
for (let i = 0; i < 80; i++) {
  try { if ((await fetch('http://127.0.0.1:5173')).ok) break; } catch {}
  await new Promise(r => setTimeout(r, 250));
}
const env = { ...process.env, CANGXIA_DEV: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const electron = spawn(require('electron'), ['.'], { stdio: 'inherit', env });
electron.on('exit', code => { vite.kill(); process.exit(code ?? 0); });
process.on('SIGINT', () => { electron.kill(); vite.kill(); });
