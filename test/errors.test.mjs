import assert from 'node:assert/strict';
import test from 'node:test';
import { isErrorEvent, recordError, withErrorLog } from '../src/errors.mjs';
import { readJsonl } from '../src/jsonl.mjs';
import { sandbox } from './helpers.mjs';

const fakeMirror = () => { const rows = []; return { rows, record: (kind, rec) => rows.push({ kind, rec }) }; };

test('isErrorEvent: failures yes, normal call events no', () => {
  assert.equal(isErrorEvent({ type: 'error', error: 'boom' }), true);
  assert.equal(isErrorEvent({ type: 'start_failed' }), true);
  assert.equal(isErrorEvent({ type: 'tool_result', error: 'bad args' }), true);
  assert.equal(isErrorEvent({ type: 'call_end', reason: 'agent session closed: network' }), true);
  assert.equal(isErrorEvent({ type: 'call_end', reason: 'room disconnected: 3' }), true);
  assert.equal(isErrorEvent({ type: 'call_end', reason: 'caller hung up' }), false);
  assert.equal(isErrorEvent({ type: 'call_end', reason: 'silence timeout' }), false);
  assert.equal(isErrorEvent({ type: 'call_start' }), false);
});

test('errors go to errors.jsonl and the database mirror, with personal details removed', () => {
  const paths = sandbox();
  const mirror = fakeMirror();
  const seen = [];
  const log = withErrorLog('bridge', (e) => seen.push(e), { paths, mirror, now: () => '2026-11-15T10:00:00.000Z' });

  log({ type: 'call_start', sessionId: 's1' });
  log({ type: 'error', sessionId: 's1', room: 'call-1', error: 'frame: could not reach jo@example.com' });
  log({ type: 'call_end', sessionId: 's1', reason: 'agent failed to start: no key' });

  assert.equal(seen.length, 3, 'the wrapped log still gets every event');
  const rows = readJsonl(paths.errors);
  assert.equal(rows.length, 2);
  assert.deepEqual({ ...rows[0], error_id: undefined }, {
    error_id: undefined, ts: '2026-11-15T10:00:00.000Z', source: 'bridge', type: 'error',
    session_id: 's1', room: 'call-1', name: null, message: 'frame: could not reach [REDACTED:email]',
  });
  assert.equal(rows[1].type, 'call_end');
  assert.equal(rows[1].message, 'agent failed to start: no key');
  assert.deepEqual(mirror.rows.map((r) => r.kind), ['errors', 'errors']);
  assert.equal(mirror.rows[0].rec.error_id, rows[0].error_id);
});

test('recordError never throws, even when storage fails', () => {
  const paths = sandbox();
  const mirror = { record() { throw new Error('db down'); } };
  const origError = console.error;
  console.error = () => {};
  try { assert.equal(recordError('server', { type: 'error', error: 'x' }, { paths, mirror }), null); }
  finally { console.error = origError; }
});
