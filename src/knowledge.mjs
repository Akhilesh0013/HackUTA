// Part D of GUIDE.md is rendered from guide/knowledge.json (the source of truth).
// Everything outside the PART_D markers and the header line is "fixed" and is hashed so
// curation can prove it never changed Parts A/B/C/E.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { CATEGORIES } from './config.mjs';
import { readJson, writeJson } from './jsonl.mjs';

export const PART_D_START = '<!-- PART_D_START (generated from knowledge.json; do not edit by hand) -->';
export const PART_D_END = '<!-- PART_D_END -->';
const HEADER_RE = /^> Guide version:.*$/m;

export function loadKnowledge(file) {
  const k = readJson(file, null);
  if (!k) throw new Error(`Missing ${file}`);
  return k;
}
export const saveKnowledge = (file, k) => writeJson(file, k);

export function activeEntries(k) {
  return k.entries.filter((e) => e.status !== 'deprecated');
}

function evidenceLine(e) {
  if (!e.evidence) return null;
  const { n_sessions, n_distinct_callers, success_rate } = e.evidence;
  return `  - *Evidence:* ${n_sessions} sessions / ${n_distinct_callers} callers / ${Math.round(success_rate * 100)}% correction success`;
}

export function renderPartD(k) {
  const out = [
    '> Format: `status` is `trial` (new; say "this often helps") or `established` (use confidently). Deprecated entries are hidden.',
    '> Cite an entry by its ID in `log_observation.guide_entry_used` whenever you apply it.',
    '',
  ];
  for (const [cat, name] of Object.entries(CATEGORIES)) {
    out.push(`### ${cat}. ${name}`);
    const entries = activeEntries(k).filter((e) => e.category === cat);
    if (!entries.length) out.push('- *(No entries yet. Added by the curation pipeline.)*');
    for (const e of entries) {
      out.push(`- **${e.id} · ${e.title}** · \`${e.status}\` · source: ${e.source}`);
      out.push(`  - *Spot it:* ${e.spot_it}`);
      out.push(`  - *Correct method:* ${e.correct_method}`);
      const ev = evidenceLine(e);
      if (ev) out.push(ev);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

export function renderGuide(guideText, k) {
  const s = guideText.indexOf(PART_D_START);
  const e = guideText.indexOf(PART_D_END);
  if (s < 0 || e < 0 || e < s) throw new Error('GUIDE.md is missing PART_D markers');
  const header = `> Guide version: v${k.meta.version} · Last curated: ${k.meta.last_curated} · Sessions included: ${k.meta.sessions_included}`;
  const body =
    guideText.slice(0, s + PART_D_START.length) + '\n' + renderPartD(k) + '\n' + guideText.slice(e);
  return body.replace(HEADER_RE, header);
}

/** Hash of everything curation is NOT allowed to change. */
export function fixedPartsHash(guideText) {
  const s = guideText.indexOf(PART_D_START);
  const e = guideText.indexOf(PART_D_END);
  if (s < 0 || e < 0) throw new Error('GUIDE.md is missing PART_D markers');
  const fixed = (guideText.slice(0, s) + guideText.slice(e)).replace(HEADER_RE, '').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(fixed).digest('hex');
}

export function partDWordCount(k) {
  return renderPartD(k).split(/\s+/).filter(Boolean).length;
}

export function nextEntryId(k, category) {
  const nums = k.entries
    .filter((e) => e.category === category)
    .map((e) => Number(e.id.split('-')[1]))
    .filter(Number.isFinite);
  return `${category}-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0')}`;
}

export const readGuide = (file) => fs.readFileSync(file, 'utf8');
