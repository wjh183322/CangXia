import { randomUUID } from 'node:crypto';
export function registerCatalogueHandlers({ ipc, client }) {
  ipc('catalogueAction', 'workspace', (action, selection) =>
    client.command({
      operationId: randomUUID(),
      kind: 'catalogue-action',
      entityVersion: 0,
      payload: { action, selection }
    })
  );
  for (const [method, query] of Object.entries({
    listWorks: 'list-works',
    cataloguePosition: 'catalogue-position',
    catalogueChoices: 'catalogue-choices',
    resolveSelection: 'resolve-selection'
  }))
    ipc(method, 'workspace', (payload) => client.query(query, payload));
}
