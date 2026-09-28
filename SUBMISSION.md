# MemoryOps — Submission

**One-line pitch:** AI that remembers how your team solved problems before.

## Problem
Teams keep solving the same kinds of technical problems. What they learned (the cause, the fix, the lesson) gets scattered across tickets, chats, and people's memories, so each new problem starts almost from zero. A regular AI assistant has the same gap: it has no memory of your team's past.

## Solution
MemoryOps stores solved problems in Hindsight long-term memory. When a new problem arrives, it recalls the most similar solved problem and shows what happened, what caused it, and what worked. It then turns that into specific checks for today. Once the problem is fixed, today's solution is saved back to memory.

## Why Hindsight matters
Without memory, MemoryOps can only offer general troubleshooting. With Hindsight, the **same** problem description brings back a real past incident and a recommendation grounded in it. The demo shows this before/after difference directly.

## How Hindsight is used
- **Retain:** stores sample solved problems and today's resolution, each with a stable `document_id`, so loading the samples again doesn't create duplicates.
- **Recall:** finds similar past problems. Results are grouped by source document, and the original text comes from the returned chunks.
- **Reflect:** reasons over the recalled memory and returns structured output (pattern, three checks, why, safety note).

## Architecture
Browser (vanilla HTML/CSS/JS) → MemoryOps Node API (`server.mjs`, zero dependencies) → Hindsight Cloud (retain / recall / reflect)

## Demo story
1. Before memory: today's checkout problem gets no match, so the answer is general troubleshooting.
2. Load 3 past solved problems into Hindsight.
3. After memory: Hindsight recalls INC-1042, where checkout broke after an update because the database connection limit had dropped from 30 to 5. MemoryOps recommends comparing the connection settings, checking saturation, and verifying whether the update changed them.
4. Save today's fix. It becomes experience the next person can use.

## Technical highlights
- Structured reflect output, with a fallback to plain text if the schema is rejected.
- Memory is only attributed when the incident was actually recalled. No fabricated matches, scores, or counts.
- Timeouts on every Hindsight call, clear error mapping (401/404/429/5xx/timeout/malformed), and protection against concurrent seeding.
- The API key stays server-side and is redacted from any error text.
- 16 automated tests against a fake Hindsight server (`npm test`).

## Real-world value
Getting to a useful first step faster on repeat problems, and keeping team knowledge when people move on. These are the intended benefits. We have **not** measured them.

## Safety
Past incidents are shown as evidence, not certainty. Every recommendation tells the team to verify today's system before applying a previous fix. MemoryOps never changes any system.

## Known limitations
The sample history is demo data, and reflect wording varies between runs. There is one shared bank with no authentication. Memories can't be deleted from the UI (use a fresh bank ID instead). Retain is synchronous, so it can take a few seconds.

## Future Microsoft integration (not implemented)
Microsoft Teams (report and resolve from chat), Azure Monitor / Application Insights (problems from real alerts), Azure DevOps (deployment history as evidence), Microsoft Entra ID (sign-in and a memory bank for each team).
