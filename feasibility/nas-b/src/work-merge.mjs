import { mergeCreator, sameCreator } from '../../../shared/creators.mjs';

const stable = creator => creator?.uid || creator?.secUid;
const updateKeys = [
  'title', 'caption', 'description', 'videoUrls', 'duration', 'width', 'height', 'publishedAt'
];
const coverOrder = ['origin_cover', 'cover_original_scale', 'cover'];

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

function mergeCover(merged, previous, next, fields) {
  if (fields.has('coverVariants')) {
    const bySource = new Map([...(previous.coverVariants ?? []), ...next.coverVariants]
      .map(variant => [variant.source, variant]));
    merged.coverVariants = coverOrder.filter(source => bySource.has(source)).map(source => bySource.get(source));
  }

  const previousPriority = coverOrder.indexOf(previous.coverSource);
  const incomingPriority = coverOrder.indexOf(next.coverSource);
  if (fields.has('coverUrls') && (!previous.coverUrls?.length || incomingPriority <= previousPriority)) {
    merged.coverUrls = next.coverUrls;
    merged.coverSource = next.coverSource;
  }
  if (fields.has('thumbnail')) {
    merged.thumbnail = merged.coverVariants?.find(variant => variant.source === 'cover')?.urls[0] ||
      merged.coverUrls?.[0] || next.thumbnail;
  }
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

  if (fields.has('images')) {
    merged.images = observed.images;
    merged.type = observed.type;
  }
  mergeCover(merged, previous, observed, fields);
  if (fields.has('music')) merged.music = mergeMusic(previous.music, observed.music, fields);
  if (observed.remoteState === 'unavailable') {
    merged.remoteState = observed.remoteState;
    merged.sourceStatus = observed.sourceStatus;
  }

  return merged;
}
