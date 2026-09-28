// Optional: index curated knowledge (and processed doc chunks) into a SEPARATE Hindsight bank for
// semantic recall. Never the team-memory bank: knowledge is not team experience.
//   npm run knowledge:ingest -- --bank memoryops-knowledge-v1
import fs from "node:fs";
import { loadKnowledge } from "../lib/knowledge.mjs";
import { parseArgs, loadMemoryApi, stop, Stop } from "./cli.mjs";

const args = parseArgs(process.argv.slice(2));
try {
  // The team bank may come from the shell or from .env; read both before refusing.
  const envFile = new URL("../.env", import.meta.url);
  const fromDotenv = fs.existsSync(envFile) ? (fs.readFileSync(envFile, "utf8").match(/^\s*HINDSIGHT_BANK_ID\s*=\s*["']?([^"'\r\n]+)/m) || [])[1] : undefined;
  const teamBank = process.env.HINDSIGHT_BANK_ID || fromDotenv;
  if (!args.bank || args.bank === true) { console.error("Usage: npm run knowledge:ingest -- --bank <knowledge-bank-id>"); stop(2); }
  if (teamBank && args.bank === teamBank) { console.error(`Refusing: ${args.bank} is the team-memory bank. Use a separate knowledge bank.`); stop(2); }
  const kb = loadKnowledge();
  const { retain, BANK_ID } = await loadMemoryApi(args.bank, "");
  const items = [
    ...kb.pack.entries.map((e) => ({
      content: [`Curated knowledge ${e.id}: ${e.title}`, "Type: CURATED_KNOWLEDGE (not team experience)", `Technology: ${e.technology} | Category: ${e.category}`,
        `Symptoms: ${e.symptoms.join("; ")}`, `Likely causes: ${e.likely_causes.join("; ")}`, `Diagnostic checks: ${e.diagnostic_checks.join("; ")}`,
        `Commonly tried but not sufficient: ${e.common_failed_actions.join("; ")}`, `Safe remediation: ${e.safe_remediation_guidance.join("; ")}`].join("\n"),
      context: `Curated troubleshooting knowledge ${e.id}`, document_id: `knowledge-${e.id}`,
      metadata: { source_type: "CURATED_KNOWLEDGE", knowledge_id: e.id, trust_level: e.source.trust_level }
    })),
    ...kb.docs.map((d) => ({
      content: `${d.title}: ${d.topic}\n${d.content}\nSource: ${d.source_url}`, context: `Public documentation from ${d.publisher}`,
      document_id: `doc-${d.chunk_id.replace(/[^a-zA-Z0-9-]/g, "-")}`, metadata: { source_type: "PUBLIC_DOCUMENTATION", source_url: d.source_url, trust_level: d.trust_level }
    }))
  ];
  let done = 0, failed = 0;
  for (let i = 0; i < items.length; i += 10) {
    try { await retain(items.slice(i, i + 10)); done += Math.min(10, items.length - i); }
    catch (err) { failed += Math.min(10, items.length - i); console.log(`batch ${i / 10 + 1} failed: ${err.message}`); if (err.code === "hindsight_auth") stop(1); }
    process.stdout.write(".");
  }
  console.log(`\n${done} knowledge documents retained into ${BANK_ID}, ${failed} failed.`);
  process.exitCode = failed ? 1 : 0;
} catch (err) {
  if (!(err instanceof Stop)) throw err;
}
