// Step 2: Aggregate (code only). Evidence used by the gates is computed HERE, never taken
// from an LLM's claims.
import { THRESHOLDS } from '../config.mjs';

export const groupKey = (o) => `${o.task_category}|${o.device.type}|${o.step_id}|${o.error_type}`;

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const normText = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function topTexts(texts, n = 3) {
  const counts = new Map();
  const example = new Map();
  for (const t of texts) {
    const k = normText(t);
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
    if (!example.has(k)) example.set(k, t);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => ({ text: example.get(k), count: c }));
}

/** Error-pattern groups: incorrect/partial observations that received a correction. */
export function aggregateGroups(observations) {
  const groups = new Map();
  for (const o of observations) {
    if (!(o.result === 'incorrect' || o.result === 'partial') || !o.error_type) continue;
    const key = groupKey(o);
    if (!groups.has(key)) groups.set(key, { key, task_category: o.task_category, device_type: o.device.type, step_id: o.step_id, error_type: o.error_type, obs: [] });
    groups.get(key).obs.push(o);
  }

  // time-to-fix: from the incorrect observation to the next correct one for the same step+session
  const bySessStep = new Map();
  for (const o of observations) {
    const k = `${o.session_id}|${o.step_id}`;
    if (!bySessStep.has(k)) bySessStep.set(k, []);
    bySessStep.get(k).push(o);
  }

  const out = {};
  for (const g of groups.values()) {
    const sessionsByCaller = new Map();
    for (const o of g.obs) {
      if (!sessionsByCaller.has(o.caller_id)) sessionsByCaller.set(o.caller_id, new Set());
      sessionsByCaller.get(o.caller_id).add(o.session_id);
    }
    const sessionIds = new Set(g.obs.map((o) => o.session_id));
    const n_sessions = sessionIds.size;
    const topCallerSessions = Math.max(...[...sessionsByCaller.values()].map((s) => s.size));
    const corrected = g.obs.filter((o) => o.correction_given && typeof o.correction_worked === 'boolean');
    const fixTimes = [];
    for (const o of g.obs) {
      const later = (bySessStep.get(`${o.session_id}|${o.step_id}`) || [])
        .filter((x) => x.result === 'correct' && (x.t_video_ms ?? -1) > (o.t_video_ms ?? Infinity))
        .sort((a, b) => a.t_video_ms - b.t_video_ms)[0];
      if (later) fixTimes.push((later.t_video_ms - o.t_video_ms) / 1000);
    }
    out[g.key] = {
      key: g.key,
      task_category: g.task_category,
      device_type: g.device_type,
      step_id: g.step_id,
      error_type: g.error_type,
      n_observations: g.obs.length,
      n_sessions,
      n_distinct_callers: sessionsByCaller.size,
      top_caller_share: n_sessions ? topCallerSessions / n_sessions : 1,
      n_corrections: corrected.length,
      correction_success_rate: corrected.length ? corrected.filter((o) => o.correction_worked).length / corrected.length : 0,
      median_time_to_fix_s: median(fixTimes),
      top_corrections: topTexts(g.obs.filter((o) => o.correction_worked).map((o) => o.correction_given)),
      top_visual_evidence: topTexts(g.obs.map((o) => o.visual_evidence)),
    };
  }
  return out;
}

/** Per-entry usage over the last N uses (for auto-deprecation) and manual-conflict counts. */
export function aggregateEntryUsage(observations, window = THRESHOLDS.deprecateWindow) {
  const byEntry = new Map();
  const sorted = [...observations].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  for (const o of sorted) {
    if (!o.guide_entry_used) continue;
    if (!byEntry.has(o.guide_entry_used)) byEntry.set(o.guide_entry_used, { uses: [], conflicts: 0 });
    const e = byEntry.get(o.guide_entry_used);
    if (o.error_type === 'other:guide_manual_conflict') { e.conflicts++; continue; }
    const success = o.result === 'correct' || o.correction_worked === true;
    e.uses.push(success);
  }
  const out = {};
  for (const [id, e] of byEntry) {
    const last = e.uses.slice(-window);
    out[id] = {
      total_uses: e.uses.length,
      window_uses: last.length,
      window_success_rate: last.length ? last.filter(Boolean).length / last.length : null,
      manual_conflicts: e.conflicts,
    };
  }
  return out;
}

/** Global metrics for a set of sessions (also used per guide version by the monitor). */
export function globalMetrics(sessions) {
  const n = sessions.length;
  const steps = sessions.reduce((a, s) => a + (s.steps_total || 0), 0);
  const firstTry = sessions.reduce((a, s) => a + (s.first_try_success_steps || 0), 0);
  const durations = sessions.map((s) => s.duration_s).filter((d) => Number.isFinite(d));
  const pct = (x) => (n ? Math.round((x / n) * 1000) / 10 : null);
  return {
    sessions: n,
    resolution_rate_pct: pct(sessions.filter((s) => s.outcome === 'resolved').length),
    first_try_step_success_pct: steps ? Math.round((firstTry / steps) * 1000) / 10 : null,
    referral_rate_pct: pct(sessions.filter((s) => s.outcome === 'referred_to_pro').length),
    safety_stop_pct: pct(sessions.filter((s) => s.safety_stop).length),
    median_duration_s: median(durations),
  };
}

export function topErrorTypes(observations, n = 5) {
  const errs = observations.filter((o) => o.error_type);
  const counts = {};
  for (const o of errs) counts[o.error_type] = (counts[o.error_type] || 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([type, c]) => ({ type, pct: Math.round((c / errs.length) * 1000) / 10 }));
}
