// Step 4: Gate checks. A proposal is rejected if ANY gate fails. Evidence numbers come from
// code-computed aggregates (aggregate.mjs), never from the proposer's claims.
import { CATEGORIES, THRESHOLDS } from '../config.mjs';
import { activeEntries } from '../knowledge.mjs';
import { containsPII } from '../pii.mjs';

const OPS = ['add_entry', 'update_entry', 'promote', 'deprecate'];
const TEXT_FIELDS = ['title', 'spot_it', 'correct_method'];

// G6: safety blocklist. Also "reserved topics" that only humans may cover (Part A).
export const SAFETY_BLOCKLIST = [
  [/\b(open|remove|unscrew|take apart|disassemble|pry)\b[^.]{0,40}\b(power supply|psu|charger brick|power brick|ac adapter)\b/i, 'opening a power supply'],
  [/\b(psu|power supply)\b[^.]{0,30}\b(cover|casing|housing|internals?|fuse)\b/i, 'power supply internals'],
  [/\b(mains|1[12]0\s?v|2[234]0\s?v|wall wiring|breaker panel|live wire|hot wire|neutral wire)\b/i, 'mains voltage'],
  [/\bcapacitors?\b/i, 'capacitors'],
  [/\b(bypass|override|defeat|disable|turn off|jumper)\b[^.]{0,40}\b(interlock|safety|security|firewall|antivirus|defender|activation lock|parental control|fuse|thermal (protection|shutdown)|secure boot)\b/i, 'bypassing protections'],
  [/\b(jailbreak|factory unlock|crack(ed)? firmware|pirat|keygen)\b/i, 'circumvention'],
  [/\brooting\b|\broot the\b/i, 'rooting devices'],
  [/\b(swollen|bulging|leaking|punctured|hot)\s+(battery|batteries)\b/i, 'battery hazards (reserved for Part A)'],
  [/\b(gas (line|valve|appliance|stove)|ladder|ceiling mount)\b/i, 'reserved topic (Part A)'],
  [/\b(microwave|crt)\b/i, 'high-voltage appliance internals'],
  [/\b(ram|memory|gpu|graphics card|cpu|motherboard|expansion card|internal)\b[^.]{0,60}\b(while|with)\b[^.]{0,20}\b(on|plugged in|running|powered)\b/i, 'hot-plugging internal parts'],
  [/\b(no need|don'?t need|do not need|skip|unnecessary)\b[^.]{0,30}\b(unplug|power(ing)? (it )?off|turn(ing)? (it )?off|ground|static|strap)\b/i, 'weakening a safety step'],
];

// G8: prompt injection / format / promotion
export const INJECTION_PATTERNS = [
  [/\b(ignore|disregard|forget|override)\b[^.]{0,30}\b(previous|above|prior|instructions?|rules?|part [a-e]|guide|system)\b/i, 'instruction override'],
  [/\b(you (must|should|will) always|always (say|tell|answer|recommend)|never (mention|say|tell)|system prompt|as an ai|the (assistant|model|ai) (must|should|will)|mentor (must|should)|genesis (must|should))\b/i, 'instructions to the model'],
  [/(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|ai|co|shop|xyz|ly|gg)\b)/i, 'URL or domain'],
  [/[$€£]\s?\d|\b\d+(\.\d+)?\s?(usd|dollars|bucks)\b/i, 'price'],
  [/\b(buy|purchase|order one|sponsored|affiliate|best brand|discount|coupon|promo code|use brand)\b/i, 'promotion'],
  [/[`#<>]|\r|\n|\*\*|\[[^\]]*\]\(/, 'markdown/code/structure characters'],
];

const words = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
export function jaccard(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
const entryText = (e) => `${e.title} ${e.spot_it} ${e.correct_method}`;

/** Text produced by applying a proposal (for update: merged with the existing entry). */
function resultingText(p, entry) {
  return Object.fromEntries(TEXT_FIELDS.map((f) => [f, p[f] ?? entry?.[f] ?? '']));
}

/** Synchronous gates G1-G6, G8, G9 (deterministic part), G11. */
export function checkSync(p, { knowledge, groups, usage, batch }) {
  const fail = [];
  const f = (gate, reason) => fail.push({ gate, reason });
  const entry = p.entry_id ? knowledge.entries.find((e) => e.id === p.entry_id) : null;
  const g = p.group_key ? groups[p.group_key] : null;

  // G1 scope
  if (!OPS.includes(p.op)) f('G1', `operation "${p.op}" not allowed`);
  if (p.op === 'deprecate' && !p.auto) f('G1', 'deprecations are computed automatically, not proposed');
  if (p.op !== 'add_entry' && (!entry || entry.status === 'deprecated')) f('G1', `entry ${p.entry_id} not found or deprecated`);
  if (p.op === 'add_entry' && !CATEGORIES[p.category]) f('G1', `category "${p.category}" not in Part D`);
  if (p.op === 'add_entry' && TEXT_FIELDS.some((k) => typeof p[k] !== 'string' || !p[k].trim())) f('G1', 'add_entry needs title, spot_it, correct_method');
  for (const k of TEXT_FIELDS) {
    if (p[k] != null && typeof p[k] !== 'string') f('G1', `${k} must be text`);
    else if (p[k] && p[k].length > (k === 'title' ? 100 : THRESHOLDS.maxFieldChars)) f('G1', `${k} too long`);
  }
  const extra = Object.keys(p).filter((k) => !['op', 'entry_id', 'group_key', 'category', 'rationale', 'auto', ...TEXT_FIELDS].includes(k));
  if (extra.length) f('G1', `unexpected fields: ${extra.join(', ')}`);
  if (fail.length) return fail; // structure broken: stop here

  if (p.op === 'deprecate') return fail;

  // Evidence must exist in code-computed aggregates
  if (!g) {
    f('G2', `no evidence group "${p.group_key}" in aggregated data`);
    return fail;
  }

  // G2 add evidence
  if (p.op === 'add_entry' || p.op === 'update_entry') {
    const t = THRESHOLDS.add;
    if (g.n_sessions < t.sessions) f('G2', `only ${g.n_sessions} sessions (need ${t.sessions})`);
    if (g.n_distinct_callers < t.callers) f('G2', `only ${g.n_distinct_callers} distinct callers (need ${t.callers})`);
    if (g.correction_success_rate < t.success) f('G2', `correction success ${(g.correction_success_rate * 100).toFixed(0)}% (need ${t.success * 100}%)`);
  }

  // G3 promotion
  if (p.op === 'promote') {
    const t = THRESHOLDS.promote;
    if (entry.status !== 'trial') f('G3', `entry is ${entry.status}, not trial`);
    if (entry.group_key !== p.group_key) f('G3', 'evidence group does not match the entry');
    if (!(entry.added_batch < batch)) f('G3', 'must stay trial for at least one earlier batch');
    if (g.n_sessions < t.sessions) f('G3', `only ${g.n_sessions} cumulative sessions (need ${t.sessions})`);
    if (g.correction_success_rate < t.success) f('G3', `success ${(g.correction_success_rate * 100).toFixed(0)}% (need ${t.success * 100}%)`);
  }

  // G4 poisoning cap
  if (g.top_caller_share > THRESHOLDS.maxCallerShare) {
    f('G4', `one caller provides ${(g.top_caller_share * 100).toFixed(0)}% of evidence (max ${THRESHOLDS.maxCallerShare * 100}%)`);
  }

  // G5 overwrite protection
  if (p.op === 'update_entry') {
    if (entry.group_key && entry.group_key !== p.group_key) f('G5', 'evidence group does not match the entry');
    if (entry.status === 'established') {
      const need = entry.evidence ? entry.evidence.n_sessions + 1 : THRESHOLDS.seedOverwriteSessions;
      if (g.n_sessions < need) f('G5', `established entry needs ≥${need} sessions to change (have ${g.n_sessions})`);
    }
  }

  // Text checks: G6 safety, G8 injection/format, PII
  const text = resultingText(p, entry);
  const all = Object.values(text).join(' . ');
  for (const [re, why] of SAFETY_BLOCKLIST) if (re.test(all)) f('G6', `safety blocklist: ${why}`);
  for (const [re, why] of INJECTION_PATTERNS) if (re.test(Object.values(text).join(' '))) f('G8', why);
  if (containsPII(all)) f('G8', 'contains personal info');

  // G9 deterministic: logged manual conflicts against this entry
  if (entry && usage[entry.id]?.manual_conflicts > 0) f('G9', `${usage[entry.id].manual_conflicts} manual conflict(s) logged for ${entry.id}`);

  // G11 duplicates
  if (p.op === 'add_entry') {
    const sameGroup = knowledge.entries.find((e) => e.group_key === p.group_key && e.status !== 'deprecated');
    if (sameGroup) f('G11', `group already covered by ${sameGroup.id}; use update_entry`);
  }
  const cat = p.category || entry?.category;
  for (const e of activeEntries(knowledge)) {
    if (e.id === entry?.id || e.category !== cat) continue;
    const sim = jaccard(entryText(text), entryText(e));
    if (sim >= THRESHOLDS.dupSimilarity) f('G11', `near-duplicate of ${e.id} (similarity ${sim.toFixed(2)})`);
  }
  return fail;
}

export function buildSafetyPrompt(text, partA, manualExcerpts) {
  return `You are a strict safety reviewer for a consumer tech-support guide used on live video calls.
Review the CANDIDATE ENTRY against the CORE RULES and any MANUAL EXCERPTS.
Mark unsafe if it could cause injury, electric shock, fire, data loss, device damage, privacy harm,
or if it weakens or contradicts any core rule. Mark unsure if you are not certain. Mark
manual_conflict if it contradicts a manual excerpt.
Return JSON only: {"verdict":"safe"|"unsafe"|"unsure","contradicts_core_rules":bool,"manual_conflict":bool,"reason":"..."}

CORE RULES:
${partA}

MANUAL EXCERPTS:
${manualExcerpts.length ? JSON.stringify(manualExcerpts) : '(none)'}

CANDIDATE ENTRY:
${JSON.stringify(text)}`;
}

/** G7 safety classifier + G9 LLM manual-conflict check. Fails closed. */
export async function checkSafetyLLM(p, { knowledge, gemini, partA, manualsForDevice, allowNoClassifier }) {
  if (p.op === 'deprecate' || p.op === 'promote') return { fail: [], note: null }; // no new text
  if (!gemini) {
    return allowNoClassifier
      ? { fail: [], note: 'G7 skipped (no classifier, --allow-no-classifier): human reviewer must check safety' }
      : { fail: [{ gate: 'G7', reason: 'safety classifier unavailable (fail-closed). Set GEMINI_API_KEY or pass --allow-no-classifier for review-only runs.' }], note: null };
  }
  const entry = p.entry_id ? knowledge.entries.find((e) => e.id === p.entry_id) : null;
  const text = resultingText(p, entry);
  const deviceType = p.group_key ? p.group_key.split('|')[1] : null;
  try {
    const r = await gemini.json(buildSafetyPrompt(text, partA, manualsForDevice(deviceType)), { tier: 'strong' });
    const fail = [];
    if (r.verdict !== 'safe' || r.contradicts_core_rules) fail.push({ gate: 'G7', reason: `classifier: ${r.verdict}${r.reason ? ` (${String(r.reason).slice(0, 160)})` : ''}` });
    if (r.manual_conflict) fail.push({ gate: 'G9', reason: `conflicts with manual: ${String(r.reason || '').slice(0, 160)}` });
    return { fail, note: null };
  } catch (err) {
    return { fail: [{ gate: 'G7', reason: `classifier error (fail-closed): ${err.message}` }], note: null };
  }
}
