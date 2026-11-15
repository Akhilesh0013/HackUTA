// PII / secret detection and redaction. Used at write time (tool handlers) and again in the
// curation filter (defense in depth). Conservative: false positives only cost a dropped record.

const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/;

const PATTERNS = [
  ['email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
  ['secret', /\b(password|passcode|passwd|pwd|wi-?fi\s*(key|password)|psk|recovery\s*code|pin\s*code|api\s*key)\b\s*(is|was|:|=)\s*["']?[^\s"',.;]{3,}/gi],
  // bare "pin" only with an explicit ':' or '=' so "the 8-pin socket" / "pin is bent" stay intact
  ['secret', /\bpin\s*[:=]\s*\d{3,}/gi],
  ['serial', /\b(s\/?n|serial(\s*(no\.?|number|#))?)\s*[:#]?\s*[A-Z0-9-]{5,}/gi],
  ['mac', /\b[0-9A-F]{2}([:-])[0-9A-F]{2}(\1[0-9A-F]{2}){4}\b/gi],
  ['phone', /(\+\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g],
  ['address', /\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:[Ss]treet|[Ss]t|[Aa]venue|[Aa]ve|[Rr]oad|[Rr]d|[Bb]oulevard|[Bb]lvd|[Ll]ane|[Ll]n|[Dd]rive|[Dd]r|[Cc]ourt|[Cc]t|[Ww]ay|[Pp]lace|[Pp]l)\b\.?/g],
  ['long_id', /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{12,}\b/g],
];

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/** @returns {{ text: string, found: string[] }} */
export function redactText(text) {
  if (typeof text !== 'string' || !text) return { text, found: [] };
  const found = new Set();
  let out = text;
  for (const [type, re] of PATTERNS) {
    out = out.replace(re, () => { found.add(type); return `[REDACTED:${type}]`; });
  }
  // Public IPs are personal; private/router IPs (192.168.1.1) are useful guidance and kept.
  out = out.replace(IPV4, (ip) => (PRIVATE_IP.test(ip) ? ip : (found.add('public_ip'), '[REDACTED:public_ip]')));
  return { text: out, found: [...found] };
}

/** Deep-redact every string in a plain object. Returns a new object + the PII types found. */
export function redactObject(obj) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = redactText(v);
      r.found.forEach((f) => found.add(f));
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(obj), found: [...found] };
}

export const containsPII = (text) => redactText(text).found.length > 0;
