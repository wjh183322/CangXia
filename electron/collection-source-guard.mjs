export function assertCollectionOnlySource(store){
  for(const table of ['authors','author_members'])if(store.rows('SELECT 1 FROM sqlite_master WHERE type=? AND name=?',['table',table]).length&&store.rows(`SELECT 1 FROM ${table} LIMIT 1`).length)throw Error('来源包含作者作品关系，当前版本尚未适配作者列表同步，不能安全导入或迁移；原资料库保持不变');
  if(store.all('downloads').some(d=>d.collectionId?.startsWith('author:')))throw Error('来源包含作者目录中的下载记录，当前版本尚未适配这种归属，未导入或迁移');
}
