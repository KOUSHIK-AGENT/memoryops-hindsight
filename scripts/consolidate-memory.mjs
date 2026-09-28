// Build/update TEAM_PATTERN and PLAYBOOK memories from confirmed incidents in a bank.
//   npm run memory:consolidate -- --bank <bank-id>
import { parseArgs, loadMemoryApi, stop, Stop } from "./cli.mjs";

try {
const args = parseArgs(process.argv.slice(2));
const { consolidateMemory, BANK_ID } = await loadMemoryApi(args.bank, "Usage: npm run memory:consolidate -- --bank <bank-id>");
try {
  const r = await consolidateMemory();
  console.log(`Bank ${BANK_ID}: read ${r.incidentsRead} incident documents, ${r.confirmedIncidents} independently confirmed.`);
  for (const p of r.patterns) console.log(`TEAM_PATTERN ${p.pattern_id}: ${p.statement}\n  supporting: ${p.supporting_incidents.join(", ")}${p.counterexamples.length ? `\n  counterexamples: ${p.counterexamples.map((c) => `${c.id} (${c.cause})`).join(", ")}` : ""}`);
  for (const b of r.playbooks) console.log(`PLAYBOOK ${b.playbook_id}: ${b.steps.length} steps, learned from ${b.learned_from} confirmed incidents`);
  if (!r.patterns.length) console.log("No pattern yet: none has 3 independently confirmed incidents with the same cause in the same situation.");
  console.log(`Changes: ${r.changes.map((c) => `${c.id}=${c.status}`).join(", ") || "none"}`);
} catch (err) {
  console.error(`Consolidation failed: ${err.message}`);
  stop(1);
}
} catch (err) {
  if (!(err instanceof Stop)) throw err;
}
