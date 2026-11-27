// Only fixed, public-facing messages leave the NAS browser boundary.
export class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = code === 'SOURCE_RATE_LIMITED' ? 429 : 409;
  }
}
