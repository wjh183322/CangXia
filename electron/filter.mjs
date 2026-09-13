export const TOTAL = '__all__';
export function selectWorks(works, { query = '', type = 'all', tags = [], tagMode = 'all', author = '', downloaded = 'all' } = {}) {
  const q = query.trim().toLocaleLowerCase();
  return works.filter(w => {
    const searchable = [w.name, w.title, w.description, w.author.nickname, w.author.uniqueId, w.author.uid, ...(w.tags || []), ...(w.localTags || [])].join(' ').toLocaleLowerCase();
    if (q && !searchable.includes(q)) return false;
    if (type !== 'all' && w.type !== type) return false;
    if (author && (w.author.uid || w.author.secUid || w.author.nickname) !== author) return false;
    if (downloaded === 'complete' && !w.downloaded) return false;
    if (downloaded === 'missing' && w.downloaded) return false;
    const actual = new Set([...(w.tags || []), ...(w.localTags || [])]);
    return !tags.length || (tagMode === 'any' ? tags.some(t => actual.has(t)) : tags.every(t => actual.has(t)));
  });
}
