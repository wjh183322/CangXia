import {serverIdentity} from '../shared/server-identity.mjs';
export const deploymentImage = 'ghcr.io/wjh183322/cangxia-server:latest';
export function validateBuild(sourceRevision) {
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw Error('Expected a complete source revision.');
  return {sourceRevision, version:serverIdentity.version, protocolVersion:serverIdentity.protocolVersion};
}
