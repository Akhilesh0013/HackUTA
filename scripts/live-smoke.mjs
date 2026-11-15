// Smoke test for the Gemini Live agent without FaceTime: scripted caller turns (typed),
// one camera frame, and a WAV of the agent's voice.
//   npm run live-smoke                      (uses MENTOR_ROOT if set, else the project)
//   GEMINI_LIVE_MODEL=... npm run live-smoke
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths as getPaths } from '../src/config.mjs';
import { LIVE_OUTPUT_AUDIO_RATE, startLiveSession } from '../src/agent/live-session.mjs';
import { hashCaller } from '../src/tools/handlers.mjs';

if (!process.env.GEMINI_API_KEY) { console.error('Set GEMINI_API_KEY (.env)'); process.exit(1); }
const paths = getPaths();
const frame = fs.readFileSync(fileURLToPath(new URL('../test/fixtures/monitor-wrong-port.jpg', import.meta.url)));
const audio = [];
let agentLine = '';
const flush = () => { if (agentLine.trim()) console.log(`  🤖 Mentor: ${agentLine.trim()}`); agentLine = ''; };

const live = await startLiveSession({
  sessionId: `smoke-${Date.now()}`,
  callerId: hashCaller('smoke-test-caller'),
  paths,
  onAudio: (pcm) => audio.push(pcm),
  onTranscript: ({ role, text }) => { if (role === 'agent') agentLine += text; },
  onCard: (c) => console.log(`  🃏 card: ${c.title} → ${c.steps.join(' | ')}`),
  onEvent: (e) => {
    if (e.type === 'open') console.log(`Connected: ${e.model}`);
    if (e.type === 'tool_call') { flush(); console.log(`  🔧 ${e.name}(${JSON.stringify(e.args).slice(0, 220)})`); }
    if (e.type === 'tool_result' && !e.result.ok && e.result.found === undefined) console.log(`     ↳ ${JSON.stringify(e.result)}`);
    if (e.type === 'error') console.log(`  ⚠ ${e.error}`);
    if (e.type === 'close' && e.reason) console.log(`  closed: ${e.reason}`);
  },
});

const turns = [
  { say: 'Hi, my new monitor just says no signal.' },
  { say: "Sure, that's fine, you can log it." },
  { frame: true, say: "Here's the back of the monitor. What's wrong?" },
  { say: 'Okay, I pressed the input button and picked DisplayPort. The desktop shows up now! Thanks, that fixed it.' },
];
for (const t of turns) {
  if (t.frame) { live.sendFrame(frame); console.log('  📷 [sent camera frame]'); await new Promise((r) => setTimeout(r, 800)); }
  console.log(`  🧑 Caller: ${t.say}`);
  live.sendText(t.say);
  // a turn may include tool round-trips: wait until the agent has been quiet for 3 s
  await live.waitForIdle(3000, 45000);
  flush();
}
live.close();

// Save agent speech as WAV
const pcm = Buffer.concat(audio);
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(LIVE_OUTPUT_AUDIO_RATE, 24); header.writeUInt32LE(LIVE_OUTPUT_AUDIO_RATE * 2, 28);
header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
const out = path.join(paths.root, 'data', 'live-smoke.wav');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, pcm]));
console.log(`Agent audio: ${(pcm.length / 2 / LIVE_OUTPUT_AUDIO_RATE).toFixed(1)} s → ${out}`);
setTimeout(() => process.exit(0), 300);
