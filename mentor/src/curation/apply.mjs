// Apply accepted proposals to a COPY of knowledge, enforce the size budget (G10), and produce
// the proposed guide + a readable diff.
import { THRESHOLDS } from '../config.mjs';
import { nextEntryId, partDWordCount, renderGuide } from '../knowledge.mjs';

const evidenceOf = (g) => ({
  n_sessions: g.n_sessions,
  n_distinct_callers: g.n_distinct_callers,
  success_rate: Number(g.correction_success_rate.toFixed(3)),
});

export function applyProposals(knowledge, accepted, { groups, usage, batch, today }) {
  const k = structuredClone(knowledge);
  const applied = [];
  const rejected = [];

  for (const p of accepted) {
    const g = p.group_key ? groups[p.group_key] : null;
    if (p.op === 'add_entry') {
      const id = nextEntryId(k, p.category);
      k.entries.push({
        id, category: p.category, status: 'trial', source: `curated:batch-${batch}`,
        title: p.title.trim(), spot_it: p.spot_it.trim(), correct_method: p.correct_method.trim(),
        group_key: p.group_key, evidence: evidenceOf(g), added_batch: batch, updated_batch: batch, history: [],
      });
      applied.push({ ...p, entry_id: id });
      continue;
    }
    const e = k.entries.find((x) => x.id === p.entry_id);
    const snapshot = { batch, title: e.title, spot_it: e.spot_it, correct_method: e.correct_method, status: e.status, evidence: e.evidence };
    e.history = [...(e.history || []), snapshot];
    if (p.op === 'update_entry') {
      for (const f of ['title', 'spot_it', 'correct_method']) if (p[f]) e[f] = p[f].trim();
      e.group_key = e.group_key || p.group_key;
      e.evidence = evidenceOf(g);
    } else if (p.op === 'promote') {
      e.status = 'established';
      e.evidence = evidenceOf(g);
    } else if (p.op === 'deprecate') {
      e.status = 'deprecated';
      e.deprecated_reason = p.rationale;
    }
    e.updated_batch = batch;
    applied.push(p);
  }

  // G10 size budget: drop newly added (lowest evidence first), then deprecate least-used old trial entries.
  while (partDWordCount(k) > THRESHOLDS.maxPartDWords) {
    const fresh = k.entries
      .filter((e) => e.added_batch === batch && e.source.startsWith('curated:') && e.status !== 'deprecated')
      .sort((a, b) => a.evidence.n_sessions - b.evidence.n_sessions);
    if (fresh.length) {
      const victim = fresh[0];
      k.entries = k.entries.filter((e) => e !== victim);
      const idx = applied.findIndex((a) => a.entry_id === victim.id);
      rejected.push({ proposal: applied[idx], failures: [{ gate: 'G10', reason: 'Part D over word budget' }] });
      applied.splice(idx, 1);
      continue;
    }
    const oldTrial = k.entries
      .filter((e) => e.status === 'trial')
      .sort((a, b) => (usage[a.id]?.total_uses || 0) - (usage[b.id]?.total_uses || 0));
    if (!oldTrial.length) break; // nothing safe to remove automatically; reviewer must trim
    oldTrial[0].status = 'deprecated';
    oldTrial[0].deprecated_reason = 'auto: G10 size budget (least used trial entry)';
    applied.push({ op: 'deprecate', entry_id: oldTrial[0].id, auto: true, rationale: 'auto: G10 size budget' });
  }

  k.meta = { ...k.meta, version: k.meta.version + 1, last_curated: today, last_batch: batch };
  return { knowledge: k, applied, rejected };
}

/** Minimal line diff (LCS) for the review report. */
export function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`- ${A[i++]}`);
    else out.push(`+ ${B[j++]}`);
  }
  while (i < n) out.push(`- ${A[i++]}`);
  while (j < m) out.push(`+ ${B[j++]}`);
  return out.join('\n');
}

export const renderProposedGuide = (guideText, k) => renderGuide(guideText, k);
