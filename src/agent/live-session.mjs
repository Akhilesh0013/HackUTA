// Gemini Live session for one FaceTime call.
// Transport-agnostic: the LiveKit/Chert bridge (or a test script) feeds caller video frames and
// audio in, and receives the agent's audio + transcripts + step cards out. GUIDE.md is the system
// instruction; tool calls are executed by the server-side handlers (consent/PII enforced there).
import fs from 'node:fs';
import { paths as getPaths } from '../config.mjs';
import { LIVE_MODEL } from '../gemini.mjs';
import { loadKnowledge } from '../knowledge.mjs';
import { TOOL_DECLARATIONS } from '../tools/declarations.mjs';
import { createToolHandlers } from '../tools/handlers.mjs';
import { localNow } from '../assistant/schedule.mjs';

export const LIVE_INPUT_AUDIO = 'audio/pcm;rate=16000'; // 16-bit mono PCM in
export const LIVE_OUTPUT_AUDIO_RATE = 24000;             // 16-bit mono PCM out

function liveTools() {
  return [{ functionDeclarations: TOOL_DECLARATIONS.map(({ name, description, parameters }) => ({ name, description, parametersJsonSchema: parameters })) }];
}

/**
 * @param {object} o
 * @param {string} o.sessionId
 * @param {string} o.callerId            hashed caller id (hashCaller)
 * @param {(pcm: Buffer) => void} [o.onAudio]       agent speech, 24 kHz PCM16 mono
 * @param {(t: {role:'agent'|'caller', text:string}) => void} [o.onTranscript]
 * @param {(card: object) => void} [o.onCard]       render into the agent's video track
 * @param {(e: object) => void} [o.onEvent]          tool calls/results, turn boundaries, errors
 * @param {(a: {target:string,label:string}) => Promise<object>} [o.pointAt]  circle a thing on screen (point_at)
 */
export async function startLiveSession({
  sessionId, callerId, paths = getPaths(), model = LIVE_MODEL, voice = process.env.GEMINI_LIVE_VOICE,
  onAudio = () => {}, onTranscript = () => {}, onCard = () => {}, onEvent = () => {}, pointAt = null,
}) {
  const { GoogleGenAI, Modality } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const knowledge = loadKnowledge(paths.knowledge);
  const guide = fs.readFileSync(paths.guide, 'utf8');
  const tools = createToolHandlers({ sessionId, callerId, guideVersion: knowledge.meta.version, paths, onCard, pointAt });
  // The model has no clock: give it today's date so "Tuesday at 3" resolves to a real date.
  const now = localNow();
  const callContext = [
    '', '', '---', '', '## Call context',
    `Now: ${now.text} (time zone ${now.tz}). Today is ${now.date}.`,
    ...(pointAt ? [] : ['Pointing (point_at) is not available on this call: describe locations in words.']),
  ].join('\n');

  let session;
  let closed = false;
  let turnResolvers = [];
  const startedAt = Date.now();
  let lastActivityAt = Date.now();
  let pendingTools = 0;
  // Consent guard: the caller must say something AFTER the agent asked about logging.
  let consentAskedAt = 0;
  let callerSpokeAt = 0;
  const CONSENT_ASK = /\b(log|logging|notes|record)\b/i;

  async function handleToolCall(toolCall) {
    const responses = [];
    pendingTools++;
    for (const fc of toolCall.functionCalls || []) {
      const args = { ...(fc.args || {}) };
      // Video time is always stamped server-side; the model's clock is unreliable.
      if (fc.name === 'log_observation') args.t_video_ms = Date.now() - startedAt;
      onEvent({ type: 'tool_call', name: fc.name, args });
      let result;
      if (fc.name === 'record_consent' && args.granted === true && !(consentAskedAt && callerSpokeAt > consentAskedAt)) {
        result = { ok: false, error: 'Consent not recorded: ask the consent question, then WAIT for the caller to answer yes in a later turn before calling record_consent.' };
      } else {
        result = await tools.dispatch(fc.name, args);
      }
      onEvent({ type: 'tool_result', name: fc.name, result });
      responses.push({ id: fc.id, name: fc.name, response: result });
    }
    pendingTools--;
    lastActivityAt = Date.now();
    if (responses.length && !closed) session.sendToolResponse({ functionResponses: responses });
  }

  const callerInput = () => { callerSpokeAt = Date.now(); lastActivityAt = callerSpokeAt; };

  session = await ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: guide + callContext,
      tools: liveTools(),
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      ...(voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } : {}),
    },
    callbacks: {
      onopen: () => onEvent({ type: 'open', model }),
      onmessage: (msg) => {
        if (msg.toolCall) handleToolCall(msg.toolCall).catch((err) => onEvent({ type: 'error', error: err.message }));
        const sc = msg.serverContent;
        if (!sc) return;
        lastActivityAt = Date.now();
        for (const part of sc.modelTurn?.parts || []) {
          if (part.inlineData?.data) onAudio(Buffer.from(part.inlineData.data, 'base64'));
        }
        if (sc.outputTranscription?.text) {
          if (CONSENT_ASK.test(sc.outputTranscription.text)) consentAskedAt = Date.now();
          onTranscript({ role: 'agent', text: sc.outputTranscription.text });
        }
        if (sc.inputTranscription?.text) { callerInput(); onTranscript({ role: 'caller', text: sc.inputTranscription.text }); }
        if (sc.interrupted) onEvent({ type: 'interrupted' });
        if (sc.turnComplete) {
          onEvent({ type: 'turn_complete' });
          const r = turnResolvers;
          turnResolvers = [];
          r.forEach((fn) => fn());
        }
      },
      onerror: (e) => onEvent({ type: 'error', error: e?.message || String(e) }),
      onclose: (e) => { closed = true; onEvent({ type: 'close', reason: e?.reason || '' }); turnResolvers.forEach((fn) => fn()); },
    },
  });

  return {
    model,
    tools,
    /** Caller camera frame (JPEG). Send ~1 fps; the Live API samples video at about 1 fps. */
    sendFrame(jpeg) {
      if (!closed) session.sendRealtimeInput({ video: { data: Buffer.from(jpeg).toString('base64'), mimeType: 'image/jpeg' } });
    },
    /** Caller microphone audio: 16 kHz, 16-bit mono PCM. */
    sendAudio(pcm16k) {
      if (!closed) session.sendRealtimeInput({ audio: { data: Buffer.from(pcm16k).toString('base64'), mimeType: LIVE_INPUT_AUDIO } });
    },
    /** Caller released push-to-talk: flush buffered audio so the model answers without waiting for silence. */
    endAudio() {
      if (!closed) session.sendRealtimeInput({ audioStreamEnd: true });
    },
    /** Typed input (tests, or iMessage side-channel). */
    sendText(text) {
      if (!closed) { callerInput(); session.sendRealtimeInput({ text }); }
    },
    /** Resolves once the agent has been quiet (no audio/tools) for idleMs. */
    waitForIdle(idleMs = 3000, maxMs = 45000) {
      const start = Date.now();
      return new Promise((resolve) => {
        const tick = () => {
          const quiet = Date.now() - lastActivityAt >= idleMs && pendingTools === 0;
          if (closed || quiet || Date.now() - start > maxMs) resolve();
          else setTimeout(tick, 200);
        };
        setTimeout(tick, 1000);
      });
    },
    /** Resolves when the model finishes its current turn (or the session closes). */
    waitForTurn(timeoutMs = 30000) {
      return new Promise((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        turnResolvers.push(() => { clearTimeout(t); resolve(); });
      });
    },
    close() {
      if (!closed) { closed = true; session.close(); }
    },
  };
}
