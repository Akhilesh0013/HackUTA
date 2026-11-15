// Local manual library: data/manuals/*.json
// { brand, model, aliases[], title, source_url, sections: [{ page, heading, text }] }
// Swap searchManuals for a vector search / Vertex AI Search later; keep the return shape.
import fs from 'node:fs';
import path from 'node:path';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

export function loadManuals(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

export function searchManuals(dir, { brand, model, topic }) {
  const manuals = loadManuals(dir);
  const m = norm(model);
  const b = norm(brand);
  const manual =
    manuals.find((x) => [x.model, ...(x.aliases || [])].some((a) => norm(a) === m) && (!b || norm(x.brand) === b)) ||
    manuals.find((x) => [x.model, ...(x.aliases || [])].some((a) => norm(a) === m));
  if (!manual) {
    return {
      found: false,
      message: `No manual for ${brand} ${model} in the library. Tell the caller you couldn't find it, don't substitute another model, and suggest the manufacturer's support site.`,
    };
  }
  const q = words(topic);
  const scored = manual.sections
    .map((s) => {
      const hay = words(`${s.heading} ${s.text}`);
      const score = q.reduce((n, w) => n + (hay.includes(w) ? 2 : hay.some((h) => h.startsWith(w)) ? 1 : 0), 0);
      return { ...s, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, 3);
  return {
    found: true,
    manual: manual.title,
    source: manual.source_url || null,
    excerpts: scored.map(({ page, heading, text }) => ({ page, heading, text: text.slice(0, 600) })),
    ...(scored.length ? {} : { message: 'Manual found, but no section matched the topic. Ask the caller what they see, or try another topic.' }),
  };
}
