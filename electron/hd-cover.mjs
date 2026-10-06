import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {imageDimensions} from './media-info.mjs';
import {requireInside} from './model.mjs';

export const comparableResolution=(a,video)=>{
 if(!a?.width||!a?.height||!video?.width||!video?.height)return false;
 const ratio=a.width/a.height,targetWidth=Math.min(video.width,video.height*ratio),targetHeight=targetWidth/ratio;
 return a.width>=targetWidth*.98&&a.height>=targetHeight*.98;
};
export const coverAssets=d=>(d?.assets||[]).filter(a=>a.key==='cover'||a.key.startsWith('cover-hd-'));
export function bestCover(d){return coverAssets(d).sort((a,b)=>Number(b.key===d.hdCover?.key)-Number(a.key===d.hdCover?.key)||(b.width||0)*(b.height||0)-(a.width||0)*(a.height||0))[0];}
const errors={video_resolution_insufficient:'视频实际分辨率不足，无法生成高清图',no_reliable_hd_match:'视频中未找到可靠匹配的高清画面',reference_insufficient_detail:'封面细节不足，无法可靠匹配视频',matching_timeout:'视频匹配超时，可单独重试',video_decode_failed:'视频无法解码',reference_invalid:'封面无法解码'};

export class HDCover {
 constructor({helper,store,extract}){Object.assign(this,{helper,store});this.extract=extract||this.runHelper.bind(this);this.tail=Promise.resolve();}
 async slot(signal,action){
  const prior=this.tail;let release,abort;this.tail=new Promise(r=>release=r);
  try{signal.throwIfAborted();await Promise.race([prior,new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});})]);signal.throwIfAborted();return await action();}
  finally{if(abort)signal.removeEventListener('abort',abort);void prior.then(release);}
 }
 async runHelper(request,signal){
  if(!fs.existsSync(this.helper))throw Error('高清匹配组件缺失，请重新安装完整版本');
  const manifest=request.output+'.json';fs.writeFileSync(manifest,JSON.stringify(request),{flag:'wx'});
  try{return await new Promise((resolve,reject)=>{
   signal.throwIfAborted();const child=spawn(this.helper,[manifest],{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',timedOut=false;
   const abort=()=>child.kill(),timer=setTimeout(()=>{timedOut=true;child.kill();},120000);signal.addEventListener('abort',abort,{once:true});
   child.stdout.on('data',b=>{stdout+=b.toString();if(stdout.length>65536)child.kill();});child.stderr.on('data',b=>{if(stderr.length<4096)stderr+=b.toString();});
   child.once('error',reject);child.once('close',code=>{clearTimeout(timer);signal.removeEventListener('abort',abort);if(signal.aborted)return reject(signal.reason);if(timedOut)return reject(Error(errors.matching_timeout));try{const result=JSON.parse(stdout.trim());if(code!==0||!result.ok)throw Error(errors[result.error]||'无法取得可靠匹配的高清图');resolve(result);}catch(e){reject(e);}});
  });}finally{fs.rmSync(manifest,{force:true});}
 }
 async ensure(queue,work,download,signal,progress){
  const existing=bestCover(download);if(download.hdCover?.status==='ready'&&existing?.key===download.hdCover.key&&this.store.assetExists(download,existing))return;
  const folder=download.path,temp=requireInside(folder,path.join(folder,'.cangxia-hd-'+randomUUID()));this.store.assertDirectory(folder);fs.mkdirSync(temp);
  try{
   let candidate,refreshError;
   const video=download.assets.find(a=>a.key==='video'&&this.store.assetExists(download,a));
   if(!video)throw Error('缺少完整视频，暂时无法核对封面与视频的实际分辨率');
   const videoPath=requireInside(folder,path.join(folder,video.file));progress('核对视频实际分辨率');
   const resolution=await this.slot(signal,()=>this.extract({mode:'probe',video:videoPath,output:path.join(temp,'probe')},signal));
   if(existing&&this.store.assetExists(download,existing))Object.assign(existing,imageDimensions(fs.readFileSync(requireInside(folder,path.join(folder,existing.file)))));
   if(comparableResolution(existing,resolution)){download.hdCover={status:'ready',source:existing.source||'platform',key:existing.key,width:existing.width,height:existing.height,videoWidth:resolution.width,videoHeight:resolution.height};download.coverWarning='';return;}
   progress('检查平台高清封面');
   // A detail refresh is scoped to this work and never opens a public browser window.
   try{const fresh=await queue.resolveWork(work.id,signal);work=fresh||work;}catch(e){signal.throwIfAborted();refreshError=e.message;if(this.store.getSetting('accessHoldUntil')>Date.now())throw e;}
   try{candidate=await queue.saveBestCover(temp,work.coverVariants?.length?work.coverVariants:[{source:work.coverSource||'cover',urls:work.coverUrls||[]}],signal,()=>{});}catch(e){signal.throwIfAborted();refreshError=e.message;}
   if(candidate&&comparableResolution(candidate,resolution)){
    this.publish(download,candidate,path.join(temp,candidate.file),signal);return;
   }
   const reference=existing&&this.store.assetExists(download,existing)?requireInside(folder,path.join(folder,existing.file)):candidate?path.join(temp,candidate.file):null;
   if(!reference||!video)throw Error(refreshError||'缺少封面或完整视频，未取得高清图');
   progress('等待匹配视频封面');
   const output=path.join(temp,'matched.png');
   const result=await this.slot(signal,async()=>{progress('匹配视频中的对应画面');return this.extract({video:requireInside(folder,path.join(folder,video.file)),reference,output},signal);});
   signal.throwIfAborted();const bytes=fs.readFileSync(output),dims=imageDimensions(bytes);
   if(!dims.width||!dims.height||dims.width!==result.width||dims.height!==result.height||dims.width>resolution.width||dims.height>resolution.height)throw Error('截帧尺寸校验失败');
   this.publish(download,{kind:'image',source:'video_frame',...dims,match:{seconds:result.seconds,frame:result.frame,correlation:result.correlation,crop:result.crop,videoWidth:resolution.width,videoHeight:resolution.height}},output,signal);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
 }
 publish(download,asset,file,signal){
  signal.throwIfAborted();const bytes=fs.readFileSync(file),sha256=createHash('sha256').update(bytes).digest('hex'),key='cover-hd-'+sha256.slice(0,16),name=(asset.source==='video_frame'?'视频截帧-':'高清封面-')+sha256.slice(0,16)+path.extname(file),destination=requireInside(download.path,path.join(download.path,name));
  if(fs.existsSync(destination)){if(createHash('sha256').update(fs.readFileSync(destination)).digest('hex')!==sha256)throw Error('高清图目标文件冲突，未覆盖');}else fs.copyFileSync(file,destination,fs.constants.COPYFILE_EXCL);
  const saved={...asset,key,file:name,size:bytes.length,sha256};download.assets=[...download.assets.filter(a=>a.key!==key),saved];download.hdCover={status:'ready',source:saved.source,key,width:saved.width,height:saved.height,match:saved.match};download.coverWarning='';
 }
}
