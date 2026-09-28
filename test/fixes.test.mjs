// Suggested fix: only from confirmed memory that states the setting and both values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestFix } from "../lib/fixes.mjs";
import { loadJson, DATASET_PATH, incidentToMemoryText } from "../lib/dataset.mjs";
import { parseFields } from "../lib/memory-text.mjs";

const ds = loadJson(DATASET_PATH);
const fromDataset = (id) => ({ incidentId: id, fields: parseFields(incidentToMemoryText(ds.find((r) => r.incident_id === id))) });
const learned = (cause, worked, status = "Human-confirmed resolution") => ({ incidentId: "MO-1", learned: true, fields: parseFields(`Past solved problem MO-1 (Checkout)\nStatus: ${status}\n${cause}\nWhat worked: ${worked}`) });

test("diff comes from the confirmed incident's own values (broken -> last known good)", () => {
  const fx = suggestFix({ match: fromDataset("INC-1042"), confidence: "HIGH", hypothesis: { id: "connection-config", hypothesis: "Database connection capacity/configuration", status: "open" } });
  assert.equal(fx.diff, "- CONNECTION_POOL_SIZE=5\n+ CONNECTION_POOL_SIZE=30");
  assert.equal(fx.source.incidentId, "INC-1042");
  assert.match(fx.verify, /saturation/);
  assert.match(fx.note, /use your system's actual setting/);
  const r3 = suggestFix({ match: learned("Confirmed cause: The new settings capped each checkout instance at 3 database connections.", "Raised the per-instance database connection limit back to 20."), confidence: "MEDIUM" });
  assert.equal(r3.diff, "- PER_INSTANCE_DATABASE_CONNECTION_LIMIT=3\n+ PER_INSTANCE_DATABASE_CONNECTION_LIMIT=20");
});

test("no fix is invented: missing values, suspected cause, weak confidence or a rejected hypothesis", () => {
  assert.equal(suggestFix({ match: fromDataset("INC-1022"), confidence: "HIGH" }), null, "fix without explicit before/after values");
  assert.equal(suggestFix({ match: fromDataset("INC-1010"), confidence: "HIGH" }), null, "certificate renewal is not a config diff");
  const suspected = learned("Suspected cause (not confirmed): connection limit changed from 30 to 5.", "Restored the connection limit from 5 to 30.");
  assert.equal(suggestFix({ match: suspected, confidence: "HIGH" }), null);
  assert.equal(suggestFix({ match: fromDataset("INC-1042"), confidence: "LOW" }), null);
  assert.equal(suggestFix({ match: fromDataset("INC-1042"), confidence: "INSUFFICIENT" }), null);
  assert.equal(suggestFix({ match: fromDataset("INC-1042"), confidence: "HIGH", hypothesis: { id: "connection-config", status: "weakened" } }), null);
  const onlyDataset = ds.filter((r) => suggestFix({ match: fromDataset(r.incident_id), confidence: "HIGH" })).map((r) => r.incident_id);
  assert.deepEqual(onlyDataset, ["INC-1042", "INC-1044"], "only incidents that state both values yield a diff");
});

test("the fix never reuses a failed action", () => {
  const fx = suggestFix({ match: fromDataset("INC-1042"), confidence: "HIGH" });
  assert.doesNotMatch(fx.diff, /restart/i);
  assert.match(fx.source.worked, /^Restore the connection pool size to 30/);
});
