# MemoryOps — Submission

**One-line pitch:** AI that remembers how your team solved problems before.

## Problem
Teams keep solving the same kinds of technical problems. What they learned (the cause, the fix, the lesson) gets scattered across tickets, chats, and people's memories, so each new problem starts almost from zero. A regular AI assistant has the same gap: it has no memory of your team's past.

## Solution
Every time the team solves a problem, MemoryOps remembers what actually worked. When something similar happens later, it starts with that experience instead of starting from zero.

The self-learning loop: recall similar resolved incidents → recommend what to check → a person verifies, acts, and confirms the outcome → the **verified** outcome is retained in Hindsight, including what did *not* work → the next similar problem recalls it. MemoryOps becomes more useful as verified incident experience accumulates. It does not claim that the model retrains itself.

## Diagnostic intelligence
MemoryOps doesn't just search old incidents. It remembers verified outcomes, knows what failed before, combines evidence from several incidents, detects conflicting historical causes, and guides the engineer through the next best diagnostic check. It learns recurring team patterns (only from at least 3 confirmed incidents, keeping exceptions), turns them into evidence-backed playbooks, and abstains when memory is insufficient. Confidence levels (HIGH/MEDIUM/LOW/INSUFFICIENT) are deterministic and based on evidence; no percentages are invented. Only human-confirmed outcomes become long-term knowledge; observations made during diagnosis stay session-only until a person confirms the outcome.

## Memory dataset (bootstrap)
MemoryOps is not fine-tuning the underlying language model. It bootstraps Hindsight with 50 synthetic, confirmed-resolved incidents across 10 categories. They include failed attempts, suspicions that were ruled out, and deliberate conflicts (the same symptoms with different causes). It then keeps learning from human-confirmed resolutions. Ingestion is duplicate-safe (stable document IDs, and unchanged records are skipped). A held-out set of 20 evaluation cases measures real Hindsight retrieval (`npm run memory:evaluate`). No accuracy figures are claimed here until that has been run against a real bank.

## Why Hindsight matters
Without memory, MemoryOps can only offer general troubleshooting. With Hindsight, the **same** problem description brings back a real past incident and a recommendation grounded in it. The demo shows this before/after difference directly.

## How Hindsight is used
- **Retain:** stores only human-confirmed resolutions (confirmed or suspected cause, failed attempts, what worked, outcome, lesson), each as a new document so earlier evidence is never overwritten. It also stores relevance feedback as separate hint-only memories.
- **Recall:** finds similar past problems. Results are grouped by source document, and the original text comes from the returned chunks.
- **Reflect:** reasons over memory and returns structured output: pattern, three checks, why, a safety note, what not to repeat, conflicts between memories, and a "Team learned" summary.

## Architecture
Browser (vanilla HTML/CSS/JS) → MemoryOps Node API (`server.mjs`, zero dependencies) → Hindsight Cloud (retain / recall / reflect)

## Demo story (fresh bank)
1. **Round 1:** "Checkout broke after an update" gets no memory, so the answer is general troubleshooting. The engineer fixes it and confirms the cause (the connection limit went from 30 to 5), what did not work (restarting only), and what worked. The outcome is saved.
2. **Round 2:** "Checkout unavailable after today's release, database capacity exhausted" is worded differently, but Hindsight recalls Round 1. The answer names the confirmed cause, what worked, what not to repeat, and what to verify today.
3. **Round 3:** another verified outcome is saved, and the experience keeps adding up.
4. An unrelated problem does **not** reuse the checkout experience.

## Technical highlights
- Structured reflect output, with a fallback to plain text if the schema is rejected.
- Memory is only attributed when the incident was actually recalled. No fabricated matches, scores, or counts.
- Timeouts on every Hindsight call, clear error mapping (401/404/429/5xx/timeout/malformed), and protection against concurrent seeding.
- The API key stays server-side and is redacted from any error text.
- Guardrails against reinforcing its own mistakes: only confirmed outcomes are learned, confirmed and suspected causes are kept apart, attempts that worked are kept apart from ones that failed, and nothing is overwritten.
- 48 automated tests against a fake Hindsight server (`npm test`), plus `npm run smoke`, which runs the 7 learning-loop acceptance checks against a real bank.

## Real-world value
Getting to a useful first step faster on repeat problems, and keeping team knowledge when people move on. These are the intended benefits. We have **not** measured them. The UI shows only factual progress, such as "0 relevant memories recalled" followed by "1 relevant resolved incident recalled". Possible future metrics: verified resolutions stored, usefulness feedback, and time to resolve repeat incidents.

## Safety
Past incidents are shown as evidence, not certainty. Every recommendation tells the team to verify today's system before applying a previous fix. Learning changes the evidence available, not what MemoryOps is allowed to do: memory recommends, then a person verifies, acts, and confirms, and only then does memory learn. MemoryOps never changes any system.

## Known limitations
The dataset is synthetic and the evaluation set is small (20 cases). Reflect wording varies between runs. There is one shared bank with no authentication. Memories can't be deleted from the UI (use a fresh bank ID instead). Retain is synchronous, so it can take a few seconds.

## Future Microsoft integration (not implemented)
Microsoft Teams (report and resolve from chat), Azure Monitor / Application Insights (problems from real alerts), Azure DevOps (deployment history as evidence), Microsoft Entra ID (sign-in and a memory bank for each team).
