import {workCreators,matchesCreator} from '../shared/creators.mjs';
export const TOTAL = '__all__';
export function selectWorks(works, { query = '', type = 'all', tags = [], tagMode = 'any', localTags = [], localTagMode = 'any', author = '', downloaded = 'all', creators } = {}) {
  const q = query.trim().toLocaleLowerCase();
  return works.filter(w => {
    const people=workCreators(w,creators);
    const searchable = [w.name, w.title, w.description, ...people.flatMap(a=>[a.nickname,a.uniqueId,a.uid,a.secUid]), ...(w.tags || []), ...(w.localTags || [])].join(' ').toLocaleLowerCase();
    if (q && !searchable.includes(q)) return false;
    if (type !== 'all' && w.type !== type) return false;
    if (author && !people.some(person=>matchesCreator(person,author))) return false;
    if (downloaded === 'complete' && !w.downloaded) return false;
    if (downloaded === 'missing' && (w.downloaded||['checking','unknown'].includes(w.localStatus))) return false;
    if (downloaded === 'checking' && !['checking','unknown'].includes(w.localStatus)) return false;
    const matches=(selected,actual,mode)=>!selected.length||(mode==='any'?selected.some(t=>actual.includes(t)):selected.every(t=>actual.includes(t)));
    return matches(tags,w.tags||[],tagMode)&&matches(localTags,w.localTags||[],localTagMode);
  });
}
