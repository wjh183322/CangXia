import {contentHash} from '../shared/backup-protocol.mjs';
import {isMediaURL} from '../electron/model.mjs';
import {SourceError} from './source-error.mjs';

const failure = (code,message) => new SourceError(code,message);
const needsReview = () => failure('NAS_MEDIA_SET_REVIEW','作品资源身份或数量已改变，请重新核对。');
const protectedQuery = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'sessionid',
  'sessionidss',
  'uidtt',
  'uidttss',
  'sidguard',
  'sidtt',
  'mstoken',
  'password',
  'accesstoken',
  'refreshtoken',
  'passportcsrftoken',
  'passportcsrftokendefault'
]);
export function validMediaTarget(value, base) {
  try {
    const url = new URL(value, base);
    const credential = [...url.searchParams.keys()].some((key) =>
      protectedQuery.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))
    );
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      !credential &&
      url.href.length <= 8192 &&
      isMediaURL(url.href)
    )
      return url.href;
  } catch {
    /* return a fixed error without the signed address */
  }
  throw failure('NAS_MEDIA_TARGET', 'The target is outside the secure source media allowlist.');
}

function candidateList(urls) {
  return [...new Set(urls ?? [])];
}

export function candidateDigest(urls) {
  if (!urls.length) return null;
  const objects = urls.map((address) => {
    const url = new URL(validMediaTarget(address));
    for (const field of ['x-signature', 'x-expires']) url.searchParams.delete(field);
    url.searchParams.sort();
    return url.href;
  });
  return contentHash([...new Set(objects)].sort());
}

export function coverObject(address) {
  const url = new URL(validMediaTarget(address));
  for (const field of ['x-signature', 'x-expires', 'l', 'from', 's', 'lk3s']) url.searchParams.delete(field);
  url.searchParams.sort();
  return contentHash(url.pathname + '?' + url.searchParams.toString());
}

export function wantedResources(work, audioOnly) {
  if (audioOnly) {
    const source = work.audioSourceHints;
    if (work.type !== 'images' || !work.music?.id || (source?.music?.id && source.music.id !== work.music.id))
      throw needsReview();
    return [
      {
        key: 'audio',
        name: '配乐',
        kind: 'audio',
        sourceIdentity: 'music:' + work.music.id,
        candidates: candidateList(source?.sources?.filter((s) => ['music','work'].includes(s.kind)).sort((a,b)=>Number(b.kind==='music')-Number(a.kind==='music')).flatMap((s) => s.urls))
      }
    ];
  }
  const identities = work.mediaQuality?.identities ?? {};
  const entry = (key, name, kind, candidates, sourceIdentity) => ({
    key,
    name,
    kind,
    candidates: candidateList(candidates),
    sourceIdentity: sourceIdentity || null
  });
  if (work.type === 'images' || identities.imageCount) {
    const byIndex = new Map((work.images ?? []).map((image) => [image.index, image]));
    const count = identities.imageCount ?? byIndex.size;
    if (!Number.isInteger(count) || count < 1) throw needsReview();
    return Array.from({ length: count }, (_, index) =>
      entry(
        'image-' + index,
        '图片-' + String(index + 1).padStart(3, '0'),
        'image',
        byIndex.get(index)?.urls,
        identities.images?.[index]
      )
    );
  }
  // The normalized source keeps video quality and original-image candidates in priority order.
  const cover = [...(work.coverVariants ?? [])].sort(
    (a, b) => Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height)
  );
  return [
    entry('video', '视频', 'video', work.videoUrls, identities.video),
    entry(
      'cover',
      '单图',
      'image',
      [...cover.flatMap((variant) => variant.urls), ...(work.coverUrls ?? [])],
      identities.cover
    )
  ];
}

export function freeze(work, audioOnly) {
  const targets = wantedResources(work, audioOnly);
  const expected = targets.map(({ candidates, ...target }) => ({
    ...target,
    identity: contentHash({
      workId: work.id,
      key: target.key,
      kind: target.kind,
      sourceIdentity: target.sourceIdentity
    })
  }));
  const candidates = Object.fromEntries(targets.map((target) => [target.key, target.candidates]));
  return { expected, candidates };
}

export function legacyObservation(target, urls) {
  // Legacy metadata can record offline or retired hosts. Preserve their observation as a digest only.
  let observation;
  if(!target.sourceIdentity){
    try { observation=candidateDigest(urls); } catch { observation=contentHash(urls); }
  }
  return contentHash([target.key,target.kind,target.sourceIdentity??null,observation??null]);
}

export function matchesSavedTarget(asset,target,urls) {
  if(asset.legacyObservation)return asset.legacyObservation===legacyObservation(target,urls);
  if(asset.resourceIdentity!==target.identity)return false;
  return !!target.sourceIdentity || asset.observationIdentity===candidateDigest(urls);
}

export const hasMedia=`EXISTS(SELECT 1 FROM media_files m LEFT JOIN archive_assets a ON a.id=m.id
  WHERE m.work_id=w.id AND (a.kind IN ('video','image','audio') OR (a.id IS NULL AND lower(m.relative_path) NOT LIKE '%.json')))`;
export const savedStatus="coalesce((SELECT status FROM maintenance_file_state WHERE work_id=w.id),json_extract(w.body,'$.localStatus'),'')";
export const checking=savedStatus+" IN ('checking','unknown')";
// Only registered typed assets can satisfy a required key. A pre-manifest library may still
// enumerate untyped files as local media, but a filename cannot establish its resource identity.
const fullJob="d.work_id=w.id AND d.state='complete' AND d.id NOT LIKE 'audio:%' AND d.id NOT LIKE 'hd:%'";
const evidence=`(SELECT json_group_array(json_object('key',a.key,'kind',a.kind,'proof',
 (SELECT f.body FROM file_commits f WHERE f.work_id=w.id AND f.resource_id=a.id AND f.stage='registered'
 AND json_extract(f.body,'$.sha256')=a.sha256 AND json_extract(f.body,'$.size')=a.size ORDER BY f.revision DESC LIMIT 1)))
 FROM archive_resources a WHERE a.work_id=w.id AND (a.key IN ('video','cover') OR a.key GLOB 'image-[0-9]*'))`;
export const complete=`CASE WHEN (${checking}) OR ${savedStatus}='partial' OR NOT EXISTS(SELECT 1 FROM download_jobs d WHERE ${fullJob}) THEN 0
 ELSE cx_complete(w.id,w.body,${evidence},(SELECT m.body FROM download_jobs d JOIN download_manifests m ON m.id=d.id
 WHERE ${fullJob} ORDER BY (m.id=w.id) DESC LIMIT 1)) END`;
export const downloadStatus=`CASE WHEN json_extract(w.body,'$.remoteState')='unavailable' THEN 'unavailable'
 WHEN ${checking} THEN 'checking' WHEN NOT ${hasMedia} THEN 'unsaved'
 WHEN ${complete} THEN 'complete' ELSE 'partial' END`;

export function installDownloadStatus(db) {
  db.function('cx_complete',{deterministic:true},(id,body,rows,manifest)=>{
    try{
      const work={...JSON.parse(body),id},old=manifest&&JSON.parse(manifest);
      const plan=freeze(work,false);
      const assets=new Map(JSON.parse(rows).map(a=>[a.key,a]));
      const required=plan.expected.filter(t=>t.key!=='cover'||plan.candidates.cover.length||old?.expected?.some(r=>r.key==='cover'));
      return Number(required.length>0 && required.every(t=>{
        const a=assets.get(t.key);
        if(!a || a.kind!==t.kind || !a.proof)return false;
        const proof=JSON.parse(a.proof);
        if(matchesSavedTarget(proof,t,plan.candidates[t.key]))return true;
        // Older sealed imports predate per-key observations. Only keys proved by that import
        // with no later source identity to reconcile may retain their historical completion.
        return !proof.legacyObservation && !proof.resourceIdentity && !t.sourceIdentity &&
          old?.legacyArchive?.recordedKeys.includes(t.key);
      }));
    }catch{return 0;}
  });
}

