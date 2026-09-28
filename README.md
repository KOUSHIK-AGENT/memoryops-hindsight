# MemoryOps

**AI that remembers how your team solved problems before.**

An incident intelligence copilot that is **useful on day one and becomes team-specific over time**. MemoryOps combines a frontier reasoning model with a curated, cited technical knowledge corpus and Hindsight-based private team memory. It does **not** train or fine-tune a language model.

Every time the team solves a problem, MemoryOps remembers what actually worked. When something similar happens later, it starts with that experience instead of starting from zero. Before the team has any history, it still helps, using documented operational knowledge that is clearly labelled as such.

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

## Useful on day one: sources, priority and response modes

Every part of an answer carries its source, and sources are never blended:

| Source | What it is | Stored in team memory? |
|---|---|---|
| `SESSION EVIDENCE` | What the engineer observed during this session | Only inside a confirmed resolution |
| `TEAM MEMORY` | Human-confirmed incidents recalled from Hindsight | Yes (it *is* team memory) |
| `TEAM PATTERN` | Patterns / playbooks from 3+ confirmed team incidents | Yes |
| `PUBLIC DOCUMENTATION` | Excerpts from official docs, with URL, publisher, licence, retrieval time | Never |
| `CURATED KNOWLEDGE` | 150 structured troubleshooting entries (`knowledge/curated/`) | Never |
| `GENERAL KNOWLEDGE` | Model reasoning without a cited source | Never |

Priority: current observations > verified team experience > team patterns/playbooks > documentation > curated knowledge > general knowledge.

The response mode is decided deterministically from the evidence (`lib/modes.mjs`):

- **TEAM-LED**: a recalled, confirmed team incident supports the answer (memory confidence MEDIUM/HIGH). Team hypotheses come first; documented knowledge only fills remaining slots and never duplicates a team hypothesis.
- **HYBRID**: some related team experience, but not enough to rely on. Team and documented evidence are shown separately.
- **KNOWLEDGE-LED**: no similar team incident. *"MemoryOps has not seen a similar verified team incident yet. Based on documented operational knowledge, these are the possibilities to investigate."* Up to 3 hypotheses with evidence, a next check, and what you'd expect if each is true. Knowledge alone never reaches HIGH confidence, and it never changes the team-memory confidence.
- **INSUFFICIENT EVIDENCE**: nothing matches closely enough. You get exactly one next best check.

**Suggested fix labels.** `VERIFIED TEAM FIX` comes only from a recalled, human-confirmed incident whose own text states the setting and both values. `GENERAL EXAMPLE` comes from curated knowledge and uses placeholders only (`<last known-good value>`); values are never invented.

**Knowledge → team memory promotion.** A documented hypothesis becomes team memory only when a person's observations support it and they confirm the outcome. The saved resolution is a normal human-confirmed incident with the line `Originally suggested by: curated knowledge KB-… (investigated and confirmed by a person)`. AI hypotheses are never stored automatically.

**What MemoryOps knows** (`GET /api/knowledge`, right-hand panel): real counts of confirmed team incidents, patterns, playbooks, curated entries and documentation excerpts. Knowledge maturity per category is *Established* (3+ confirmed team incidents), *Some* (1–2) or *No team experience yet*, with the number of documented entries shown separately. There are no percentages.

### Knowledge corpus and ingestion

```
knowledge/sources.json                     allow-list: publisher, licence, licence status, trust level, URLs
knowledge/curated/troubleshooting-pack.json 150 entries, 41 technologies (SYNTHETIC, written for MemoryOps)
knowledge/raw/                             fetched pages (git-ignored)
knowledge/processed/docs.json              cleaned, chunked, de-duplicated excerpts with full metadata
```

```bash
npm run knowledge:fetch      # only sources with licence_status "permissive"; honours robots.txt
npm run knowledge:process    # strip boilerplate (nav, scripts, link-dense menus) → chunk by heading → redact → dedupe
npm run knowledge:evaluate   # held-out retrieval evaluation, local and deterministic
npm run knowledge:ingest -- --bank <separate-knowledge-bank>   # optional; refuses to write into the team bank
```

The pipeline is fetch → normalize → strip boilerplate → dedupe → chunk → metadata → index (BM25, per corpus) → retrieve. Each chunk carries `source_id, title, source_url, publisher, retrieved_at, document_type, technology, topic, version, license, trust_level, content, chunk_id`. Reference-only sources (for example MDN, Redis, NGINX) are cited but never fetched. The committed `docs.json` currently holds only the Node.js errors page, because the build sandbox's network blocked the other doc sites; run `knowledge:fetch` and `knowledge:process` locally to add the rest.

`MEMORYOPS_LIVE_DOCS=1` turns on an optional live lookup (off by default). It fetches only the permissive pages cited by the top curated entry, honours robots.txt, caches for an hour, and shows excerpts with URL and retrieval time. Nothing it returns is stored.

Knowledge evaluation (`npm run knowledge:evaluate`, 28 held-out queries written separately from the pack; a test checks that no query copies a 6-word sequence from it):

| Metric | Result |
|---|---|
| Top-1 relevant | 23 / 24 |
| Top-3 relevant | 24 / 24 |
| Correct abstention on unrelated queries | 4 / 4 (0 false positives) |
| Provenance labelled CURATED_KNOWLEDGE | 28 / 28 |
| Top hit cites the expected authoritative source | 24 / 24 |
| Produces hypotheses with a next check | 24 / 24 |
| General examples use placeholders only | yes |

These numbers are for the local curated corpus only. They say nothing about Hindsight retrieval on real incidents (see `memory:evaluate`).

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
   ↓  /api/status  /api/knowledge  /api/seed  /api/analyze  /api/diagnose  /api/resolve  /api/feedback
MemoryOps Node API (server.mjs, no dependencies, API key stays server-side)
   ├─ local knowledge corpus (lib/knowledge.mjs: curated pack + processed docs, BM25; never team memory)
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
npm test          # 67 tests (server, dataset, ingestion, reasoning, fixes, knowledge) against fake Hindsight; never touches your account
npm run smoke     # the 7 learning-loop acceptance checks against your REAL bank (server must be running)
                  # (same as npm run memory:smoke)
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

## Memory Dataset

**MemoryOps is not fine-tuning the underlying language model. It bootstraps Hindsight with verified incident experience and continues learning from human-confirmed resolutions.**

- **Corpus:** `data/incidents.json` contains 50 **synthetic** resolved incidents, 5 in each of 10 categories: checkout, payments, login/authentication, database, slow APIs/latency, deployment/configuration, storage, certificates/TLS, background queues, and external dependencies. No real company data is used.
- **Structure:** each record has `incident_id, title, service, category, severity, environment, symptoms[], context, suspected_causes[]` (ruled out), `confirmed_root_cause, attempted_actions[]` (each with `worked: false | "partial"` and an observation), `successful_action, outcome, lesson_learned, verification, status: "confirmed_resolved", timestamp`. Validation rejects anything else: unconfirmed status, attempted actions marked as having worked, unknown categories, bad dates, or duplicate IDs.
- **Conflicting memories on purpose:** INC-1042, INC-1010, and INC-1001 are all "checkout failing after a release", but their causes were a database connection pool, an expired dependency certificate, and a payment-provider outage. The same symptoms do not mean the same cause. Reflect is told to list the checks that tell the causes apart and to report conflicts.
- **Memory text:** `lib/dataset.mjs` turns each record into a deterministic, labelled natural-language memory: *What happened, Context, Initially suspected but ruled out, Confirmed cause, Tried but did NOT fix it, Tried and helped only partially, What worked, Outcome, Verification, Lesson learned*. The app's incident cards read these fields back from recalled chunks.

### Ingestion

```bash
npm run memory:seed -- --bank memoryops-training-v1            # all 50
npm run memory:seed -- --bank memoryops-training-v1 --dry-run  # validate + print one memory, no network
```

- **A bank must be named explicitly,** so development runs never write to your demo bank by accident. Suggested banks: `memoryops-training-v1`, `memoryops-evaluation-v1`, `memoryops-final-demo`.
- **Duplicate-safe:** each incident's `document_id` is `memoryops-INC-xxxx`. Hindsight upserts on `document_id` by deleting the old version and re-processing. Before sending anything, the script calls `GET /documents/{id}` and skips incidents whose stored `original_text` is unchanged. A second run therefore reports `50 unchanged` and sends nothing.
- **Batching and errors:** synchronous retains in batches of 5 (`--batch-size`). 429, 5xx, timeout, and network errors are retried up to 3 times with exponential backoff; Hindsight documents no rate limits, so this is deliberately conservative. On 401/403 the script stops immediately. The API key is never printed.
- **Shared with the app:** the *Load sample history* button stores 3 records from this same dataset with the same document IDs, so the button and the script never duplicate each other.

### Evaluation (held out)

```bash
npm run memory:evaluate -- --bank memoryops-evaluation-v1           # recall + reflect, the real app pipeline
npm run memory:evaluate -- --bank memoryops-evaluation-v1 --recall-only --k 5 --json eval.json
```

- `data/evaluation-cases.json` has 20 cases: 13 reworded, 1 ambiguous, 2 with several plausible matches, and 4 that should not match (2 unrelated, 2 technical with no comparable incident). The expected category, expected incident IDs, `should_match`, and notes are only used for scoring.
- **Held out:** queries are written independently of the dataset. A unit test fails if any query shares a 6-word phrase with any memory text.
- **No gaming:** the harness calls the same `analyzeIncident()` the app uses (real Hindsight recall, then reflect's match judgement). Expected answers are only compared after the results come back.
- **Report:** Top-1 and Top-K retrieval, correct no-match behaviour, false matches, missed matches, failed requests, and every failure with what was retrieved. Hindsight reranker scores are shown only when Hindsight returns them. `--recall-only` skips reflect and does not score no-match behaviour, because recall always returns its nearest memories.

### How bootstrap and continuous learning fit together

The dataset gives the bank its **initial experience**. From then on, each human-confirmed resolution saved in the app becomes a new `memoryops-MO-…` document in the same bank. It is recalled alongside the dataset and never overwrites it. The Knowledge Bank badge shows exact counts from Hindsight (`GET /documents?q=<prefix>` totals), for example *50 historical incidents · 2 learned*. AI recommendations and feedback never become verified incidents.

## Clean memory bank (for the "before" state)

**Reset** clears only the browser view. It does **not** delete anything in Hindsight. For a truly empty "before" state, use a bank ID you have never used:

```env
HINDSIGHT_BANK_ID=memoryops-final-demo-0928
```

Restart `npm start`. The header should show **Hindsight connected ✓**, and the Knowledge Bank should show **Memory is empty**. A bank that doesn't exist yet counts as empty, and Hindsight creates it on the first retain.

## Diagnostic intelligence

MemoryOps does more than find a similar incident. Everything below is **deterministic application logic** over what Hindsight actually recalled (`lib/signals.mjs`, `lib/reasoning.mjs`, `lib/patterns.mjs`). No confidence number is invented, and none of it is LLM retraining.

- **Typed memory, weighted by authority:** human-confirmed successful outcome > human-confirmed failed attempt > team pattern backed by confirmed incidents > suspected cause > feedback hint. AI recommendations are never stored as evidence.
- **Confidence and abstention (`HIGH`, `MEDIUM`, `LOW`, `INSUFFICIENT`):** the level comes from how many recalled, *confirmed* incidents share today's explicitly stated facts (area, timing, symptoms). It is capped when causes conflict, when reflect finds nothing similar, when today's description contradicts the remembered cause, or when the team marked the memory "Not relevant". At `LOW` or `INSUFFICIENT` it says: *"MemoryOps does not have enough historical evidence for a confident memory-based recommendation."*
- **Multiple memories and conflicts:** up to 3 hypotheses, grouped by confirmed cause. If equally good matches had different causes, the UI shows *Conflicting history* instead of picking one.
- **Next best check:** each hypothesis carries its supporting memories, a next check (taken from the remembered lesson), and what you'd expect to see if it's true. You type what you observed (*"Current pool is 5. Previous version was 30."*) and the hypotheses update (`/api/diagnose`). Observations are **session evidence only**; they are saved only as part of a confirmed outcome.
- **Negative experience:** failed attempts are listed as *Previously tried, did NOT work*, and a guard removes any suggested check that just repeats a known failed action.
- **Suggested fix:** a config diff (for example `- CONNECTION_POOL_SIZE=5` / `+ CONNECTION_POOL_SIZE=30`) with a Copy button. It appears **only** when the recommendation is based on a recalled, human-confirmed incident whose own text states the setting and both values, and confidence is MEDIUM or HIGH (`lib/fixes.mjs`). The key name mirrors that incident's wording and is labelled as such. If your observations weaken that cause, the fix is set aside, and MemoryOps never applies it.
- **Why this recommendation?** Only facts that were actually shared or counted appear here, with the supporting incident IDs.
- **Team patterns (level-2 learning):** after each confirmed save, MemoryOps reads the confirmed incidents and creates or updates a `TEAM_PATTERN`. This needs **at least 3 independently confirmed incidents** with the same cause in the same situation (area plus timing); suspected causes don't count. Counterexamples are kept in the statement, for example *"…has been a recurring cause…, but similar symptoms have also come from certificate problems"*. Each pattern has a stable ID, so it is updated rather than duplicated, and incidents are never deleted.
- **Team playbook:** generated once a pattern exists. There is one step per confirmed cause in that situation, and each step shows *why this check exists* and which incidents support it. It is guidance only; a person runs every step.
- **Query normalization:** `normalizeQuery()` extracts explicit facts only. Adding them to the recall query is **off by default** and can be A/B tested with `npm run memory:evaluate -- --normalize`.

### Memory Quality Lab

```bash
npm run memory:seed     -- --bank memoryops-advanced-eval-v1
npm run memory:evaluate -- --bank memoryops-advanced-eval-v1 --json baseline.json            # frozen 20 cases
npm run memory:evaluate -- --bank memoryops-advanced-eval-v1 --normalize --json norm.json    # A/B
npm run memory:seed     -- --bank memoryops-lab-v1
npm run memory:lab      -- --bank memoryops-lab-v1        # WRITES test resolutions; use a dedicated bank
npm run memory:consolidate -- --bank <bank>              # show / update team patterns and playbooks
```

`memory:evaluate` reports RETRIEVAL (top-1, top-K), DECISION, ABSTENTION (correct no-match, false confident match), PROVENANCE, NEGATIVE EXPERIENCE, CONFLICT HANDLING and the spread of confidence levels. It then classifies every failure as `RETRIEVAL_MISS`, `BAD_RANKING`, `FALSE_POSITIVE`, `OVER_GENERIC_MEMORY`, `CONFLICT_ERROR`, `BAD_ABSTENTION`, `FAILED_ACTION_ERROR`, `PROVENANCE_ERROR` or `REFLECT_ERROR`. There is no combined "AI score". `memory:lab` checks pattern thresholds, counterexamples, playbook provenance, duplicate-safe consolidation, self-learning from different wording, negative experience and abstention against real Hindsight.

## Exact demo: five rounds (about 3 minutes, fresh bank)

The **Demo problems** buttons fill in both the problem and the outcome a person would confirm. The observation field suggests what a person would report.

1. **Round 1: no history.** Click **Analyze with MemoryOps**. Confidence is **INSUFFICIENT** and you get general troubleshooting. Record the observation *"Current pool is 5. Previous version was 30."*, tick **I confirm…**, then click **Save verified experience** to see **✓ Experience learned**.
2. **Round 2: reworded.** Hindsight recalls Round 1 (*Learned from a previous resolved incident*). You see what worked, *Previously tried, did NOT work* (restart only), *Why this recommendation?* and the **Next best check**. Record the observation, and the hypothesis becomes *supported*. Confirm and save.
3. **Round 3: another confirmed incident.** Analyze, then confirm and save. That makes 3 confirmed connection-limit incidents, so the log shows **Team has learned**, and a **Team playbook** is created.
4. **Round 4: same symptoms, different cause.** Today's text says the database looks healthy, so the remembered cause is *weakened* and confidence drops. The team pattern is shown, but it doesn't override the evidence. Record *"Connection pool is 30 as usual. Logs show the tax service certificate has expired."*: the next best check then says to investigate beyond memory. Confirm the certificate cause. The pattern updates to name the exception, and analyzing again shows **Conflicting history**.
5. **Unrelated.** Click **Unrelated**, then **Analyze with MemoryOps**. MemoryOps abstains.

*Load sample history* is optional: it adds 3 incidents from the dataset.

**Bootstrap variant** (shows bootstrap learning and continuous learning together): `npm run memory:seed -- --bank memoryops-final-demo`, set `HINDSIGHT_BANK_ID=memoryops-final-demo`, then `npm start`. The badge reads *50 historical incidents · 0 learned*.
1. Click **Round 2 · reworded**, then **Analyze with MemoryOps**. Hindsight recalls a dataset incident (INC-1042 in the intended case) with its cause, what worked, and what did not.
2. Confirm and save today's fix. The badge becomes *1 learned*.
3. Analyze a similar reworded problem. The newly learned `MO-…` resolution is recalled alongside the dataset.

## Limitations

- The curated troubleshooting pack is synthetic: written for MemoryOps from general operational practice and linked to authoritative references. No domain expert has reviewed it. It is labelled `SYNTHETIC`, and knowledge-led answers are framed as possibilities to investigate.
- Knowledge retrieval is lexical (BM25 with a small synonym map). Paraphrases with no shared vocabulary can be missed, and in that case MemoryOps abstains.

- Confidence, relevance, hypotheses and patterns come from a deterministic English keyword lexicon (`lib/signals.mjs`). Unusual wording can be missed; when that happens, MemoryOps under-claims (it abstains) rather than over-claims.
- Consolidation reads every incident document after each confirmed save (one `GET` per document). That is fine for hundreds of documents but not tuned for large banks.
- The 50-incident corpus is synthetic. Retrieval quality on it says nothing about real-world incident data, and 20 evaluation cases is a small sample.
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
