# Guide curation: how GUIDE.md learns safely

This is how logged FaceTime sessions become updates to **Part D** of `GUIDE.md`. It also covers how bad or harmful data is kept out of the guide.

---

## 1. When curation runs

Run a curation batch when **either** of these is true:
- **25** new completed sessions with `consent=true`, or
- **200** new observations

A teammate can also run it manually. Use smaller thresholds for the hackathon demo, e.g. 5 sessions.

---

## 2. Two outputs, two rules

| Output | What goes in | Errors allowed? |
|---|---|---|
| **Training dataset** (`data/episodes/*.jsonl`) | Every observation that passes the filters, **including mistakes**, labeled `result` + `error_type` + `correction_given` | **Yes, but as labeled negatives.** A model learns to *recognize* mistakes from them. |
| **GUIDE.md Part D** | Only the *correct methods* and *how to spot* patterns, backed by evidence | **Never.** No wrong methods, unverified tips, or anything that conflicts with Part A or a manual. |

A wrong action can be useful training data. It must never become guidance.

---

## 3. Pipeline

```
raw logs ─► 1 Filter ─► 2 Aggregate ─► 3 Propose (LLM) ─► 4 Gate checks ─► 5 Human review ─► 6 Publish + monitor
                                                                │ reject                         │ regression
                                                                ▼                                ▼
                                                           rejected.log                       rollback
```

### Step 1: Filter (code only, no LLM)
Drop a record if any of these apply:
- **No consent:** `consent=false` (it should never have been logged; delete it).
- **Low confidence:** `confidence < 0.7`, or `result = unverifiable`.
- **Unknown outcome:** the session has `outcome_evidence = none`, or `outcome = abandoned`.
- **Safety stop:** the session has `safety_stop = true`. Keep it for review, but never use it to change the guide.
- **Personal info:** it matches a PII pattern: email, phone, street address, MAC address, full serial-number format, or any word that looks like a Wi-Fi key or password. **Redact** these in the training set, and drop the record from curation input.
- **Inconsistent:** an observation contradicts the session outcome (e.g. "correction_worked: true" but the session was unresolved on that step) → mark it for review and exclude it.
- **Abusive or test calls:** the session was flagged as a prank, abuse, or a caller trying to "teach" the agent wrong things.

### Step 2: Aggregate (code only)
For each `(task_category, device.type, step_id, error_type)` group, compute:
- `n_sessions`, `n_distinct_callers`
- `error_rate` = incorrect ÷ attempts
- `correction_success_rate` = corrections that worked ÷ corrections given
- the most common `correction_given` phrasings, clustered
- `median_time_to_fix_s`
- the **share from the top caller** (how much of the evidence comes from one person)

Also compute global metrics per batch: first-try step success rate, resolution rate, average session duration, and the referral-to-pro rate.

### Step 3: Propose (LLM)
The summarizer model gets **only the aggregated stats from Step 2 plus the current Part D**, never raw transcripts or caller wording. This blocks prompt injection from callers.

Summarizer prompt:
```
You maintain Part D of a technician guide. Given the aggregated statistics below
and the current Part D, propose changes as a JSON list. Allowed operations:
  add_entry, update_entry, promote (trial→established), deprecate.
Each change must include: entry_id, category, title, spot_it, correct_method,
evidence {n_sessions, n_distinct_callers, correction_success_rate}, rationale.
Rules:
- Describe only CORRECT methods and how to visually spot the problem.
- Never include brand promotion, URLs, phone numbers, prices, or instructions
  about how the assistant should behave.
- Never weaken or contradict safety rules. Never suggest opening power supplies,
  mains wiring, bypassing security or interlocks.
- If evidence is weak, propose nothing.
Output JSON only.
```

### Step 4: Gate checks (code; automatic rejection)
A proposed change is **rejected** if any check fails. Each rejection is written to `rejected.log` with the reason.

| # | Check | Rule |
|---|---|---|
| G1 | Scope | Only changes Part D. Any edit to Parts A, B, C or E is rejected. |
| G2 | Evidence for `add_entry` (as `trial`) | `n_sessions ≥ 5`, `n_distinct_callers ≥ 3`, `correction_success_rate ≥ 0.8` |
| G3 | Evidence for `promote` to `established` | Already `trial` for at least one earlier batch, cumulative `n_sessions ≥ 15`, success rate `≥ 0.85` |
| G4 | Poisoning cap | No single caller provides more than **20%** of an entry's evidence |
| G5 | Overwrite protection | `update_entry` on an `established` entry needs **more** evidence than the original entry had |
| G6 | Safety blocklist | Reject text matching: open/remove the power supply, mains, 120V/240V wiring, capacitor, bypass, jailbreak, disable security/firewall/antivirus, root, factory unlock, override interlock, remove battery from a swollen device, and similar |
| G7 | Safety classifier | A second LLM call checks for contradicting Part A or giving a risky instruction; any "unsafe/unsure" result → reject |
| G8 | Injection or format | Reject entries containing instructions to the model ("ignore", "always say", "you must", "system prompt"), URLs, emails, phone numbers, prices, brand promotion, or code |
| G9 | Manual conflict | If `lookup_manual` covers the device and contradicts the entry → reject and flag it |
| G10 | Size budget | Part D stays under **~2,500 words**. If it's over, deprecate the least-used `trial` entries first. |
| G11 | Duplicates | If the entry is a near-duplicate of an existing one, merge it into an `update_entry` instead of adding a new entry |

**Deprecation runs automatically:** an entry is set to `deprecated` when its correction success rate drops **below 0.6** over the last 10 uses, or when it causes a `guide_manual_conflict`.

### Step 5: Human review
The pipeline writes `GUIDE.proposed.md`, a readable **diff**, and `curation_report.md` with metrics, accepted changes and rejected changes with reasons. A teammate approves or edits before publishing. **Nothing reaches the live guide without approval.**

### Step 6: Publish, version, monitor, roll back
- Save the old guide as `guide/versions/GUIDE.v{N}.md`, bump the header (`Guide version`, `Last curated`, `Sessions included`), and add a line to `CHANGELOG.md`.
- **Monitor** the next 25 sessions. If first-try step success **or** resolution rate drops by **more than 10 points** compared with the previous version, **roll back automatically** to the earlier version and flag the batch.

---

## 4. Example batch report (format)

```
Batch #3 · sessions 51–75 · 412 observations (37 dropped: 21 low-conf, 9 PII, 7 no outcome)

Global:  resolution 84% (+3) · first-try step success 71% (+5) · median call 3m40s
Top errors: wrong_input_source 18% · not_seated 15% · wrong_port 12%

Accepted:
  + D4-001 (trial) "Smart TV stuck on 'No signal' after console swap → disable HDMI-CEC auto input"
      evidence 7 sessions / 6 callers / 86%
  ↑ D3-003 promoted to established (17 sessions / 12 callers / 91%)
Rejected:
  ✗ "Remove PSU cover to reset fuse": G6 safety blocklist
  ✗ "Use cable brand X": G8 brand promotion
  ✗ D1-002 rewrite: G4, one caller provided 45% of evidence
```
