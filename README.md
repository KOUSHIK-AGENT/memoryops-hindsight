# MemoryOps

**AI that remembers how your team solved problems before.**

Every time the team solves a problem, MemoryOps remembers what actually worked. When something similar happens later, it starts with that experience instead of starting from zero.

## How MemoryOps learns

```
Problem occurs → Hindsight recalls similar resolved incidents → MemoryOps recommends what to check
      → a person verifies, acts, and confirms the outcome → the verified outcome is retained
      → the next similar problem recalls it
```

MemoryOps gets more useful because **verified experience accumulates in Hindsight**. The model is not retraining itself. Safeguards:

- **Only human-confirmed outcomes are learned.** `/api/resolve` refuses to save unless the person ticks "I confirm this is what actually happened". Analysis never writes to memory, so AI recommendations are never stored as fact.
- **Confirmed and suspected are kept apart.** A cause is stored as `Confirmed cause:` only if the person marks it confirmed. Otherwise it is stored as `Suspected cause (not confirmed):`.
- **Learns from failure.** "Tried, but did NOT fix it" is stored separately. Reflect is told never to present those actions as the fix, and the UI shows them under "Already tried before, did NOT fix it".
- **No overwriting.** Each resolution gets a new unique `document_id` (`memoryops-MO-…`), so old evidence is never replaced. Sample incidents use fixed IDs, so loading them again replaces them instead of duplicating.
- **Provenance and conflicts are shown.** The UI names the recalled incident behind each recommendation and marks incidents "Learned from a previous resolved incident". Reflect reports conflicting memories in a `conflict_note` instead of silently picking one.
- **Feedback is a hint, not a fact.** "Helpful / Not relevant" is saved as a separate feedback memory. It appears on the incident card and never counts as an incident, cause, or fix.
- **The learning log is factual.** The Learning progress panel only reports what actually happened in this session, for example "0 relevant memories recalled → general troubleshooting", then "1 relevant resolved incident recalled (MO-…)". It shows no invented percentages.

## Why memory matters

Teams keep solving the same kinds of problems, but the useful knowledge ends up scattered across tickets, chats, and people's heads. A normal AI assistant starts from zero every time. MemoryOps starts from your team's experience. The demo shows this directly: the **same** problem gets a generic answer before memory is loaded and a specific answer after.

## Where Hindsight is used

All memory lives in [Hindsight](https://hindsight.vectorize.io). MemoryOps does not keep a memory store of its own.

| Step | Hindsight API | What MemoryOps does |
|---|---|---|
| **Retain** | `POST /v1/default/banks/{bank}/memories` | Stores human-confirmed resolutions (cause, failed attempts, what worked, outcome, lesson), optional sample history, and relevance feedback. |
| **Recall** | `POST /v1/default/banks/{bank}/memories/recall` | Searches memory for today's problem. The recalled facts are grouped by the document they came from, and the original text is read from the returned chunks to build the incident card. |
| **Reflect** | `POST /v1/default/banks/{bank}/reflect` | Reasons over memory using a JSON `response_schema`: pattern, three checks, why, a safety note, what not to repeat, conflicts, and a "Team learned" summary. If the schema is rejected, it retries once as plain text. |

Truthfulness rules the code enforces:
- If recall returns nothing, reflect is **not** called. The UI says "No similar solved problem was found" and shows general troubleshooting labelled as such.
- A recommendation is labelled "Memory used" only when reflect names an incident that recall **actually returned**.
- If recall succeeds but reflect fails, the UI still shows the recalled memory and reports the reflect error.
- Connection status comes from a real `GET /stats` call, and the memory count is Hindsight's `total_documents`.

## Architecture

```
Browser (public/: HTML/CSS/JS, no build step)
   ↓  /api/status  /api/seed  /api/analyze  /api/resolve  /api/feedback
MemoryOps Node API (server.mjs, no dependencies, API key stays server-side)
   ↓  Bearer auth, timeouts, error mapping
Hindsight Cloud
   ↓
Retain / Recall / Reflect
```

## Run it

Requires Node.js 18 or newer.

```bash
cp .env.example .env        # then set HINDSIGHT_API_KEY and a fresh HINDSIGHT_BANK_ID
npm start                   # http://localhost:3000
```

On Windows PowerShell, run `Copy-Item .env.example .env` and then `notepad .env`.

## Test it

```bash
npm test          # 19 tests against a fake Hindsight server; never touches your account
npm run smoke     # the 7 learning-loop acceptance checks against your REAL bank (server must be running)
```

`npm test` covers status, validation, the empty-memory path, attribution only to recalled incidents, the confirmed-only save, suspected versus confirmed causes, feedback isolation, seeding without duplicates, 401/429/500 errors, timeouts, malformed responses, key non-leakage, and a full learning-loop scenario (with scripted recall).

`npm run smoke` runs these checks against real Hindsight:
1. A fresh bank gives no fake match.
2. A confirmed fix is retained.
3. A reworded problem recalls it.
4. The recommendation is attributed to it.
5. A second outcome is kept alongside the first.
6. An unrelated problem is not matched.
7. Analysis stores nothing, and unconfirmed saves are refused.

It writes to the bank, so use a fresh `HINDSIGHT_BANK_ID`.

## Clean memory bank (for the "before" state)

**Reset screen** clears only the browser view. It does **not** delete anything in Hindsight. For a truly empty "before" state, use a bank ID you have never used:

```env
HINDSIGHT_BANK_ID=memoryops-final-demo-0928
```

Restart `npm start`. The header should show **Hindsight connected ✓**, and the Knowledge Bank should show **Memory is empty**. A bank that doesn't exist yet counts as empty, and Hindsight creates it on the first retain.

## Exact demo: three rounds (about 3 minutes, fresh bank)

The **Demo problems** buttons (Round 1 / Round 2 · reworded / Unrelated) fill in both the problem and the outcome a person would confirm.

1. **Round 1: before.** Click **Analyze problem**. You get *No similar solved problem was found* and general troubleshooting. The log shows "0 relevant memories recalled".
2. **Human fixes it.** In Step 4 the fields show the confirmed cause (30 → 5), what did not work (restarting only), and what worked. Tick **I confirm this is what actually happened**, then click **Save verified experience**. You see **✓ Experience learned**.
3. **Round 2: reworded.** Click **Round 2 · reworded**, then **Analyze problem**. Hindsight recalls the Round 1 resolution, marked "Learned from a previous resolved incident". You see the confirmed cause, what worked, and "Already tried before, did NOT fix it". Click **Helpful**.
4. **Round 3: accumulate.** Confirm and save the Round 2 outcome, which has a different cause (a configuration template). The memory count grows, and the log shows experience building up.
5. **Unrelated.** Click **Unrelated**, then **Analyze problem**. MemoryOps does not reuse the checkout experience.

*Load past solved incidents* is optional: it adds 3 sample incidents if you want a richer bank to start with.

## Limitations

- The sample history is deterministic demo data. Recall and reflect results come from Hindsight, so the exact wording (and occasionally the match judgement) varies from run to run.
- A single shared memory bank. There is no login, no multi-tenancy, and no deletion of memories from the UI.
- MemoryOps only suggests checks. Learning changes the evidence available, never what the system is allowed to do. A person verifies, acts, and confirms, and there is no automatic fix.
- The memory count is Hindsight's `total_documents`, which includes feedback notes.
- Possible future metrics (not measured today): relevant incidents recalled, verified resolutions stored, usefulness feedback, and time to resolve repeat incidents.
- Retain is synchronous, so loading samples or saving a solution can take several seconds.

## Future work / potential integrations (not implemented)

- Microsoft Teams: raise problems and save resolutions from a Teams channel
- Azure Monitor / Application Insights: fill in "what's happening" from real alerts
- Azure DevOps: attach deployment and change history as evidence
- Microsoft Entra ID: sign-in and a memory bank for each team
