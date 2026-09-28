// Held-out evaluation of curated-knowledge retrieval (local, deterministic: no network, no Hindsight).
//   npm run knowledge:evaluate [-- --k 3]
// Metrics are reported separately; nothing is combined into a single score.
import fs from "node:fs";
import { searchKnowledge, knowledgeHypotheses, loadKnowledge } from "../lib/knowledge.mjs";
import { parseArgs } from "./cli.mjs";

const args = parseArgs(process.argv.slice(2));
const K = Math.max(1, Number(args.k) || 3);
const cases = JSON.parse(fs.readFileSync(new URL("../data/knowledge-evaluation.json", import.meta.url), "utf8"));
const kb = loadKnowledge();
const ok = (c, h) => c.expected_ids.includes(h.id) || c.expected_categories.includes(h.category);
const rows = cases.map((c) => {
  const r = searchKnowledge(c.query, { k: K, kb });
  const hyps = knowledgeHypotheses(r.hits);
  return { c, hits: r.hits, hyps };
});
const match = rows.filter((x) => x.c.should_match), none = rows.filter((x) => !x.c.should_match);
const top1 = match.filter((x) => x.hits[0] && ok(x.c, x.hits[0]));
const topK = match.filter((x) => x.hits.slice(0, K).some((h) => ok(x.c, h)));
const abstain = none.filter((x) => x.hits.length === 0);
const provenance = rows.filter((x) => x.hits.every((h) => h.source_type === "CURATED_KNOWLEDGE") && x.hyps.every((h) => h.source === "CURATED_KNOWLEDGE"));
const withSource = match.filter((x) => x.c.expected_source);
const docOk = withSource.filter((x) => x.hits[0]?.citations.some((ct) => ct.source_id === x.c.expected_source));
const useful = match.filter((x) => x.hyps.length > 0 && x.hyps.every((h) => h.next_check));
const noValues = rows.every((x) => x.hits.every((h) => !h.example_fix || !/[=]\s*\d/.test(h.example_fix.diff)));

console.log("MEMORYOPS KNOWLEDGE EVALUATION (curated pack, held-out queries)");
console.log(`Corpus: ${kb.pack.entries.length} curated entries, ${kb.docs.length} documentation chunks   Queries: ${cases.length} (${match.length} should match, ${none.length} should not)\n`);
console.log("RETRIEVAL");
console.log(`  Top-1 relevant:              ${top1.length} / ${match.length}`);
console.log(`  Top-${K} relevant:              ${topK.length} / ${match.length}`);
console.log("NO-MATCH");
console.log(`  Correct abstention:          ${abstain.length} / ${none.length}`);
console.log(`  False positives:             ${none.length - abstain.length}`);
console.log("PROVENANCE");
console.log(`  Labelled CURATED_KNOWLEDGE:  ${provenance.length} / ${rows.length}`);
console.log("DOCUMENT SOURCE");
console.log(`  Top hit cites expected authoritative source: ${docOk.length} / ${withSource.length}`);
console.log("GENERAL KNOWLEDGE USEFULNESS (zero team memory)");
console.log(`  Produces hypotheses with a next check: ${useful.length} / ${match.length}`);
console.log("CODE FIX");
console.log(`  General examples use placeholders only (no concrete values): ${noValues ? "yes" : "NO"}\n`);
for (const x of rows) {
  const hit = x.c.should_match ? x.hits.slice(0, K).some((h) => ok(x.c, h)) : x.hits.length === 0;
  if (!hit) console.log(`FAIL ${x.c.id}: "${x.c.query}"\n  expected ${x.c.expected_ids.join(", ") || "no match"}; got ${x.hits.map((h) => `${h.id} (${h.score})`).join(", ") || "nothing"}`);
}
