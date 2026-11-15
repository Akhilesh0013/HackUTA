// Step 6: publish an approved batch, snapshot the old version, and monitor/rollback.
import fs from 'node:fs';
import path from 'node:path';
import { THRESHOLDS } from '../config.mjs';
import { localDate } from '../config.mjs';
import { ensureDir, readJson, readJsonl, writeJson } from '../jsonl.mjs';
import { fixedPartsHash, loadKnowledge, readGuide, renderGuide, saveKnowledge } from '../knowledge.mjs';
import { globalMetrics } from './aggregate.mjs';
import { latestSessions } from './filter.mjs';
import { INJECTION_PATTERNS, SAFETY_BLOCKLIST } from './gates.mjs';
import { loadState, saveState } from './pipeline.mjs';
import { containsPII } from '../pii.mjs';

/** Re-check text of every entry the reviewer may have edited (G6/G8/PII), vs the base knowledge. */
export function validateReviewedKnowledge(base, reviewed) {
  const problems = [];
  const baseById = new Map(base.entries.map((e) => [e.id, e]));
  for (const e of reviewed.entries) {
    const b = baseById.get(e.id);
    const changed = !b || ['title', 'spot_it', 'correct_method'].some((f) => b[f] !== e[f]);
    if (!changed) continue;
    const text = `${e.title} . ${e.spot_it} . ${e.correct_method}`;
    for (const [re, why] of SAFETY_BLOCKLIST) if (re.test(text)) problems.push(`${e.id}: G6 ${why}`);
    for (const [re, why] of INJECTION_PATTERNS) if (re.test(`${e.title} ${e.spot_it} ${e.correct_method}`)) problems.push(`${e.id}: G8 ${why}`);
    if (containsPII(text)) problems.push(`${e.id}: personal info`);
  }
  for (const b of base.entries) if (!reviewed.entries.some((e) => e.id === b.id)) problems.push(`${b.id}: entries may be deprecated, not deleted`);
  return problems;
}

function snapshot(paths, k, guideText) {
  ensureDir(paths.versions);
  fs.writeFileSync(path.join(paths.versions, `GUIDE.v${k.meta.version}.md`), guideText, 'utf8');
  writeJson(path.join(paths.versions, `knowledge.v${k.meta.version}.json`), k);
}

function changelog(paths, line) {
  const head = fs.existsSync(paths.changelog) ? '' : '# Guide changelog\n\n';
  fs.appendFileSync(paths.changelog, `${head}- ${line}\n`, 'utf8');
}

export function publishBatch({ paths, batch, today = localDate() }) {
  const dir = path.join(paths.curation, `batch-${batch}`);
  const meta = readJson(path.join(dir, 'meta.json'), null);
  if (!meta) throw new Error(`No proposal for batch ${batch}. Run npm run curate first.`);
  if (meta.status !== 'proposed') throw new Error(`Batch ${batch} is ${meta.status}, not proposed.`);

  const current = loadKnowledge(paths.knowledge);
  const guideText = readGuide(paths.guide);
  if (current.meta.version !== meta.base_version) {
    throw new Error(`Guide changed since this proposal (v${current.meta.version} vs base v${meta.base_version}). Re-run curate.`);
  }
  if (fixedPartsHash(guideText) !== meta.fixed_parts_hash) {
    throw new Error('Fixed parts (A/B/C/E) of GUIDE.md changed since proposal. Re-run curate.');
  }

  const reviewed = readJson(path.join(dir, 'knowledge.proposed.json'), null);
  const problems = validateReviewedKnowledge(current, reviewed);
  if (problems.length) throw new Error(`Reviewed knowledge failed checks:\n  ${problems.join('\n  ')}`);

  const newGuide = renderGuide(guideText, reviewed);
  if (fixedPartsHash(newGuide) !== meta.fixed_parts_hash) throw new Error('Render changed fixed parts. Aborting.');

  snapshot(paths, current, guideText);
  reviewed.meta.from_batch = batch;
  saveKnowledge(paths.knowledge, reviewed);
  fs.writeFileSync(paths.guide, newGuide, 'utf8');
  if (fs.existsSync(paths.proposedGuide)) fs.rmSync(paths.proposedGuide);

  const accepted = readJson(path.join(dir, 'accepted.json'), []);
  changelog(paths, `${today} · v${current.meta.version} → v${reviewed.meta.version} · batch #${batch} · ${accepted.length} change(s): ${accepted.map((a) => `${a.op} ${a.entry_id || ''}`.trim()).join(', ') || 'none'}`);

  meta.status = 'published';
  meta.published = new Date().toISOString();
  writeJson(path.join(dir, 'meta.json'), meta);

  const state = loadState(paths);
  state.processed_session_ids = [...new Set([...state.processed_session_ids, ...meta.new_session_ids])];
  state.batches = state.batches.map((b) => (b.batch === batch ? { ...b, status: 'published' } : b));
  saveState(paths, state);
  return { from: current.meta.version, to: reviewed.meta.version };
}

/** Compare the live version against the previous one; roll back if metrics dropped. */
export function monitor({ paths, dryRun = false, today = localDate() }) {
  const k = loadKnowledge(paths.knowledge);
  const v = k.meta.version;
  const state = loadState(paths);
  if (k.meta.rollback_of) return { action: 'none', reason: `v${v} is a rollback; not monitored.` };
  if (!k.meta.from_batch) return { action: 'none', reason: `v${v} did not come from a curation batch.` };
  if (state.evaluated_versions[v]) return { action: 'none', reason: `v${v} already evaluated: ${state.evaluated_versions[v]}.` };

  const sessions = [...latestSessions(readJsonl(paths.sessions)).values()].filter((s) => s.consent && !s.flagged);
  const cur = sessions.filter((s) => s.guide_version === v).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const prev = sessions.filter((s) => s.guide_version === v - 1);
  if (cur.length < THRESHOLDS.rollbackWindow) return { action: 'wait', reason: `v${v} has ${cur.length}/${THRESHOLDS.rollbackWindow} sessions.` };
  if (!prev.length) return { action: 'none', reason: `No sessions for v${v - 1} to compare against.` };

  const now = globalMetrics(cur.slice(0, THRESHOLDS.rollbackWindow));
  const before = globalMetrics(prev);
  const drops = {
    resolution: before.resolution_rate_pct - now.resolution_rate_pct,
    first_try: before.first_try_step_success_pct - now.first_try_step_success_pct,
  };
  const regress = drops.resolution > THRESHOLDS.rollbackDropPts || drops.first_try > THRESHOLDS.rollbackDropPts;
  const summary = { version: v, before, now, drops };
  if (!regress) {
    if (!dryRun) { state.evaluated_versions[v] = 'ok'; saveState(paths, state); }
    return { action: 'keep', ...summary };
  }
  if (dryRun) return { action: 'would_rollback', ...summary };

  const prevK = readJson(path.join(paths.versions, `knowledge.v${v - 1}.json`), null);
  if (!prevK) throw new Error(`Snapshot knowledge.v${v - 1}.json missing; cannot roll back.`);
  const guideText = readGuide(paths.guide);
  snapshot(paths, k, guideText);
  const restored = { ...prevK, meta: { ...prevK.meta, version: v + 1, last_curated: today, rollback_of: v, from_batch: null } };
  saveKnowledge(paths.knowledge, restored);
  fs.writeFileSync(paths.guide, renderGuide(guideText, restored), 'utf8');
  // A drop is positive when the metric got worse; a metric that improved shows as +.
  const change = (drop) => `${drop >= 0 ? '−' : '+'}${Math.abs(drop).toFixed(1)} pts`;
  changelog(paths, `${today} · ROLLBACK v${v} → v${v + 1} (content of v${v - 1}) · resolution ${change(drops.resolution)}, first-try ${change(drops.first_try)}`);
  state.evaluated_versions[v] = 'rolled_back';
  state.batches = state.batches.map((b) => (b.batch === k.meta.from_batch ? { ...b, status: 'rolled_back' } : b));
  saveState(paths, state);
  return { action: 'rolled_back', ...summary, new_version: v + 1 };
}
