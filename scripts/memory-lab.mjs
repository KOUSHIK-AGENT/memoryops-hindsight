// Memory Quality Lab: learning behaviours against a REAL Hindsight bank.
//   npm run memory:seed -- --bank memoryops-lab-v1   (first)
//   npm run memory:lab  -- --bank memoryops-lab-v1
// WRITES confirmed test resolutions and patterns to the bank, so never point it at your eval or demo bank.
import { parseArgs, loadMemoryApi } from "./cli.mjs";

const args = parseArgs(process.argv.slice(2));
const api = await loadMemoryApi(args.bank, "Usage: npm run memory:lab -- --bank <lab-bank-id>   (a dedicated bank; it will be written to)");
const { analyzeIncident, resolveIncident, consolidateMemory, hindsightFetch, BANK_PATH, BANK_ID } = api;
let failures = 0;
const report = (ok, area, name, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  [${area}] ${name}${detail ? `  (${detail})` : ""}`); };

const listed = await hindsightFetch(`${BANK_PATH}/documents?q=memoryops-INC-&limit=1`, { timeoutMs: 15000 }).catch(() => ({ total: 0 }));
if (!(listed.total >= 50)) { console.error(`Bank ${BANK_ID} has ${listed.total ?? 0} dataset incidents. Seed it first: npm run memory:seed -- --bank ${BANK_ID}`); process.exit(1); }
console.log(`MEMORY QUALITY LAB on ${BANK_ID}\n`);

// PATTERN LEARNING on the bootstrap corpus.
const c1 = await consolidateMemory();
const confirmedIds = new Set();
report(c1.patterns.every((p) => p.supporting_incidents.length >= 3), "PATTERN", "every team pattern has >= 3 confirmed incidents", `${c1.patterns.length} pattern(s) from ${c1.confirmedIncidents} confirmed incidents`);

// SELF LEARNING: save a confirmed outcome, then ask in different words.
const ts = Date.now().toString(36);
const s1 = await resolveIncident({
  incident: `Checkout stopped accepting orders after the ${ts} release; database connections were exhausted and requests timed out.`,
  area: "Checkout", confirmed: true, causeConfirmed: true,
  cause: "The release lowered the database connection limit from 40 to 4.",
  attempted: "Restarted the checkout service only; timeouts returned.",
  worked: "Restored the database connection limit to 40 and redeployed checkout.",
  lesson: "After a release, compare database connection limits with the last known-good configuration."
});
const a1 = await analyzeIncident("Right after today's deploy people can't buy anything and the DB says it has no free connections left.");
const hit = a1.matches.findIndex((m) => m.incidentId === s1.id);
report(hit >= 0 && hit < 5, "SELF LEARNING", "newly confirmed incident recalled from different wording", hit >= 0 ? `rank #${hit + 1}` : "not recalled");
report(!a1.recommendation?.checks?.some((c) => /^restart/i.test(c)) && a1.evidence.failedBefore.length > 0, "NEGATIVE EXPERIENCE", "restart-only is reported as failed and not promoted", `failed actions known: ${a1.evidence.failedBefore.length}, reflect suggestions removed: ${a1.recommendation?.suppressed?.length ?? 0}`);
const recalled = new Set(a1.matches.map((m) => m.incidentId));
report([a1.recommendation?.matchedIncidentId, ...a1.evidence.why.supporting].filter(Boolean).every((id) => recalled.has(id)), "PROVENANCE", "every cited incident was actually recalled");

// PATTERN FROM ACCUMULATED EVIDENCE + COUNTEREXAMPLES (INC-1042 + 2 new confirmed => 3; INC-1010/INC-1001 are exceptions).
await resolveIncident({ incident: `Orders failed immediately after the ${ts} rollout; the database refused new connections.`, area: "Checkout", confirmed: true, causeConfirmed: true, cause: "A configuration template capped the database connection pool at 3.", worked: "Fixed the template and restored the database connection pool to 30." });
const c2 = await consolidateMemory();
const p = c2.patterns.find((x) => x.pattern_id === "pattern-checkout-after-change-connection-config");
report(Boolean(p) && p.supporting_incidents.length >= 3, "PATTERN", "pattern created once 3 confirmed same-cause incidents exist", p ? `supporting ${p.supporting_incidents.join(", ")}` : "not created");
report(Boolean(p) && p.counterexamples.length > 0 && /but similar symptoms have also come from/.test(p.statement), "COUNTEREXAMPLES", "exceptions retained in the pattern statement", p ? `${p.counterexamples.map((x) => `${x.id}:${x.cause}`).join(", ")}` : "");
const b = c2.playbooks.find((x) => x.playbook_id === "playbook-checkout-after-change");
const known = new Set([...(p?.supporting_incidents || []), ...(p?.counterexamples || []).map((x) => x.id)]);
report(Boolean(b) && b.steps.every((st) => st.supporting_incidents.length && st.supporting_incidents.every((id) => known.has(id))), "PLAYBOOK", "playbook generated only from confirmed incidents it cites", b ? `${b.steps.length} steps, learned from ${b.learned_from}` : "not created");
const c3 = await consolidateMemory();
report(c3.changes.every((ch) => ch.status === "unchanged"), "PATTERN", "re-consolidation is duplicate-safe (no rewrites)");

// CONFLICT HANDLING and ABSTENTION.
const a2 = await analyzeIncident("Checkout has been failing for customers since this morning's release; errors appear when orders are submitted.");
report(a2.evidence.conflicts.detected || a2.evidence.hypotheses.length >= 2, "CONFLICT", "similar symptoms with different causes are surfaced", a2.evidence.hypotheses.map((h) => h.id).join(" | "));
const a3 = await analyzeIncident("The office coffee machine shows a descaling warning every morning.");
report(!a3.recommendation?.memoryUsed && ["LOW", "INSUFFICIENT"].includes(a3.evidence.confidence.level), "ABSTENTION", "unrelated problem abstains", a3.evidence.confidence.level);

console.log(failures ? `\n${failures} lab check(s) failed.` : "\nAll lab checks passed.");
process.exit(failures ? 1 : 0);
