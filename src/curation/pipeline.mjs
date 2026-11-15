// Orchestrates one curation batch: filter -> aggregate -> propose -> gates -> apply -> artifacts.
// Never touches GUIDE.md / knowledge.json; it only writes proposals for human review.
import fs from 'node:fs';
import path from 'node:path';
import { THRESHOLDS } from '../config.mjs';
import { localDate } from '../config.mjs';
import { ensureDir, readJson, readJsonl, writeJson, writeJsonl, appendJsonl } from '../jsonl.mjs';
import { fixedPartsHash, loadKnowledge, readGuide } from '../knowledge.mjs';
import { loadManuals } from '../manuals.mjs';
import { aggregateEntryUsage, aggregateGroups, globalMetrics, topErrorTypes } from './aggregate.mjs';
import { applyProposals, lineDiff, renderProposedGuide } from './apply.mjs';
import { filterRecords, latestSessions, summarizeDrops } from './filter.mjs';
import { checkSafetyLLM, checkSync } from './gates.mjs';
import { proposeDeprecations, proposeOffline, proposeWithLLM } from './propose.mjs';
import { renderReport } from './report.mjs';

export const loadState = (p) => readJson(p.state, { processed_session_ids: [], batches: [], evaluated_versions: {} });
export const saveState = (p, s) => writeJson(p.state, s);

export function extractPartA(guideText) {
  const s = guideText.indexOf('## Part A');
  const e = guideText.indexOf('## Part B');
  return s >= 0 && e > s ? guideText.slice(s, e).trim() : '';
}

export async function runCuration({ paths, gemini = null, force = false, offline = false, allowNoClassifier = false, today = localDate(), log = console.log }) {
  const state = loadState(paths);
  const knowledge = loadKnowledge(paths.knowledge);
  const guideText = readGuide(paths.guide);
  const observations = readJsonl(paths.observations);
  const sessionsRaw = readJsonl(paths.sessions);

  const processed = new Set(state.processed_session_ids);
  const allSessions = [...latestSessions(sessionsRaw).values()];
  const newSessionIds = allSessions.filter((s) => !processed.has(s.session_id)).map((s) => s.session_id);
  const newSet = new Set(newSessionIds);
  const newObsCount = observations.filter((o) => newSet.has(o.session_id)).length;

  if (!force && newSessionIds.length < THRESHOLDS.batchSessions && newObsCount < THRESHOLDS.batchObservations) {
    return { skipped: true, reason: `Not enough new data: ${newSessionIds.length}/${THRESHOLDS.batchSessions} sessions, ${newObsCount}/${THRESHOLDS.batchObservations} observations. Use --force to run anyway.` };
  }

  const batch = knowledge.meta.last_batch + 1;
  const dir = path.join(paths.curation, `batch-${batch}`);
  ensureDir(dir);

  // 1 Filter (cumulative: evidence accrues across batches)
  const f = filterRecords({ observations, sessions: sessionsRaw });
  // 2 Aggregate
  const groups = aggregateGroups(f.curation);
  const usage = aggregateEntryUsage(f.curation);
  const newSessions = f.sessions.filter((s) => newSet.has(s.session_id));
  const metrics = globalMetrics(newSessions);
  const errors = topErrorTypes(f.curation.filter((o) => newSet.has(o.session_id)));

  // Training dataset export (new sessions only; mistakes kept as labeled negatives)
  const episodes = f.training
    .filter((o) => newSet.has(o.session_id))
    .map(({ caller_id, consent, pii_redacted, ...o }) => ({
      ...o,
      label: o.result === 'correct' ? 'correct_action' : 'error',
      use: o.result === 'correct' ? 'positive_example' : 'negative_example_do_not_imitate',
    }));
  writeJsonl(path.join(paths.episodes, `batch-${batch}.jsonl`), episodes);

  // 3 Propose
  let mode = 'offline';
  let proposals;
  if (gemini && !offline) {
    try {
      proposals = await proposeWithLLM(gemini, groups, knowledge);
      mode = `llm (proposer ${gemini.modelFor('fast')}, safety ${gemini.modelFor('strong')})`;
    } catch (err) {
      log(`LLM proposer failed (${err.message}); falling back to offline proposer.`);
      proposals = proposeOffline(groups, knowledge);
    }
  } else {
    proposals = proposeOffline(groups, knowledge);
  }
  proposals = [...proposals, ...proposeDeprecations(knowledge, usage)];

  // 4 Gates
  const partA = extractPartA(guideText);
  const manuals = loadManuals(paths.manuals);
  const manualsForDevice = (type) =>
    manuals.filter((m) => m.device_type && m.device_type === type).flatMap((m) => m.sections.map((s) => ({ manual: m.title, page: s.page, text: s.text })));
  const accepted = [];
  const rejected = [];
  const notes = [];
  for (const p of proposals) {
    const failures = checkSync(p, { knowledge, groups, usage, batch });
    if (!failures.length) {
      const r = await checkSafetyLLM(p, { knowledge, gemini: offline ? null : gemini, partA, manualsForDevice, allowNoClassifier });
      failures.push(...r.fail);
      if (r.note) notes.push(`${p.op} ${p.entry_id || p.title}: ${r.note}`);
    }
    if (failures.length) rejected.push({ proposal: p, failures });
    else accepted.push(p);
  }

  // 5 Apply to a copy + render proposal
  const { knowledge: proposedK, applied, rejected: sizeRejected } = applyProposals(knowledge, accepted, { groups, usage, batch, today });
  rejected.push(...sizeRejected);
  proposedK.meta.sessions_included = knowledge.meta.sessions_included + newSessionIds.length;
  const proposedGuide = renderProposedGuide(guideText, proposedK);
  const diff = lineDiff(guideText.replace(/\r\n/g, '\n'), proposedGuide.replace(/\r\n/g, '\n'));

  for (const r of rejected) {
    appendJsonl(paths.rejectedLog, { batch, ts: new Date().toISOString(), proposal: r.proposal, failures: r.failures });
  }

  const meta = {
    batch, created: new Date().toISOString(), mode, status: 'proposed',
    base_version: knowledge.meta.version, proposed_version: proposedK.meta.version,
    fixed_parts_hash: fixedPartsHash(guideText),
    new_session_ids: newSessionIds,
    counts: {
      new_sessions: newSessionIds.length, new_observations: newObsCount,
      kept_for_curation: f.curation.length, training_episodes: episodes.length,
      dropped: summarizeDrops(f.dropped.filter((d) => newSet.has(d.session_id))),
      safety_review: f.review.filter((o) => newSet.has(o.session_id)).length,
    },
  };
  const report = renderReport({ meta, metrics, errors, applied, rejected, notes, groups });

  writeJson(path.join(dir, 'meta.json'), meta);
  writeJson(path.join(dir, 'aggregates.json'), { groups, usage, metrics, errors });
  writeJson(path.join(dir, 'proposals.json'), proposals);
  writeJson(path.join(dir, 'accepted.json'), applied);
  writeJson(path.join(dir, 'rejected.json'), rejected);
  writeJson(path.join(dir, 'knowledge.proposed.json'), proposedK);
  fs.writeFileSync(path.join(dir, 'diff.txt'), diff, 'utf8');
  fs.writeFileSync(path.join(dir, 'report.md'), report, 'utf8');
  fs.writeFileSync(paths.proposedGuide, proposedGuide, 'utf8');

  state.batches = [...state.batches.filter((b) => b.batch !== batch), { batch, status: 'proposed', created: meta.created }];
  saveState(paths, state);

  return { skipped: false, batch, dir, meta, applied, rejected, report };
}
