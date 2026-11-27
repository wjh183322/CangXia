import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import selfsigned from 'selfsigned';
import {openLibrary} from '../../server/library.mjs';
import {createSessionService} from '../../server/session.mjs';
import {createHttpsService} from '../../server/http.mjs';
import {createDownloads} from '../../server/downloads.mjs';
import {ServerClient,pinnedMedia} from '../../electron/server-client.mjs';

const count=Number(process.argv[2]??50000);
assert.ok(Number.isInteger(count)&&count>=40&&count<=50000);
const area=fs.mkdtempSync(path.join(os.tmpdir(),'cx-release-benchmark-'));
const root=path.join(area,'volume');fs.mkdirSync(root);
let library,downloads,sessions,server,client;
try {
  execFileSync(process.env.CANGXIA_TEST_COVER_PYTHON || 'python3',['-I',fileURLToPath(new URL('./fixtures/archive-cover.py',import.meta.url)),area]);
  const movie=fs.readFileSync(path.join(area,'video.mp4')),cover=fs.readFileSync(path.join(area,'reference.png'));
  const source={account:()=>({uid:'42',authEpoch:'test'}),recover:async()=>null};
  library=openLibrary({root,mode:'init'});
  let metadataBytes=0,relations=0;
  library.write(db=>{
    db.exec("INSERT INTO source_account VALUES(1,'42','synthetic','profile');INSERT INTO download_auth VALUES(1,'fixture')");
    const put=db.prepare('INSERT INTO works VALUES(?,?,?)'),member=db.prepare('INSERT INTO source_members VALUES(?,?,?,0)');
    const tag=db.prepare('INSERT INTO work_tags VALUES(?,?)');
    for(let i=0;i<count;i++){
      const id=String(i+1000), name='合成作品 '+id, type=(i%5===4?'images':'video');
      const addr=(kind,n)=>'https://p3.douyinpic.com/benchmark/'+kind+'/'+id+'/'+n+'?fixture='+'a'.repeat(88);
      const w={id,name,type,author:{uid:String(42+i%400),nickname:'合成作者 '+i%400},
        description:('旅行、摄影与生活记录。').repeat(8+i%13),tags:['合成','样本'+i%71],createTime:1710000000+i,
        coverUrls:[addr('cover',1),addr('cover',2)],music:{id:String(i%30+1),title:'测试配乐'},
        ...(type==='images'?{images:Array.from({length:3+i%4},(_,n)=>({index:n,urls:[addr('image',n)]}))}:
          {videoUrls:[addr('video',1),addr('video',2)],duration:3000,width:960,height:540})};
      const body=JSON.stringify(w);metadataBytes+=Buffer.byteLength(body);put.run(id,name,body);
      member.run('total',id,i);member.run('folder:'+String(i%50+50),id,i);relations+=2;
      if(i%3===0){member.run('author:'+w.author.uid,id,i);relations++;}
      if(i%4===0)tag.run(id,'合成标签');
    }
  });
  const id=library.libraryId;
  library.close();library=openLibrary({root,expectedId:id});
  downloads=createDownloads({root,library,source,fetchAsset:async url=>{
    const video=url.includes('/video/'), bytes=video?movie:cover;
    return new Response(bytes,{headers:{'content-length':String(bytes.length),'content-type':video?'video/mp4':'image/png'}});
  }});
  library.write(db=>downloads.enqueue(db,['1000'],'missing'));
  await downloads.run();
  sessions=createSessionService({library,source,downloads});
  const credentials={pc:{accountId:'benchmark',token:'b'.repeat(48)}};
  const tls=await selfsigned.generate([{name:'commonName',value:'localhost'}],{keySize:2048});
  server=createHttpsService({cert:tls.cert,key:tls.private,credentials,sessions,downloads});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const config={url:'https://127.0.0.1:'+server.address().port,deviceId:'pc',token:credentials.pc.token,
    fingerprint:new X509Certificate(tls.cert).fingerprint256,libraryId:id};
  client=new ServerClient();await client.connect(config);await client.acquire();
  const measure=async(fn)=>{const t=performance.now();await fn();return Math.round((performance.now()-t)*10)/10;};
  const list=async page=>{const result=await client.query('list-works',{source:'total',page});assert.equal(result.total,count);assert.equal(result.ids.length,20);};
  const firstPageMs=await measure(()=>list(1)),warmMs=[];
  for(const page of [1,2,Math.floor(count/40),1,2])warmMs.push(await measure(()=>list(page)));
  const detail=await client.query('work-detail',{id:'1000'}),video=detail.media.find(x=>x.key==='video'),pic=detail.media.find(x=>x.key==='cover');
  assert.ok(pic&&video,'archived cover and video must be available');
  const media=async(item,range,expected)=>{
    const res=await pinnedMedia(client.config,client.grant,item,{range,signal:new AbortController().signal});
    assert.equal(res.statusCode,range?206:200);const chunks=[];for await(const chunk of res)chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks),expected);
  };
  const getCover=()=>media(pic,undefined,cover),getRange=()=>media(video,'bytes=0-65535',movie.subarray(0,65536));
  const coverMs=await measure(getCover),rangeMs=await measure(getRange);
  const mixedMs=await measure(()=>Promise.all([list(1),list(2),getCover(),getRange()]));
  console.log(JSON.stringify({transport:'HTTPS loopback',count,relations,metadataBytes,averageBodyBytes:Math.round(metadataBytes/count),
    videoBytes:movie.length,coverBytes:cover.length,firstPageMs,warmMs,coverMs,rangeMs,mixedMs},null,2));
} finally {
  if(client)await client.release().catch(()=>{});
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  await sessions?.close();await downloads?.close();library?.close();
  fs.rmSync(area,{recursive:true,force:true,maxRetries:5});
}
