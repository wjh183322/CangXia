// These cursors and baselines belong to the current device's read session.
export const collectionCheckpointTables=['collection_read_runs','collection_read_baselines','collection_read_items','collection_read_refs','collection_read_pages'];
export function clearCollectionCheckpoints(store){for(const table of collectionCheckpointTables)store.db.run('DELETE FROM '+table);store.db.run('DELETE FROM settings WHERE key=?',['collectionMembershipRevision']);store.collectionReads.baselines.clear();}
