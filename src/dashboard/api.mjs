// Read-only views over the call logs and the playbook for the dashboard.
// Logs are already PII-redacted by the tool handlers; caller ids (hashed) are still left out here.
import fs from 'node:fs';
import path from 'node:path';
import { globalMetrics, topErrorTypes } from '../curation/aggregate.mjs';
import { latestSessions } from '../curation/filter.mjs';
import { loadState } from '../curation/pipeline.mjs';
import { readJson, readJsonl } from '../jsonl.mjs';
import { activeEntries, loadKnowledge } from '../knowledge.mjs';

const SESSION_FIELDS = ['session_id', 'ts', 'guide_version', 'task_category', 'goal', 'outcome', 'duration_s', 'steps_total', 'errors_total', 'first_try_success_steps', 'manual_used', 'safety_stop', 'caller_rating', 'flagged'];
const OBS_FIELDS = ['obs_id', 'ts', 't_video_ms', 'task_category', 'device', 'step_id', 'instruction_given', 'observed_action', 'result', 'error_type', 'correction_given', 'correction_worked', 'guide_entry_used', 'fixes_obs_id'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

function load(paths) {
  return { sessions: [...latestSessions(readJsonl(paths.sessions)).values()], observations: readJsonl(paths.observations) };
}

/** Headline numbers, plus metrics per guide version so the effect of each update shows. */
export function overview(paths) {
  const { sessions, observations } = load(paths);
  const versions = [...new Set(sessions.map((s) => s.guide_version))].sort((a, b) => a - b);
  return {
    guide_version: loadKnowledge(paths.knowledge).meta.version,
    metrics: globalMetrics(sessions),
    by_version: versions.map((v) => ({ version: v, ...globalMetrics(sessions.filter((s) => s.guide_version === v)) })),
    top_errors: topErrorTypes(observations),
    observations: observations.length,
  };
}

/** Newest calls first. Calls with steps but no session summary yet are still in progress. */
export function listCalls(paths, limit = 50) {
  const { sessions, observations } = load(paths);
  const obsBySession = new Map();
  for (const o of observations) obsBySession.set(o.session_id, (obsBySession.get(o.session_id) || 0) + 1);
  const calls = sessions.map((s) => ({ ...pick(s, SESSION_FIELDS), observations: obsBySession.get(s.session_id) || 0, status: 'done' }));
  const known = new Set(sessions.map((s) => s.session_id));
  for (const [id, n] of obsBySession) {
    if (known.has(id)) continue;
    const last = observations.filter((o) => o.session_id === id).at(-1);
    calls.push({ session_id: id, ts: last.ts, guide_version: last.guide_version, task_category: last.task_category, observations: n, status: 'in_progress' });
  }
  return calls.sort((a, b) => String(b.ts).localeCompare(String(a.ts)) || String(b.session_id).localeCompare(String(a.session_id), undefined, { numeric: true })).slice(0, limit);
}

/** One call: its summary and every logged step in video order. */
export function getCall(paths, sessionId) {
  const { sessions, observations } = load(paths);
  const steps = observations.filter((o) => o.session_id === sessionId).sort((a, b) => (a.t_video_ms ?? 0) - (b.t_video_ms ?? 0)).map((o) => pick(o, OBS_FIELDS));
  const session = sessions.find((s) => s.session_id === sessionId);
  if (!session && !steps.length) return null;
  return { session: session ? pick(session, SESSION_FIELDS) : null, steps };
}

/** Learned knowledge (Part D), version files and the changelog (publishes and rollbacks). */
export function guideInfo(paths) {
  const k = loadKnowledge(paths.knowledge);
  const versions = fs.existsSync(paths.versions)
    ? fs.readdirSync(paths.versions).map((f) => /^GUIDE\.v(\d+)\.md$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b)
    : [];
  const changelog = fs.existsSync(paths.changelog)
    ? fs.readFileSync(paths.changelog, 'utf8').split('\n').filter((l) => l.startsWith('- ')).map((l) => {
      const text = l.slice(2);
      return { text, rollback: /\bROLLBACK\b/.test(text) };
    })
    : [];
  return {
    meta: k.meta,
    entries: activeEntries(k).map((e) => pick(e, ['id', 'category', 'status', 'source', 'title', 'spot_it', 'correct_method', 'evidence', 'added_batch'])),
    versions,
    changelog,
  };
}

/** The newest curation batch: what was accepted, what was rejected and by which gate. */
export function latestCuration(paths) {
  const state = loadState(paths);
  const last = state.batches.at(-1);
  if (!last) return { batches: [], latest: null };
  const dir = path.join(paths.curation, `batch-${last.batch}`);
  const meta = readJson(path.join(dir, 'meta.json'), {});
  const accepted = readJson(path.join(dir, 'accepted.json'), []);
  const rejected = readJson(path.join(dir, 'rejected.json'), []);
  return {
    batches: state.batches,
    latest: {
      batch: last.batch,
      status: last.status,
      created: meta.created,
      mode: meta.mode,
      base_version: meta.base_version,
      proposed_version: meta.proposed_version,
      new_sessions: meta.new_session_ids?.length ?? null,
      accepted: accepted.map((a) => pick(a, ['op', 'entry_id', 'category', 'title', 'rationale'])),
      rejected: rejected.map((r) => ({ op: r.proposal?.op, title: r.proposal?.title, failures: r.failures })),
    },
  };
}
