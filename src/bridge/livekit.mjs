// FaceTime bridge: joins the LiveKit room a Chert FaceTime call lands in, as the agent.
//   caller video (CALLER_VIDEO_TRACK, ~1 fps JPEG) + caller audio (16 kHz PCM) → Gemini Live session
//   agent speech (24 kHz PCM) → "genesis-voice" audio track; step cards → "genesis-cards" video track
// `rtc` and `startSession` are injectable so tests can run without LiveKit or Gemini.
import { startLiveSession } from '../agent/live-session.mjs';
import { hashCaller } from '../tools/handlers.mjs';
import { locate } from '../agent/pointer.mjs';
import { getGemini } from '../gemini.mjs';
import { CARD_H, CARD_W, PcmChunker, cardToRgba, pointerToRgba, rgbaToJpeg, rms } from './media.mjs';

export const AGENT_IDENTITY = 'genesis';
export const DEFAULT_CALLER_VIDEO_TRACK = 'facetime-remote-video';
const OUT_RATE = 24000;
const OUT_FRAME = OUT_RATE / 100; // 10 ms frames
const IN_RATE = 16000;
const VOICE_RMS = 500;
const CARD_MAX_BITRATE = 4_000_000;
const POINT_FRAME_WIDTH = 1280; // sharper copy of the caller frame, for finding and circling things

let geminiClient;
/** Default point_at finder: a Gemini vision model on the caller's latest frame. */
async function defaultLocate(jpeg, target) {
  geminiClient ??= getGemini({ log: () => {} });
  const gemini = await geminiClient;
  if (!gemini) throw new Error('GEMINI_API_KEY not set');
  return locate(gemini, jpeg, target);
}            // above this, the caller counts as talking

/** chert dev sets room metadata {"chert_bridge_ready":true,...} once FaceTime is connected. */
export function bridgeReady(metadata) {
  try { return JSON.parse(metadata || '{}')?.chert_bridge_ready === true; } catch { return false; }
}

/**
 * Bridge one LiveKit room (already connected) to one Gemini Live session.
 * @returns {{ done: Promise<string>, end: (reason: string) => Promise<void> }}  done resolves with the end reason
 */
export async function bridgeRoom({
  room, rtc, roomName,
  startSession = startLiveSession,
  callerVideoTrack = process.env.CALLER_VIDEO_TRACK || DEFAULT_CALLER_VIDEO_TRACK,
  agentIdentity = AGENT_IDENTITY,
  silenceMs = 60_000,
  frameIntervalMs = 1000,
  pointHoldMs = 12_000, // how long a circled snapshot stays up before the step card returns
  locateThing = defaultLocate,
  cardIntervalMs = 200, // 5 fps: a static card still needs steady frames or the encoder stays blurry
  maxReconnects = 1,
  // 'first_track': greet when caller media arrives (plain LiveKit rooms).
  // 'bridge_ready': greet only on Chert's bridge_ready metadata; the Mac drops calls silent for 10 s after it.
  greetOn = 'first_track',
  log = () => {},
}) {
  const sessionId = `facetime-${roomName}-${Date.now()}`;
  let callerIdentity = null;
  let live = null;
  let ended = false;
  let reconnects = 0;
  let lastFrame = null;
  let lastFrameHi = null;
  let lastCallerActivity = Date.now();
  let greeted = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const timers = [];

  // ---- agent voice out ----
  const voice = new rtc.AudioSource(OUT_RATE, 1);
  const voiceTrack = rtc.LocalAudioTrack.createAudioTrack('genesis-voice', voice);
  await room.localParticipant.publishTrack(voiceTrack, new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE }));
  const chunker = new PcmChunker(OUT_FRAME);
  let playout = Promise.resolve(); // captureFrame must be called in order
  const speak = (pcm) => {
    for (const samples of chunker.push(pcm)) {
      playout = playout.then(() => voice.captureFrame(new rtc.AudioFrame(samples, OUT_RATE, 1, samples.length))).catch((err) => log({ type: 'error', error: `voice: ${err.message}` }));
    }
  };

  // ---- step cards out (re-sent on a timer so late subscribers and encoders always have a frame) ----
  const cards = new rtc.VideoSource(CARD_W, CARD_H);
  const cardTrack = rtc.LocalVideoTrack.createVideoTrack('genesis-cards', cards);
  // One full-quality layer (no simulcast, which would let the receiver pick a low-res layer) and a
  // bitrate high enough for sharp text. Static frames compress well, so real usage stays far below it.
  await room.localParticipant.publishTrack(cardTrack, new rtc.TrackPublishOptions({
    source: rtc.TrackSource.SOURCE_CAMERA,
    simulcast: false,
    videoEncoding: { maxBitrate: BigInt(CARD_MAX_BITRATE), maxFramerate: 1000 / cardIntervalMs },
  }));
  let cardPixels = await cardToRgba(null);
  let cardBase = cardPixels; // the current step card; a pointer snapshot covers it for a while
  let restoreTimer = null;
  const pushCard = () => { if (!ended) cards.captureFrame(new rtc.VideoFrame(cardPixels, CARD_W, CARD_H, rtc.VideoBufferType.RGBA)); };
  const showCard = (px) => { clearTimeout(restoreTimer); cardBase = cardPixels = px; pushCard(); };

  // point_at: find the thing in the latest frame and circle it on a snapshot of that frame.
  async function pointAt({ target, label }) {
    const frame = lastFrameHi;
    if (!frame) return { ok: false, error: 'No camera picture yet. Ask the caller to point the camera at it.' };
    let found;
    try {
      found = await locateThing(frame, target);
    } catch (err) {
      log({ type: 'error', error: `point_at: ${err.message}` });
      return { ok: false, error: 'Pointing failed just now. Describe the location in words.' };
    }
    if (!found?.found) return { ok: false, found: false, error: `Could not see "${target}" clearly. Ask the caller to move closer or adjust the view, then try again.` };
    const px = await pointerToRgba(frame, found.box, label || found.label);
    if (ended) return { ok: false, error: 'call ended' };
    clearTimeout(restoreTimer);
    cardPixels = px;
    pushCard();
    restoreTimer = setTimeout(() => { cardPixels = cardBase; pushCard(); }, pointHoldMs);
    timers.push(restoreTimer);
    return { ok: true, found: true, shown: `Circled on the caller's screen for ${Math.round(pointHoldMs / 1000)} s, on a snapshot of their camera.` };
  }
  pushCard();
  timers.push(setInterval(pushCard, cardIntervalMs));

  // ---- Gemini Live session (restarted once if it drops mid-call) ----
  async function openSession() {
    live = await startSession({
      sessionId,
      callerId: hashCaller(callerIdentity || roomName),
      onAudio: speak,
      pointAt,
      onTranscript: (t) => { if (t.role === 'caller') lastCallerActivity = Date.now(); },
      onCard: (card) => {
        cardToRgba(card).then(showCard).catch((err) => log({ type: 'error', error: `card: ${err.message}` }));
      },
      onEvent: (e) => {
        // Only type/name/error: tool args can hold caller details.
        log({ type: e.type, sessionId, name: e.name, error: e.error });
        if (e.type === 'interrupted') { voice.clearQueue(); chunker.reset(); }
        if (e.type === 'close' && !ended) onSessionLost(e.reason);
      },
    });
  }

  async function onSessionLost(reason) {
    if (reconnects >= maxReconnects) { await end(`agent session closed: ${reason || 'unknown'}`); return; }
    reconnects++;
    log({ type: 'reconnect', sessionId, attempt: reconnects });
    try {
      await openSession();
      if (lastFrame) live.sendFrame(lastFrame);
      live.sendText('The call dropped for a moment and reconnected. Continue helping from where we were.');
    } catch (err) {
      await end(`agent reconnect failed: ${err.message}`);
    }
  }

  function greetOnce() {
    if (greeted || !live) return;
    greeted = true;
    // Live models wait for input: a short nudge makes Genesis greet first (GUIDE.md: within 10 s).
    live.sendText('Hi, I just called.');
  }

  // ---- caller media in ----
  async function pumpVideo(track) {
    let last = 0;
    let busy = false;
    for await (const { frame } of new rtc.VideoStream(track)) {
      if (ended) break;
      const now = Date.now();
      if (busy || now - last < frameIntervalMs) continue;
      busy = true;
      last = now;
      try {
        const rgba = frame.convert(rtc.VideoBufferType.RGBA);
        lastFrame = await rgbaToJpeg(rgba);
        live?.sendFrame(lastFrame);
        lastFrameHi = await rgbaToJpeg(rgba, POINT_FRAME_WIDTH);
      } catch (err) {
        log({ type: 'error', error: `frame: ${err.message}` });
      } finally {
        busy = false;
      }
    }
  }

  async function pumpAudio(track) {
    for await (const frame of new rtc.AudioStream(track, { sampleRate: IN_RATE, numChannels: 1 })) {
      if (ended) break;
      const d = frame.data;
      live?.sendAudio(Buffer.from(d.buffer, d.byteOffset, d.byteLength));
      if (rms(d) > VOICE_RMS) lastCallerActivity = Date.now();
    }
  }

  function onTrack(track, publication, participant) {
    if (participant.identity === agentIdentity) return;
    callerIdentity ??= participant.identity;
    const name = track.name || publication?.name || '';
    if (track.kind === rtc.TrackKind.KIND_VIDEO) {
      // Chert names the FaceTime camera track; fall back to any caller video if names differ.
      if (callerVideoTrack !== '*' && name !== callerVideoTrack) log({ type: 'video_track_name_mismatch', name, expected: callerVideoTrack });
      log({ type: 'caller_video', name });
      pumpVideo(track).catch((err) => log({ type: 'error', error: `video in: ${err.message}` }));
    } else if (track.kind === rtc.TrackKind.KIND_AUDIO) {
      log({ type: 'caller_audio', name });
      pumpAudio(track).catch((err) => log({ type: 'error', error: `audio in: ${err.message}` }));
    }
    if (greetOn === 'first_track') greetOnce();
  }

  // Chert: greet once FaceTime is ready, never just because the caller joined.
  const onMetadata = () => {
    if (greetOn !== 'bridge_ready' || !bridgeReady(room.metadata)) return;
    if (!live) return; // session still opening: checked again right after it opens
    room.off?.('roomMetadataChanged', onMetadata);
    log({ type: 'bridge_ready', sessionId });
    greetOnce();
  };

  // ---- lifecycle ----
  async function end(reason) {
    if (ended) return;
    ended = true;
    timers.forEach(clearInterval);
    clearTimeout(restoreTimer);
    room.off?.('trackSubscribed', onTrack);
    room.off?.('roomMetadataChanged', onMetadata);
    try { live?.close(); } catch {}
    await Promise.allSettled([voice.close(), cards.close(), room.disconnect()]);
    log({ type: 'call_end', sessionId, reason });
    resolveDone(reason);
  }

  room.on('trackSubscribed', onTrack);
  room.on('roomMetadataChanged', onMetadata);
  room.on('participantDisconnected', (p) => {
    if (p.identity === agentIdentity) return;
    const others = [...(room.remoteParticipants?.values?.() ?? [])].filter((x) => x.identity !== agentIdentity && x.identity !== p.identity);
    if (!others.length) end('caller hung up');
  });
  room.on('disconnected', (reason) => end(`room disconnected: ${reason ?? ''}`));
  timers.push(setInterval(() => {
    if (Date.now() - lastCallerActivity > silenceMs) end('silence timeout');
  }, Math.min(5000, silenceMs)));

  try {
    await openSession();
  } catch (err) {
    await end(`agent failed to start: ${err.message}`);
    return { done, end };
  }
  log({ type: 'call_start', sessionId, room: roomName });
  onMetadata(); // bridge_ready may already be set

  // Tracks that were subscribed before we attached the listener.
  for (const p of room.remoteParticipants?.values?.() ?? []) {
    for (const pub of p.trackPublications?.values?.() ?? []) {
      if (pub.track) onTrack(pub.track, pub, p);
    }
  }
  return { done, end };
}
