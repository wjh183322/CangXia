import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {SystemBrowser} from '../electron/system-browser.mjs';
import {isMediaURL,parsePlatformJSON,sleep} from '../electron/model.mjs';

// Run only from the repository root. Public-page research, no production profile,
// no saved credentials, no library/NAS writes. New output folder by default.
const root=path.resolve(process.env.CANGXIA_AUDIO_EXPERIMENT_DIR||path.join('.test-output','audio-research-'+new Date().toISOString().slice(0,10)+'-'+randomUUID().slice(0,8)));
if(!root.startsWith(path.resolve('.test-output')+path.sep))throw Error('experiment-path-outside-workspace');
fs.mkdirSync(root,{recursive:true});
const candidates=process.argv.length>2?process.argv.slice(2):['7559349337312447763','7688233301782297929','7605984910264459411','7591483092655194347','7693029744136194214','7689789427421997162','7693112789354787251'];
if(candidates.length>12||candidates.some(id=>!/^\d+$/.test(id)))throw Error('invalid-experiment-scope');
const hash=x=>createHash('sha256').update(x).digest('hex');
const mediaIdentity=url=>{try{const u=new URL(url);return {host:u.hostname,pathHash:hash(u.pathname),fullHash:hash(url)};}catch{return null;}};
const scalar=object=>Object.fromEntries(Object.entries(object||{}).filter(([k,v])=>v===null||['number','boolean'].includes(typeof v)||typeof v==='string'&&!/https?:|token|cookie/i.test(k+':'+v)&&v.length<250));
const report={date:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date()),source:'isolated-public-browser',limits:{works:candidates.length,perAudioBytes:8*1048576,totalAudioBytes:32*1048576},samples:[],objects:[]};
let totalBytes=0;
const browser=new SystemBrowser(path.join(root,'browser'),{headless:true}),objectByURL=new Map();
const persist=()=>fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));
async function mediaFetch(url,headers={}){
  for(let n=0;n<5;n++){
    if(!isMediaURL(url))throw Error('unsupported-media-origin');
    const r=await fetch(url,{signal:AbortSignal.timeout(20000),redirect:'manual',headers:{Referer:'https://www.douyin.com/','User-Agent':browser.userAgent||'Mozilla/5.0',...headers}});
    if([301,302,303,307,308].includes(r.status)){const next=r.headers.get('location');await r.body?.cancel();if(!next)throw Error('redirect-without-location');url=new URL(next,url).href;continue;}
    return r;
  }throw Error('redirect-limit');
}
async function audioObject(url){
  if(objectByURL.has(url))return objectByURL.get(url);
  const probe=await mediaFetch(url,{Range:'bytes=0-1023'});
  const range={status:probe.status,type:probe.headers.get('content-type'),contentRange:probe.headers.get('content-range'),length:probe.headers.get('content-length'),acceptRanges:probe.headers.get('accept-ranges')};
  await probe.body?.cancel();if(probe.status===429)throw Error('rate-limited');
  const r=await mediaFetch(url);if(r.status!==200){await r.body?.cancel();throw Error('media-http-'+r.status);}
  const limit=report.limits.perAudioBytes,length=Number(r.headers.get('content-length'));
  if(length>limit||totalBytes+length>report.limits.totalAudioBytes){await r.body?.cancel();throw Error('experiment-byte-limit');}
  const reader=r.body.getReader(),chunks=[];let count=0;
  try{for(;;){const x=await reader.read();if(x.done)break;count+=x.value.length;if(count>limit||totalBytes+count>report.limits.totalAudioBytes)throw Error('experiment-byte-limit');chunks.push(x.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=Buffer.concat(chunks),sha256=hash(bytes),file=sha256+'.bin';await fsp.writeFile(path.join(root,file),bytes);totalBytes+=count;
  const result={sha256,file,bytes:count,type:r.headers.get('content-type'),range,source:mediaIdentity(url)};objectByURL.set(url,result);if(!report.objects.some(x=>x.sha256===sha256))report.objects.push(result);return result;
}
async function sample(id){
  const result={id,url:'https://www.douyin.com/video/'+id,live:false};
  let cleanup,raw,resolveDetail;const ready=new Promise(r=>resolveDetail=r),observed=[];
  const listener=(method,p)=>{
    if(method!=='Network.responseReceived'||!isMediaURL(p.response?.url))return;
    const r=p.response;
    if(p.type==='Media'||/audio\//i.test(r.mimeType||'')||/\/ies-music|music-east|\.mp3(?:\?|$)/.test(r.url))observed.push({url:r.url,status:r.status,mime:r.mimeType,type:p.type});
  };
  browser.on('event',listener);
  try{
    cleanup=await browser.observeWork(id,(_url,status,text)=>{if(status!==200)return;try{const d=parsePlatformJSON(text),w=d.aweme_detail;if(String(w?.aweme_id)===id){raw=w;resolveDetail();}}catch{}});
    await Promise.race([ready,sleep(12000)]);
    if(!raw){try{const r=await browser.api.request('/aweme/v1/web/aweme/detail/',{params:{aweme_id:id},signal:AbortSignal.timeout(15000)});const d=parsePlatformJSON(await r.text());if(d.status_code)result.apiCode=d.status_code;if(d.aweme_detail)raw=d.aweme_detail;}catch(e){result.detailError=e.code||e.message;}}
    if(raw){result.live=true;result.title=String(raw.desc||'').slice(0,160);result.type=raw.aweme_type;result.images=raw.images?.length||0;const m=raw.music||{};
      result.music=scalar(m);result.musicFields=Object.keys(m);result.album=scalar(raw.image_album_music_info);result.audioFields=Object.keys(raw).filter(k=>/audio|music|sound/.test(k));result.videoAudio=raw.video?.audio?{keys:Object.keys(raw.video.audio),originalSoundCount:raw.video.audio.original_sound_infos?.length||0}:null;
      result.musicId=String(m.id_str||m.id||'');result.musicURLs=(m.play_url?.url_list||[]).map(mediaIdentity);result.workPlaybackURLs=(raw.video?.play_addr?.url_list||[]).map(mediaIdentity);result.isUseMusic=raw.is_use_music;
      const {targetInfos}=await browser.connection.send('Target.getTargets');const page=targetInfos.find(x=>x.url.includes(id)&&x.type==='page');
      if(page){const sid=await browser.attach(page.targetId);const a=await browser.connection.send('Runtime.evaluate',{expression:'Array.from(document.querySelectorAll("audio,video")).map(e=>({tag:e.tagName,source:e.currentSrc||e.src,time:e.currentTime,duration:Number.isFinite(e.duration)?e.duration:null,muted:e.muted,volume:e.volume,paused:e.paused}))',returnByValue:true},sid);result.playersBefore=(a.result?.value||[]).map(x=>({...x,source:mediaIdentity(x.source)}));
        await browser.connection.send('Runtime.evaluate',{expression:'Promise.allSettled(Array.from(document.querySelectorAll("audio,video")).map(e=>{e.muted=true;return e.play()})).then(x=>x.map(r=>r.status))',awaitPromise:true,returnByValue:true},sid).catch(()=>{});await sleep(1800);
        const b=await browser.connection.send('Runtime.evaluate',{expression:'Array.from(document.querySelectorAll("audio,video")).map(e=>({tag:e.tagName,source:e.currentSrc||e.src,time:e.currentTime,duration:Number.isFinite(e.duration)?e.duration:null,paused:e.paused}))',returnByValue:true},sid);result.playersAfter=(b.result?.value||[]).map(x=>({...x,source:mediaIdentity(x.source)}));
      }
      const paths=new Set((m.play_url?.url_list||[]).filter(isMediaURL).map(url=>new URL(url).pathname));
      result.observedMedia=observed.map(x=>({...x,url:mediaIdentity(x.url),exactMusicURL:(m.play_url?.url_list||[]).includes(x.url),matchingMusicPath:paths.has(new URL(x.url).pathname)}));
      const primary=(m.play_url?.url_list||[]).filter(isMediaURL),alternate=raw.aweme_type===68?(raw.video?.play_addr?.url_list||[]).filter(isMediaURL):[];const urls=primary.length?primary:alternate;result.audioSourceField=primary.length?'music.play_url':alternate.length?'video.play_addr (requires audio-only decode verification)':null;if(urls.length){try{result.audio=await audioObject(urls[0]);if(!primary.length)for(const u of alternate)paths.add(new URL(u).pathname);const playback=observed.find(x=>paths.has(new URL(x.url).pathname)&&/^audio\//.test(x.mime||''));if(playback){result.observedAudio=await audioObject(playback.url);result.observedAudioSameBytes=result.observedAudio.sha256===result.audio.sha256;}}catch(e){result.audioError=e.message;}}
    }else result.detailError ||= 'no-live-detail';
  }finally{browser.removeListener('event',listener);await cleanup?.();}
  report.samples.push(result);persist();console.log(JSON.stringify({id,live:result.live,title:result.title,type:result.type,musicId:result.musicId,album:result.album,audioBytes:result.audio?.bytes,observed:result.observedMedia?.length,error:result.detailError||result.audioError}));
}
try{for(const id of candidates){await sample(id);if(report.samples.at(-1).apiCode===429||report.samples.at(-1).audioError==='rate-limited')break;await sleep(1500);}}catch(e){report.error=e.code||e.message;console.log('experiment stopped: '+report.error);}finally{await browser.close();report.totalAudioBytes=totalBytes;persist();}
