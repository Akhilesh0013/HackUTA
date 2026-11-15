// FaceTime bridge CLI.
//   npm run bridge -- --room <name>             join one room (the one Chert put the call in)
//   npm run bridge -- --watch [--prefix call-]  join every new room that has a caller in it
// Needs LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET and GEMINI_API_KEY in .env.
// Optional: CALLER_VIDEO_TRACK (default facetime-remote-video, '*' = any caller video).
import * as rtc from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { AGENT_IDENTITY, bridgeRoom } from '../bridge/livekit.mjs';

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

const missing = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'GEMINI_API_KEY'].filter((k) => !process.env[k]);
if (missing.length) { console.error(`Missing in .env: ${missing.join(', ')}`); process.exit(1); }
if (!arg('room') && !argv.includes('--watch')) { console.error('Usage: npm run bridge -- --room <name> | --watch [--prefix <p>]'); process.exit(1); }

// Only type/session/name/reason/error: never caller content.
const log = ({ type, sessionId, name, room, reason, error, attempt, expected }) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), type, sessionId, room, name, reason, error, attempt, expected }));

async function agentToken(room) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: AGENT_IDENTITY, name: 'Genesis', ttl: '2h' });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  return at.toJwt();
}

async function joinRoom(roomName) {
  const room = new rtc.Room();
  await room.connect(LIVEKIT_URL, await agentToken(roomName), { autoSubscribe: true, dynacast: true });
  log({ type: 'joined', room: roomName });
  const { done } = await bridgeRoom({ room, rtc, roomName, log });
  return done;
}

const active = new Set();
const finishedAt = new Map(); // don't rejoin a room we just left (e.g. silence timeout) for 5 min
async function handle(roomName) {
  active.add(roomName);
  try { await joinRoom(roomName); return true; } catch (err) { log({ type: 'error', room: roomName, error: err.message }); return false; }
  finally { active.delete(roomName); finishedAt.set(roomName, Date.now()); }
}
const coolingDown = (name) => Date.now() - (finishedAt.get(name) ?? 0) < 5 * 60_000;

if (arg('room')) {
  const ok = await handle(arg('room'));
  await rtc.dispose();
  process.exit(ok ? 0 : 1);
} else {
  const prefix = arg('prefix') || '';
  const svc = new RoomServiceClient(LIVEKIT_URL.replace(/^ws/, 'http'), LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  console.log(`Watching for calls${prefix ? ` in rooms starting with "${prefix}"` : ''}…`);
  const poll = async () => {
    try {
      for (const r of await svc.listRooms()) {
        if (r.name.startsWith(prefix) && r.numParticipants > 0 && !active.has(r.name) && !coolingDown(r.name)) handle(r.name);
      }
    } catch (err) {
      log({ type: 'error', error: `listRooms: ${err.message}` });
    }
  };
  // shortcut: polling every 2 s, switch to Chert's call webhook once its docs are available
  setInterval(poll, 2000);
  poll();
  process.on('SIGINT', async () => { await rtc.dispose(); process.exit(0); });
}
