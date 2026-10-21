import {app,net} from 'electron';import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
const root=process.env.CANGXIA_PREVIEW_TEST_PROFILE;if(!root)throw Error('isolated profile required');app.setPath('userData',path.join(root,'profile'));app.disableHardwareAcceleration();
void app.whenReady().then(async()=>{const checks=[],check=(name,value)=>{assert.ok(value,name);checks.push(name);};let previews;
 try{
  const base=process.env.CANGXIA_PREVIEW_TEST_PACKAGE?pathToFileURL(path.resolve(process.env.CANGXIA_PREVIEW_TEST_PACKAGE)+path.sep):new URL('../electron/',import.meta.url);
  const [{PreviewFiles},{quiesceSelectedDeletion,withReleasedPreviews}]=await Promise.all(['preview-files.mjs','deletion-session.mjs'].map(file=>import(new URL(file,base).href)));
  previews=new PreviewFiles((file,options)=>net.fetch(pathToFileURL(file).href,options));const dirs=[];
  for(const id of ['1','2']){const dir=path.join(root,'owned-'+id);assert.equal(path.dirname(dir),root);fs.mkdirSync(dir);const file=path.join(dir,'video.bin');fs.writeFileSync(file,Buffer.alloc(32*1024*1024,1));dirs.push({id,dir,file,moved:path.join(root,'moved-'+id)});}
  let released=0;const responses=[];for(const entry of dirs){const response=await previews.open(entry.id,entry.file,new Request('https://fixture.invalid/'),{release:()=>released++});const reader=response.body.getReader();await reader.read();responses.push(reader);}
  if(process.platform==='win32'){let locked=false;try{await fs.promises.rename(dirs[0].dir,dirs[0].moved);await fs.promises.rename(dirs[0].moved,dirs[0].dir);}catch(error){locked=['EPERM','EACCES','EBUSY'].includes(error.code);}check('an active real Chromium file response reproduces the Windows folder lock',locked);}
  const unblock=previews.block(['1']);await quiesceSelectedDeletion({ids:['1'],files:true},{previews});check('selected cache pin and preview are released before deletion returns',released===1&&!previews.active.has('1')&&previews.active.has('2'));
  await fs.promises.rename(dirs[0].dir,dirs[0].moved);check('the folder moves immediately without closing the app or changing permissions',fs.existsSync(dirs[0].moved)&&!fs.existsSync(dirs[0].dir));
  const denied=await previews.open('1',dirs[0].file,new Request('https://fixture.invalid/'));check('selected works cannot reopen a file during the deletion',denied.status===423);
  const chunk=await responses[1].read();check('unrelated previews remain readable',!chunk.done&&chunk.value.length>0);
  unblock();const reopened=await previews.open('1',path.join(dirs[0].moved,'video.bin'),new Request('https://fixture.invalid/'));const reader=reopened.body.getReader();await reader.read();await reader.cancel();check('previewing is available again after the scoped operation',!previews.active.has('1'));
  await previews.closeSelected(['2']);check('all owned file handles are closed before process exit',previews.active.size===0);
  const audioFile=path.join(root,'owned-audio.bin'),audioMoved=path.join(root,'moved-audio.bin');fs.writeFileSync(audioFile,Buffer.alloc(32*1024*1024,2));
  const audioResponse=await previews.open('1',audioFile,new Request('https://audio/1/music')),audioReader=audioResponse.body.getReader();await audioReader.read();
  const coverResponse=await previews.open('1',dirs[1].file,new Request('https://cover/1/image')),coverReader=coverResponse.body.getReader();await coverReader.read();
  await withReleasedPreviews(['1'],previews,async()=>{
   await fs.promises.rename(audioFile,audioMoved);check('independent audio removal releases the real Windows file handle before moving the audio',fs.existsSync(audioMoved)&&!fs.existsSync(audioFile));
   const deniedAudio=await previews.open('1',audioMoved,new Request('https://audio/1/music'));check('independent audio removal blocks reacquiring an audio handle',deniedAudio.status===423);
   check('the same work cover remains readable during audio-only removal',!(await coverReader.read()).done);
  },'audio');
  await coverReader.cancel();const audioAgain=await previews.open('1',audioMoved,new Request('https://audio/1/music'));await audioAgain.body.cancel();check('audio-only gate and handles are cleared after the operation',previews.active.size===0&&previews.scopedBlocked.size===0);
  fs.writeFileSync('.test-output/preview-files-desktop-result.json',JSON.stringify({ok:true,packaged:!!process.env.CANGXIA_PREVIEW_TEST_PACKAGE,checks},null,2));console.log({ok:true,checks});app.quit();
 }catch(error){console.error(error);await previews?.closeSelected(['1','2']).catch(()=>{});fs.writeFileSync('.test-output/preview-files-desktop-result.json',JSON.stringify({ok:false,checks,error:error.message},null,2));app.exit(1);}
});
