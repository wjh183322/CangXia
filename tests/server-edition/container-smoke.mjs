import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {openLibrary} from '../../server/library.mjs';
import {createSessionService} from '../../server/session.mjs';
import {createSourceBrowser} from '../../server/source-browser.mjs';
import {openOfficialProvider} from '../../server/source-provider.mjs';
import {testNavigation} from './source-navigation-fixture.mjs';
test('offline Chromium official navigation controls',t=>testNavigation(t,openOfficialProvider));
test('saved profile directory with unexpected access fails closed',async t=>{
  const root='/library',library=openLibrary({root,expectedId:fs.readFileSync('/config/identity/library-id','utf8')});
  const source=createSourceBrowser({library,root}),sessions=createSessionService({library,source});
  t.after(async()=>{await sessions.close();await source.close();library.close();});
  const who={deviceId:'ci',accountId:'ci'}, grant=sessions.acquire(who,{deviceId:'ci',instanceId:randomUUID(),operationId:randomUUID()});
  const profile=randomUUID();
  library.write(db=>db.prepare('INSERT OR REPLACE INTO source_account VALUES(1,?,?,?)').run('42','fixture',profile));
  const dir=root+'/cangxia-server/source-session';
  fs.mkdirSync(dir,{recursive:true,mode:0o700}); fs.chmodSync(dir,0o755);
  await assert.rejects(source.recover(sessions.sourceSession(who,grant)),/权限/);
  fs.chmodSync(dir,0o700);
});
test('native download, checksum and recovery flows on Linux',()=>{
  execFileSync(process.execPath,['--test','--test-concurrency=1','/opt/cangxia/tests/server-edition/downloads.test.mjs','/opt/cangxia/tests/server-edition/archive.test.mjs'],{stdio:'inherit',timeout:360000});
});
