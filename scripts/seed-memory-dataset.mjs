// Bootstrap a Hindsight bank with the synthetic incident dataset (data/incidents.json).
//   npm run memory:seed -- --bank memoryops-training-v1 [--batch-size 5] [--only INC-1042,INC-1057] [--force] [--dry-run]
// Duplicate-safe: each incident has a stable document_id (memoryops-INC-xxxx). Hindsight upserts on document_id,
// and incidents whose stored original_text already matches are skipped entirely.
import { DATASET_PATH, loadJson, validateDataset, incidentToRetainItem } from "../lib/dataset.mjs";
import { parseArgs, loadMemoryApi, sleep, stop, Stop } from "./cli.mjs";

try {
const USAGE = "Usage: npm run memory:seed -- --bank <bank-id> [--batch-size 5] [--only INC-1042,...] [--force] [--dry-run] [--file data/incidents.json]";
const args = parseArgs(process.argv.slice(2));
const RETRYABLE = new Set(["hindsight_rate_limited", "hindsight_unavailable", "hindsight_timeout", "hindsight_unreachable"]);

const file = typeof args.file === "string" ? args.file : DATASET_PATH;
const records = loadJson(file);
console.log(`Loading ${Array.isArray(records) ? records.length : 0} incidents from ${file}...`);
const { valid, errors } = validateDataset(records);
if (errors.length) {
  console.error(`\n${errors.length} invalid record(s); nothing was sent to Hindsight:`);
  for (const e of errors) console.error(`  #${e.index} ${e.id ?? "(no id)"}: ${e.problems.join("; ")}`);
  stop(1);
}
const only = typeof args.only === "string" ? new Set(args.only.split(",").map((s) => s.trim())) : null;
const selected = only ? valid.filter((r) => only.has(r.incident_id)) : valid;
console.log(`${valid.length} valid. ${selected.length} selected.`);

if (args["dry-run"]) {
  console.log("\n--dry-run: no network calls. Memory text for the first incident:\n");
  console.log(incidentToRetainItem(selected[0]).content);
  stop(0);
}

const api = await loadMemoryApi(args.bank ?? process.env.MEMORYOPS_SEED_BANK, USAGE);
const { hindsightFetch, retain, BANK_PATH, BANK_ID } = api;
const batchSize = Math.max(1, Math.min(20, Number(args["batch-size"]) || 5));
console.log(`Bank: ${BANK_ID}   batch size: ${batchSize}${args.force ? "   (--force: re-retain unchanged incidents)" : ""}\n`);

function fatalIfAuth(err) {
  if (err.code === "hindsight_auth" || err.code === "missing_api_key") {
    console.error(`\nStopping: ${err.message}`);
    stop(1);
  }
}

async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      fatalIfAuth(err);
      if (!RETRYABLE.has(err.code) || attempt >= 3) throw err;
      const wait = 2000 * 2 ** attempt;
      console.log(`   ${err.message} Retrying in ${wait / 1000}s...`);
      await sleep(wait);
    }
  }
}

// 1) Decide what needs retaining (new, changed, or --force).
const plan = [];
let unchanged = 0;
for (const r of selected) {
  const item = incidentToRetainItem(r);
  let action = "new";
  if (!args.force) {
    try {
      const doc = await withRetry(() => hindsightFetch(`${BANK_PATH}/documents/${encodeURIComponent(item.document_id)}`, { timeoutMs: 15000 }));
      action = doc.original_text === item.content ? "unchanged" : "updated";
    } catch (err) {
      if (err.code !== "hindsight_not_found") { console.error(`Could not check ${r.incident_id}: ${err.message}`); stop(1); }
    }
  } else {
    action = "replaced";
  }
  if (action === "unchanged") unchanged++;
  plan.push({ r, item, action });
}

// 2) Retain in small synchronous batches.
let done = 0, retained = 0, failed = 0;
const total = plan.length;
const pending = plan.filter((p) => p.action !== "unchanged");
for (const p of plan.filter((x) => x.action === "unchanged")) console.log(`[${++done}/${total}] ${p.r.incident_id} unchanged, skipped`);
for (let i = 0; i < pending.length; i += batchSize) {
  const batch = pending.slice(i, i + batchSize);
  try {
    const res = await withRetry(() => retain(batch.map((p) => p.item)));
    if (Number.isFinite(res.items_count) && res.items_count !== batch.length) throw new Error(`Hindsight confirmed ${res.items_count} of ${batch.length} items`);
    for (const p of batch) { retained++; console.log(`[${++done}/${total}] ${p.r.incident_id} retained (${p.action})`); }
  } catch (err) {
    for (const p of batch) { failed++; console.log(`[${++done}/${total}] ${p.r.incident_id} FAILED: ${err.message}${err.detail ? ` (${err.detail})` : ""}`); }
  }
}

console.log(`\n${total} incidents processed`);
console.log(`${retained} retained`);
console.log(`${unchanged} unchanged (already in the bank)`);
console.log(`${failed} failed`);
process.exitCode = failed ? 1 : 0;
} catch (err) {
  if (!(err instanceof Stop)) throw err;
}
