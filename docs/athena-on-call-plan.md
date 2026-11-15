# Athena on Call

FaceTime an AI goddess, show her what you're stuck on, she sees it and guides you step by step. Demo scenario: cooking from whatever's in your fridge.

**Prizes targeted:** Main, Chert, ElevenLabs, Gemini, MongoDB, Vultr, GoDaddy. Scored on robustness, theme fit, creativity. Robustness first, so everything below favors a small loop that never breaks.

## 1. Demo script (3 min + 2 min Q&A)

| Time | What judges see |
|------|-----------------|
| 0:00 | Hook: "Odysseus had Athena. Now you do." Dial Athena on an iPhone. |
| 0:20 | Point camera at props (eggs, tomato, cheese). Athena names them, suggests an omelette. |
| 1:00 | Do step 1. Hold up the pan. Athena says the next step, corrects if wrong. |
| 2:00 | Laptop: recap page with the steps and captured frames, saved in MongoDB. |
| 2:30 | Why it matters, what's next. Stop talking at 3:00. |

Props: 3 ingredients, a pan, a phone on a stand so judges see the screen.

## 2. Scope

### MVP (must ship)

- Inbound FaceTime call answered by Athena with ElevenLabs voice.
- Every turn: camera frame + what the user said → Gemini → one short instruction (max 20 words).
- One scenario (cooking) tuned hard. Prompt refuses to guess: unsure → "bring it closer".
- Recap page: per-call steps and frames in MongoDB.
- Browser fallback at `/call` that runs the same loop with `getUserMedia`. This is also the dev harness.

### Stretch (only after MVP works end to end)

- Second scenario (fix a thing, or homework).
- Avatar on the call if Chert supports it.
- Solana or Tiger Data. Skip unless trivially bolt-on.

### Not building

Accounts, payments, multi-language, mobile app.

## 3. Architecture

```
iPhone FaceTime → Chert managed line
                     │  (A) Chert hosts the agent loop: we set prompt, model, voice,
                     │      and get webhooks for events/tools
                     │  (B) Chert streams media to us: we run the loop ourselves
                     ▼
Next.js (Vultr) ─ /api/chert/webhook   Chert events, call start/end, tool calls
               ─ /api/step             frame + transcript → Gemini → instruction
               ─ /api/tts              instruction → ElevenLabs stream
               ─ /call                 browser fallback (camera, mic, audio)
               ─ /recap/[id]           steps + frames from MongoDB
MongoDB Atlas: calls { id, startedAt, steps[{ t, transcript, instruction, frameUrl }] }
```

Decide A or B at the Chert table in the first hour. A is less code. B reuses the `/call` loop. Either way the `/call` browser path is built first so the project works even if Chert is late.

**Latency budget (target under 3 s per turn):** frame downscaled to 512 px JPEG; Gemini Flash model; output capped at 1 sentence; ElevenLabs streaming TTS; opening lines pre-generated and cached.

## 4. Repo

```
athena/
  app/
    page.tsx                landing, "Call Athena", link to /call
    call/page.tsx           browser loop
    recap/[id]/page.tsx
    api/chert/webhook/route.ts
    api/step/route.ts
    api/tts/route.ts
  lib/
    prompt.ts               Athena persona + cooking rules
    gemini.ts
    eleven.ts
    db.ts
  .env.example              GEMINI_API_KEY ELEVENLABS_API_KEY CHERT_API_KEY MONGODB_URI
```

**Stack:** Next.js 15 app router, TypeScript, Tailwind, official Gemini, ElevenLabs and MongoDB Node SDKs. No extra state or UI libraries.

## 5. Team split (4 people)

| Person | Owns | First deliverable |
|--------|------|-------------------|
| P1 Integration | Chert keys and line, Vultr deploy, domain (code MLHUTA76), env, CI-free git push deploy | Skeleton live at the domain by hour 1 |
| P2 AI | `lib/prompt.ts`, `/api/step`, scenario tuning, latency | Frame + text → one correct instruction, under 2 s |
| P3 Voice + UI | `/api/tts`, `/call` page, audio playback, cached openers | Voice loop in the browser by hour 4 |
| P4 Product | MongoDB, `/recap`, landing, Devpost, slides, DEV post, props, pitch | Devpost draft submitted before Sat 11:59 PM |

3 people: merge P4 into P3 and P1.

## 6. Timeline (hacking ends Sun 12 PM, judging Sun 1 PM)

| When | Milestone |
|------|-----------|
| Sat 5–6 PM | Chert table: keys, docs, A or B. `create-next-app`, env, deploy skeleton, domain. |
| 6–9 PM | Browser loop works: camera → Gemini → ElevenLabs voice. Cooking prompt v1. |
| 9 PM–12 AM | Chert wired: a real FaceTime call answered by Athena. Submit Devpost draft before 11:59 PM in case the listed deadline is real. |
| 12–3 AM | MongoDB logging, recap page, landing page. Prompt v2 from 10 test runs. |
| 3–6 AM | Two people sleep. Others fix bugs only. No new features. |
| 6–9 AM | Rehearse the demo 5 times with the real props. Record a backup video. |
| 9–11 AM | Freeze code. Final Devpost: video, screenshots, write-up naming Chert, ElevenLabs, Gemini, MongoDB, Vultr, GoDaddy. DEV post. |
| 11–12 PM | Slides, Q&A prep, charge devices, hotspot ready. |
| 1 PM | Judge. |

## 7. Risks and fallbacks

| Risk | Fallback |
|------|----------|
| Chert access slow or API flaky | Demo on `/call` in the browser. Still competes for Main, ElevenLabs, Gemini. |
| Devpost deadline is really Sat 11:59 PM | Draft submitted before then; Devpost allows edits after. Confirm on Discord. |
| Venue Wi-Fi | Phone hotspot. Cached opener audio. Backup video on the laptop. |
| Gemini misreads objects | One scenario, fixed ingredient list in props, "bring it closer" rule in prompt. |
| Turn latency over 3 s | Flash model, 512 px frames, 1-sentence cap, streaming TTS. |
| Audio feedback (phone hears Athena) | Push-to-talk in `/call`; on FaceTime rely on Chert's echo cancellation. |

## 8. Q&A prep

Expect:

- "What if Chert disappears?" — works in browser.
- "How is this different from ChatGPT voice?" — it calls you on FaceTime, no app, sees in real time.
- "Monetization?" — per-minute guidance for brands: appliance makers, meal kits, hardware stores.

## Open items

- Chert's API shape is unverified. Section 3's A/B split and the webhook route are guesses until the docs are read at the table.
- Biggest risk: the Sat 11:59 PM Devpost deadline. Submit a draft before it even if it looks like a typo.

---

# 3-Person Task Plan (end to end)

Roles:

- **A, Integration**: Chert, Vultr deploy, domain, MongoDB, recap page, Devpost submission.
- **B, AI**: Gemini step API, Athena prompt, cooking scenario, latency.
- **C, Voice + UI**: ElevenLabs, `/call` browser loop, landing page, demo video, slides.

Everyone works against the contracts in section 1, so nobody waits on anyone.

## 1. Contracts (agree in the first 15 minutes, then don't change)

```ts
// POST /api/step
req: { callId: string; transcript: string; frameJpegBase64: string; history: Step[] }
res: { instruction: string; done: boolean }        // instruction ≤ 20 words

// POST /api/tts
req: { text: string }  →  res: audio/mpeg stream

// POST /api/chert/webhook   (shape from Chert docs; A fills in)

// MongoDB collection: calls
{ _id, startedAt, endedAt?, scenario: "cooking",
  steps: [{ t: Date, transcript, instruction, frameUrl?: string }] }

type Step = { transcript: string; instruction: string }
```

Env: `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `CHERT_API_KEY`, `MONGODB_URI`, `NEXT_PUBLIC_BASE_URL`.

## 2. Tasks

### Phase 0: setup (Sat 5–6 PM)

| ID | Owner | Task | Done when |
|----|-------|------|-----------|
| 0.1 | A | Chert table: get API key, docs, a managed FaceTime line. Learn: does Chert run the agent loop (mode A) or stream media to us (mode B)? Which voices and models? Webhook shape? | Written answers in `docs/chert.md`, mode chosen |
| 0.2 | B | `npx create-next-app@latest athena --ts --tailwind --app`, add `.env.example`, `lib/db.ts`, `lib/gemini.ts`, `lib/eleven.ts` stubs, push to GitHub, invite A and C | Repo cloned by all 3 |
| 0.3 | C | Vultr account with credits, Ubuntu VM, Node 20, `pm2`, nginx reverse proxy, HTTPS via certbot. Domain via GoDaddy code `MLHUTA76`, A record to the VM | `https://<domain>` serves the Next.js hello page |
| 0.4 | B | MongoDB Atlas free cluster, user, IP allowlist `0.0.0.0/0` for the hackathon, `MONGODB_URI` in team secrets (not in git) | `lib/db.ts` connects from local and VM |

### Phase 1: browser loop (Sat 6–9 PM)

| ID | Owner | Task | Done when |
|----|-------|------|-----------|
| 1.1 | B | `lib/prompt.ts`: Athena persona, cooking rules, "if unsure say 'bring it closer'", output 1 sentence ≤ 20 words, `done: true` when dish is finished | Prompt reviewed by A |
| 1.2 | B | `/api/step`: client sends 512 px frame, call Gemini Flash with image + transcript + last 6 steps, parse `{instruction, done}` with a fallback to raw text | `curl` with a test image returns a sane instruction under 2 s |
| 1.3 | C | `/api/tts`: ElevenLabs streaming endpoint, pipe to response | `curl` saves playable mp3 |
| 1.4 | C | `/call` page: `getUserMedia`, canvas to 512 px JPEG, push-to-talk button, Web Speech API STT, call `/api/step`, then `/api/tts`, play audio, show instruction text | Full turn in the browser with real camera |
| 1.5 | A | Pre-generate opener audio ("Greetings, mortal. Show me what you have.") and 3 error lines ("The gods are slow, give me a moment"), save to `public/audio/`, served when APIs fail | `/call` never goes silent on an error |
| 1.6 | A | Save each turn to MongoDB from `/api/step`; store frame as base64 or skip frames if size is a problem | Document appears per call |

**Checkpoint 9 PM:** one person stands at a counter with eggs, the browser guides an omelette end to end. If not, nobody moves to Phase 2.

### Phase 2: FaceTime + recap (Sat 9 PM–12 AM)

| ID | Owner | Task | Done when |
|----|-------|------|-----------|
| 2.1 | A | Chert integration. Mode A: configure persona prompt from `lib/prompt.ts`, Gemini as model if offered, ElevenLabs voice; point tool or event webhook at `/api/chert/webhook` to log steps. Mode B: adapt `/call` loop server-side, feed Chert audio with `/api/tts` output | Real iPhone FaceTime call answered by Athena, she describes what the camera sees |
| 2.2 | B | Prompt v2 from 10 runs: fix misreads, enforce step order (prep → heat → cook → plate), add "bring it closer" triggers | 8 of 10 runs correct |
| 2.3 | C | `/recap/[id]`: list of steps with timestamps and frames; `/` landing: name, one-line pitch, "Call Athena" number, link to `/call` | Both pages live on the domain |
| 2.4 | A | **Devpost draft submitted before 11:59 PM.** Title, tagline, placeholder video link, team members, every sponsor track selected | Submission exists; editable later |

### Phase 3: harden (Sun 12–3 AM)

| ID | Owner | Task | Done when |
|----|-------|------|-----------|
| 3.1 | B | Latency pass: measure each stage, log timings, cut to under 3 s total. Shorter prompt, fewer history turns, smaller frame if needed | p50 under 3 s over 10 turns |
| 3.2 | C | Audio robustness: queue playback so replies never overlap; retry `/api/tts` once; fall back to cached error line | No overlap in 10 turns |
| 3.3 | A | Error handling at boundaries: validate `/api/step` body, cap base64 size, 10 s timeout on Gemini, return the cached line on failure. Mongo writes never block the reply | Bad input returns 400, Gemini timeout returns a spoken fallback |
| 3.4 | all | Bugs only. No new features. Two people sleep 3–6 AM in shifts | |

### Phase 4: demo and submission (Sun 6–11 AM)

| ID | Owner | Task | Done when |
|----|-------|------|-----------|
| 4.1 | C | Record a 2-minute backup video of a full FaceTime run and the recap page. Upload to YouTube unlisted | Link in Devpost |
| 4.2 | all | Rehearse the 3-minute demo 5 times with the real props on the hotspot. Time it | Under 3:00 every time |
| 4.3 | A | Final Devpost: write-up (problem, how it works, sponsor tech used by name, what's next), screenshots, video, GitHub link. DEV post at dev.to/mlh-hackathon | Submitted and verified from another account |
| 4.4 | B | 5 slides: hook, live demo, architecture, prizes alignment, what's next | On a laptop and a phone |
| 4.5 | C | Freeze: tag `v1-demo`, `pm2 restart`, confirm the domain works from a phone | Tag pushed |

### Phase 5: judging (Sun 1 PM, UH)

Setup: phone on a stand facing judges, laptop open on `/recap`, hotspot on, props ready. A runs the call, C narrates, B handles Q&A on architecture.

## 3. Dependencies at a glance

```
0.1 ──────────────► 2.1
0.2 ─► 1.1 ─► 1.2 ─► 1.4 ─► checkpoint ─► 2.2 ─► 3.1
         1.3 ──────┘                        2.3 ─► 4.1
0.3 ─► deploy anytime after 1.4            2.4 before Sat 11:59 PM
0.4 ─► 1.6 ─► 2.3
```

## 4. Open items

- Chert's API is unverified, so task 2.1 and the webhook shape are placeholders until A reads their docs.
- The Sat 11:59 PM Devpost deadline may be a typo. Task 2.4 covers it either way.
