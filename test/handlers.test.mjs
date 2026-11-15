import assert from 'node:assert/strict';
import test from 'node:test';
import { readJsonl } from '../src/jsonl.mjs';
import { createToolHandlers, hashCaller } from '../src/tools/handlers.mjs';
import { sandbox } from './helpers.mjs';

const obs = {
  t_video_ms: 1000, task_category: 'cabling', device: { type: 'monitor' }, step_id: 'connect_video_cable',
  observed_action: 'Cable in DP port', result: 'incorrect', error_type: 'wrong_port',
  correction_given: 'Use HDMI 1', correction_worked: true, confidence: 0.9,
};

test('logging is refused before and without consent', () => {
  const paths = sandbox();
  const h = createToolHandlers({ sessionId: 's1', callerId: hashCaller('x'), guideVersion: 1, paths });
  assert.equal(h.handlers.log_observation(obs).ok, false);
  h.handlers.record_consent({ granted: false });
  assert.equal(h.handlers.log_observation(obs).ok, false);
  assert.equal(readJsonl(paths.observations).length, 0);
});

test('identity comes from context, PII is redacted, bad input rejected', () => {
  const paths = sandbox();
  const h = createToolHandlers({ sessionId: 's2', callerId: hashCaller('+18175550142'), guideVersion: 3, paths });
  h.handlers.record_consent({ granted: true });
  const r = h.handlers.log_observation({ ...obs, session_id: 'spoofed', observed_action: 'Screen shows password: hunter2pass' });
  assert.equal(r.ok, true);
  assert.match(r.warning, /secret/);
  const [rec] = readJsonl(paths.observations);
  assert.equal(rec.session_id, 's2');
  assert.equal(rec.guide_version, 3);
  assert.doesNotMatch(JSON.stringify(rec), /hunter2pass|8175550142/);
  assert.deepEqual(rec.pii_redacted, ['secret']);

  assert.equal(h.handlers.log_observation({ ...obs, error_type: 'made_up' }).ok, false);
  assert.equal(h.handlers.log_observation({ ...obs, result: 'great' }).ok, false);
  assert.equal(h.handlers.log_observation({ ...obs, step_id: 'Has Spaces' }).ok, false);
});

test('lookup_manual finds the demo manual and refuses unknown models', () => {
  const paths = sandbox();
  const h = createToolHandlers({ sessionId: 's3', callerId: 'c_x', guideVersion: 1, paths });
  const hit = h.handlers.lookup_manual({ brand: 'DemoCo', model: 'dm 24', topic: 'input source' });
  assert.equal(hit.found, true);
  assert.equal(hit.excerpts[0].page, 7);
  assert.equal(h.handlers.lookup_manual({ brand: 'X', model: 'nope', topic: 'x' }).found, false);
});

test('show_card validates and forwards to the video renderer', async () => {
  const paths = sandbox();
  const cards = [];
  const h = createToolHandlers({ sessionId: 's4', callerId: 'c_x', guideVersion: 1, paths, onCard: (c) => cards.push(c) });
  assert.equal((await h.dispatch('show_card', { title: 'Fix', steps: [] })).ok, false);
  assert.equal((await h.dispatch('show_card', { title: 'Fix', steps: ['a', 'b'], image_hint: 'hdmi_vs_dp' })).ok, true);
  assert.equal(cards[0].image_hint, 'hdmi_vs_dp');
  assert.equal((await h.dispatch('nope', {})).ok, false);
});
