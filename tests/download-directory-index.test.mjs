import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {SqliteStore} from '../electron/sqlite-store.mjs';
import {buildDirectoryIndex,directoryKey,DirectoryReservations} from '../electron/download-directory-index.mjs';
import {DownloadPathJournal} from '../electron/download-path-journal.mjs';
import {createPreparationFixture} from './download-preparation-fixture.mjs';

test('one compact scan serves 775 candidates and preserves multiple owners and reservations',()=>{
 let scans=0;const shared=path.join(os.tmpdir(),'cx-owner-test','shared');
 const rows={*[Symbol.iterator](){scans++;yield {id:'1',path:shared};yield {id:'2',path:shared.toUpperCase()};for(let i=3;i<=31542;i++)yield {id:String(i),path:path.join(os.tmpdir(),'cx-owner-test',String(i))};}};
 const index=buildDirectoryIndex(rows),r=new DirectoryReservations(index);
 for(let i=0;i<775;i++)assert.equal(r.owners(shared).size,2);
 assert.equal(scans,1);assert.deepEqual([...index.get(directoryKey(shared))].sort(),['1','2']);
 r.reserve(shared,'new');assert.equal(r.owners(shared).has('new'),true);r.release('new');assert.equal(r.owners(shared).has('new'),false);assert.equal(r.owners(shared).has('1'),true);
 r.update({id:'1',oldPath:shared,path:shared+'-moved'});assert.equal(r.owners(shared).has('1'),false);assert.equal(r.owners(shared+'-moved').has('1'),true);
});

test('transactional path journal covers insert, replacement, direct SQL, rollback and bounded gaps',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cx-path-journal-'));const db=await SqliteStore.open(path.join(dir,'library.sqlite'));
 t.after(()=>{db.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});
 db.run('CREATE TABLE downloads(id TEXT PRIMARY KEY,body TEXT)');const j=new DownloadPathJournal({db});j.init();assert.equal(j.head(),0);
 db.run('INSERT INTO downloads VALUES(?,?)',['1',JSON.stringify({path:'C:\\media\\one',assets:[]})]);const first=j.head();assert.ok(first>0);
 db.run('UPDATE downloads SET body=? WHERE id=?',[JSON.stringify({path:'C:\\media\\one',assets:[{size:10}]}),'1']);assert.equal(j.head(),first);
 db.run('INSERT OR REPLACE INTO downloads VALUES(?,?)',['1',JSON.stringify({path:'C:\\media\\one',assets:[{size:20}]})]);assert.equal(j.head(),first,'Store.put replacements without a path change must not invalidate ownership');
 db.run('BEGIN');db.run('UPDATE downloads SET body=? WHERE id=?',[JSON.stringify({path:'C:\\media\\rollback'}),'1']);db.run('ROLLBACK');assert.equal(j.head(),first);
 db.run('INSERT OR REPLACE INTO downloads VALUES(?,?)',['1',JSON.stringify({path:'C:\\media\\two'})]);
 assert.equal(j.changes(first).items.at(-1).path,'C:\\media\\two');
 db.run('DELETE FROM downloads WHERE id=?',['1']);assert.equal(j.changes(first).items.at(-1).path,null);
 for(let i=0;i<205;i++)db.run('INSERT INTO downloads VALUES(?,?)',[String(i),JSON.stringify({path:'C:\\media\\'+i})]);
 const page=j.changes(0);assert.equal(page.items.length,200);assert.equal(page.hasMore,true);
 j.prune({keep:3});assert.throws(()=>j.changes(first),e=>e.code==='PATH_JOURNAL_GAP');assert.equal(j.changes(j.head()).items.length,0);
});

test('real destination context keeps collision suffix and remembered NAS home without reading full downloads',async t=>{
 const f=await createPreparationFixture(t,{savedCount:2,unsavedCount:2}),s=f.store;
 for(const id of ['3','4'])s.put('works',id,{...s.work(id),name:'same-title'});
 const all=s.all.bind(s);let scans=0;s.all=table=>{if(table==='downloads')scans++;return all(table);};
 const first=s.destination('3',{owners:new Map(),exists:()=>false,check:false}),owners=new Map([[directoryKey(first.dir),new Set(['3'])]]);
 const second=s.destination('4',{owners,exists:()=>false,check:false});assert.equal(second.dir,first.dir+'-4');assert.equal(scans,0);
 s.put('backup_downloads','4',{id:'4',home:{kind:'collection',id:'__all__',folder:'remembered',workFolder:'four'},assets:[]});
 assert.equal(s.destination('4',{owners,check:false}).dir,path.join(s.root,'remembered','four'));assert.equal(scans,0);
});
