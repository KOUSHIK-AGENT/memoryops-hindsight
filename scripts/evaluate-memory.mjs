// Held-out evaluation of MemoryOps memory retrieval against a real Hindsight bank.
//   npm run memory:evaluate -- --bank memoryops-evaluation-v1 [--k 3] [--recall-only] [--json results.json]
// Each case runs the same pipeline as the app (Hindsight recall -> MemoryOps grouping -> reflect judgement).
// Nothing here knows the expected answers except the final comparison.
import fs from "node:fs";
import { DATASET_PATH, EVAL_PATH, loadJson, validateEvalCase } from "../lib/dataset.mjs";
import { parseArgs, loadMemoryApi, sleep } from "./cli.mjs";

const USAGE = "Usage: npm run memory:evaluate -- --bank <bank-id> [--k 3] [--recall-only] [--cases data/evaluation-cases.json] [--json out.json]";
const args = parseArgs(process.argv.slice(2));
const K = Math.max(1, Number(args.k) || 3);
const recallOnly = Boolean(args["recall-only"]);

const dataset = loadJson(DATASET_PATH);
const cases = loadJson(typeof args.cases === "string" ? args.cases : EVAL_PATH);
const ids = new Set(dataset.map((r) => r.incident_id));
const invalid = cases.map((c) => [c.id, validateEvalCase(c, ids)]).filter(([, e]) => e.length);
if (invalid.length) {
  for (const [id, e] of invalid) console.error(`${id}: ${e.join("; ")}`);
  process.exit(1);
}

const { analyzeIncident, recallMatches, hindsightFetch, BANK_PATH, BANK_ID } = await loadMemoryApi(args.bank ?? process.env.MEMORYOPS_EVAL_BANK, USAGE);

let stats;
try {
  stats = await hindsightFetch(`${BANK_PATH}/stats`, { timeoutMs: 15000 });
} catch (err) {
  console.error(err.code === "hindsight_not_found" ? `Bank "${BANK_ID}" does not exist yet. Run npm run memory:seed -- --bank ${BANK_ID} first.` : `Cannot read bank: ${err.message}`);
  process.exit(1);
}

const results = [];
for (const c of cases) {
  const r = { id: c.id, type: c.type, query: c.query, expected: c.expected_incident_ids, should_match: c.should_match };
  try {
    if (recallOnly) {
      r.ranking = (await recallMatches(c.query)).map((m) => ({ id: m.incidentId, score: m.score }));
    } else {
      const a = await analyzeIncident(c.query);
      r.ranking = a.matches.map((m) => ({ id: m.incidentId, score: m.score }));
      r.state = a.state;
      r.memoryUsed = Boolean(a.recommendation?.memoryUsed);
      r.matched = a.recommendation?.matchedIncidentId ?? null;
      if (a.reflectError) r.error = `reflect: ${a.reflectError.message}`;
    }
  } catch (err) {
    r.error = err.message;
  }
  results.push(r);
  process.stdout.write(".");
  await sleep(250);
}
console.log("\n");

const ok = results.filter((r) => !r.error);
const matchCases = ok.filter((r) => r.should_match);
const noMatchCases = ok.filter((r) => !r.should_match);
const inTop = (r, k) => r.ranking.slice(0, k).some((x) => r.expected.includes(x.id));
const top1 = matchCases.filter((r) => inTop(r, 1));
const topK = matchCases.filter((r) => inTop(r, K));
const decided = (r) => r.memoryUsed && r.expected.includes(r.matched);
const scoresAvailable = ok.some((r) => r.ranking.some((x) => Number.isFinite(x.score)));

console.log("MEMORYOPS MEMORY EVALUATION");
console.log(`Bank: ${BANK_ID}  (${stats.total_documents ?? "?"} documents, ${stats.total_nodes ?? "?"} facts)`);
console.log(`Dataset: ${dataset.length} incidents   Held-out queries: ${cases.length}   Mode: ${recallOnly ? "recall only" : "recall + reflect (full app pipeline)"}\n`);
console.log(`Top-1 expected retrieval:   ${top1.length} / ${matchCases.length}`);
console.log(`Top-${K} expected retrieval:   ${topK.length} / ${matchCases.length}`);
if (!recallOnly) {
  const correctNo = noMatchCases.filter((r) => !r.memoryUsed);
  const falseMatches = ok.filter((r) => r.memoryUsed && !r.expected.includes(r.matched));
  const missed = matchCases.filter((r) => !r.memoryUsed);
  console.log(`Memory used with a correct incident: ${matchCases.filter(decided).length} / ${matchCases.length}`);
  console.log(`Correct no-match behaviour:  ${correctNo.length} / ${noMatchCases.length}`);
  console.log(`False matches:               ${falseMatches.length}`);
  console.log(`Missed matches (no memory used when one was expected): ${missed.length}`);
} else {
  console.log("No-match behaviour: not measured in --recall-only mode (recall always returns its nearest memories; the app's match decision is made by reflect).");
}
console.log(`Failed requests:             ${results.length - ok.length}`);
console.log(`Similarity scores: ${scoresAvailable ? "Hindsight reranker scores shown below (0-1, from recall)" : "not returned by Hindsight; none shown"}\n`);

const fmt = (r) => r.ranking.slice(0, K).map((x) => `${x.id}${Number.isFinite(x.score) ? ` (${x.score.toFixed(2)})` : ""}`).join(", ") || "nothing";
for (const r of results) {
  let pass, reason;
  if (r.error) { pass = false; reason = `request failed: ${r.error}`; }
  else if (r.should_match) {
    pass = inTop(r, K) && (recallOnly || decided(r));
    reason = !inTop(r, K) ? `expected incident not in top ${K}` : !recallOnly && !r.memoryUsed ? "recalled, but reflect judged it not similar" : !recallOnly && !decided(r) ? `reflect chose ${r.matched}` : "";
  } else {
    pass = recallOnly ? true : !r.memoryUsed;
    reason = pass ? "" : `false match: memory used from ${r.matched}`;
  }
  if (!pass) {
    console.log(`FAIL ${r.id} [${r.type}]\n  Query: "${r.query}"\n  Expected: ${r.expected.join(", ") || "no match"}\n  Retrieved: ${fmt(r)}${recallOnly ? "" : `\n  Decision: ${r.memoryUsed ? `memory used (${r.matched})` : "no memory used"}`}\n  Reason: ${reason}\n`);
  } else {
    console.log(`PASS ${r.id} [${r.type}]  top: ${fmt(r)}${!recallOnly && r.memoryUsed ? `  -> used ${r.matched}` : ""}`);
  }
}

if (typeof args.json === "string") {
  fs.writeFileSync(args.json, JSON.stringify({ bank: BANK_ID, k: K, recallOnly, ranAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nRaw results written to ${args.json}`);
}
