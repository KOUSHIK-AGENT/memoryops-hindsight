# MemoryOps — Hindsight-powered incident response demo

MemoryOps is a compact hackathon demo that makes **persistent agent memory the visible product behavior**.

The story is simple:

1. A new production incident arrives.
2. With no history, the agent can only give generic triage.
3. You seed a few previously resolved incidents into **Hindsight**.
4. The same incident is analyzed again.
5. Hindsight recalls the closest past incident and `reflect` turns that evidence into specific first checks.
6. When the current incident is resolved, the resolution is retained so the agent gets better next time.

## Why this is a strong demo

The “before vs after memory” difference is visible in under a minute. The agent is not just a chatbot with a memory feature bolted on; the usefulness of its recommendation depends on historical incident memory.

## Tech

- Node.js 18+ (no npm dependencies)
- Vanilla HTML/CSS/JS
- Hindsight Cloud REST API
- Hindsight `retain`, `recall`, and `reflect`

## Run locally

```bash
cp .env.example .env
# edit .env and add HINDSIGHT_API_KEY
npm start
```

Open:

```text
http://localhost:3000
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
notepad .env
npm start
```

## Get a Hindsight key

Create a Hindsight Cloud account, create/copy an API key, and put it in `.env`.

Recommended `.env`:

```env
HINDSIGHT_API_KEY=hsk_your_key
HINDSIGHT_BANK_ID=memoryops-demo-yourname
HINDSIGHT_BASE_URL=https://api.hindsight.vectorize.io
PORT=3000
MOCK_MODE=0
```

Use a fresh `HINDSIGHT_BANK_ID` when you want a clean “before memory” state.

## Demo sequence

### 1. Show the “before” state

Open the app and click **Analyze with memory** before seeding any incidents.

Expected story:

> “There is no useful incident history yet, so the system can only offer generic triage.”

### 2. Teach the agent

Click **Teach agent past incidents**.

This calls Hindsight `retain` for three resolved incidents.

### 3. Show the “after” state

Click **Analyze with memory** again.

The checkout incident should now retrieve the earlier checkout/DB-pool incident, and the response should become much more specific.

### 4. Close the learning loop

Click **Save resolution to Hindsight**.

Explain:

> “The next outage starts with the resolution we learned today instead of starting from zero.”

## API routes in this demo

- `GET /api/status`
- `POST /api/seed`
- `POST /api/analyze`
- `POST /api/resolve`

## Hindsight operations used

### Retain

```http
POST /v1/default/banks/{bank_id}/memories
Authorization: Bearer hsk_...
Content-Type: application/json

{
  "items": [{
    "content": "Resolved incident ...",
    "context": "Resolved incident INC-1042"
  }]
}
```

### Recall

```http
POST /v1/default/banks/{bank_id}/memories/recall

{
  "query": "checkout-api 502 DB acquire timeout"
}
```

### Reflect

```http
POST /v1/default/banks/{bank_id}/reflect

{
  "query": "Use remembered incidents as historical evidence and recommend the first checks..."
}
```

## Local UI-only testing

If you need to test the interface before obtaining a Hindsight key:

```env
MOCK_MODE=1
```

Do **not** use mock mode for the final recorded demo. The final demo should show real Hindsight calls.

## Suggested 3-minute recording

**0:00–0:25** — “Production teams keep solving the same classes of incidents, but the useful context is scattered across tickets and postmortems. MemoryOps turns resolved incidents into reusable operational memory.”

**0:25–0:55** — Analyze the checkout incident with an empty bank. Point out the generic response.

**0:55–1:20** — Click “Teach agent past incidents.” Explain that each resolution is retained in Hindsight as experience.

**1:20–2:10** — Analyze again. Show the recalled checkout incident and the specific DB-pool checks.

**2:10–2:35** — Save the current resolution. Explain the learning loop.

**2:35–3:00** — Show the code briefly: retain → recall → reflect. Close with: “The agent is useful because it remembers what actually worked, not because it can generate more text.”

## Production-style improvements if time remains

- Separate memory bank per organization/team
- Incident tags (service, severity, environment)
- Microsoft Teams bot or webhook
- Azure Monitor / Application Insights event ingestion
- Evidence links back to the original incident or postmortem
- Approval gate before executing any remediation
- Metrics: time-to-first-useful-action and repeat-incident MTTR

## Submission checklist

- Clean public GitHub repository
- Working live demo
- 2–5 minute public YouTube demo
- Clear explanation of Hindsight retain/recall/reflect
- Article and social post completed according to the provided content guide
- Screenshots of the UI and memory evidence
- Never commit `.env` or the Hindsight API key
