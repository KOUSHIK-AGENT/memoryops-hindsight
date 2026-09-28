// Real-Hindsight acceptance run for the self-learning loop.
// 1) Set a NEW HINDSIGHT_BANK_ID in .env, 2) `npm start`, 3) in another terminal: `npm run smoke`.
// Talks only to the MemoryOps server; the API key never leaves the server.
import { stop, Stop } from "./cli.mjs";

try {const BASE = process.env.MEMORYOPS_URL || "http://localhost:3000";

const ROUND1 = "Customers are unable to place orders after today's checkout update. Some checkout requests are failing, and the database appears overloaded. The problem started immediately after the latest update.";
const ROUND2 = "Customers report that checkout becomes unavailable after today's release. Database requests are timing out and capacity appears exhausted.";
const UNRELATED = "Product images on the company website load very slowly for visitors in Europe since this morning. Pages open, but pictures take a long time to appear.";

let failures = 0;
const report = (ok, name, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

async function call(path, body) {
  const res = await fetch(BASE + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const docs = async () => (await call("/api/status")).json.documents;

let status;
try {
  status = (await call("/api/status")).json;
} catch {
  console.error(`Cannot reach MemoryOps at ${BASE}. Start it first with \`npm start\` in another terminal (or set MEMORYOPS_URL).`);
  stop(1);
}
if (!status.connected) {
  console.error(`Hindsight not connected: ${status.error || "unknown error"}`);
  stop(1);
}
console.log(`Bank: ${status.bankId} (${status.documents ?? "?"} documents)`);
if (status.documents > 0) console.log("WARN  Bank is not empty. Use a brand-new HINDSIGHT_BANK_ID for a true 'before memory' run.");

// TEST 1 — fresh bank: no fake match. TEST 7 — analysis writes nothing.
const before = await docs();
const r1 = (await call("/api/analyze", { incident: ROUND1 })).json;
report(r1.state === "no_experience" && !r1.recommendation?.memoryUsed, "1 fresh bank: no fake historical incident", `state=${r1.state}, recalled=${r1.matches?.length}`);
report((await docs()) === before, "7a analysis alone stores nothing");

// TEST 7 — unconfirmed outcome is rejected.
const unconfirmed = await call("/api/resolve", { incident: ROUND1, worked: "Restored the limit." });
report(unconfirmed.status === 400, "7b unconfirmed outcome is refused", `status=${unconfirmed.status}`);

// TEST 2 — save a confirmed checkout resolution (real retain).
const s1 = await call("/api/resolve", {
  incident: ROUND1, area: "Checkout", confirmed: true, causeConfirmed: true,
  cause: "The database connection limit was changed from 30 to 5 in today's update.",
  attempted: "Restarted the checkout service only; the database timeouts came back within minutes.",
  worked: "Restored the database connection limit from 5 to 30, restarted the checkout service, and confirmed orders were working normally again.",
  outcome: "Orders returned to normal.",
  lesson: "For checkout failures plus database timeouts right after an update, compare database connection settings with the last known-good configuration first."
});
report(s1.status === 200 && s1.json.id, "2 confirmed resolution retained", s1.json.id || s1.json.error);

// TEST 3 + 4 — reworded problem recalls the learned resolution, with provenance.
const r2 = (await call("/api/analyze", { incident: ROUND2 })).json;
const recalled = r2.matches?.find((m) => m.incidentId === s1.json.id);
report(Boolean(recalled), "3 reworded problem recalls the saved resolution", `recalled=${(r2.matches || []).map((m) => m.incidentId).join(",") || "none"}`);
report(r2.recommendation?.matchedIncidentId === s1.json.id && recalled?.learned && recalled?.fields?.cause,
  "4 recommendation attributed to it (provenance: learned + confirmed cause)", `state=${r2.state}, avoid="${r2.recommendation?.avoid || ""}"`);

// TEST 5 — a different outcome is added; the old one survives.
const s2 = await call("/api/resolve", {
  incident: ROUND2, area: "Checkout", confirmed: true, causeConfirmed: true,
  cause: "A shared configuration template reset the database connection limit to 5 during the release.",
  worked: "Fixed the shared configuration template, restored the connection limit to 30, and redeployed checkout."
});
const r2b = (await call("/api/analyze", { incident: ROUND2 })).json;
const ids = (r2b.matches || []).map((m) => m.incidentId);
report(s2.status === 200 && s2.json.id !== s1.json.id, "5a second verified outcome retained", s2.json.id);
report(ids.includes(s1.json.id), "5b earlier experience still recalled", ids.join(","));

// TEST 6 — unrelated problem is not matched to checkout experience.
const r3 = (await call("/api/analyze", { incident: UNRELATED })).json;
report(!r3.recommendation?.memoryUsed, "6 unrelated problem does not reuse checkout experience", `state=${r3.state}`);

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll learning-loop checks passed against the configured Hindsight bank.");
process.exitCode = failures ? 1 : 0;
} catch (err) {
  if (!(err instanceof Stop)) throw err;
}
