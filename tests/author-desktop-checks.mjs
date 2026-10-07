import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
export async function checkAuthorDesktop({win,http,call,check,profile}){
  const id='MS4wLjABAAAA_SYNTHETIC_AUTHOR',cursors=[],prior=await call('state');let hold=false,arrived=false;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6kAAAAASUVORK5CYII=','base64');
  const raw=n=>({aweme_id:String(n),desc:'作者测试作品 '+n,author:{uid:'777',sec_uid:id,nickname:'主页示例作者'},...(n%2===0?{images:[{url_list:['https://p3.douyinpic.com/author-fixture.png']},{url_list:['https://p3.douyinpic.com/author-fixture.png']}]}:{video:{play_addr:{url_list:['https://v3.douyinvod.com/author-fixture.mp4']},cover:{url_list:['https://p3.douyinpic.com/author-fixture.png']},duration:10000}})});
  const previous=http.fetch;http.fetch=async(url,options)=>{
    const u=new URL(url),route=u.pathname;
    if(route==='/aweme/v1/web/user/profile/self/')return Response.json({status_code:0,user:{uid:'123',nickname:'fixture'}});
    if(route==='/aweme/v1/web/user/profile/other/')return Response.json({status_code:0,user:{uid:'777',sec_uid:id,nickname:'主页示例作者',unique_id:'author_demo',aweme_count:35}});
    if(route==='/aweme/v1/web/aweme/post/'){
      const cursor=u.searchParams.get('max_cursor');cursors.push(cursor);
      if(cursor==='0')return Response.json({status_code:0,aweme_list:Array.from({length:30},(_,i)=>raw(100000+i)),has_more:1,max_cursor:'30'});
      if(hold){arrived=true;return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}
      return Response.json({status_code:0,aweme_list:[raw(100000),raw(100030),raw(100031)],has_more:0,max_cursor:'60'});
    }
    if(route==='/aweme/v1/web/aweme/detail/')return Response.json({status_code:0,aweme_detail:raw(Number(u.searchParams.get('aweme_id')))});
    if(u.hostname==='p3.douyinpic.com')return new Response(png,{headers:{'content-type':'image/png','content-length':String(png.length)}});
    if(u.hostname==='v3.douyinvod.com')return new Response(new Uint8Array(64).fill(5),{headers:{'content-type':'video/mp4','content-length':'64'}});
    throw Error('Unexpected author fixture request');
  };
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const click=async text=>{let result;for(let i=0;i<30;i++){result=await win.webContents.executeJavaScript(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return {ok:false,disabled:!!b?.disabled,buttons:[...document.querySelectorAll('button')].map(x=>x.textContent.trim())};b.click();return {ok:true};})()`);if(result.ok)break;await wait(100);}assert.ok(result.ok,'Missing enabled button '+text+': '+JSON.stringify(result));await wait(300);};
  try{
    const added=await call('addAuthor',`https://www.douyin.com/user/${id}`);assert.equal(added.id,id);await wait(400);
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.main-nav button')].find(b=>b.textContent.includes('作者作品')).click()`);await wait(150);await click('主页示例作者0');await click('读取作者作品');
    check('native author dialog defaults to 20 and identifies homepage owner',await win.webContents.executeJavaScript(`document.querySelector('[aria-label="作者读取作品数"]').value==='20'&&document.querySelector('.modal').textContent.includes('author_demo')`));
    try{fs.writeFileSync('.test-output/author-read-dialog.png',(await win.webContents.capturePage()).toPNG());}catch(e){fs.writeFileSync('.test-output/author-capture-note.txt',String(e));}
    await click('从头读取 20 条');let state;for(let i=0;i<60;i++){state=await call('state');if(!state.collector.busy&&state.authorMembers?.[id]?.length===20)break;await wait(100);}
    check('native author first page is bounded to 20 without favorite contamination',state.authorMembers[id].length===20&&JSON.stringify(state.members)===JSON.stringify(prior.members));await wait(400);
    check('native author list renders cards without collection-order warnings',await win.webContents.executeJavaScript(`document.querySelectorAll('.work-card').length===20&&!document.querySelector('.order-section')&&document.querySelector('h1').textContent.includes('主页示例作者')`));try{fs.writeFileSync('.test-output/author-first-page.png',(await win.webContents.capturePage()).toPNG());}catch(e){fs.writeFileSync('.test-output/author-capture-note.txt',String(e));}
    const expanded=await call('readAuthor',{id,readAll:true,resume:true});check('native author resumes remaining page and deduplicates pinned items',expanded.complete&&expanded.processed===12&&JSON.stringify(cursors)===JSON.stringify(['0','0','30']));
    hold=true;arrived=false;const pending=call('readAuthor',{id,readAll:true});pending.catch(()=>{});for(let i=0;i<60&&!arrived;i++)await wait(100);assert.ok(arrived);await assert.rejects(call('download',['100000']),/正在读取/);await assert.rejects(call('logout'),/正在读取/);await call('stopSync');assert.equal((await pending).stopped,true);state=await call('state');check('native author stop keeps 32 records and exposes continuation',!state.collector.busy&&state.authorMembers[id].length===32&&state.authors.find(a=>a.id===id).run.canResume);
    hold=false;const directory=path.join(path.dirname(profile),'author-media');fs.mkdirSync(directory);const intent=await call('flatPrepare',directory,['100000','100001'],true);await call('flatStart',intent.token,false);
    for(let i=0;i<60;i++){state=await call('state');if(!state.flatQueue.running)break;await wait(100);}const batch=state.flatQueue.batches.at(-1);
    check('native author batch downloads both images and video with optional cover',batch.complete===2&&batch.failed===0&&fs.readdirSync(directory).length===4&&fs.readdirSync(directory).filter(n=>n.endsWith('.png')).every(n=>fs.readFileSync(path.join(directory,n)).equals(png)));
    check('author one-off download leaves normal library and favorites unchanged',state.works.filter(w=>w.local).length===prior.works.filter(w=>w.local).length&&JSON.stringify(state.members)===JSON.stringify(prior.members));
  }finally{http.fetch=previous;}
}
