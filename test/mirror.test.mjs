import assert from 'node:assert/strict';
import test from 'node:test';
import { readJsonl } from '../src/jsonl.mjs';
import { createMirror } from '../src/mirror.mjs';
import { createToolHandlers, hashCaller } from '../src/tools/handlers.mjs';
import { sandbox } from './helpers.mjs';

/** In-memory stand-in for a MongoClient. */
function fakeMongo() {
  const store = { observations: new Map(), sessions: new Map(), consent: [] };
  const state = { connects: 0, closed: false, dbName: null };
  const coll = (name) => ({
    async updateOne(filter, update, opts) {
      assert.equal(opts.upsert, true);
      if (!store[name].has(filter._id)) store[name].set(filter._id, update.$setOnInsert);
    },
    async replaceOne(filter, doc, opts) {
      assert.equal(opts.upsert, true);
      store[name].set(filter._id, doc);
    },
    async insertOne(doc) { store[name].push(doc); },
  });
  const connect = async () => {
    state.connects++;
    return { db: (n) => { state.dbName = n; return { collection: coll }; }, close: async () => { state.closed = true; } };
  };
  return { store, state, connect };
}

const obs = {
  t_video_ms: 1000, task_category: 'cabling', device: { type: 'monitor' }, step_id: 'connect_video_cable',
  observed_action: 'Cable in DP port, email me at jo@example.com', result: 'incorrect', error_type: 'wrong_port',
  correction_given: 'Use HDMI 1', correction_worked: true, confidence: 0.9,
};
const summary = {
  task_category: 'cabling', goal: 'Monitor no signal', outcome: 'resolved', outcome_evidence: 'seen',
  steps_total: 2, errors_total: 1, first_try_success_steps: 1, safety_stop: false,
};

test('mirror is off without MONGODB_URI', async () => {
  const m = createMirror({ uri: '' });
  assert.equal(m.enabled, false);
  m.record('observations', {});
  await m.flush();
});

test('handlers mirror consent, redacted observations and the latest session summary', async () => {
  const paths = sandbox();
  const fake = fakeMongo();
  const mirror = createMirror({ uri: 'mongodb://fake', dbName: 'genesis-test', connect: fake.connect });
  const h = createToolHandlers({ sessionId: 's1', callerId: hashCaller('+18175550142'), guideVersion: 1, paths, mirror });

  assert.equal(h.handlers.log_observation(obs).ok, false); // refused before consent: nothing written anywhere
  h.handlers.record_consent({ granted: true });
  h.handlers.log_observation(obs);
  h.handlers.log_session(summary);
  h.handlers.log_session({ ...summary, outcome: 'partially_resolved' });
  await mirror.flush();

  assert.equal(fake.state.connects, 1);
  assert.equal(fake.state.dbName, 'genesis-test');
  assert.equal(fake.store.consent.length, 1);

  const [o] = [...fake.store.observations.values()];
  const [fileObs] = readJsonl(paths.observations);
  assert.equal(o._id, fileObs.obs_id);
  assert.ok(!JSON.stringify(o).includes('jo@example.com'), 'mirror gets the redacted record');
  assert.deepEqual({ ...o, _id: undefined }, { ...fileObs, _id: undefined });

  assert.equal(fake.store.sessions.size, 1, 'one document per call');
  assert.equal(fake.store.sessions.get('s1').outcome, 'partially_resolved');
  assert.equal(fake.store.sessions.get('s1').seq, 2);

  await mirror.close();
  assert.ok(fake.state.closed);
});

test('a down database never breaks a call, warns once, and reconnects later', async () => {
  const paths = sandbox();
  const warnings = [];
  let up = false;
  const fake = fakeMongo();
  const connect = async (uri) => { if (!up) throw new Error('ECONNREFUSED'); return fake.connect(uri); };
  const mirror = createMirror({ uri: 'mongodb://down', connect, warn: (m) => warnings.push(m) });
  const h = createToolHandlers({ sessionId: 's2', callerId: hashCaller('x'), guideVersion: 1, paths, mirror });

  h.handlers.record_consent({ granted: true });
  assert.equal(h.handlers.log_observation(obs).ok, true);
  assert.equal(h.handlers.log_observation(obs).ok, true);
  await mirror.flush();
  assert.equal(readJsonl(paths.observations).length, 2, 'JSONL still written');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ECONNREFUSED/);

  up = true;
  h.handlers.log_observation(obs);
  await mirror.flush();
  assert.equal(fake.store.observations.size, 1, 'writes resume once the database is back');
});
