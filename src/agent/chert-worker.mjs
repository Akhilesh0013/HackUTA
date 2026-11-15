// Genesis as a LiveKit agent worker, the way Chert's `chert dev` dispatches FaceTime calls.
//   terminal 1:  npm run facetime          (this worker; registers as AGENT_NAME)
//   terminal 2:  npx @trychert/facetime dev
// chert dev keeps a room ready with this agent in it before any call. The Gemini session opens only
// once the caller (chert-bridge-<call id>) joins, and Genesis greets on chert_bridge_ready.
// Needs LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, AGENT_NAME and GEMINI_API_KEY.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServerOptions, cli, defineAgent } from '@livekit/agents';
import * as rtc from '@livekit/rtc-node';
import { bridgeRoom } from '../bridge/livekit.mjs';
import { captureProcessErrors, withErrorLog } from '../errors.mjs';

export const AGENT_NAME = process.env.AGENT_NAME || 'genesis-facetime-guide';

// Only type/session/name/reason/error: never caller content.
const log = withErrorLog('chert-worker', ({ type, sessionId, name, room, reason, error, attempt }) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), type, sessionId, room, name, reason, error, attempt })));
captureProcessErrors('chert-worker');

export default defineAgent({
  entry: async (ctx) => {
    await ctx.connect(); // subscribe to the caller's audio and video
    // Wait for the caller before opening a model session: the room exists before any call.
    let caller;
    try { caller = await ctx.waitForParticipant(); } catch { return; } // waiting room closed with no call: not an error
    log({ type: 'caller_joined', name: caller.identity.startsWith('chert-bridge-') ? 'chert-bridge' : 'other', room: ctx.room.name });
    const { done } = await bridgeRoom({
      room: ctx.room,
      rtc,
      roomName: ctx.room.name,
      agentIdentity: ctx.room.localParticipant?.identity,
      callerVideoTrack: process.env.CALLER_VIDEO_TRACK || '*', // Chert's track names are not documented
      greetOn: 'bridge_ready',
      log,
    });
    log({ type: 'job_done', reason: await done });
  },
});

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const missing = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'GEMINI_API_KEY'].filter((k) => !process.env[k]);
  if (missing.length) { console.error(`Missing in .env / .env.local: ${missing.join(', ')}`); process.exit(1); }
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
}
