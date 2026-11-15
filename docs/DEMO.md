# Genesis demo runbook

Three minutes of demo, then two minutes of Q&A. Rehearse with the real props until three runs in a row finish under three minutes with no failures.

## Props

- A monitor, plus an HDMI cable and a DisplayPort cable. Plug the cable into the **wrong port** before you start (the demo fix).
- A phone on a stand, angled so judges can see its screen.
- A laptop showing the dashboard.
- Headphones for the person on the call, so Genesis doesn't hear itself.
- A phone hotspot, already paired with the laptop.

## Before judges arrive (10 minutes)

1. Build the dashboard history: `npm run demo:seed`. This creates `demo-data/` with 136 simulated calls, one curation batch, a publish and a rollback. The repo's own `guide/` and `data/` are not touched.
2. Start the server on that data: `npm run demo`. Open `http://localhost:3000/dashboard.html` on the laptop. On a deployed server, use the dashboard link that `setup.sh` printed (it includes the token).
3. FaceTime path: run `npm run bridge -- --watch` in a second terminal, and check it prints `Watching for calls…`.
4. Place one test call. Check that Genesis greets you within 10 seconds, and that the call shows up on the dashboard.
5. Plug the monitor cable back into the wrong port.

## The three minutes

| Time | Show | Say |
|------|------|-----|
| 0:00 | Title on the laptop | "Odysseus never made it home alone. Athena guided him. When your monitor says 'No signal', the person who could help can't see it. Genesis can." |
| 0:15 | Phone: FaceTime Genesis (or open `/call.html`) | "I'm calling Genesis. No app, no account." |
| 0:25 | Point the camera at the monitor and the back of it | Say: "My monitor says no signal." Genesis asks before keeping notes; say yes. |
| 0:45 | Genesis names the wrong port; the step card appears | "It sees the cable is in DisplayPort, and walks me through one step at a time." |
| 1:15 | Move the cable; the monitor comes on | Genesis confirms. Hang up. |
| 1:35 | Laptop: dashboard, open the call you just made | "Every step is logged with consent: the mistake, the fix that worked, personal details removed." |
| 2:00 | Scroll to "Latest curation" | "Calls become a better playbook. Eleven gates block weak evidence, one-caller attacks, unsafe advice like opening a power supply, and prompt injection." |
| 2:30 | "Results by playbook version" and the rollback line | "If an update makes results worse, Genesis rolls itself back. Here v2 dropped resolution from 87% to 47%, so v1 came back as v3." |
| 2:50 | Back to the title | "Every fix is a beginning." Stop at 3:00. |

## If something fails

Go down this list and don't debug in front of judges.

1. **FaceTime doesn't connect:** use the browser call on the laptop at `/call.html`. The same agent answers.
2. **Gemini is slow or down:** say so in one line, and show the dashboard story (2:00 onward), which runs on stored data.
3. **Wi-Fi is down:** switch to the hotspot. If that fails too, play `~/Desktop/Genesis-demo-v2.mp4`.

## Q&A prep

- **"What stops someone teaching it something harmful?"** Updates need evidence from at least 3 different callers, no single caller can supply more than 20% of it, a blocklist and a safety model reject unsafe advice, injection patterns are rejected, and a human approves every publish. If no safety model is available, nothing new is learned (it fails closed).
- **"What about privacy?"** Genesis asks before keeping notes, and logs are refused until the caller says yes. Emails, phone numbers, serial numbers, MAC addresses, public IPs and secrets are removed before anything is stored. Caller IDs are hashed.
- **"How is this different from ChatGPT voice?"** You FaceTime it with no app, it sees in real time, and it learns from real calls under gates, with rollback.
- **"What if Chert's API changes?"** The agent doesn't depend on the transport: the browser call runs the same session.
- **"Why does the rollback say −55 points when the table shows 87% vs 47%?"** The monitor decides fast: it compares the first 25 calls on the new version against the previous version's consented, unflagged calls. The table counts every call, including flagged ones.
- **"Business model?"** Support teams pay per resolved call; device makers pay for their manuals and fixes to be in the playbook.

## Reference

- Demo data: `npm run demo:seed` (add `-- --keep-v2` to stop before the rollback).
- Offline video: `~/Desktop/Genesis-demo-v2.mp4` (85 s, no audio). Add a voiceover in iMovie before uploading.
- Deploy: [DEPLOY.md](DEPLOY.md).
