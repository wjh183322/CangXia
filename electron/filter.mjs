export const TOTAL = '__all__';
export function selectWorks(works, { query = '', type = 'all', tags = [], tagMode = 'any', localTags = [], localTagMode = 'any', author = '', downloaded = 'all' } = {}) {
  const q = query.trim().toLocaleLowerCase();
  return works.filter(w => {
    const searchable = [w.name, w.title, w.description, w.author.nickname, w.author.uniqueId, w.author.uid, ...(w.tags || []), ...(w.localTags || [])].join(' ').toLocaleLowerCase();
    if (q && !searchable.includes(q)) return false;
    if (type !== 'all' && w.type !== type) return false;
    if (author && (w.author.uid || w.author.secUid || w.author.nickname) !== author) return false;
    if (downloaded === 'complete' && !w.downloaded) return false;
    if (downloaded === 'missing' && w.downloaded) return false;
    const matches=(selected,actual,mode)=>!selected.length||(mode==='any'?selected.some(t=>actual.includes(t)):selected.every(t=>actual.includes(t)));
    return matches(tags,w.tags||[],tagMode)&&matches(localTags,w.localTags||[],localTagMode);
  });
}
