# Genesis: build plan

Work one task at a time, top to bottom. **Keys come last:** build every phase first, then add `.env` keys and run the checks marked 🔑. A task is done only when its **Done when** check passes. Tick the box, commit, then start the next one.

Already done: guide, tool handlers, curation pipeline (G1–G11), publish/rollback, simulator, 18 tests, offline demo video.

## Phase 0: Unblock

- [ ] **0.1 Gemini key and live smoke test.** Put `GEMINI_API_KEY` in `.env`. Run `npm run live-smoke`.
  Done when: the agent names the wrong port in `test/fixtures/monitor-wrong-port.jpg`, calls `lookup_manual`, and a WAV of its voice is written.
- [x] **0.2 Rename Mentor to Genesis.** Update `README.md`, `package.json`, the persona name in `guide/GUIDE.md` Part A, and log strings in `scripts/`.
  Done when: `grep -ri mentor` only hits the Odyssey reference in the README, and `npm test` passes.

## Phase 1: Browser call (works without Chert, also the dev harness)

- [ ] **1.1 Call server.** `src/server.mjs`: Node HTTP + WebSocket. One WebSocket per call opens a `startLiveSession`. Forwards caller frames and audio in, and agent audio, transcripts and cards out.
  Done when: a scripted WebSocket client sends the fixture frame and gets agent audio back.
  Status: built. `test/server.test.mjs` passes with a fake session (forwarding, input validation, no tool args leak to the browser, path traversal refused). 🔑 Real check: `npm run ws-smoke`.
- [ ] **1.2 Call page.** `public/call.html`: camera + mic with `getUserMedia`, a JPEG frame every ~1 s, 16 kHz PCM mic audio, 24 kHz playback, step cards drawn beside the video.
  Done when: on a laptop, pointing the camera at a monitor cable gets a spoken step and a card.
  Status: built (`npm start`, open http://localhost:3000). Without a key the page shows "Agent disconnected: API key not valid." 🔑 Real check: a live call in Chrome.
- [ ] **1.3 Consent and echo.** Consent prompt at call start. Push-to-talk button so the mic doesn't hear the agent.
  Done when: no steps are logged before consent, and the agent doesn't answer itself.
  Status: built. The start screen explains logging; consent itself stays verbal (the agent asks, `record_consent` is refused until the caller answers). Hold-to-talk button or Space, which sends `audio_end` on release. 🔑 Real check: a live call.
- [ ] **1.4 Logged calls feed curation.** Confirm browser calls land in `data/raw/observations.jsonl` with PII redacted.
  Done when: 3 real browser calls show up in `npm run curate -- --force`.
  Status: no code needed; the same tool handlers write the logs. 🔑 Real check: 3 live calls.

## Phase 2: FaceTime bridge (Chert + LiveKit)

- [ ] **2.1 Chert access.** Get Chert and LiveKit keys and the docs at the Chert table. Add them to `.env`. Write down how a FaceTime call reaches LiveKit.
  Done when: you know the room or participant the call joins, and the track names (`facetime-remote-video`, audio).
- [ ] **2.2 Join the room as the agent.** `src/bridge/livekit.mjs`: join with the LiveKit server SDK, subscribe to the caller's video and audio.
  Done when: frames and audio from a real FaceTime call are logged on the server.
- [ ] **2.3 Caller to Gemini.** Downscale video to ~1 fps JPEG and resample audio to 16 kHz PCM, then feed `startLiveSession`.
  Done when: the agent's transcript describes what the FaceTime camera shows.
- [ ] **2.4 Gemini to caller.** Publish the agent's 24 kHz audio as an audio track, and step cards as a video track.
  Done when: on the iPhone, you hear the agent and see cards during the FaceTime call.
- [ ] **2.5 Harden.** Reconnect on drop, end the session when the caller hangs up, time out silent calls.
  Done when: 5 calls in a row start and end cleanly.

## Phase 3: Dashboard

- [ ] **3.1 Calls view.** `public/dashboard.html`, served by `src/server.mjs`: recent calls with steps, mistakes, fixes and cards.
  Done when: a finished call appears with its steps.
- [ ] **3.2 Playbook view.** Current `GUIDE.md` version, the latest curation report (accepted vs rejected, with gate reasons), version history and rollbacks.
  Done when: running `simulate`, `curate`, `publish-guide` and `monitor` changes what the dashboard shows.

## Phase 4: Optional sponsor add-ons (only if Phases 1–3 are done)

- [ ] **4.1 Deploy.** Run `src/server.mjs` on Vultr behind HTTPS (the camera needs HTTPS), on a GoDaddy domain.
  Done when: `/call` works from a phone browser at the domain.
- [ ] **4.2 MongoDB.** Mirror observations and call records to MongoDB Atlas. Keep the JSONL files as the source for curation.
  Done when: a call appears in Atlas.

## Phase 5: Demo and submission

- [ ] **5.1 Real demo run.** Props: monitor + wrong cable, phone on a stand. Rehearse 5 times.
  Done when: 3 runs in a row finish in under 3 minutes with no failures.
- [ ] **5.2 New video.** Record the real call plus the dashboard (OBS), add a voiceover (iMovie), upload to YouTube as Unlisted.
  Done when: the Devpost "Video demo link" field has the URL.
- [ ] **5.3 Update Devpost.** Make "How we built it", "Built with" and the generative AI answer match what actually shipped.
  Done when: every claim on Devpost can be shown in the demo.
- [ ] **5.4 Backup.** Keep the current offline video and the browser call (Phase 1) as a fallback if FaceTime or Wi-Fi fails.
  Done when: the fallback is on the laptop and rehearsed once.
