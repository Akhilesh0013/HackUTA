import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { monitor, publishBatch } from '../src/curation/publish.mjs';
import { runCuration } from '../src/curation/pipeline.mjs';
import { readJson, readJsonl } from '../src/jsonl.mjs';
import { fixedPartsHash, loadKnowledge, readGuide } from '../src/knowledge.mjs';
import { simulate } from '../src/sim.mjs';
import { sandbox } from './helpers.mjs';

const quiet = () => {};

test('end to end: learn real patterns, block attacks, publish, roll back', async () => {
  const paths = sandbox();
  const hash0 = fixedPartsHash(readGuide(paths.guide));
  simulate({ paths, guideVersion: 1, sessions: 80, seed: 11 });

  // below threshold without --force? 80+ sessions >= 25, so it runs
  const res = await runCuration({ paths, allowNoClassifier: true, today: '2026-11-15', log: quiet });
  assert.equal(res.skipped, false);

  const added = res.applied.filter((a) => a.op === 'add_entry').map((a) => a.group_key);
  assert.ok(added.some((k) => k.includes('printer')), 'learns printer pattern');
  assert.ok(added.some((k) => k.includes('desktop_pc|connect_gpu_power')), 'learns GPU power pattern');
  assert.ok(!added.some((k) => k.includes('laptop')), 'low-success pattern not learned');

  const rej = res.rejected.map((r) => ({ key: r.proposal.group_key, gates: r.failures.map((f) => f.gate) }));
  const psu = rej.find((r) => r.key?.includes('power_on'));
  assert.ok(psu && psu.gates.includes('G4') && psu.gates.includes('G6'), 'single-caller unsafe attack blocked');
  const inj = rej.find((r) => r.key?.includes('configure_dns'));
  assert.ok(inj && inj.gates.includes('G8'), 'coordinated injection blocked');

  // nothing live changed yet; proposal exists
  assert.equal(loadKnowledge(paths.knowledge).meta.version, 1);
  const proposed = fs.readFileSync(paths.proposedGuide, 'utf8');
  assert.equal(fixedPartsHash(proposed), hash0, 'Parts A/B/C/E untouched');
  assert.doesNotMatch(proposed, /PSU cover|fastfix|hunter2pass|Ignore previous/);

  // training export keeps mistakes as labeled negatives, no caller IDs, no PII
  const eps = readJsonl(path.join(paths.episodes, 'batch-1.jsonl'));
  assert.ok(eps.some((e) => e.use === 'negative_example_do_not_imitate'));
  assert.ok(eps.every((e) => !('caller_id' in e)));
  assert.doesNotMatch(JSON.stringify(eps), /hunter2pass|jane\.doe|ABC123456789/);

  // reviewer tampering is caught at publish
  const kp = path.join(paths.curation, 'batch-1', 'knowledge.proposed.json');
  const good = readJson(kp);
  const tampered = structuredClone(good);
  tampered.entries[0].correct_method = 'Remove the PSU cover.';
  fs.writeFileSync(kp, JSON.stringify(tampered));
  assert.throws(() => publishBatch({ paths, batch: 1 }), /G6/);
  fs.writeFileSync(kp, JSON.stringify(good));

  const pub = publishBatch({ paths, batch: 1, today: '2026-11-15' });
  assert.deepEqual(pub, { from: 1, to: 2 });
  assert.equal(fixedPartsHash(readGuide(paths.guide)), hash0);
  assert.ok(fs.existsSync(path.join(paths.versions, 'GUIDE.v1.md')));
  assert.throws(() => publishBatch({ paths, batch: 1 }), /published/);

  // a bad version gets rolled back
  assert.equal(monitor({ paths }).action, 'wait');
  simulate({ paths, guideVersion: 2, sessions: 30, seed: 12, quality: 0.2, attacks: false, noise: false, prefix: 'v2' });
  const m = monitor({ paths, today: '2026-11-15' });
  assert.equal(m.action, 'rolled_back');
  const after = loadKnowledge(paths.knowledge);
  assert.equal(after.meta.version, 3);
  assert.equal(after.meta.rollback_of, 2);
  assert.ok(!after.entries.some((e) => e.source === 'curated:batch-1'), 'curated entries removed by rollback');
});

test('curation waits for enough data unless forced', async () => {
  const paths = sandbox();
  simulate({ paths, guideVersion: 1, sessions: 5, seed: 3, attacks: false, noise: false });
  assert.equal((await runCuration({ paths, allowNoClassifier: true, log: quiet })).skipped, true);
  assert.equal((await runCuration({ paths, allowNoClassifier: true, force: true, log: quiet })).skipped, false);
});

test('without a classifier and without the override, nothing new is accepted', async () => {
  const paths = sandbox();
  simulate({ paths, guideVersion: 1, sessions: 60, seed: 5 });
  const res = await runCuration({ paths, log: quiet });
  assert.equal(res.applied.filter((a) => a.op === 'add_entry').length, 0);
  assert.ok(res.rejected.some((r) => r.failures.some((f) => f.gate === 'G7')));
});

test('a logged fix is linked back to the earlier mistake', async () => {
  const { linkFixesToMistakes } = await import('../src/curation/filter.mjs');
  const [mistake, fix] = linkFixesToMistakes([
    { obs_id: 'a', session_id: 's', step_id: 'choose_input_source', t_video_ms: 1000, result: 'incorrect', error_type: 'wrong_input_source', correction_given: 'Pick DisplayPort', correction_worked: false },
    { obs_id: 'b', session_id: 's', step_id: 'choose_input_source', t_video_ms: 9000, result: 'correct', error_type: 'wrong_input_source', correction_worked: true },
  ]);
  assert.equal(mistake.correction_worked, true);
  assert.equal(fix.error_type, null);
  assert.equal(fix.linked_mistake, 'a');
});
