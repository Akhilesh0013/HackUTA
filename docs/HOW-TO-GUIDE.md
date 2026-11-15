# Genesis how-to guide

## AI models used

Google Gemini via the `@google/genai` SDK.

- **Live agent:** the Gemini Live API (`gemini-3.8-live`). It takes camera frames and audio from the call, speaks back, and calls our tools.
- **Curation pipeline:** Gemini Flash (`gemini-3.8-flash`, falling back to `gemini-3.5-flash` and `gemini-2.5-flash`). It proposes playbook updates and acts as the safety classifier.

Override the models with `GEMINI_LIVE_MODEL`, `GEMINI_MODEL` and `GEMINI_SAFETY_MODEL` in `.env`.

## How to test

Run every command from the project folder. Each level needs the one before it to pass.

### 1. Without any keys

1. Run `npm test`. Expect `pass 33` and `fail 0`.
2. Run `npm run demo:seed`, then `npm run demo`.
3. Open http://localhost:3000/dashboard.html. Click a call: each step shows, with the mistake in red and the fix in green. Further down, "Latest curation" lists learned and blocked updates, and "Playbook history" shows the rollback.
4. Open http://localhost:3000/call.html and click **Start call**, then allow the camera. Without a key, the call ends with "Agent disconnected: API key not valid". That is expected.

### 2. With the Gemini key

Add `GEMINI_API_KEY=...` to `.env` first.

1. Run `npm run live-smoke`. Genesis names the wrong port in the test photo and writes a WAV of its voice.
2. Run `npm run ws-smoke`. Expect `✓ … bytes of agent audio`.
3. Run `npm start`, then open http://localhost:3000/call.html in **Chrome**, with headphones on. Point the camera at a cable, hold Space and talk. You hear a step and see a step card.
4. Keep http://localhost:3000/dashboard.html open in another tab during the call. "Call started" and the step card appear live.
5. Make 3 calls and say yes when Genesis asks to keep notes. Then run `npm run curate -- --force --allow-no-classifier`. The report counts your 3 calls.

### 3. With FaceTime

Add the Chert and LiveKit keys (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`) to `.env` first.

1. At the Chert table, ask how call rooms are named, what the caller's track names are, and whether a second video track (the step cards) reaches the iPhone.
2. Run `npm run bridge -- --watch`, then FaceTime the Chert number.
3. In the bridge log, look for `caller_video`, `caller_audio`, then `call_start`. If you see `video_track_name_mismatch`, set `CALLER_VIDEO_TRACK` to the name it prints.
4. On the iPhone, you hear Genesis and see step cards. Make 5 calls in a row; each ends with a `call_end` line.

### 4. Deployed

Follow [DEPLOY.md](DEPLOY.md) first, and push to GitHub before running `setup.sh`: the server pulls from there.

1. On a phone, open `https://<domain>/call.html`. The browser asks for the camera.
2. `https://<domain>/dashboard.html` says **Locked**. Adding `?token=...` (printed by `setup.sh`) shows the data.
3. If `MONGODB_URI` is set: after a call, Atlas has new documents in `observations`, `sessions` and `consent`.

### 5. Before judging

1. Run through [DEMO.md](DEMO.md) 3 times with the props, timing each run.
2. Practice the fallback once: switch from FaceTime to the browser call mid-demo.
