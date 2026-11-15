import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = process.env.MENTOR_ROOT
  ? path.resolve(process.env.MENTOR_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function paths(root = ROOT) {
  const p = (...s) => path.join(root, ...s);
  return {
    root,
    guide: p('guide', 'GUIDE.md'),
    knowledge: p('guide', 'knowledge.json'),
    proposedGuide: p('guide', 'GUIDE.proposed.md'),
    versions: p('guide', 'versions'),
    changelog: p('guide', 'CHANGELOG.md'),
    observations: p('data', 'raw', 'observations.jsonl'),
    sessions: p('data', 'raw', 'sessions.jsonl'),
    episodes: p('data', 'episodes'),
    curation: p('data', 'curation'),
    state: p('data', 'curation', 'state.json'),
    rejectedLog: p('data', 'curation', 'rejected.log'),
    manuals: p('data', 'manuals'),
  };
}

const num = (name, dflt) => (process.env[name] ? Number(process.env[name]) : dflt);

// Thresholds from CURATION.md. Env overrides exist for small hackathon demos.
export const THRESHOLDS = {
  batchSessions: num('CURATE_BATCH_SESSIONS', 25),
  batchObservations: num('CURATE_BATCH_OBSERVATIONS', 200),
  minConfidence: 0.7,
  add: { sessions: 5, callers: 3, success: 0.8 },          // G2
  promote: { sessions: 15, success: 0.85 },                 // G3
  maxCallerShare: 0.2,                                      // G4
  seedOverwriteSessions: 30,                                // G5 for seed entries with no evidence
  deprecateBelow: 0.6,
  deprecateWindow: 10,
  maxPartDWords: 2500,                                      // G10
  dupSimilarity: 0.6,                                       // G11
  maxFieldChars: 400,
  rollbackWindow: num('ROLLBACK_WINDOW', 25),
  rollbackDropPts: 10,
};

export const CATEGORIES = {
  D1: 'Cabling and displays',
  D2: 'Networking',
  D3: 'PC hardware',
  D4: 'Device setup and configuration',
};

export const TASK_CATEGORIES = ['troubleshoot', 'install', 'configure', 'cabling', 'manual_lookup'];
export const RESULTS = ['correct', 'incorrect', 'partial', 'unverifiable'];
export const OUTCOMES = ['resolved', 'partially_resolved', 'unresolved', 'referred_to_pro', 'abandoned'];
export const OUTCOME_EVIDENCE = ['seen', 'caller_confirmed', 'none'];
export const ERROR_TYPES = [
  'wrong_port', 'not_seated', 'wrong_cable', 'wrong_orientation', 'no_power',
  'wrong_input_source', 'wrong_setting', 'skipped_step', 'wrong_order',
  'misidentified_part', 'missing_part', 'damaged_part', 'firmware_software',
];
export const isValidErrorType = (e) =>
  e == null || ERROR_TYPES.includes(e) || /^other:[a-z0-9_ -]{1,60}$/i.test(e);

/** Local calendar date (YYYY-MM-DD), not UTC. */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
