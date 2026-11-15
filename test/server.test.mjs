import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { createCallServer } from '../src/server.mjs';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const tag = (kind, body) => Buffer.concat([Buffer.from([kind]), body]);

/** Fake Live session: records what the server forwards and answers like the real one. */
function fakeSession(calls) {
  return async (opts) => {
    const s = { opts, frames: [], audio: [], texts: [], audioEnds: 0, closed: false };
    calls.push(s);
    return {
      sendFrame: (b) => { s.frames.push(Buffer.from(b)); opts.onAudio(Buffer.from([1, 0, 2, 0])); },
      sendAudio: (b) => s.audio.push(Buffer.from(b)),
      sendText: (t) => {
        s.texts.push(t);
        opts.onTranscript({ role: 'agent', text: 'Hi, I am Genesis.' });
        opts.onCard({ title: 'Fix', steps: ['Use HDMI 1'] });
        opts.onEvent({ type: 'tool_call', name: 'log_observation', args: { secret: 'caller detail' } });
      },
      endAudio: () => { s.audioEnds++; },
      close: () => { s.closed = true; },
    };
  };
}

async function withServer(startSession, fn) {
  const server = createCallServer({ startSession });
  server.listen(0);
  await once(server, 'listening');
  const base = `127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

function client(base) {
  const ws = new WebSocket(`ws://${base}/ws`);
  const json = [];
  const binary = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) binary.push(Buffer.from(data)); else json.push(JSON.parse(String(data)));
    waiters.splice(0).forEach((w) => w());
  });
  const until = async (pred, ms = 2000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('timed out waiting for server message');
      await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  return { ws, json, binary, until };
}

test('call server bridges frames, audio, text and cards; validates input; closes the session', async () => {
  const calls = [];
  await withServer(fakeSession(calls), async (base) => {
    const c = client(base);
    await c.until(() => c.json.some((m) => m.type === 'ready'));

    c.ws.send(tag(0x01, JPEG));
    c.ws.send(tag(0x01, Buffer.from('not a jpeg')));      // rejected: no JPEG magic
    c.ws.send(tag(0x02, Buffer.alloc(640)));
    c.ws.send(tag(0x02, Buffer.alloc(3)));                 // rejected: odd length
    c.ws.send(tag(0x07, Buffer.alloc(10)));                // rejected: unknown kind
    c.ws.send(JSON.stringify({ type: 'audio_end' }));
    c.ws.send('not json');                                 // ignored
    c.ws.send(JSON.stringify({ type: 'text', text: 'my monitor says no signal' }));

    await c.until(() => c.json.some((m) => m.type === 'card') && c.binary.length > 0);
    const s = calls[0];
    assert.equal(s.frames.length, 1);
    assert.deepEqual(s.frames[0], JPEG);
    assert.equal(s.audio.length, 1);
    assert.equal(s.audio[0].length, 640);
    assert.equal(s.audioEnds, 1);
    assert.deepEqual(s.texts, ['my monitor says no signal']);
    assert.deepEqual(c.binary[0], Buffer.from([1, 0, 2, 0]));
    assert.deepEqual(c.json.find((m) => m.type === 'card').card, { title: 'Fix', steps: ['Use HDMI 1'] });
    assert.ok(c.json.some((m) => m.type === 'transcript' && m.role === 'agent'));

    // Tool args never reach the browser.
    const ev = c.json.find((m) => m.type === 'event');
    assert.deepEqual(ev, { type: 'event', event: 'tool_call', name: 'log_observation' });
    assert.ok(!JSON.stringify(c.json).includes('caller detail'));

    c.ws.close();
    await c.until(() => s.closed);
  });
});

test('a failed agent start reports an error and closes the socket', async () => {
  await withServer(async () => { throw new Error('no key'); }, async (base) => {
    const c = client(base);
    await once(c.ws, 'close');
    assert.match(c.json[0].error, /no key/);
  });
});

test('static files are served and path traversal is refused', async () => {
  await withServer(fakeSession([]), async (base) => {
    const page = await fetch(`http://${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Genesis Call<\/title>/);
    assert.equal((await fetch(`http://${base}/..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`http://${base}/%2e%2e/.env.example`)).status, 404);
    assert.equal((await fetch(`http://${base}/missing.html`)).status, 404);
  });
});
