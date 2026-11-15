// Error log: every failure from the call server, the FaceTime bridge and the Chert worker goes to
// data/raw/errors.jsonl, and to the MongoDB `errors` collection when MONGODB_URI is set.
// Only event metadata is stored (type, session, room, tool name, message); text is PII-redacted anyway.
import crypto from 'node:crypto';
import { paths as getPaths } from './config.mjs';
import { appendJsonl } from './jsonl.mjs';
import { defaultMirror } from './mirror.mjs';
import { redactText } from './pii.mjs';

// A call that ended for one of these reasons is a failure, not a hang-up.
const FAILED_END = /^(agent |room disconnected)/;

/** True for log events that describe a failure. */
export function isErrorEvent(e) {
  if (!e) return false;
  if (e.error) return true;
  if (e.type === 'error' || e.type === 'start_failed') return true;
  return e.type === 'call_end' && FAILED_END.test(e.reason || '');
}

/**
 * Store one error. Never throws: logging must not break a call.
 * @param {string} source  'server' | 'bridge' | 'chert-worker' | ...
 * @param {{ type?: string, sessionId?: string, room?: string, name?: string, error?: string, reason?: string }} e
 */
export function recordError(source, e, { paths = getPaths(), mirror = defaultMirror, now = () => new Date().toISOString() } = {}) {
  try {
    const record = {
      error_id: crypto.randomUUID(),
      ts: now(),
      source,
      type: e.type || 'error',
      session_id: e.sessionId || null,
      room: e.room || null,
      name: e.name || null,
      message: redactText(String(e.error || e.reason || e.type || 'unknown').slice(0, 1000)).text,
    };
    appendJsonl(paths.errors, record);
    mirror.record('errors', record);
    return record;
  } catch (err) {
    console.error(`error log failed: ${err.message}`);
    return null;
  }
}

/** Wrap a log function so failures are also stored. */
export function withErrorLog(source, log, opts) {
  return (e) => {
    log(e);
    if (isErrorEvent(e)) recordError(source, e, opts);
  };
}

/** Store crashes that no handler caught, then let the process exit as it would have. */
export function captureProcessErrors(source, opts) {
  process.on('uncaughtExceptionMonitor', (err) => recordError(source, { type: 'uncaught_exception', error: err?.stack || String(err) }, opts));
  process.on('unhandledRejection', (err) => recordError(source, { type: 'unhandled_rejection', error: err?.stack || String(err) }, opts));
}
