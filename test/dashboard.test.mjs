import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { monitor, publishBatch } from '../src/curation/publish.mjs';
import { runCuration } from '../src/curation/pipeline.mjs';
import { getCall, guideInfo, latestCuration, listCalls, overview } from '../src/dashboard/api.mjs';
import { appendJsonl } from '../src/jsonl.mjs';
import { createCallServer } from '../src/server.mjs';
import { simulate } from '../src/sim.mjs';
import { sandbox } from './helpers.mjs';

const quiet = () => {};

/** Sandbox that went through learn → publish → bad calls → rollback, like the demo. */
async function curatedSandbox() {
  const paths = sandbox();
  simulate({ paths, guideVersion: 1, sessions: 80, seed: 11 });
  await runCuration({ paths, allowNoClassifier: true, today: '2026-11-15', log: quiet });
  publishBatch({ paths, batch: 1, today: '2026-11-15' });
  simulate({ paths, guideVersion: 2, sessions: 40, quality: 0.3, seed: 7, prefix: 'bad' });
  monitor({ paths, today: '2026-11-15' });
  return paths;
}

test('dashboard api: overview, calls, call detail, playbook history and curation', async () => {
  const paths = await curatedSandbox();

  const o = overview(paths);
  assert.equal(o.guide_version, 3); // rolled back to v1 content as v3
  assert.ok(o.metrics.sessions > 100);
  assert.deepEqual(o.by_version.map((v) => v.version), [1, 2]);
  assert.ok(o.by_version[1].resolution_rate_pct < o.by_version[0].resolution_rate_pct, 'bad batch shows the drop');
  assert.ok(o.top_errors.length > 0);

  const calls = listCalls(paths, 500);
  assert.equal(calls.length, o.metrics.sessions);
  assert.ok(calls.every((c) => !('caller_id' in c)), 'no caller ids in the API');

  const withSteps = calls.find((c) => c.observations > 1);
  const detail = getCall(paths, withSteps.session_id);
  assert.equal(detail.steps.length, withSteps.observations);
  assert.ok(detail.steps.every((s, i) => i === 0 || s.t_video_ms >= detail.steps[i - 1].t_video_ms), 'steps in video order');
  assert.ok(detail.steps.every((s) => !('caller_id' in s)));
  assert.equal(getCall(paths, 'nope'), null);

  const g = guideInfo(paths);
  assert.deepEqual(g.versions, [1, 2]);
  assert.equal(g.changelog.length, 2);
  assert.equal(g.changelog[0].rollback, false);
  assert.equal(g.changelog[1].rollback, true);
  assert.ok(g.entries.length > 0);

  const c = latestCuration(paths);
  assert.equal(c.latest.batch, 1);
  assert.equal(c.latest.status, 'rolled_back');
  assert.ok(c.latest.accepted.length > 0);
  assert.ok(c.latest.rejected.some((r) => r.failures.some((f) => f.gate === 'G6')), 'unsafe advice shows as blocked');
});

test('dashboard api: a call with steps but no summary yet is in progress; empty data is fine', () => {
  const paths = sandbox();
  assert.deepEqual(listCalls(paths), []);
  assert.equal(overview(paths).metrics.sessions, 0);
  assert.equal(latestCuration(paths).latest, null);
  assert.deepEqual(guideInfo(paths).changelog, []);

  appendJsonl(paths.observations, { session_id: 'live-1', caller_id: 'c_x', guide_version: 1, ts: '2026-11-15T10:00:00Z', task_category: 'cabling', step_id: 'a', observed_action: 'x', result: 'correct', t_video_ms: 1 });
  const [call] = listCalls(paths);
  assert.equal(call.status, 'in_progress');
  assert.equal(getCall(paths, 'live-1').session, null);
});

async function listen(server) {
  server.listen(0);
  await once(server, 'listening');
  return `127.0.0.1:${server.address().port}`;
}

test('dashboard http: endpoints, token, and live events over SSE', async () => {
  const paths = await curatedSandbox();
  const fakeStart = async (opts) => ({
    sendFrame() {}, sendAudio() {}, endAudio() {}, close() {},
    sendText() {
      opts.onCard({ title: 'Fix', steps: ['Use HDMI 1'] });
      opts.onEvent({ type: 'tool_call', name: 'log_observation', args: { observed_action: 'secret detail' } });
    },
  });
  const server = createCallServer({ paths, startSession: fakeStart, dashboardToken: 's3cret' });
  const base = await listen(server);
  try {
    assert.equal((await fetch(`http://${base}/api/overview`)).status, 401);
    assert.equal((await fetch(`http://${base}/api/overview?token=wrong`)).status, 401);
    const auth = { headers: { Authorization: 'Bearer s3cret' } };
    const ov = await (await fetch(`http://${base}/api/overview`, auth)).json();
    assert.equal(ov.guide_version, 3);
    const calls = await (await fetch(`http://${base}/api/calls?token=s3cret&limit=5`)).json();
    assert.equal(calls.length, 5);
    assert.equal((await fetch(`http://${base}/api/calls/${calls[0].session_id}?token=s3cret`)).status, 200);
    assert.equal((await fetch(`http://${base}/api/calls/missing?token=s3cret`)).status, 404);
    assert.equal((await fetch(`http://${base}/api/nope?token=s3cret`)).status, 404);
    assert.equal((await fetch(`http://${base}/api/guide`, { ...auth, method: 'POST' })).status, 405);
    assert.equal((await fetch(`http://${base}/dashboard.html`)).status, 200); // the page itself has no data

    // SSE: a browser call's card and tool events reach the dashboard, tool args do not.
    const ac = new AbortController();
    const stream = await fetch(`http://${base}/api/stream?token=s3cret`, { signal: ac.signal });
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    const ws = new WebSocket(`ws://${base}/ws`);
    ws.on('message', (d, bin) => { if (!bin && JSON.parse(String(d)).type === 'ready') ws.send(JSON.stringify({ type: 'text', text: 'hi' })); });
    let text = '';
    const end = Date.now() + 3000;
    while (!(text.includes('"card"') && text.includes('log_observation')) && Date.now() < end) {
      text += new TextDecoder().decode((await reader.read()).value);
    }
    assert.match(text, /"type":"call_start"/);
    assert.match(text, /"type":"card".*"Use HDMI 1"/);
    assert.match(text, /"type":"tool_call","sessionId":"[^"]+","name":"log_observation"/);
    assert.ok(!text.includes('secret detail'));
    ws.close();
    ac.abort();
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
