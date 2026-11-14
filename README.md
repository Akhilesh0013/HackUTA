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
