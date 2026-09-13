import path from 'node:path';
export { selectWorks } from './filter.mjs';

export const TOTAL = '__all__';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function parsePlatformJSON(text) {
  return JSON.parse(text,(key,value,context)=>{
    if(typeof value==='number'&&Number.isInteger(value)&&!Number.isSafeInteger(value)) {
      if(context?.source&&/^-?\d+$/.test(context.source))return context.source;
      throw new Error('平台返回了无法精确解析的整数标识');
    }
    return value;
  });
}
export function joinPages(pages) {
  const items=[],visited=new Set();let cursor='0',complete=false;
  while(pages.has(cursor)&&!visited.has(cursor)){
    visited.add(cursor);const p=pages.get(cursor);items.push(...p.items);
    if(p.more===false){complete=true;break;}
    cursor=p.next;
  }
  return {items,complete};
}
export function safeName(value, max = 64) {
  let name = String(value || '').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, max).replace(/[. ]+$/g, '');
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + (name || '未命名');
  return name;
}
export function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
export function requireInside(root, target) {
  if (!inside(root, target)) throw new Error('文件路径超出媒体库目录');
  return path.resolve(target);
}
export function isDouyinURL(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && (u.hostname === 'douyin.com' || u.hostname.endsWith('.douyin.com')); } catch { return false; }
}
export function isMediaURL(value) {
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) && ['douyin.com', 'douyinvod.com', 'douyinpic.com', 'byteimg.com', 'bytecdn.cn', 'ibytedtos.com', 'bytedance.com', 'pstatp.com', 'snssdk.com', 'amemv.com', 'iesdouyin.com', 'douyinstatic.com'].some(d => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch { return false; }
}
function urls(value) {
  const list = value?.url_list || value?.urlList || (typeof value === 'string' ? [value] : []);
  return list.filter(isMediaURL).map(u => u.replace(/^http:/, 'https:'));
}
export function parseWork(raw) {
  const id = String(raw.aweme_id || raw.awemeId || '');
  if (!/^\d+$/.test(id)) return null;
  const author = raw.author || {};
  const desc = String(raw.desc ?? raw.caption ?? '');
  const name = String(raw.item_title || raw.preview_title || raw.title || desc.replace(/#[^\s#]+/g, '').trim() || desc || '未命名作品');
  const tags = new Set();
  for (const t of raw.text_extra || raw.textExtra || []) if (t.hashtag_name || t.tag_name) tags.add(String(t.hashtag_name || t.tag_name).replace(/^#/, ''));
  for (const t of raw.cha_list || []) if (t.cha_name || t.name) tags.add(String(t.cha_name || t.name).replace(/^#/, ''));
  for (const match of desc.matchAll(/#([^\s#]+)/gu)) tags.add(match[1]);
  const v = raw.video || {};
  const variants = (v.bit_rate || v.bitRate || []).filter(x => urls(x.play_addr || x.playAddr).length).sort((a,b) => {
    const av = a.play_addr || a.playAddr, bv = b.play_addr || b.playAddr;
    return Number(bv.width || 0) * Number(bv.height || 0) - Number(av.width || 0) * Number(av.height || 0) || Number(b.bit_rate || b.bitRate || 0) - Number(a.bit_rate || a.bitRate || 0);
  });
  const addresses=[...variants.map(x=>({address:x.play_addr||x.playAddr,rate:Number(x.bit_rate||x.bitRate||0),hint:0})),...['play_addr_h264_1080p','play_addr_1080p','play_addr_h264_720p','play_addr_720p','play_addr_h264','play_addr_265','play_addr'].map(key=>({address:v[key]||(key==='play_addr'?v.playAddr:null),rate:0,hint:key.includes('1080p')?1080*1920:key.includes('720p')?720*1280:0}))].filter(x=>urls(x.address).length);
  addresses.sort((a,b)=>(Number(b.address.width||0)*Number(b.address.height||0)||b.hint)-(Number(a.address.width||0)*Number(a.address.height||0)||a.hint)||b.rate-a.rate);
  const candidates = addresses.flatMap(x=>urls(x.address));
  const images = (raw.images || raw.image_post_info?.images || raw.image_post_info?.image_list || raw.image_list || []).map((im, i) => ({ index: i, urls: [...new Set([...urls({ url_list: im.watermark_free_download_url_list }), ...urls(im.origin_image), ...urls(im.display_image), ...urls(im)])], width: im.width || 0, height: im.height || 0 })).filter(im => im.urls.length);
  const original = urls(v.origin_cover || v.originCover || v.cover_original_scale);
  const staticCover = urls(v.cover);
  const coverVariants=[['origin_cover',v.origin_cover||v.originCover],['cover_original_scale',v.cover_original_scale],['cover',v.cover]].map(([source,value])=>({source,urls:urls(value),width:Number(value?.width||0),height:Number(value?.height||0)})).filter(x=>x.urls.length);
  return {
    id, name, title: String(raw.item_title || raw.title || ''), caption: String(raw.caption || ''), description: desc, tags: [...tags], rawTags: { textExtra: raw.text_extra || [], challenges: raw.cha_list || [] },
    author: { uid: String(author.uid || ''), secUid: String(author.sec_uid || author.secUid || ''), uniqueId: String(author.unique_id || author.uniqueId || author.short_id || ''), nickname: String(author.nickname || '未知作者') },
    type: images.length ? 'images' : 'video', images, videoUrls: [...new Set(candidates)], coverVariants,
    coverUrls: original.length ? original : staticCover, coverSource: original.length ? (v.origin_cover || v.originCover ? 'origin_cover' : 'cover_original_scale') : 'cover',
    thumbnail: staticCover[0] || original[0] || images[0]?.urls[0] || '',
    duration: Number(v.duration || raw.duration || 0), width: Number(v.width || 0), height: Number(v.height || 0),
    publishedAt: Number(raw.create_time || 0), url: `https://www.douyin.com/video/${id}`, remoteState: raw.is_delete === true || raw.is_delete === 1 || raw.status?.is_delete === true ? 'unavailable' : 'available', checkedAt: new Date().toISOString()
  };
}
export function classifyResponse(url, data) {
  let u; try { u = new URL(url); } catch { return null; }
  if (!isDouyinURL(url) || !data || typeof data !== 'object') return null;
  const p = u.pathname;
  if (/\/aweme\/detail\//.test(p)) return { kind: 'detail', id: u.searchParams.get('aweme_id'), raw: data.aweme_detail, data };
  if (/\/collects\/list\//.test(p)) return { kind: 'collections', data, collections: data.collects_list || data.collects || [] };
  if (/\/collects\/video\/list\//.test(p)) return { kind: 'works', collectionId: u.searchParams.get('collects_id') || data.collects_id, data };
  if (/\/aweme\/listcollection\//.test(p)) return { kind: 'works', collectionId: TOTAL, data };
  return null;
}
