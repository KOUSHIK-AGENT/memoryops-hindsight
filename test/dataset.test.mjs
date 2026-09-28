// Dataset, transformation and evaluation-set checks. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORIES, DATASET_PATH, EVAL_PATH, loadJson, validateDataset, validateIncident, validateEvalCase, incidentToMemoryText, incidentToRetainItem, documentIdFor } from "../lib/dataset.mjs";

const records = loadJson(DATASET_PATH);
const cases = loadJson(EVAL_PATH);

test("dataset: 50 valid confirmed incidents, 5 per category, unique ids", () => {
  const { valid, errors } = validateDataset(records);
  assert.deepEqual(errors, []);
  assert.equal(valid.length, 50);
  const perCategory = {};
  for (const r of valid) perCategory[r.category] = (perCategory[r.category] || 0) + 1;
  assert.deepEqual(Object.keys(perCategory).sort(), Object.keys(CATEGORIES).sort());
  for (const [cat, n] of Object.entries(perCategory)) assert.equal(n, 5, `${cat} has ${n}`);
});

test("dataset: records are not shallow copies of each other", () => {
  const causes = new Set(records.map((r) => r.confirmed_root_cause));
  const fixes = new Set(records.map((r) => r.successful_action));
  assert.equal(causes.size, 50);
  assert.equal(fixes.size, 50);
});

test("dataset: includes conflicting memories (same symptoms, different confirmed causes)", () => {
  const checkoutAfterRelease = ["INC-1042", "INC-1010", "INC-1001"].map((id) => records.find((r) => r.incident_id === id));
  assert.ok(checkoutAfterRelease.every((r) => r.service === "checkout"));
  assert.equal(new Set(checkoutAfterRelease.map((r) => r.category)).size, 3);
});

test("validation rejects malformed rows with specific reasons", () => {
  assert.deepEqual(validateIncident(null), ["record is not an object"]);
  const good = records[0];
  const bad = { ...good, incident_id: "1042", status: "suspected", symptoms: [], attempted_actions: [{ action: "restart", worked: true, observation: "x" }], category: "misc", timestamp: "yesterday" };
  const problems = validateIncident(bad).join(" | ");
  for (const expected of ["INC-1234", "confirmed_resolved", "symptoms", "worked must be false", "unknown category", "timestamp"]) assert.match(problems, new RegExp(expected));
  const { valid, errors } = validateDataset([good, good, { title: "x" }]);
  assert.equal(valid.length, 1);
  assert.match(errors[0].problems.join(), /duplicate incident_id/);
  assert.ok(errors[1].problems.length > 5);
  assert.equal(validateDataset({}).errors[0].problems[0], "dataset must be a JSON array");
});

test("transformation: deterministic memory text separates confirmed/suspected and failed/successful", () => {
  const r = records.find((x) => x.incident_id === "INC-1042");
  const text = incidentToMemoryText(r);
  assert.equal(text, incidentToMemoryText(structuredClone(r)), "deterministic");
  assert.match(text, /^Past solved problem INC-1042 \(checkout\)\n/);
  assert.match(text, /Status: Confirmed resolved incident/);
  assert.match(text, /Initially suspected but ruled out: slow queries from new code/);
  assert.match(text, /Confirmed cause: The database connection pool size was reduced from 30 to 5/);
  assert.match(text, /Tried but did NOT fix it: restart the checkout service \(database acquire timeouts returned within minutes\)\./);
  assert.match(text, /What worked: Restore the connection pool size to 30/);
  assert.match(text, /Verification: /);
  const partial = incidentToMemoryText(records.find((x) => x.incident_id === "INC-1027"));
  assert.match(partial, /Tried, helped only partially: disable the button/);
  assert.doesNotMatch(partial, /Tried but did NOT fix it/);
});

test("duplicate-safe ingestion: stable document ids and string-only metadata", () => {
  const items = records.map(incidentToRetainItem);
  assert.equal(new Set(items.map((i) => i.document_id)).size, 50);
  assert.equal(items[0].document_id, documentIdFor(records[0].incident_id));
  assert.deepEqual(incidentToRetainItem(records[0]), incidentToRetainItem(records[0]));
  for (const i of items) for (const v of Object.values(i.metadata)) assert.equal(typeof v, "string");
});

test("evaluation cases: valid, reference real incidents, mix of match and no-match", () => {
  const ids = new Set(records.map((r) => r.incident_id));
  for (const c of cases) assert.deepEqual(validateEvalCase(c, ids), [], c.id);
  assert.ok(cases.length >= 15 && cases.length <= 20);
  assert.ok(cases.filter((c) => !c.should_match).length >= 3);
  assert.ok(cases.some((c) => c.expected_incident_ids.length >= 2), "has multi-plausible cases");
  assert.match(validateEvalCase({ id: "x", query: "short", should_match: true, expected_incident_ids: ["INC-9999"] }, ids).join(), /query|INC-9999/);
});

test("evaluation queries are held out: no 6-word phrase copied from the dataset", () => {
  const words = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const grams = new Set();
  for (const r of records) {
    const w = words(incidentToMemoryText(r));
    for (let i = 0; i + 6 <= w.length; i++) grams.add(w.slice(i, i + 6).join(" "));
  }
  for (const c of cases) {
    const w = words(c.query);
    for (let i = 0; i + 6 <= w.length; i++) assert.ok(!grams.has(w.slice(i, i + 6).join(" ")), `${c.id} copies "${w.slice(i, i + 6).join(" ")}"`);
  }
});
