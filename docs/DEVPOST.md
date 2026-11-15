# Devpost submission text

Paste each section into the matching Devpost field. Before submitting, delete any line marked **[only if live]** that wasn't working by the deadline.

## Tagline

FaceTime it. Show it. Fix it. A tech guide that sees your problem and learns safely from every call.

## Inspiration

In the Odyssey, Odysseus never makes it home alone. Athena guides him at every turn, often disguised as Mentor. Most of us have a version of her: the friend or family member who gets the call when the Wi-Fi dies or the monitor says "No signal". The fix usually takes two minutes. The hard part is that they can't see the problem, and the caller can't describe it.

We wanted a guide anyone can call, that can actually see what's wrong, and that gets wiser from every call without learning the wrong lessons.

## What it does

You call Genesis and point your camera at the problem: a monitor with no signal, a router, a PC build, a printer that won't join Wi-Fi. Genesis sees it, diagnoses it, looks up the device manual, and walks you through the fix one step at a time, with step cards on your screen.

With your consent, every step is logged, mistakes included. Those logs:
1. **Build a training dataset**, with wrong turns kept as labeled negative examples.
2. **Update Genesis's own playbook** through a gated curation pipeline. Eleven gates block weak evidence, single-caller attacks, unsafe advice, prompt injection and private data. A human approves every update, and Genesis rolls back automatically if results get worse.

A dashboard shows every call step by step, the results of each playbook version, and what curation learned or blocked, with the reason.

## How we built it

- **Live agent:** one Gemini Live session per call. Camera frames (about 1 per second, 512 px JPEG) and 16 kHz audio go in; 24 kHz speech and tool calls come out. The system prompt is our playbook, `GUIDE.md`.
- **Tools:** step cards, manual lookup, consent, and step/mistake/fix logging. Every handler runs on the server with validation, consent enforcement and personal-data redaction.
- **Calls:** a browser call page (camera plus hold-to-talk over WebSocket), and a FaceTime bridge that joins the Chert/LiveKit call room as the agent and draws step cards into its video track.
- **Curation pipeline:** filter, aggregate, propose, 11 gates, apply, human approval, publish, monitor, rollback. It fails closed when no safety classifier is available.
- **Dashboard:** calls, results per playbook version, learned vs blocked updates, rollback history, with live events over server-sent events.
- **Storage and deploy:** JSONL logs as the source of truth, an optional MongoDB Atlas copy, and a one-command deploy to a Vultr server with Caddy HTTPS on a GoDaddy domain.
- **Stack:** Node.js 22+, `@google/genai`, `ws`, `@livekit/rtc-node`, `livekit-server-sdk`, `sharp`, `mongodb`. 33 automated tests on Node's built-in test runner.

## Challenges we ran into

- **Learning without being poisoned.** Anyone who calls can try to teach a self-improving agent something harmful. Gates strict enough to block that, yet loose enough to learn real fixes, took most of our time.
- **Privacy on a live camera.** Callers show serial numbers, Wi-Fi passwords and email addresses without meaning to. We redact all of it before anything is stored, and logging is refused until the caller agrees.
- **Real-time media.** Turning FaceTime video and audio into what a live model needs, and turning its speech and step cards back into call tracks, while keeping replies conversational.
- **Building against a private API.** Chert's FaceTime API is in private preview, so we kept the agent independent of the transport and built the browser call first.

## Accomplishments that we're proud of

- A curation pipeline that learns real fixes, blocks simulated attacks (including unsafe power-supply advice and prompt injection), publishes a new playbook version, and rolls it back when results drop.
- Safety that fails closed: with no classifier available, nothing new is learned.
- A dashboard that makes the learning visible: every call, every gate decision, every rollback.
- 33 automated tests, passing on macOS and Linux.
- **[only if live]** A live call where Genesis spots the wrong port and walks the caller through the fix.

## What we learned

- Learning from mistakes beats hiding them. Logging wrong turns as labeled negatives gives more useful guidance than logging only successes.
- A self-improving AI needs the same discipline as shipping code: review, versioning, monitoring and rollback.
- Keeping the agent independent of the call transport let us build and test everything before the FaceTime bridge was live.

## What's next for Genesis

- Production FaceTime calls through Chert.
- A bigger manual library: common routers, monitors and printers.
- More domains: home appliances, car dashboards, and accessibility help for older users.
- Fine-tuning a smaller, faster model on the curated mistakes dataset.

## Built with

```
node.js, javascript, gemini, gemini-live-api, google-genai-sdk, websockets, livekit, chert, facetime, sharp, mongodb, mongodb-atlas, vultr, godaddy, caddy
```

Drop `chert`, `facetime`, `vultr`, `godaddy` or `mongodb-atlas` if that part wasn't live by the deadline.

## Did you use a generative AI model or API?

Yes. Google Gemini through the `@google/genai` SDK. The live agent uses the Gemini Live API (`gemini-3.8-live`): it takes camera frames and audio from the call, speaks back, and calls our tools. The curation pipeline uses Gemini Flash (`gemini-3.8-flash`, falling back to `gemini-3.5-flash` and `gemini-2.5-flash`) to propose playbook updates and as a safety classifier.

## Video

Upload `Genesis-demo-v2.mp4`, or the recording of the real call, to YouTube as **Unlisted**, and paste the link.
