// FaceTime bridge: joins the LiveKit room a Chert FaceTime call lands in, as the agent.
//   caller video (CALLER_VIDEO_TRACK, ~1 fps JPEG) + caller audio (16 kHz PCM) → Gemini Live session
//   agent speech (24 kHz PCM) → "genesis-voice" audio track; step cards → "genesis-cards" video track
// `rtc` and `startSession` are injectable so tests can run without LiveKit or Gemini.
import { startLiveSession } from '../agent/live-session.mjs';
import { hashCaller } from '../tools/handlers.mjs';
import { CARD_H, CARD_W, PcmChunker, cardToRgba, rgbaToJpeg, rms } from './media.mjs';

export const AGENT_IDENTITY = 'genesis';
export const DEFAULT_CALLER_VIDEO_TRACK = 'facetime-remote-video';
const OUT_RATE = 24000;
const OUT_FRAME = OUT_RATE / 100; // 10 ms frames
const IN_RATE = 16000;
const VOICE_RMS = 500;            // above this, the caller counts as talking

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
  cardIntervalMs = 500,
  maxReconnects = 1,
  log = () => {},
}) {
  const sessionId = `facetime-${roomName}-${Date.now()}`;
  let callerIdentity = null;
  let live = null;
  let ended = false;
  let reconnects = 0;
  let lastFrame = null;
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
  await room.localParticipant.publishTrack(cardTrack, new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_CAMERA }));
  let cardPixels = await cardToRgba(null);
  const pushCard = () => { if (!ended) cards.captureFrame(new rtc.VideoFrame(cardPixels, CARD_W, CARD_H, rtc.VideoBufferType.RGBA)); };
  pushCard();
  timers.push(setInterval(pushCard, cardIntervalMs));

  // ---- Gemini Live session (restarted once if it drops mid-call) ----
  async function openSession() {
    live = await startSession({
      sessionId,
      callerId: hashCaller(callerIdentity || roomName),
      onAudio: speak,
      onTranscript: (t) => { if (t.role === 'caller') lastCallerActivity = Date.now(); },
      onCard: (card) => {
        cardToRgba(card).then((px) => { cardPixels = px; pushCard(); }).catch((err) => log({ type: 'error', error: `card: ${err.message}` }));
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
        lastFrame = await rgbaToJpeg(frame.convert(rtc.VideoBufferType.RGBA));
        live?.sendFrame(lastFrame);
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
    greetOnce();
  }

  // ---- lifecycle ----
  async function end(reason) {
    if (ended) return;
    ended = true;
    timers.forEach(clearInterval);
    room.off?.('trackSubscribed', onTrack);
    try { live?.close(); } catch {}
    await Promise.allSettled([voice.close(), cards.close(), room.disconnect()]);
    log({ type: 'call_end', sessionId, reason });
    resolveDone(reason);
  }

  room.on('trackSubscribed', onTrack);
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

  // Tracks that were subscribed before we attached the listener.
  for (const p of room.remoteParticipants?.values?.() ?? []) {
    for (const pub of p.trackPublications?.values?.() ?? []) {
      if (pub.track) onTrack(pub.track, pub, p);
    }
  }
  return { done, end };
}
