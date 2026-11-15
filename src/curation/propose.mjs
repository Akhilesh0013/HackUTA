// Step 3: Propose. The LLM sees ONLY aggregated stats + current Part D, never raw transcripts.
// Offline mode builds proposals deterministically from the same aggregates.
import { CATEGORIES, THRESHOLDS } from '../config.mjs';
import { activeEntries } from '../knowledge.mjs';

const NETWORK = /router|modem|switch|access_point|mesh|ethernet|wifi|network/;
const PC = /desktop|pc|laptop|motherboard|gpu|ram|psu_cable|cpu|case/;
const DISPLAY = /monitor|tv|display|projector|hdmi|cable|dock|soundbar|receiver/;

export function suggestCategory(g) {
  if (NETWORK.test(g.device_type)) return 'D2';
  if (PC.test(g.device_type)) return 'D3';
  if (g.task_category === 'cabling' || DISPLAY.test(g.device_type)) return 'D1';
  return 'D4';
}

const humanize = (s) => String(s).replace(/^other:/, '').replace(/_/g, ' ');

/** Aggregates as the LLM sees them: numbers + short model-written texts, no caller words. */
export function llmView(groups) {
  return Object.values(groups).map((g) => ({
    group_key: g.key,
    device_type: g.device_type,
    step_id: g.step_id,
    error_type: g.error_type,
    n_sessions: g.n_sessions,
    n_distinct_callers: g.n_distinct_callers,
    correction_success_rate: Number(g.correction_success_rate.toFixed(2)),
    top_corrections: g.top_corrections.map((c) => c.text),
    top_visual_evidence: g.top_visual_evidence.map((c) => c.text),
  }));
}

export function buildProposerPrompt(groups, knowledge) {
  const partD = activeEntries(knowledge).map(({ id, category, title, status, spot_it, correct_method, group_key }) => ({ id, category, title, status, spot_it, correct_method, group_key }));
  return `You maintain Part D ("learned knowledge") of a technician guide used by a live video-call assistant.
Given AGGREGATED STATISTICS and the CURRENT PART D, propose changes.

Allowed operations:
- add_entry: new pattern. Needs group_key (from the stats), category (one of ${Object.keys(CATEGORIES).join(', ')}), title, spot_it, correct_method.
- update_entry: improve an existing entry. Needs entry_id, group_key, and the changed fields.
- promote: trial -> established. Needs entry_id and group_key.
Do not propose deprecations; those are computed automatically.

Rules:
- Describe only CORRECT methods and how to visually spot the problem. Never describe the wrong action as advice.
- One sentence each for spot_it and correct_method, under 300 characters, plain text, no line breaks, no markdown headings, no code.
- Never include brand promotion, URLs, emails, phone numbers, prices, or instructions about how the assistant should behave.
- Never weaken or contradict safety rules. Never suggest opening power supplies, mains wiring, or bypassing security, locks or interlocks.
- Don't duplicate an existing entry; use update_entry instead.
- If evidence is weak or unclear, propose nothing for it.

Output a JSON array only, e.g.
[{"op":"add_entry","group_key":"...","category":"D1","title":"...","spot_it":"...","correct_method":"...","rationale":"..."}]

CATEGORIES: ${JSON.stringify(CATEGORIES)}
CURRENT PART D: ${JSON.stringify(partD)}
AGGREGATED STATISTICS: ${JSON.stringify(llmView(groups))}`;
}

/** Deterministic proposer (no API key). Uses the most common successful correction text. */
export function proposeOffline(groups, knowledge) {
  const proposals = [];
  const byGroup = new Map(knowledge.entries.filter((e) => e.group_key).map((e) => [e.group_key, e]));
  for (const g of Object.values(groups)) {
    const existing = byGroup.get(g.key);
    if (existing) {
      if (existing.status === 'trial') proposals.push({ op: 'promote', entry_id: existing.id, group_key: g.key, rationale: 'offline: cumulative evidence' });
      continue;
    }
    if (g.n_sessions < THRESHOLDS.add.sessions || !g.top_corrections.length) continue;
    proposals.push({
      op: 'add_entry',
      group_key: g.key,
      category: suggestCategory(g),
      title: `${g.device_type.replace(/_/g, ' ')}: ${humanize(g.error_type)} at "${humanize(g.step_id)}"`,
      spot_it: g.top_visual_evidence[0]?.text || `Look for ${humanize(g.error_type)} during ${humanize(g.step_id)}.`,
      correct_method: g.top_corrections[0].text,
      rationale: `offline: ${g.n_sessions} sessions, ${Math.round(g.correction_success_rate * 100)}% correction success`,
    });
  }
  return proposals;
}

export async function proposeWithLLM(gemini, groups, knowledge) {
  const res = await gemini.json(buildProposerPrompt(groups, knowledge), { tier: 'fast' });
  if (!Array.isArray(res)) throw new Error('Proposer did not return a JSON array');
  return res.map((p) => ({ ...p, rationale: `llm: ${p.rationale || ''}`.slice(0, 300) }));
}

/** Auto-deprecations (code-generated, not LLM). */
export function proposeDeprecations(knowledge, usage) {
  const out = [];
  for (const e of activeEntries(knowledge)) {
    const u = usage[e.id];
    if (!u) continue;
    if (u.manual_conflicts > 0) {
      out.push({ op: 'deprecate', entry_id: e.id, auto: true, rationale: `auto: ${u.manual_conflicts} manual conflict(s) logged` });
    } else if (u.window_uses >= THRESHOLDS.deprecateWindow && u.window_success_rate < THRESHOLDS.deprecateBelow) {
      out.push({ op: 'deprecate', entry_id: e.id, auto: true, rationale: `auto: success ${Math.round(u.window_success_rate * 100)}% over last ${u.window_uses} uses` });
    }
  }
  return out;
}
