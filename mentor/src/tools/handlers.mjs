// Server-side tool handlers. They never trust the model: consent, schema, enums and PII
// redaction are enforced here, and identity fields (session/caller/guide version) are
// injected from the call context, not taken from model arguments.
import crypto from 'node:crypto';
import {
  OUTCOMES, OUTCOME_EVIDENCE, RESULTS, TASK_CATEGORIES, isValidErrorType, paths as getPaths,
} from '../config.mjs';
import { appendJsonl } from '../jsonl.mjs';
import { redactObject } from '../pii.mjs';
import { searchManuals } from '../manuals.mjs';

/** Hash a caller's phone/Apple ID so callers can be counted but never identified. */
export function hashCaller(rawId, salt = process.env.CALLER_SALT || 'dev-salt-change-me') {
  return 'c_' + crypto.createHash('sha256').update(salt + ':' + rawId).digest('hex').slice(0, 16);
}

const clamp01 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : null);
const nonNegInt = (x) => (Number.isInteger(x) && x >= 0 ? x : null);
const cut = (s, n = 400) => (typeof s === 'string' ? s.slice(0, n) : s);

export function createToolHandlers({
  sessionId,
  callerId,            // already hashed (hashCaller)
  guideVersion,
  paths = getPaths(),
  onCard = () => {},
  now = () => new Date().toISOString(),
}) {
  if (!sessionId || !callerId || guideVersion == null) throw new Error('sessionId, callerId, guideVersion required');
  let consent = null; // null = not asked yet
  let sessionLogged = false;

  const ctx = () => ({ session_id: sessionId, caller_id: callerId, guide_version: guideVersion, ts: now() });
  const needConsent = () =>
    consent === true ? null : { ok: false, error: 'Logging refused: caller has not consented. Keep helping, do not log.' };

  const handlers = {
    record_consent({ granted }) {
      if (typeof granted !== 'boolean') return { ok: false, error: 'granted must be boolean' };
      consent = granted;
      appendJsonl(paths.sessions.replace('sessions.jsonl', 'consent.jsonl'), { ...ctx(), consent: granted });
      return { ok: true, consent: granted };
    },

    log_observation(args = {}) {
      const refused = needConsent();
      if (refused) return refused;
      const errs = [];
      if (!TASK_CATEGORIES.includes(args.task_category)) errs.push('task_category invalid');
      if (!args.device || typeof args.device.type !== 'string' || !args.device.type) errs.push('device.type required');
      if (typeof args.step_id !== 'string' || !/^[a-z0-9_]{2,60}$/.test(args.step_id)) errs.push('step_id must be snake_case');
      if (!RESULTS.includes(args.result)) errs.push('result invalid');
      if (typeof args.observed_action !== 'string' || !args.observed_action) errs.push('observed_action required');
      const error_type = args.error_type ? String(args.error_type) : null;
      if (!isValidErrorType(error_type)) errs.push('error_type not in taxonomy');
      const confidence = clamp01(args.confidence);
      if (confidence == null) errs.push('confidence must be 0-1');
      if (errs.length) return { ok: false, error: errs.join('; ') };

      const record = {
        t_video_ms: nonNegInt(args.t_video_ms),
        task_category: args.task_category,
        device: {
          type: cut(args.device.type, 40).toLowerCase(),
          brand: cut(args.device.brand || '', 40),
          model: cut(args.device.model || '', 40),
          id_confidence: clamp01(args.device.id_confidence),
        },
        step_id: args.step_id,
        instruction_given: cut(args.instruction_given || ''),
        observed_action: cut(args.observed_action),
        result: args.result,
        error_type,
        correction_given: cut(args.correction_given || ''),
        correction_worked: typeof args.correction_worked === 'boolean' ? args.correction_worked : null,
        visual_evidence: cut(args.visual_evidence || ''),
        guide_entry_used: /^D\d-\d{3}$/.test(args.guide_entry_used || '') ? args.guide_entry_used : null,
        confidence,
      };
      const { value, found } = redactObject(record);
      appendJsonl(paths.observations, {
        ...ctx(),
        obs_id: crypto.randomUUID(),
        consent: true,
        ...value,
        pii_redacted: found,
      });
      return { ok: true, ...(found.length ? { warning: `Personal info removed (${found.join(', ')}). Never log it.` } : {}) };
    },

    log_session(args = {}) {
      const refused = needConsent();
      if (refused) return refused;
      const errs = [];
      if (!TASK_CATEGORIES.includes(args.task_category)) errs.push('task_category invalid');
      if (!OUTCOMES.includes(args.outcome)) errs.push('outcome invalid');
      if (!OUTCOME_EVIDENCE.includes(args.outcome_evidence)) errs.push('outcome_evidence invalid');
      for (const k of ['steps_total', 'errors_total', 'first_try_success_steps']) {
        if (nonNegInt(args[k]) == null) errs.push(`${k} must be a non-negative integer`);
      }
      if (typeof args.safety_stop !== 'boolean') errs.push('safety_stop must be boolean');
      if (!errs.length && args.first_try_success_steps > args.steps_total) errs.push('first_try_success_steps > steps_total');
      if (errs.length) return { ok: false, error: errs.join('; ') };

      const record = {
        task_category: args.task_category,
        goal: cut(args.goal || '', 200),
        outcome: args.outcome,
        outcome_evidence: args.outcome_evidence,
        duration_s: nonNegInt(args.duration_s),
        steps_total: args.steps_total,
        errors_total: args.errors_total,
        first_try_success_steps: args.first_try_success_steps,
        manual_used: cut(args.manual_used || '', 120),
        safety_stop: args.safety_stop,
        caller_rating: Number.isInteger(args.caller_rating) && args.caller_rating >= 1 && args.caller_rating <= 5 ? args.caller_rating : null,
      };
      const { value, found } = redactObject(record);
      appendJsonl(paths.sessions, {
        ...ctx(),
        consent: true,
        flagged: false,
        ...value,
        pii_redacted: found,
        seq: sessionLogged ? 2 : 1, // curation uses the last summary per session
      });
      sessionLogged = true;
      return { ok: true };
    },

    lookup_manual({ brand = '', model = '', topic = '' } = {}) {
      return searchManuals(paths.manuals, { brand, model, topic });
    },

    show_card({ title, steps, image_hint } = {}) {
      if (typeof title !== 'string' || !title) return { ok: false, error: 'title required' };
      if (!Array.isArray(steps) || !steps.length) return { ok: false, error: 'steps required' };
      const card = {
        title: cut(title, 60),
        steps: steps.slice(0, 6).map((s) => cut(String(s), 120)),
        image_hint: cut(image_hint || '', 40),
      };
      onCard(card);
      return { ok: true, shown: card };
    },
  };

  /** Single entry point for any model runtime: dispatch(name, args) -> JSON-safe result. */
  async function dispatch(name, args) {
    const fn = handlers[name];
    if (!fn) return { ok: false, error: `Unknown tool ${name}` };
    try {
      return await fn(args ?? {});
    } catch (err) {
      return { ok: false, error: `Tool failed: ${err.message}` };
    }
  }

  return { handlers, dispatch, getConsent: () => consent };
}
