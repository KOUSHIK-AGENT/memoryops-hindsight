// Held-out evaluation of MemoryOps memory retrieval against a real Hindsight bank.
//   npm run memory:evaluate -- --bank memoryops-evaluation-v1 [--k 3] [--recall-only] [--json results.json]
// Each case runs the same pipeline as the app (Hindsight recall -> MemoryOps grouping -> reflect judgement).
// Nothing here knows the expected answers except the final comparison.
import fs from "node:fs";
import { DATASET_PATH, EVAL_PATH, loadJson, validateEvalCase } from "../lib/dataset.mjs";
import { parseArgs, loadMemoryApi, sleep } from "./cli.mjs";
import { suppressFailedChecks } from "../lib/reasoning.mjs";

const USAGE = "Usage: npm run memory:evaluate -- --bank <bank-id> [--k 3] [--recall-only] [--normalize] [--cases data/evaluation-cases.json] [--json out.json]";
const args = parseArgs(process.argv.slice(2));
const K = Math.max(1, Number(args.k) || 3);
const recallOnly = Boolean(args["recall-only"]);
// A/B switch for query normalization (appends only explicitly present facts to the recall query).
if (args.normalize) process.env.MEMORYOPS_NORMALIZE_QUERY = "1";

const dataset = loadJson(DATASET_PATH);
const cases = loadJson(typeof args.cases === "string" ? args.cases : EVAL_PATH);
const ids = new Set(dataset.map((r) => r.incident_id));
const categoryOf = Object.fromEntries(dataset.map((r) => [r.incident_id, r.category]));
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
      r.confidence = a.evidence?.confidence?.level ?? null;
      r.conflict = Boolean(a.evidence?.conflicts?.detected) || (a.evidence?.hypotheses?.length ?? 0) >= 2;
      r.suppressed = a.recommendation?.suppressed?.length ?? 0;
      // Negative experience: after MemoryOps' guard, no remaining check may repeat a known failed action.
      r.failedPromoted = suppressFailedChecks(a.recommendation?.checks || [], a.evidence?.failedBefore || [], a.evidence?.workedBefore || []).suppressed.length;
      // Provenance: everything cited must be something Hindsight actually recalled for this query.
      const recalled = new Set(a.matches.map((m) => m.incidentId));
      const cited = [r.matched, ...(a.evidence?.why?.supporting || []), ...(a.evidence?.hypotheses || []).flatMap((h) => h.supporting_memories.map((x) => x.id))].filter(Boolean);
      r.provenanceOk = cited.every((id) => recalled.has(id));
      if (a.reflectError) { r.error = `reflect: ${a.reflectError.message}`; r.reflectError = true; }
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

const confident = (r) => r.confidence === "MEDIUM" || r.confidence === "HIGH";
const fmt = (r) => r.ranking.slice(0, K).map((x) => `${x.id}${Number.isFinite(x.score) ? ` (${x.score.toFixed(2)})` : ""}`).join(", ") || "nothing";

// Failure classes (a case can have several).
function classify(r) {
  if (r.error && !r.ranking) return ["REQUEST_FAILED"];
  const out = [];
  if (r.reflectError) out.push("REFLECT_ERROR");
  if (r.should_match) {
    if (!inTop(r, K)) out.push("RETRIEVAL_MISS");
    else if (!inTop(r, 1)) out.push("BAD_RANKING");
    if (!recallOnly && inTop(r, K) && !r.memoryUsed && !r.reflectError) out.push("BAD_ABSTENTION");
    if (!recallOnly && r.memoryUsed && !r.expected.includes(r.matched)) out.push(categoryOf[r.matched] && categoryOf[r.matched] === categoryOf[r.expected[0]] ? "OVER_GENERIC_MEMORY" : "FALSE_POSITIVE");
    if (!recallOnly && r.expected.length >= 2 && !r.conflict) out.push("CONFLICT_ERROR");
  } else if (!recallOnly && (r.memoryUsed || confident(r))) out.push("FALSE_POSITIVE");
  if (!recallOnly && r.failedPromoted) out.push("FAILED_ACTION_ERROR");
  if (!recallOnly && r.provenanceOk === false) out.push("PROVENANCE_ERROR");
  return out;
}

console.log("MEMORYOPS MEMORY QUALITY LAB: held-out evaluation");
console.log(`Bank: ${BANK_ID}  (${stats.total_documents ?? "?"} documents, ${stats.total_nodes ?? "?"} facts)`);
console.log(`Dataset: ${dataset.length} incidents   Held-out queries: ${cases.length}   Mode: ${recallOnly ? "recall only" : "recall + reflect + MemoryOps reasoning (full app pipeline)"}${args.normalize ? "   Query normalization: ON" : ""}\n`);
console.log("RETRIEVAL");
console.log(`  Top-1 expected:            ${top1.length} / ${matchCases.length}`);
console.log(`  Top-${K} expected:            ${topK.length} / ${matchCases.length}`);
if (!recallOnly) {
  const correctNo = noMatchCases.filter((r) => !r.memoryUsed && !confident(r));
  const falseConfident = noMatchCases.filter((r) => r.memoryUsed || confident(r));
  const multi = matchCases.filter((r) => r.expected.length >= 2);
  const withFailed = ok.filter((r) => r.failedPromoted !== undefined);
  console.log("DECISION");
  console.log(`  Memory used, correct incident: ${matchCases.filter(decided).length} / ${matchCases.length}`);
  console.log(`  Wrong incident used:       ${matchCases.filter((r) => r.memoryUsed && !r.expected.includes(r.matched)).length}`);
  console.log("ABSTENTION");
  console.log(`  Correct no-match:          ${correctNo.length} / ${noMatchCases.length}`);
  console.log(`  False confident match:     ${falseConfident.length}`);
  console.log("PROVENANCE");
  console.log(`  Citations all recalled:    ${ok.filter((r) => r.provenanceOk).length} / ${ok.length}`);
  console.log("NEGATIVE EXPERIENCE");
  console.log(`  Known failed fix promoted: ${withFailed.filter((r) => r.failedPromoted).length} / ${withFailed.length}   (reflect suggestions removed by the guard: ${ok.reduce((n, r) => n + (r.suppressed || 0), 0)})`);
  console.log("CONFLICT HANDLING");
  console.log(`  Disagreement surfaced:     ${multi.filter((r) => r.conflict).length} / ${multi.length}`);
  console.log("CONFIDENCE LEVELS");
  console.log(`  ${["HIGH", "MEDIUM", "LOW", "INSUFFICIENT"].map((l) => `${l}: ${ok.filter((r) => r.confidence === l).length}`).join("   ")}`);
} else {
  console.log("No-match / confidence / provenance: not measured in --recall-only mode.");
}
console.log(`Failed requests:             ${results.filter((r) => r.error && !r.ranking).length}`);
console.log(`Similarity scores: ${scoresAvailable ? "Hindsight reranker scores shown (0-1, from recall)" : "not returned by Hindsight; none shown"}\n`);

const classCounts = {};
for (const r of results) {
  const classes = classify(r);
  for (const c of classes) classCounts[c] = (classCounts[c] || 0) + 1;
  const hard = classes.filter((c) => c !== "BAD_RANKING");
  if (hard.length) {
    console.log(`FAIL ${r.id} [${r.type}] ${classes.join(", ")}\n  Query: "${r.query}"\n  Expected: ${r.expected.join(", ") || "no match"}\n  Retrieved: ${r.ranking ? fmt(r) : "-"}${recallOnly ? "" : `\n  Decision: ${r.memoryUsed ? `memory used (${r.matched})` : "no memory used"}; confidence ${r.confidence}${r.error ? `\n  Error: ${r.error}` : ""}`}\n`);
  } else {
    console.log(`PASS ${r.id} [${r.type}]${classes.length ? ` (${classes.join(", ")})` : ""}  top: ${fmt(r)}${!recallOnly ? `  -> ${r.memoryUsed ? `used ${r.matched}` : "no memory"}, ${r.confidence}` : ""}`);
  }
}
console.log(`\nFailure classes: ${Object.keys(classCounts).length ? Object.entries(classCounts).map(([c, n]) => `${c}=${n}`).join("  ") : "none"}`);

if (typeof args.json === "string") {
  fs.writeFileSync(args.json, JSON.stringify({ bank: BANK_ID, k: K, recallOnly, ranAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nRaw results written to ${args.json}`);
}
