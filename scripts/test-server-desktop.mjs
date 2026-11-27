import {spawnSync} from 'node:child_process';
if(process.platform!=='win32') throw Error('Windows x64 desktop required.');
const run=spawnSync(process.execPath,['--test','--test-concurrency=1','tests/server-edition/*.test.mjs'],{
  stdio:'inherit',env:{...process.env,CANGXIA_DESKTOP_SESSION_TEST:'1'}
});
if(run.error)throw run.error;
process.exitCode=run.status??1;
