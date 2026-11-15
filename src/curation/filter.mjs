// Step 1: Filter (code only). Splits raw logs into:
//   curation: observations allowed to influence the guide
//   training: observations allowed in the training dataset (redacted; mistakes kept as labeled negatives)
//   dropped:  everything else, with a reason
import { THRESHOLDS } from '../config.mjs';
import { redactObject } from '../pii.mjs';

/** Last summary wins per session (handlers write seq 1, 2...). */
export function latestSessions(sessions) {
  const map = new Map();
  for (const s of sessions) map.set(s.session_id, s);
  return map;
}

export function filterRecords({ observations, sessions, flaggedSessionIds = new Set() }) {
  const sessMap = latestSessions(sessions);
  const curation = [];
  const training = [];
  const dropped = [];
  const review = []; // safety stops etc.: humans look, curation never uses
  const drop = (o, reason, alsoTraining = false) => {
    dropped.push({ obs_id: o.obs_id, session_id: o.session_id, reason });
    if (alsoTraining) training.push(o);
  };

  observations = linkFixesToMistakes(observations);

  // Inconsistency: a step marked "correction worked" but a later observation of the same step in the
  // same session is still incorrect.
  const laterIncorrect = new Set();
  const bySessStep = new Map();
  for (const o of observations) {
    const key = `${o.session_id}|${o.step_id}`;
    if (!bySessStep.has(key)) bySessStep.set(key, []);
    bySessStep.get(key).push(o);
  }
  for (const list of bySessStep.values()) {
    list.sort((a, b) => (a.t_video_ms ?? 0) - (b.t_video_ms ?? 0));
    list.forEach((o, i) => {
      if (o.correction_worked === true && list.slice(i + 1).some((x) => x.result === 'incorrect')) laterIncorrect.add(o.obs_id);
    });
  }

  for (const raw of observations) {
    const s = sessMap.get(raw.session_id);
    if (raw.consent !== true || (s && s.consent !== true)) { drop(raw, 'no_consent'); continue; }
    if (!s) { drop(raw, 'no_session_summary'); continue; }
    if (s.flagged || flaggedSessionIds.has(raw.session_id)) { drop(raw, 'flagged_session'); continue; }
    if (s.outcome === 'abandoned' || s.outcome_evidence === 'none') { drop(raw, 'unknown_outcome'); continue; }
    if (raw.result === 'unverifiable' || !(raw.confidence >= THRESHOLDS.minConfidence)) { drop(raw, 'low_confidence'); continue; }

    // Re-scan for PII even though handlers redact at write time.
    const { value: o, found } = redactObject(raw);
    const hadPII = found.length > 0 || (raw.pii_redacted && raw.pii_redacted.length > 0);

    if (s.safety_stop) { review.push(o); drop(raw, 'safety_stop_review'); continue; }
    if (hadPII) { drop(o, 'pii', true); continue; }

    const isError = o.result === 'incorrect' || o.result === 'partial';
    if ((o.result === 'correct' && o.error_type) || (isError && !o.error_type)) { drop(o, 'inconsistent_labels', false); continue; }
    if (laterIncorrect.has(o.obs_id)) { drop(o, 'inconsistent_with_later_step', false); continue; }

    training.push(o);
    curation.push(o);
  }

  const usableSessions = [...sessMap.values()].filter(
    (s) => s.consent === true && !s.flagged && !flaggedSessionIds.has(s.session_id),
  );
  return { curation, training, dropped, review, sessions: usableSessions };
}

/**
 * The live model can't edit past logs, so it records a mistake as `incorrect` and later the fix as
 * `correct` (often repeating the error_type). Link them: the earlier mistake gets the fix's
 * correction_worked, and the fix is cleaned to a plain `correct` step. Returns new objects.
 */
export function linkFixesToMistakes(observations) {
  const out = observations.map((o) => ({ ...o }));
  const bySessStep = new Map();
  for (const o of out) {
    const k = `${o.session_id}|${o.step_id}`;
    if (!bySessStep.has(k)) bySessStep.set(k, []);
    bySessStep.get(k).push(o);
  }
  for (const list of bySessStep.values()) {
    list.sort((a, b) => (a.t_video_ms ?? 0) - (b.t_video_ms ?? 0));
    list.forEach((fix, i) => {
      if (fix.result !== 'correct') return;
      const mistake = list.slice(0, i).reverse().find((m) => m.result === 'incorrect' || m.result === 'partial');
      if (mistake) {
        if (fix.correction_worked === true) mistake.correction_worked = true;
        if (!mistake.correction_given && fix.correction_given) mistake.correction_given = fix.correction_given;
        fix.linked_mistake = mistake.obs_id;
      }
      if (fix.error_type) fix.error_type = null; // a correct step carries no error label
    });
  }
  return out;
}

export function summarizeDrops(dropped) {
  const counts = {};
  for (const d of dropped) counts[d.reason] = (counts[d.reason] || 0) + 1;
  return counts;
}
