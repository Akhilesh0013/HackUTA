import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import sharp from 'sharp';
import { bridgeRoom } from '../src/bridge/livekit.mjs';
import { PcmChunker, cardSvg, cardToRgba, rgbaToJpeg, rms } from '../src/bridge/media.mjs';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timed out'); await tick(); }
}

// ---- media ----

test('rgbaToJpeg downscales caller video to a 512 px JPEG', async () => {
  const width = 1280, height = 720;
  const jpeg = await rgbaToJpeg({ data: new Uint8Array(width * height * 4).fill(200), width, height });
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  const meta = await sharp(jpeg).metadata();
  assert.equal(meta.width, 512);
  assert.equal(meta.height, 288);
});

test('cards render to 1280x720 RGBA and escape untrusted text', async () => {
  const px = await cardToRgba({ title: 'Fix <script>', steps: ['Use HDMI 1 & check "input"', 'Power on'] });
  assert.equal(px.length, 1280 * 720 * 4);
  const svg = cardSvg({ title: '<b>x</b>', steps: ['a & b'] });
  assert.ok(!svg.includes('<b>'));
  assert.ok(svg.includes('&lt;b&gt;') && svg.includes('a &amp; b'));
  assert.equal((await cardToRgba(null)).length, 1280 * 720 * 4); // idle screen
});

test('PcmChunker emits fixed frames and carries the remainder', () => {
  const c = new PcmChunker(240);
  assert.equal(c.push(Buffer.alloc(300)).length, 0);       // 150 samples
  const out = c.push(Buffer.alloc(500));                    // +250 = 400 samples → 1 frame, 160 left
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 240);
  assert.equal(c.push(Buffer.alloc(160)).length, 1);        // 160 + 80 = 240
  assert.equal(rms(new Int16Array([3, -4, 3, -4])) > 3, true);
});

// ---- bridge with fake LiveKit + fake Gemini ----

/** Async-iterable stream fed by the test. */
class FakeStream {
  constructor() { this.items = []; this.waiting = null; this.closed = false; }
  push(x) { this.items.push(x); this.waiting?.(); }
  close() { this.closed = true; this.waiting?.(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length) { yield this.items.shift(); continue; }
      if (this.closed) return;
      await new Promise((r) => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

function fakeRtc() {
  const streams = { video: null, audio: null };
  const out = { voiceFrames: [], cardFrames: [], cleared: 0, published: [] };
  const rtc = {
    TrackKind: { KIND_AUDIO: 1, KIND_VIDEO: 2 },
    TrackSource: { SOURCE_CAMERA: 1, SOURCE_MICROPHONE: 2 },
    VideoBufferType: { RGBA: 0 },
    TrackPublishOptions: class { constructor(o) { Object.assign(this, o); } },
    AudioFrame: class { constructor(data, rate, ch, n) { Object.assign(this, { data, rate, ch, n }); } },
    VideoFrame: class { constructor(data, w, h, type) { Object.assign(this, { data, w, h, type }); } },
    AudioSource: class {
      constructor(rate, ch) { Object.assign(this, { rate, ch }); }
      async captureFrame(f) { out.voiceFrames.push(f); }
      clearQueue() { out.cleared++; }
      async close() {}
    },
    VideoSource: class {
      captureFrame(f) { out.cardFrames.push(f); }
      async close() {}
    },
    LocalAudioTrack: { createAudioTrack: (name) => ({ name }) },
    LocalVideoTrack: { createVideoTrack: (name) => ({ name }) },
    VideoStream: class { constructor() { streams.video = new FakeStream(); return streams.video; } },
    AudioStream: class { constructor(track, opts) { out.audioOpts = opts; streams.audio = new FakeStream(); return streams.audio; } },
  };
  return { rtc, streams, out };
}

function fakeRoom() {
  const room = new EventEmitter();
  room.remoteParticipants = new Map();
  room.localParticipant = { publishTrack: async (track, opts) => { room.published.push({ name: track.name, source: opts.source }); } };
  room.published = [];
  room.disconnected = false;
  room.disconnect = async () => { room.disconnected = true; };
  return room;
}

function fakeSessions() {
  const sessions = [];
  const start = async (opts) => {
    const s = { opts, frames: [], audio: [], texts: [], closed: false };
    sessions.push(s);
    return {
      sendFrame: (b) => s.frames.push(b),
      sendAudio: (b) => s.audio.push(b),
      sendText: (t) => s.texts.push(t),
      close: () => { s.closed = true; },
    };
  };
  return { sessions, start };
}

const caller = { identity: '+18175550142' };
const rgbaFrame = { frame: { convert: () => ({ data: new Uint8Array(64 * 48 * 4).fill(90), width: 64, height: 48 }) } };

test('bridge: caller media in, agent voice and cards out, hang up ends the call', async () => {
  const { rtc, streams, out } = fakeRtc();
  const room = fakeRoom();
  const { sessions, start } = fakeSessions();
  const { done } = await bridgeRoom({ room, rtc, roomName: 'call-1', startSession: start, frameIntervalMs: 0, cardIntervalMs: 10_000 });

  assert.deepEqual(room.published, [{ name: 'genesis-voice', source: 2 }, { name: 'genesis-cards', source: 1 }]);
  assert.equal(out.cardFrames.length, 1); // idle card pushed straight away

  // Caller tracks arrive. The agent's own tracks are ignored.
  room.emit('trackSubscribed', { kind: 2, name: 'genesis-cards' }, {}, { identity: 'genesis' });
  room.remoteParticipants.set(caller.identity, caller);
  room.emit('trackSubscribed', { kind: 2, name: 'facetime-remote-video' }, {}, caller);
  room.emit('trackSubscribed', { kind: 1, name: 'facetime-remote-audio' }, {}, caller);
  const s = sessions[0];
  assert.deepEqual(s.texts, ['Hi, I just called.']); // greeted once, not per track
  assert.deepEqual(out.audioOpts, { sampleRate: 16000, numChannels: 1 });
  assert.notEqual(s.opts.callerId, caller.identity); // caller id is hashed

  streams.video.push(rgbaFrame);
  streams.audio.push({ data: new Int16Array(160).fill(1000) });
  await until(() => s.frames.length === 1 && s.audio.length === 1);
  assert.equal(s.frames[0][0], 0xff);
  assert.equal(s.audio[0].length, 320);

  // Agent speaks 25 ms of audio → two 10 ms frames now, 5 ms carried.
  s.opts.onAudio(Buffer.alloc(600 * 2));
  await until(() => out.voiceFrames.length === 2);
  assert.equal(out.voiceFrames[0].n, 240);
  assert.equal(out.voiceFrames[0].rate, 24000);

  // Barge-in clears queued speech.
  s.opts.onEvent({ type: 'interrupted' });
  assert.equal(out.cleared, 1);

  // A card is rendered and pushed to the video track.
  s.opts.onCard({ title: 'Fix', steps: ['Use HDMI 1'] });
  await until(() => out.cardFrames.length === 2);
  assert.equal(out.cardFrames[1].data.length, 1280 * 720 * 4);

  room.remoteParticipants.delete(caller.identity);
  room.emit('participantDisconnected', caller);
  assert.equal(await done, 'caller hung up');
  assert.ok(s.closed);
  assert.ok(room.disconnected);
  streams.video.close();
  streams.audio.close();
});

test('bridge: reconnects the agent once with the last frame, then gives up', async () => {
  const { rtc, streams } = fakeRtc();
  const room = fakeRoom();
  const { sessions, start } = fakeSessions();
  const { done } = await bridgeRoom({ room, rtc, roomName: 'call-2', startSession: start, frameIntervalMs: 0, cardIntervalMs: 10_000 });
  room.emit('trackSubscribed', { kind: 2, name: 'facetime-remote-video' }, {}, caller);
  streams.video.push(rgbaFrame);
  await until(() => sessions[0].frames.length === 1);

  sessions[0].opts.onEvent({ type: 'close', reason: 'network' });
  await until(() => sessions.length === 2);
  await until(() => sessions[1].frames.length === 1);
  assert.match(sessions[1].texts[0], /reconnected/);

  sessions[1].opts.onEvent({ type: 'close', reason: 'network' });
  assert.match(await done, /agent session closed/);
  streams.video.close();
});

test('bridge: silence timeout and failed agent start both end the call', async () => {
  const a = fakeRtc();
  const room = fakeRoom();
  const { start } = fakeSessions();
  const r1 = await bridgeRoom({ room, rtc: a.rtc, roomName: 'call-3', startSession: start, silenceMs: 50, cardIntervalMs: 10_000 });
  assert.equal(await r1.done, 'silence timeout');

  const b = fakeRtc();
  const r2 = await bridgeRoom({ room: fakeRoom(), rtc: b.rtc, roomName: 'call-4', startSession: async () => { throw new Error('no key'); }, cardIntervalMs: 10_000 });
  assert.match(await r2.done, /agent failed to start: no key/);
});
