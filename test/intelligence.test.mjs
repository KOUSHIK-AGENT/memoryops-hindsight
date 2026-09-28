// Deterministic reasoning, diagnosis and consolidation. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadJson, DATASET_PATH, incidentToMemoryText } from "../lib/dataset.mjs";
import { parseFields } from "../lib/memory-text.mjs";
import { typeMemory, analyzeEvidence, applyObservations, suppressFailedChecks, AUTHORITY, ABSTAIN_TEXT } from "../lib/reasoning.mjs";
import { consolidate, patternToRetainItem, playbookToRetainItem, MIN_SUPPORT } from "../lib/patterns.mjs";
import { normalizeQuery } from "../lib/signals.mjs";

const ds = loadJson(DATASET_PATH);
const mem = (id, extra = {}) => {
  const r = ds.find((x) => x.incident_id === id);
  return { incidentId: id, fields: parseFields(incidentToMemoryText(r)), facts: [], feedback: [], ...extra };
};
const learned = (id, { problem, cause, confirmed = true, attempted, worked, lesson }) => {
  const text = [
    `Past solved problem ${id} (Checkout)`, `Title: ${problem}`,
    "Status: Human-confirmed resolution (saved by the team after the problem was fixed)",
    `What happened: ${problem}`,
    cause && (confirmed ? `Confirmed cause: ${cause}` : `Suspected cause (not confirmed): ${cause}`),
    attempted && `Tried but did NOT fix it: ${attempted}`,
    `What worked: ${worked}`, lesson && `Lesson learned: ${lesson}`, "Recorded at: 2026-09-28T10:00:00Z"
  ].filter(Boolean).join("\n");
  return { documentId: `memoryops-${id}`, text, match: { incidentId: id, learned: true, fields: parseFields(text), facts: [], feedback: [] } };
};

test("query normalization extracts only explicit facts", () => {
  assert.deepEqual(normalizeQuery("People cannot order since today's release and database connections appear full."),
    { area: "checkout", areas: ["checkout"], trigger: "after-change", signals: ["db-connections-exhausted"], impact: "customers-cannot-order" });
  assert.deepEqual(normalizeQuery("The office printer keeps jamming."), {});
});

test("typed memory: confirmed vs suspected, failed attempts, feedback; authority order", () => {
  const t = typeMemory(mem("INC-1042", { feedback: [{ verdict: "Helpful" }] }));
  assert.equal(t.confirmed, true);
  assert.deepEqual(t.items.map((i) => i.type), ["VERIFIED_INCIDENT", "VERIFIED_RESOLUTION", "FAILED_ATTEMPT", "TEAM_FEEDBACK"]);
  const s = typeMemory(learned("MO-1", { problem: "Checkout failing after release", cause: "Maybe the cache", confirmed: false, worked: "Rolled back" }).match);
  assert.equal(s.confirmed, false);
  assert.equal(s.items[0].type, "SUSPECTED_CAUSE");
  assert.ok(!s.items.some((i) => i.type === "VERIFIED_RESOLUTION"), "a suspected case never yields a verified resolution");
  assert.ok(AUTHORITY.VERIFIED_RESOLUTION > AUTHORITY.FAILED_ATTEMPT && AUTHORITY.FAILED_ATTEMPT > AUTHORITY.TEAM_PATTERN && AUTHORITY.TEAM_PATTERN > AUTHORITY.SUSPECTED_CAUSE && AUTHORITY.SUSPECTED_CAUSE > AUTHORITY.TEAM_FEEDBACK);
});

test("confidence & abstention: unrelated query abstains even when recall returned memories", () => {
  const e = analyzeEvidence({ incident: "The office printer on the third floor keeps jamming and printing blank pages.", matches: ds.slice(0, 10).map((r) => mem(r.incident_id)) });
  assert.equal(e.confidence.level, "INSUFFICIENT");
  assert.equal(e.confidence.statement, ABSTAIN_TEXT);
  assert.equal(e.hypotheses.length, 0);
  assert.equal(e.relevant.length, 0);
});

test("confidence: suspected-only evidence is LOW; two confirmed consistent incidents are HIGH", () => {
  const q = "Checkout is failing after today's release and database connections appear exhausted.";
  const sus = learned("MO-2", { problem: "Checkout failing after release, database connections exhausted", cause: "Maybe the connection pool", confirmed: false, worked: "Raised the pool" });
  assert.equal(analyzeEvidence({ incident: q, matches: [sus.match] }).confidence.level, "LOW");
  const a = learned("MO-3", { problem: "Checkout failing after release, database connections exhausted", cause: "Database connection pool reduced to 5", worked: "Restored pool to 30" });
  const e = analyzeEvidence({ incident: q, matches: [a.match, mem("INC-1042")] });
  assert.equal(e.confidence.level, "HIGH");
  assert.equal(e.confidence.statement, null);
  assert.deepEqual(e.why.supporting.sort(), ["INC-1042", "MO-3"]);
  assert.ok(e.why.reasons.includes("2 confirmed historical incidents had similar signals"));
});

test("multi-memory conflict: same symptoms, different confirmed causes are surfaced, not collapsed", () => {
  const e = analyzeEvidence({ incident: "Checkout has been failing for customers since this morning's release; errors when they submit orders.", matches: ["INC-1042", "INC-1010", "INC-1001"].map((id) => mem(id)) });
  assert.equal(e.conflicts.detected, true);
  assert.equal(e.conflicts.causes.length, 3);
  assert.equal(e.hypotheses.length, 3);
  assert.notEqual(e.confidence.level, "HIGH", "conflicting evidence caps confidence");
  for (const h of e.hypotheses) assert.ok(h.next_check && h.expected_if_true && h.supporting_memories.length);
});

test("negative experience: failed restart is reported and never promoted as the fix", () => {
  const e = analyzeEvidence({ incident: "Orders fail after today's release and database connections are exhausted.", matches: [mem("INC-1042")] });
  assert.match(e.failedBefore[0].text, /"restart the checkout service" alone did not resolve a similar previous incident \(INC-1042\)/);
  const { checks, suppressed } = suppressFailedChecks(
    ["Restart the checkout service.", "Restore the connection pool size and restart the checkout service.", "Compare connection settings with the last known-good configuration."],
    e.failedBefore, e.workedBefore);
  assert.deepEqual(checks, ["Restore the connection pool size and restart the checkout service.", "Compare connection settings with the last known-good configuration."]);
  assert.equal(suppressed.length, 1);
  assert.ok(!e.workedBefore.some((w) => /^restart/i.test(w)));
});

test("interactive diagnosis: observations update hypotheses; contradicting evidence weakens", () => {
  const e = analyzeEvidence({ incident: "Checkout has been failing for customers since this morning's release; errors when they submit orders.", matches: ["INC-1042", "INC-1010", "INC-1001"].map((id) => mem(id)) });
  const r1 = applyObservations(e.hypotheses, ["Current pool is 5. Previous version was 30."]);
  assert.equal(r1.hypotheses[0].id, "connection-config");
  assert.equal(r1.hypotheses[0].status, "supported");
  assert.match(r1.nextBestCheck.text, /supports/);
  const r2 = applyObservations(e.hypotheses, ["Connection pool is 30 as usual", "The tax service certificate has expired"]);
  assert.equal(r2.hypotheses.find((h) => h.id === "connection-config").status, "weakened");
  assert.equal(r2.hypotheses[0].id, "certificate");
  const r3 = applyObservations(e.hypotheses, ["The weather is nice"]);
  assert.deepEqual(r3.unmatched, ["The weather is nice"]);
});

test("patterns require >= 3 independently confirmed incidents; suspected ones do not count", () => {
  const base = { problem: "Checkout failing after today's release; database connections exhausted", worked: "Restored the connection limit", lesson: "Compare database connection settings with the last known-good configuration.", attempted: "Restarted the checkout service" };
  const two = [learned("MO-A", { ...base, cause: "Database connection limit lowered to 5" }), learned("MO-B", { ...base, cause: "Connection pool size reduced by a template" })];
  assert.equal(consolidate(two).patterns.length, 0);
  const suspected = learned("MO-C", { ...base, cause: "Maybe the connection pool", confirmed: false });
  assert.equal(consolidate([...two, suspected]).patterns.length, 0, "suspected cause is not independent confirmation");
  const three = [...two, learned("MO-D", { ...base, cause: "Per-instance database connection limit capped at 3" })];
  const { patterns, playbooks } = consolidate(three);
  assert.equal(MIN_SUPPORT, 3);
  assert.equal(patterns.length, 1);
  assert.deepEqual(patterns[0].supporting_incidents, ["MO-A", "MO-B", "MO-D"]);
  assert.equal(patterns[0].pattern_id, "pattern-checkout-after-change-connection-config");
  assert.equal(playbooks.length, 1);
});

test("counterexamples are preserved and prevent over-generalised statements", () => {
  const base = { problem: "Checkout failing after today's release; database connections exhausted", worked: "Restored the connection limit", lesson: "Compare database connection settings with the last known-good configuration.", attempted: "Restarted the checkout service" };
  const docs = [
    learned("MO-A", { ...base, cause: "Database connection limit lowered to 5" }),
    learned("MO-B", { ...base, cause: "Connection pool size reduced by a template" }),
    learned("MO-D", { ...base, cause: "Per-instance database connection limit capped at 3" }),
    learned("MO-E", { problem: "Checkout failing after today's release; errors on order submit", cause: "Tax service TLS certificate expired", worked: "Renewed the certificate", lesson: "Check dependency certificate expiry." })
  ];
  const { patterns, playbooks } = consolidate(docs);
  const p = patterns[0];
  assert.deepEqual(p.counterexamples.map((c) => c.id), ["MO-E"]);
  assert.match(p.statement, /recurring cause .* but similar symptoms have also come from certificate/);
  assert.doesNotMatch(p.statement, /^Across/);
  // Playbook provenance: every step cites real confirmed incidents from the input.
  const ids = new Set(["MO-A", "MO-B", "MO-D", "MO-E"]);
  const b = playbooks[0];
  assert.equal(b.learned_from, 4);
  assert.deepEqual(b.steps.map((s) => s.cause_class), ["connection-config", "certificate"]);
  for (const s of b.steps) { assert.ok(s.supporting_incidents.every((id) => ids.has(id))); assert.ok(s.why.includes(String(s.supporting_incidents.length))); }
  assert.match(b.cautions[0].text, /"Restarted the checkout service" alone did not fix MO-A, MO-B, MO-D/);
});

test("pattern/playbook updates are duplicate-safe: stable ids and deterministic content", () => {
  const base = { problem: "Checkout failing after today's release; database connections exhausted", worked: "Restored the connection limit", lesson: "Compare settings." };
  const docs = ["MO-A", "MO-B", "MO-D"].map((id) => learned(id, { ...base, cause: "Database connection limit lowered" }));
  const a = consolidate(docs), b = consolidate([...docs].reverse());
  assert.deepEqual(a.patterns.map(patternToRetainItem), b.patterns.map(patternToRetainItem));
  assert.deepEqual(a.playbooks.map(playbookToRetainItem), b.playbooks.map(playbookToRetainItem));
  const withMore = consolidate([...docs, learned("MO-F", { ...base, cause: "Database connection limit lowered again" })]);
  assert.equal(patternToRetainItem(withMore.patterns[0]).document_id, patternToRetainItem(a.patterns[0]).document_id, "same id => upsert, not a new pattern");
  assert.equal(withMore.patterns[0].supporting_incidents.length, 4);
});

test("bootstrap dataset alone yields no pattern without 3 same-cause confirmed incidents", () => {
  const docs = ds.map((r) => ({ documentId: `memoryops-${r.incident_id}`, text: incidentToMemoryText(r) }));
  const { patterns, incidents } = consolidate(docs);
  assert.equal(incidents, 50);
  for (const p of patterns) assert.ok(p.supporting_incidents.length >= 3);
});

test("anti-overlearning: today's text contradicting the remembered cause lowers confidence", () => {
  const base = { worked: "Restored the connection limit", lesson: "Compare database connection settings." };
  const mems = ["MO-A", "MO-B", "MO-D"].map((id) => learned(id, { ...base, problem: "Checkout failing after today's release; database connections exhausted", cause: "Database connection limit lowered to 5" }).match);
  const plain = analyzeEvidence({ incident: "Checkout started failing right after today's release; customers see errors when submitting orders.", matches: mems });
  const contra = analyzeEvidence({ incident: "Checkout started failing right after today's release; customers see errors when submitting orders, but database connections look healthy.", matches: mems });
  assert.equal(plain.confidence.level, "HIGH");
  assert.notEqual(contra.confidence.level, "HIGH");
  assert.equal(contra.hypotheses[0].status, "weakened");
  assert.match(contra.hypotheses[0].evidence_against[0], /database connections look healthy/);
});
