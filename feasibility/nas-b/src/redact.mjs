
const REDACTED = '[redacted]';
const sensitiveKey = /authorization|cookie|token|password|passwd|secret|credential|privatekey|apikey|accesskey|leaseproof|storage(state|path)|^(proof|stack|env|response(body|text)?|raw(body|response|text)|sourceresponse|requestbody|headers|qr(code|image)?|data(root|dir)|profile(dir|path)|host(path|name|port)|canonicalsource|lanaddress|filepath)$/;

function redactText(text) {
  return text
    .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, REDACTED)
    .replace(/["'](?:[^"']*(?:cookie|token|password|secret|authorization|api[-_]?key|access[-_]?key|proof))["']\s*:\s*["'](?:\\.|[^"'\\])*["']/gi, REDACTED)
    .replace(/\b(?:cookie|set-cookie|authorization|proxy-authorization)\s*:\s*[^\r\n]*/gi, REDACTED)
    .replace(/\b(?:\w*(?:token|password|secret)|api[-_]?key|access[-_]?key|proof)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, REDACTED)
    .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>]*|\\\\[^\\\s]+\\[^\r\n"'<>]*|(?<![\w/])\/(?:volume\d+|Users|home|mnt|run|tmp|var|probe)(?:\/[^\r\n"'<>]*)?/gi, REDACTED);
}

export function redact(value, ancestors = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return REDACTED;

  ancestors.add(value);
  let copy;
  if (Array.isArray(value)) {
    copy = value.map(item => redact(item, ancestors));
  } else if (value instanceof Error) {
    copy = { message: redactText(value.message) };
    if (typeof value.code === 'string') copy.code = redactText(value.code);
    if (Object.hasOwn(value, 'details')) copy.details = redact(value.details, ancestors);
  } else {
    copy = Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      redactText(key), sensitiveKey.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''))
        ? REDACTED : redact(entry, ancestors)
    ]));
  }
  ancestors.delete(value);
  return copy;
}
