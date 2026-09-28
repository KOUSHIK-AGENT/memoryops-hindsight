# MemoryOps

**AI that remembers how your team solved problems before.**

When something breaks today, MemoryOps searches the problems your team has already solved. If it finds a similar one, it shows what happened, what caused it, what fixed it, and what to check today. When today's problem is fixed, MemoryOps saves the solution so it can help next time.

## Why memory matters

Teams keep solving the same kinds of problems, but the useful knowledge ends up scattered across tickets, chats, and people's heads. A normal AI assistant starts from zero every time. MemoryOps starts from your team's experience. The demo shows this directly: the **same** problem gets a generic answer before memory is loaded and a specific answer after.

## Where Hindsight is used

All memory lives in [Hindsight](https://hindsight.vectorize.io). MemoryOps does not keep a memory store of its own.

| Step | Hindsight API | What MemoryOps does |
|---|---|---|
| **Retain** | `POST /v1/default/banks/{bank}/memories` | Stores the sample solved problems, and later today's solution. Each one gets a stable `document_id`, so loading the samples again replaces them instead of creating duplicates. |
| **Recall** | `POST /v1/default/banks/{bank}/memories/recall` | Searches memory for today's problem. The recalled facts are grouped by the document they came from, and the original text is read from the returned chunks to build the incident card. |
| **Reflect** | `POST /v1/default/banks/{bank}/reflect` | Reasons over the recalled memory using a JSON `response_schema` and returns a likely pattern, three checks, why, and a safety note. If the schema is rejected, it retries once as plain text. |

Truthfulness rules the code enforces:
- If recall returns nothing, reflect is **not** called. The UI says "No similar solved problem was found" and shows general troubleshooting labelled as such.
- A recommendation is labelled "Memory used" only when reflect names an incident that recall **actually returned**.
- If recall succeeds but reflect fails, the UI still shows the recalled memory and reports the reflect error.
- Connection status comes from a real `GET /stats` call, and the memory count is Hindsight's `total_documents`.

## Architecture

```
Browser (public/: HTML/CSS/JS, no build step)
   ↓  /api/status  /api/seed  /api/analyze  /api/resolve
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
npm test
```

There are 16 tests using `node:test`. They run against a **fake Hindsight HTTP server** and never touch your real account. They cover status, validation, invalid JSON, the empty-memory path, recall attribution, rejecting a reflect answer that names an incident recall never returned, seeding without duplicates and blocking concurrent seeds, saving a resolution, 401/429/500 errors, timeouts, malformed responses, and checking that the API key never reaches the browser.

## Clean memory bank (for the "before" state)

**Reset screen** clears only the browser view. It does **not** delete anything in Hindsight. For a truly empty "before" state, use a bank ID you have never used:

```env
HINDSIGHT_BANK_ID=memoryops-final-demo-0928
```

Restart `npm start`. The header should show **Hindsight connected ✓**, and the Knowledge Bank should show **Memory is empty**. A bank that doesn't exist yet counts as empty, and Hindsight creates it on the first retain.

## Exact demo (about 3 minutes)

1. **Before.** With a fresh bank, click **Analyze problem**. You get *No similar solved problem was found* and general troubleshooting.
2. **Teach.** Click **Load past solved incidents**. Three solved problems are retained in Hindsight: checkout (similar), payments, and login (both different). This takes a few seconds because retain runs synchronously.
3. **After.** Click **Analyze problem** again on the same text. Hindsight recalls **INC-1042**, and you see what happened, the cause, what worked, and the lesson. The recommendation is labelled **Memory used** and gives three specific checks and a safety note. The other recalled incidents are listed as "judged less similar".
4. **Learn.** Click **Save solution to memory**. You see **Saved to Hindsight ✓**, and the memory count goes up by one. You can analyze again: today's saved solution can now be recalled too.

## Limitations

- The sample history is deterministic demo data. Recall and reflect results come from Hindsight, so the exact wording (and occasionally the match judgement) varies from run to run.
- A single shared memory bank. There is no login, no multi-tenancy, and no deletion of memories from the UI.
- MemoryOps only suggests checks. It never changes any system.
- Retain is synchronous, so loading samples or saving a solution can take several seconds.

## Future work / potential integrations (not implemented)

- Microsoft Teams: raise problems and save resolutions from a Teams channel
- Azure Monitor / Application Insights: fill in "what's happening" from real alerts
- Azure DevOps: attach deployment and change history as evidence
- Microsoft Entra ID: sign-in and a memory bank for each team
