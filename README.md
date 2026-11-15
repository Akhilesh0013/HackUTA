# Genesis: a FaceTime tech guide that learns safely

*Every fix is a beginning.*

HackUTA 2026 · Chert "Best Use of FaceTime" · theme: Homer's Odyssey (Odysseus never made it home alone: Athena, disguised as Mentor, guided him and Telemachus).

You FaceTime Genesis and point your camera at a problem: a monitor with no signal, a router, a PC build, a printer that won't join Wi-Fi. Genesis sees it, walks you through the fix one step at a time, and shows step cards on your screen. Every checked step is logged with consent. Those logs:
1. become a **training dataset**, with mistakes kept as labeled negative examples, and
2. update the agent's own playbook, `guide/GUIDE.md`, through a gated curation pipeline that keeps unsafe, poisoned or private data out.

## Layout
| Path | What |
|---|---|
| `guide/GUIDE.md` | System instruction for the live model. Parts A/B/C/E are fixed. Part D is generated. |
| `guide/knowledge.json` | Source of truth for Part D (learned knowledge) |
| `guide/CURATION.md` | Curation rules and gates G1–G11 |
| `src/agent/live-session.mjs` | Gemini 3.8 Live session for one call: GUIDE.md as system prompt, tools, frames/audio in, speech/cards out, server-side consent guard |
| `src/tools/` | Tool schemas (Gemini/OpenAI adapters) + server-side handlers (consent, validation, PII redaction) |
| `src/curation/` | filter → aggregate → propose → gates → apply → publish / monitor / rollback |
| `src/server.mjs`, `public/call.html` | Browser call: camera + hold-to-talk mic over WebSocket |
| `src/bridge/` | FaceTime bridge: LiveKit room ↔ Gemini Live, step cards rendered as a video track |
| `src/sim.mjs` | Synthetic sessions, including attacks and noise, for demos and tests |
| `data/manuals/` | Manual library for `lookup_manual` (the included one is a demo fixture) |

## Commands
```bash
npm start                                  # browser call at http://localhost:3000 (camera + mic)
npm test                                   # 27 tests: PII, handlers, every gate, end-to-end, call server, bridge
npm run live-smoke                         # scripted call against Gemini 3.8 Live (frame + tools + WAV)
npm run ws-smoke                           # same, through the call server WebSocket
npm run bridge -- --watch                  # FaceTime bridge: join each Chert/LiveKit call room as the agent
npm run simulate -- --sessions 60          # fake calls through the real handlers
npm run curate                             # needs 25 new sessions (or --force)
npm run curate -- --allow-no-classifier    # offline run; reviewer must check safety manually
npm run publish-guide -- --approve 1       # human approval → GUIDE.md v+1, old version saved
npm run monitor                            # auto-rollback if resolution/first-try drops >10 pts
npm run render-guide                       # re-render Part D after editing knowledge.json
```
Put `GEMINI_API_KEY` in `.env` (scripts load it). The live agent uses `gemini-3.8-live` (`GEMINI_LIVE_MODEL`). Curation uses `gemini-3.8-flash`, then `gemini-3.5-flash`, then `gemini-2.5-flash`, with retries, because Gemini often returns 503s under load (`GEMINI_MODEL` overrides). Without a key, the proposer is deterministic, and the safety gate **fails closed** unless you pass `--allow-no-classifier`.

## Status
- ✅ Guide, tools, curation pipeline, publish/rollback, simulator, tests
- ✅ Gemini 3.8 Live session tested end to end with a camera frame: diagnosis, manual lookup, consent, mistake + fix logging
- 🔧 Browser call (`npm start`) and Chert/LiveKit FaceTime bridge (`npm run bridge`): built and tested with fakes; live runs need Gemini and LiveKit keys
- ⏳ Demo dashboard

## Earlier plan
The team's original "Athena on Call" plan (cooking assistant, Next.js) is kept in [docs/athena-on-call-plan.md](docs/athena-on-call-plan.md).
