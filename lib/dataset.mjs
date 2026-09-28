// Incident dataset: validation and the deterministic conversion into Hindsight memory items.
// Shared by server.mjs (/api/seed), scripts/seed-memory-dataset.mjs, scripts/evaluate-memory.mjs and tests.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATASET_PATH = path.join(root, "data", "incidents.json");
export const EVAL_PATH = path.join(root, "data", "evaluation-cases.json");

export const CATEGORIES = {
  checkout: "Checkout / ordering",
  payments: "Payments",
  authentication: "Login / authentication",
  database: "Database",
  latency: "Slow APIs / latency",
  deployment: "Deployment / configuration",
  storage: "Storage / disk",
  certificates: "Certificates / TLS",
  queues: "Background workers / queues",
  "external-dependency": "External dependency"
};

const REQUIRED_TEXT = ["incident_id", "title", "service", "category", "severity", "environment", "context",
  "confirmed_root_cause", "successful_action", "outcome", "lesson_learned", "verification", "status", "timestamp"];
const ID_RE = /^INC-\d{4}$/;
const SEVERITIES = new Set(["SEV-1", "SEV-2", "SEV-3", "SEV-4"]);

export const documentIdFor = (incidentId) => `memoryops-${incidentId}`;

export function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Returns a list of human-readable problems; empty means valid.
export function validateIncident(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return ["record is not an object"];
  const errors = [];
  for (const f of REQUIRED_TEXT) {
    if (typeof r[f] !== "string" || !r[f].trim()) errors.push(`${f} is required`);
  }
  if (typeof r.incident_id === "string" && !ID_RE.test(r.incident_id)) errors.push("incident_id must look like INC-1234");
  if (r.category && !CATEGORIES[r.category]) errors.push(`unknown category "${r.category}"`);
  if (r.severity && !SEVERITIES.has(r.severity)) errors.push(`unknown severity "${r.severity}"`);
  // Only confirmed outcomes become reusable experience.
  if (r.status && r.status !== "confirmed_resolved") errors.push(`status must be "confirmed_resolved" (got "${r.status}")`);
  if (r.timestamp && Number.isNaN(Date.parse(r.timestamp))) errors.push("timestamp is not a valid date");
  if (!Array.isArray(r.symptoms) || r.symptoms.length === 0 || r.symptoms.some((s) => typeof s !== "string" || !s.trim())) {
    errors.push("symptoms must be a non-empty list of strings");
  }
  if (!Array.isArray(r.attempted_actions)) {
    errors.push("attempted_actions must be a list (may be empty)");
  } else {
    r.attempted_actions.forEach((a, i) => {
      if (!a || typeof a.action !== "string" || !a.action.trim()) errors.push(`attempted_actions[${i}].action is required`);
      // An attempted action is never the fix: it either failed or only partially helped.
      if (a && a.worked !== false && a.worked !== "partial") errors.push(`attempted_actions[${i}].worked must be false or "partial"`);
      if (a && typeof a.observation !== "string") errors.push(`attempted_actions[${i}].observation is required`);
    });
  }
  if (r.suspected_causes !== undefined) {
    if (!Array.isArray(r.suspected_causes)) errors.push("suspected_causes must be a list");
    else r.suspected_causes.forEach((s, i) => {
      if (!s || typeof s.cause !== "string" || typeof s.ruled_out_because !== "string") errors.push(`suspected_causes[${i}] needs cause and ruled_out_because`);
    });
  }
  return errors;
}

export function validateDataset(records) {
  if (!Array.isArray(records)) return { valid: [], errors: [{ index: -1, id: null, problems: ["dataset must be a JSON array"] }] };
  const seen = new Set();
  const valid = [];
  const errors = [];
  records.forEach((r, index) => {
    const problems = validateIncident(r);
    const id = r?.incident_id ?? null;
    if (id && seen.has(id)) problems.push(`duplicate incident_id ${id}`);
    if (id) seen.add(id);
    if (problems.length) errors.push({ index, id, problems });
    else valid.push(r);
  });
  return { valid, errors };
}

const sentence = (s) => { const t = String(s).trim(); return /[.!?]$/.test(t) ? t : `${t}.`; };

// Deterministic natural-language memory. Line labels match what server.mjs parses back from recalled chunks.
export function incidentToMemoryText(r) {
  const failed = r.attempted_actions.filter((a) => a.worked === false);
  const partial = r.attempted_actions.filter((a) => a.worked === "partial");
  const list = (items) => items.map((a) => `${a.action} (${a.observation})`).join("; ");
  return [
    `Past solved problem ${r.incident_id} (${r.service})`,
    `Title: ${r.title}`,
    "Status: Confirmed resolved incident (synthetic historical record from the MemoryOps bootstrap dataset)",
    `Service: ${r.service} | Category: ${CATEGORIES[r.category]} | Severity: ${r.severity} | Environment: ${r.environment}`,
    `What happened: ${r.symptoms.map((s) => s.trim()).join("; ")}.`,
    `Context: ${sentence(r.context)}`,
    r.suspected_causes?.length && `Initially suspected but ruled out: ${r.suspected_causes.map((s) => `${s.cause} (${s.ruled_out_because})`).join("; ")}.`,
    `Confirmed cause: ${sentence(r.confirmed_root_cause)}`,
    failed.length && `Tried but did NOT fix it: ${list(failed)}.`,
    partial.length && `Tried, helped only partially: ${list(partial)}.`,
    `What worked: ${sentence(r.successful_action)}`,
    `Outcome: ${sentence(r.outcome)}`,
    `Verification: ${sentence(r.verification)}`,
    `Lesson learned: ${sentence(r.lesson_learned)}`
  ].filter(Boolean).join("\n");
}

export function incidentToRetainItem(r) {
  return {
    content: incidentToMemoryText(r),
    context: `Confirmed resolved incident report ${r.incident_id} (${CATEGORIES[r.category]}, ${r.service})`,
    timestamp: r.timestamp,
    // Stable id: Hindsight upserts on document_id, so re-ingesting replaces instead of duplicating.
    document_id: documentIdFor(r.incident_id),
    metadata: { memoryops_id: r.incident_id, source: "incident-dataset", category: r.category, service: r.service, severity: r.severity, verification: "confirmed_resolved" }
  };
}

export function validateEvalCase(c, knownIds) {
  const errors = [];
  if (!c || typeof c !== "object") return ["case is not an object"];
  if (typeof c.id !== "string" || !c.id) errors.push("id is required");
  if (typeof c.query !== "string" || c.query.trim().length < 20) errors.push("query must be a sentence");
  if (typeof c.should_match !== "boolean") errors.push("should_match must be true or false");
  if (!Array.isArray(c.expected_incident_ids)) errors.push("expected_incident_ids must be a list");
  else {
    if (c.should_match && c.expected_incident_ids.length === 0) errors.push("a should_match case needs expected_incident_ids");
    if (c.should_match === false && c.expected_incident_ids.length) errors.push("a no-match case must not list expected ids");
    for (const id of c.expected_incident_ids) if (knownIds && !knownIds.has(id)) errors.push(`expected id ${id} is not in the dataset`);
  }
  if (c.expected_category !== null && c.expected_category !== undefined && !CATEGORIES[c.expected_category]) errors.push(`unknown expected_category ${c.expected_category}`);
  return errors;
}
