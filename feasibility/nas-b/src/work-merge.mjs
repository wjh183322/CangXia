import { mergeCreator, sameCreator } from '../../../shared/creators.mjs';

const stable = creator => creator?.uid || creator?.secUid;
const updateKeys = ['title', 'caption', 'description', 'publishedAt'];
const videoParams = ['duration', 'width', 'height'];

function mergeMusic(previous, next, fields) {
  if (!previous) return next;
  if (!next || next.state === 'unknown') return previous;
  if (!previous.id || previous.id !== next.id) return next;

  return {
    ...next,
    title: next.title || previous.title,
    author: next.author || previous.author,
    duration: next.duration ?? previous.duration,
    mixPending: fields.has('music.mixPending') ? next.mixPending : previous.mixPending,
    clip: {
      unit: 'ms',
      begin: next.clip?.begin ?? previous.clip?.begin ?? null,
      end: next.clip?.end ?? previous.clip?.end ?? null,
      volume: next.clip?.volume ?? previous.clip?.volume ?? null
    }
  };
}

function coversCandidate(previous, next) {
  return next && next.urls.length >= previous.urls.length &&
    Number(next.width ?? 0) >= Number(previous.width ?? 0) &&
    Number(next.height ?? 0) >= Number(previous.height ?? 0);
}

function mergeMedia(merged, previous, observed, fields) {
  // Choose a coherent snapshot for each media family. Shorter or lower-quality
  // observations retain the prior family without mixing candidate versions.
  const oldQuality = previous.mediaQuality ?? {};
  const incoming = observed.mediaQuality ?? {};
  const quality = { ...oldQuality };
  const byIndex = new Map(observed.images.map(image => [image.index, image]));
  const imagesComplete = fields.has('images') && (previous.images ?? []).every(image =>
    coversCandidate(image, byIndex.get(image.index)) &&
    (incoming.imageOriginals?.[image.index] ?? 0) >= (oldQuality.imageOriginals?.[image.index] ?? 0)
  );
  if (imagesComplete) {
    merged.images = observed.images;
    merged.type = observed.type;
    quality.imageOriginals = incoming.imageOriginals ?? {};
  }

  const hasVideo = fields.has('videoUrls');
  const pixels = incoming.videoPixels ?? 0;
  const previousPixels = oldQuality.videoPixels ?? 0;
  const bitRate = incoming.videoBitRate ?? 0;
  const previousVideos = previous.videoUrls?.length ?? 0;
  const hasVideoMetadata = !previousVideos ||
    ((!previous.duration || fields.has('duration')) &&
      ['width', 'height'].every(key => Number(observed[key] ?? 0) >= Number(previous[key] ?? 0)));
  const videoComplete = hasVideo && hasVideoMetadata && observed.videoUrls.length >= previousVideos &&
    (incoming.videoRanked ?? 0) >= (oldQuality.videoRanked ?? 0) &&
    (pixels > previousPixels || (pixels === previousPixels && bitRate >= (oldQuality.videoBitRate ?? 0)));
  if (videoComplete) {
    merged.videoUrls = observed.videoUrls;
    quality.videoRanked = incoming.videoRanked ?? 0;
    quality.videoPixels = pixels;
    quality.videoBitRate = bitRate;
  }
  for (const key of videoParams) {
    if (fields.has(key) && (videoComplete || (!hasVideo && !previous[key]))) merged[key] = observed[key];
  }

  const bySource = new Map(observed.coverVariants.map(variant => [variant.source, variant]));
  const coverComplete = fields.has('coverUrls') &&
    observed.coverUrls.length >= (previous.coverUrls?.length ?? 0) &&
    (previous.coverVariants ?? []).every(variant => coversCandidate(variant, bySource.get(variant.source)));
  if (coverComplete) {
    merged.coverVariants = observed.coverVariants;
    merged.coverUrls = observed.coverUrls;
    merged.coverSource = observed.coverSource;
    merged.thumbnail = observed.thumbnail;
  } else if (imagesComplete && !previous.coverUrls?.length) {
    merged.thumbnail = observed.images[0]?.urls[0] || previous.thumbnail;
  }
  merged.mediaQuality = quality;
}

export function mergeObservedWork(previous, observed) {
  if (!previous) return observed;
  if (previous.id !== observed.id) throw new Error('Cannot merge different work identities.');

  const fields = new Set(observed.observedFields);
  const merged = {
    ...previous,
    url: observed.url,
    checkedAt: observed.checkedAt,
    observedFields: [...new Set([...(previous.observedFields ?? []), ...fields])]
  };

  for (const key of updateKeys) {
    if (fields.has(key) && (observed[key] || !previous[key])) merged[key] = observed[key];
  }
  if (fields.has('name') || !previous.name || previous.name === '未命名作品') merged.name = observed.name;

  if (['description', 'textExtra', 'challenges'].some(field => fields.has(field))) {
    const complete = ['description', 'textExtra', 'challenges'].every(field => fields.has(field));
    merged.tags = complete ? observed.tags : [...new Set([...(previous.tags ?? []), ...observed.tags])];
    merged.rawTags = {
      textExtra: (fields.has('textExtra') ? observed.rawTags : previous.rawTags)?.textExtra ?? [],
      challenges: (fields.has('challenges') ? observed.rawTags : previous.rawTags)?.challenges ?? []
    };
  }

  if (fields.has('author')) {
    if (!stable(previous.author)) merged.author = observed.author;
    else if (sameCreator(previous.author, observed.author)) merged.author = mergeCreator(previous.author, observed.author);
  }
  if (fields.has('coAuthors')) {
    merged.coAuthors = observed.coAuthors.filter(person => !sameCreator(merged.author, person)).map(person => {
      const known = previous.coAuthors?.find(creator => sameCreator(creator, person));
      return known ? mergeCreator(known, person) : person;
    });
    merged.coAuthorsState = observed.coAuthorsState;
    merged.creatorInfoVersion = observed.creatorInfoVersion;
    merged.creatorsCheckedAt = observed.creatorsCheckedAt;
  }

  mergeMedia(merged, previous, observed, fields);
  if (fields.has('music')) merged.music = mergeMusic(previous.music, observed.music, fields);
  if (observed.remoteState === 'unavailable') {
    merged.remoteState = observed.remoteState;
    merged.sourceStatus = observed.sourceStatus;
  }

  return merged;
}
