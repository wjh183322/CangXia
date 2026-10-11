const id=value=>typeof value==='string'&&/^\d{1,30}$/.test(value)?value:typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?String(value):'';
export function parseMusicInfo(raw){
 if(!Object.hasOwn(raw,'music'))return undefined;
 const m=raw.music;if(!m||typeof m!=='object')return {version:1,state:'unknown'};
 const musicId=id(m.id_str)||id(m.id),clip=raw.image_album_music_info||{};
 const result={version:1,state:musicId&&musicId!=='0'?'known':'unknown',id:musicId,title:String(m.title||'').slice(0,256),author:String(m.author||'').slice(0,128),duration:Number.isFinite(m.duration)&&m.duration>=0?m.duration:null,mixPending:!!raw.video?.audio?.original_sound_infos?.length,clip:{begin:Number.isSafeInteger(clip.begin_time)?clip.begin_time:null,end:Number.isSafeInteger(clip.end_time)?clip.end_time:null,volume:Number.isFinite(clip.volume)?clip.volume:null,unit:'ms'}};
 if(m.status===0&&m.offline_desc)result.state='unavailable';
 return result;
}
export function musicClip(info,duration){
 const c=info?.clip;if(info?.mixPending||!c||c.unit!=='ms'||!Number.isFinite(duration)||duration<=0||!Number.isSafeInteger(c.begin)||!Number.isSafeInteger(c.end)||c.begin!==0||c.end<=c.begin)return null;
 const start=c.begin/1000,end=c.end/1000;if(start>=duration||end>duration+.05)return null;
 return {start,end:Math.min(end,duration)};
}
export function validateAudioBackup(audio){
 if(!audio||typeof audio!=='object'||Array.isArray(audio)||Object.keys(audio).some(k=>!['state','object','musicId','savedAt'].includes(k))||audio.state!=='saved')throw Error('配乐备份状态无效');
 const o=audio.object;if(!o||Object.keys(o).some(k=>!['sha256','size','format','duration'].includes(k))||!/^[a-f0-9]{64}$/.test(o.sha256)||!Number.isSafeInteger(o.size)||o.size<=0||o.size>256*1024*1024||!['mp3','m4a','aac','wav'].includes(o.format)||!Number.isFinite(o.duration)||o.duration<=0||o.duration>86400)throw Error('共享配乐对象无效');
 if(audio.musicId!==undefined&&audio.musicId!==''&&!id(audio.musicId))throw Error('配乐标识无效');
 if(audio.savedAt!==undefined&&(typeof audio.savedAt!=='string'||audio.savedAt.length>80))throw Error('配乐保存时间无效');
}
