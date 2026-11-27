import { mergeCreator, sameCreator } from '../shared/creators.mjs';

const stable = (creator) => creator?.uid || creator?.secUid;
const updateKeys = ['title', 'caption', 'description', 'publishedAt'];
const videoParams = ['duration', 'width', 'height'];
const coverSources = ['origin_cover', 'cover_original_scale', 'cover'];

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
  return (
    next &&
    next.urls.length >= previous.urls.length &&
    Number(next.width ?? 0) >= Number(previous.width ?? 0) &&
    Number(next.height ?? 0) >= Number(previous.height ?? 0)
  );
}

function mergeMedia(merged, previous, observed, fields) {
  // Image and video candidates retain coherent snapshots across observations.
  const oldQuality = previous.mediaQuality ?? {};
  const incoming = observed.mediaQuality ?? {};
  const quality = { ...oldQuality };
  quality.identities = { ...oldQuality.identities };
  const byIndex = new Map(observed.images.map((image) => [image.index, image]));
  const imagesComplete =
    fields.has('images') &&
    (previous.images ?? []).every(
      (image) =>
        coversCandidate(image, byIndex.get(image.index)) &&
        (incoming.imageOriginals?.[image.index] ?? 0) >= (oldQuality.imageOriginals?.[image.index] ?? 0)
    );
  if (imagesComplete) {
    merged.images = observed.images;
    merged.type = observed.type;
    quality.imageOriginals = incoming.imageOriginals ?? {};
    quality.identities.images = incoming.identities?.images;
    quality.identities.imageCount = incoming.identities?.imageCount;
  }

  const hasVideo = fields.has('videoUrls');
  const pixels = incoming.videoPixels ?? 0;
  const previousPixels = oldQuality.videoPixels ?? 0;
  const bitRate = incoming.videoBitRate ?? 0;
  const previousVideos = previous.videoUrls?.length ?? 0;
  const maintainsDimensions = ['width', 'height'].every(
    (key) => !fields.has(key) || Number(observed[key]) >= Number(previous[key] ?? 0)
  );
  const hasKnownParams = videoParams.every((key) => !previous[key] || fields.has(key));
  const hasProvenSize = previousPixels > 0 && pixels >= previousPixels;
  const videoCompatible = !previousVideos || (maintainsDimensions && (hasKnownParams || hasProvenSize));
  const videoComplete =
    hasVideo &&
    videoCompatible &&
    observed.videoUrls.length >= previousVideos &&
    (incoming.videoRanked ?? 0) >= (oldQuality.videoRanked ?? 0) &&
    (pixels > previousPixels || (pixels === previousPixels && bitRate >= (oldQuality.videoBitRate ?? 0)));
  if (videoComplete) {
    merged.videoUrls = observed.videoUrls;
    quality.videoRanked = incoming.videoRanked ?? 0;
    quality.videoPixels = pixels;
    quality.videoBitRate = bitRate;
    quality.videoObservedAt = incoming.videoObservedAt ?? observed.checkedAt;
    quality.identities.video = incoming.identities?.video;
  }
  for (const key of videoParams) {
    if (fields.has(key) && (videoComplete || (!hasVideo && !previous[key]))) merged[key] = observed[key];
  }

  // Each named cover variant keeps its own URLs and dimensions together.
  const bySource = new Map((previous.coverVariants ?? []).map((variant) => [variant.source, variant]));
  for (const variant of observed.coverVariants) {
    const known = bySource.get(variant.source);
    if (!known || coversCandidate(known, variant)) bySource.set(variant.source, variant);
  }
  const covers = coverSources.map((source) => bySource.get(source)).filter(Boolean);
  if (covers.length) {
    merged.coverVariants = covers;
    merged.coverUrls = covers[0].urls;
    merged.coverSource = covers[0].source;
    merged.thumbnail = bySource.get('cover')?.urls[0] || merged.coverUrls[0];
    const candidate = covers[0];
    if (observed.coverVariants.includes(candidate)) quality.identities.cover = incoming.identities?.cover;
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

  if (['description', 'textExtra', 'challenges'].some((field) => fields.has(field))) {
    const complete = ['description', 'textExtra', 'challenges'].every((field) => fields.has(field));
    merged.tags = complete ? observed.tags : [...new Set([...(previous.tags ?? []), ...observed.tags])];
    merged.rawTags = {
      textExtra: (fields.has('textExtra') ? observed.rawTags : previous.rawTags)?.textExtra ?? [],
      challenges: (fields.has('challenges') ? observed.rawTags : previous.rawTags)?.challenges ?? []
    };
  }

  if (fields.has('author')) {
    if (!stable(previous.author)) merged.author = observed.author;
    else if (sameCreator(previous.author, observed.author))
      merged.author = mergeCreator(previous.author, observed.author);
  }
  if (fields.has('coAuthors')) {
    merged.coAuthors = observed.coAuthors
      .filter((person) => !sameCreator(merged.author, person))
      .map((person) => {
        const known = previous.coAuthors?.find((creator) => sameCreator(creator, person));
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
