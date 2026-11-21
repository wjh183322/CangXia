
import { redact } from './redact.mjs';

export const PROBE = Object.freeze({
  service: 'cangxia-server-probe',
  protocol: 1,
  version: '0.4.0-alpha.1',
  mode: 'feasibility',
  root: '/probe',
  marker: '.cangxia-server-probe.json',
  markerVersion: 1,
  containerPort: 8443
});

export function parseProbeBuildInfo(value) {
  const { imageVersion, sourceRevision } = value ?? {};
  if (typeof sourceRevision !== 'string' || !/^[a-f0-9]{40}$/.test(sourceRevision) ||
      imageVersion !== PROBE.version + '-' + sourceRevision.slice(0, 12)) return null;
  return Object.freeze({ imageVersion, sourceRevision });
}

export const LIMITS = Object.freeze({
  cpus: 2,
  memoryBytes: 2 ** 31,
  shmBytes: 2 ** 29,
  detailSamples: 20,
  receivedRows: 300,
  pagesPerSource: 2,
  requestedMediaBytes: 2 ** 30
});

export const SESSION = Object.freeze({
  heartbeatMs: 5000,
  timeoutMs: 3000,
  ttlMs: 20000
});

export class ProbeError extends Error {
  constructor(code, message, details) {
    super(message ? redact(message) : code);
    this.name = 'ProbeError';
    this.code = code;
    if (details !== undefined) this.details = redact(details);
  }
}
