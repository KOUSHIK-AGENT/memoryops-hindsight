import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATASET_PATH, loadJson, validateDataset, incidentToRetainItem } from "./lib/dataset.mjs";
import { parseFields, parseFeedback } from "./lib/memory-text.mjs";
import { normalizeQuery, normalizedContext } from "./lib/signals.mjs";
import { analyzeEvidence, applyObservations, suppressFailedChecks, nextBestCheck } from "./lib/reasoning.mjs";
import { consolidate, patternToRetainItem, playbookToRetainItem, readPayload } from "./lib/patterns.mjs";
import { suggestFix } from "./lib/fixes.mjs";
import { searchKnowledge, knowledgeHypotheses, generalExampleFix, knowledgeStats, loadKnowledge } from "./lib/knowledge.mjs";
import { decideMode, INSUFFICIENT_CHECK } from "./lib/modes.mjs";
import { knowledgeMaturity } from "./lib/maturity.mjs";
import { liveDocs } from "./lib/live-docs.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (process.env.MEMORYOPS_SKIP_DOTENV !== "1") loadEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.HINDSIGHT_BASE_URL || "https://api.hindsight.vectorize.io").replace(/\/$/, "");
const API_KEY = process.env.HINDSIGHT_API_KEY || "";
const BANK_ID = process.env.HINDSIGHT_BANK_ID || "memoryops-demo";
// One override for every Hindsight call (used by tests); otherwise per-operation defaults.
const TIMEOUT_OVERRIDE = Number(process.env.HINDSIGHT_TIMEOUT_MS) || 0;
const TIMEOUTS = { status: 10000, retain: 120000, recall: 30000, reflect: 90000 };
const MAX_TEXT = 4000;
// Query normalization appends only explicitly present facts to the recall query. Off by default:
// enable only if the held-out evaluation shows it helps (npm run memory:evaluate -- --normalize).
const NORMALIZE_QUERY = process.env.MEMORYOPS_NORMALIZE_QUERY === "1";
const AUTO_CONSOLIDATE = process.env.MEMORYOPS_AUTO_CONSOLIDATE !== "0";
// Optional live documentation lookup for the top knowledge hit (off by default).
const LIVE_DOCS = process.env.MEMORYOPS_LIVE_DOCS === "1";
export const BANK_PATH = `/v1/default/banks/${encodeURIComponent(BANK_ID)}`;
export { BANK_ID };

// "Load past solved incidents" stores these three records from the synthetic dataset (data/incidents.json).
// Same document_ids as `npm run memory:seed`, so the button and the bulk ingest never duplicate each other.
const SAMPLE_IDS = ["INC-1042", "INC-1057", "INC-1088"];
function sampleIncidents() {
  const { valid } = validateDataset(loadJson(DATASET_PATH));
  return SAMPLE_IDS.map((id) => valid.find((r) => r.incident_id === id)).filter(Boolean);
}

const GENERAL_TROUBLESHOOTING = {
  pattern: "No similar solved problem was found in team memory, so this is general troubleshooting.",
  checks: [
    "Find out exactly what changed recently (code, settings, or infrastructure) and whether the problem started right after that change.",
    "Check the health of the systems the failing feature depends on, such as its database, for errors, slowness, or overload.",
    "If customers are still affected, consider safely undoing the latest change while the team investigates."
  ],
  why: "MemoryOps has no past experience with a problem like this yet, so it cannot point to a specific cause.",
  safety: "Confirm each finding on today's system before changing anything."
};

const REFLECT_SCHEMA = {
  type: "object",
  properties: {
    similar_problem_found: { type: "boolean" },
    matched_incident_id: { type: "string" },
    likely_pattern: { type: "string" },
    first_checks: { type: "array", items: { type: "string" } },
    why: { type: "string" },
    safety_note: { type: "string" },
    avoid: { type: "string" },
    conflict_note: { type: "string" },
    team_learned: { type: "string" }
  },
  required: ["similar_problem_found", "matched_incident_id", "likely_pattern", "first_checks", "why", "safety_note", "avoid", "conflict_note", "team_learned"]
};

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function send(res, status, payload, type = "application/json; charset=utf-8") {
  const body = type.startsWith("application/json") ? JSON.stringify(payload) : payload;
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

export class ApiError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new ApiError(413, "body_too_large", "Request body is too large.");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  let body;
  try { body = JSON.parse(raw); } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "invalid_json", "Request body must be a JSON object.");
  }
  return body;
}

function requiredText(body, field, label) {
  const value = typeof body[field] === "string" ? body[field].trim() : "";
  if (!value) throw new ApiError(400, "validation", `${label} is required.`);
  if (value.length > MAX_TEXT) throw new ApiError(400, "validation", `${label} must be under ${MAX_TEXT} characters.`);
  return value;
}

function optionalText(body, field, max = 1000) {
  const value = typeof body[field] === "string" ? body[field].trim() : "";
  if (value.length > max) throw new ApiError(400, "validation", `${field} must be under ${max} characters.`);
  return value;
}

function redact(text) {
  let s = String(text ?? "");
  if (API_KEY) s = s.split(API_KEY).join("[redacted]");
  return s.slice(0, 300);
}

export async function hindsightFetch(urlPath, { method = "GET", body, timeoutMs } = {}) {
  if (!API_KEY) {
    throw new ApiError(503, "missing_api_key", "Hindsight is not configured: HINDSIGHT_API_KEY is missing. Copy .env.example to .env and add your key.");
  }
  let response;
  try {
    response = await fetch(`${BASE_URL}${urlPath}`, {
      method,
      headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_OVERRIDE || timeoutMs || 30000)
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new ApiError(504, "hindsight_timeout", "Hindsight did not respond in time. Please try again.");
    }
    throw new ApiError(502, "hindsight_unreachable", "Could not reach Hindsight. Check your network connection and HINDSIGHT_BASE_URL.", redact(err?.cause?.code || err?.message));
  }
  const text = await response.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = null; }

  if (!response.ok) {
    const detail = redact(typeof data?.detail === "string" ? data.detail : data?.message || text || response.statusText);
    const s = response.status;
    if (s === 401 || s === 403) throw new ApiError(502, "hindsight_auth", `Hindsight rejected the API key (${s}). Check HINDSIGHT_API_KEY.`, detail);
    if (s === 404) throw new ApiError(404, "hindsight_not_found", "Hindsight memory bank not found.", detail);
    if (s === 429) throw new ApiError(429, "hindsight_rate_limited", "Hindsight rate limit reached. Wait a moment and try again.", detail);
    if (s === 400 || s === 422) throw new ApiError(502, "hindsight_rejected", `Hindsight rejected the request (${s}).`, detail);
    throw new ApiError(502, "hindsight_unavailable", `Hindsight is temporarily unavailable (${s}). Please try again.`, detail);
  }
  if (data === null || typeof data !== "object") {
    throw new ApiError(502, "hindsight_bad_response", "Hindsight returned an unexpected response.", redact(text));
  }
  return data;
}

// ---------- Hindsight operations ----------

export async function retain(items) {
  const data = await hindsightFetch(`${BANK_PATH}/memories`, {
    method: "POST",
    body: { items, async: false },
    timeoutMs: TIMEOUTS.retain
  });
  if (data.success !== true) {
    throw new ApiError(502, "hindsight_bad_response", "Hindsight did not confirm the memory was saved.", redact(JSON.stringify(data)));
  }
  return data;
}

async function recall(query) {
  try {
    const data = await hindsightFetch(`${BANK_PATH}/memories/recall`, {
      method: "POST",
      body: { query, types: ["world", "experience"], include: { entities: null, chunks: { max_tokens: 4000 } } },
      timeoutMs: TIMEOUTS.recall
    });
    if (!Array.isArray(data.results)) {
      throw new ApiError(502, "hindsight_bad_response", "Hindsight recall returned no results list.");
    }
    return data;
  } catch (err) {
    // A bank that does not exist yet simply has no memories.
    if (err.code === "hindsight_not_found") return { results: [], chunks: {} };
    throw err;
  }
}

async function reflect(query) {
  try {
    return await hindsightFetch(`${BANK_PATH}/reflect`, {
      method: "POST",
      body: { query, response_schema: REFLECT_SCHEMA, include: { facts: {} } },
      timeoutMs: TIMEOUTS.reflect
    });
  } catch (err) {
    // Older/limited deployments may not accept structured output: retry once as plain text.
    if (err.code !== "hindsight_rejected") throw err;
    return hindsightFetch(`${BANK_PATH}/reflect`, { method: "POST", body: { query }, timeoutMs: TIMEOUTS.reflect });
  }
}

// ---------- Response shaping ----------

// Group recalled facts by the Hindsight document they came from, in recall rank order.
export function groupRecall(data) {
  const chunks = data?.chunks && typeof data.chunks === "object" ? data.chunks : {};
  const docs = new Map();
  for (const [rank, r] of (data?.results || []).entries()) {
    if (!r || typeof r.text !== "string") continue;
    const key = r.document_id || `fact-${r.id || rank}`;
    if (!docs.has(key)) docs.set(key, { documentId: r.document_id || null, rank: docs.size + 1, facts: [], chunkIds: new Set(), score: null, metadata: r.metadata || null });
    const doc = docs.get(key);
    doc.facts.push(r.text);
    if (r.chunk_id) doc.chunkIds.add(r.chunk_id);
    const s = r.scores?.reranker;
    if (typeof s === "number" && (doc.score === null || s > doc.score)) doc.score = s;
  }
  const sourceText = (d) => [...d.chunkIds].map((id) => chunks[id]).filter((c) => c && typeof c.text === "string")
    .sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0)).map((c) => c.text).join("\n");

  // Feedback memories are relevance hints about an incident, never incidents themselves.
  const feedback = [];
  const incidents = [];
  for (const d of docs.values()) {
    if (/^memoryops-(pattern|playbook)-/.test(d.documentId || "")) continue; // team knowledge, fetched separately
    if (d.documentId?.startsWith("memoryops-feedback-")) {
      const fb = parseFeedback(sourceText(d));
      if (fb) feedback.push(fb);
    } else {
      incidents.push(d);
    }
  }
  return incidents.map((d, idx) => {
    const source = sourceText(d);
    const fields = source ? parseFields(source) : {};
    const idFromDoc = d.documentId?.startsWith("memoryops-") ? d.documentId.slice("memoryops-".length) : null;
    const incidentId = d.metadata?.memoryops_id || fields.incidentId || idFromDoc || d.documentId || "Memory";
    return {
      incidentId,
      documentId: d.documentId,
      rank: idx + 1,
      score: d.score,
      learned: incidentId.startsWith("MO-") || d.metadata?.source === "memoryops-resolution",
      verified: /^(human-)?confirmed/i.test(fields.status || ""),
      fields: source ? fields : null,
      facts: d.facts.slice(0, 5),
      feedback: feedback.filter((f) => f.about === incidentId)
    };
  });
}

function cleanText(s) {
  return String(s || "").replace(/\*\*(.*?)\*\*/g, "$1").replace(/^#+\s*/gm, "").trim();
}

export function shapeRecommendation(reflectData, matches) {
  let out = reflectData?.structured_output;
  if (!out && typeof reflectData?.text === "string") {
    try { out = JSON.parse(reflectData.text.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { out = null; }
  }
  const ids = new Set(matches.map((m) => m.incidentId));
  if (out && typeof out === "object" && Array.isArray(out.first_checks)) {
    // Only attribute the answer to memory Hindsight actually recalled. The model may wrap the id
    // ("INC-1042 (checkout)", "mo-0928…", "Incident MO-…"), so find a recalled id inside what it returned.
    const claimed = String(out.matched_incident_id || "").trim().toUpperCase();
    const hit = claimed && [...ids].find((id) => id.toUpperCase() === claimed || claimed.includes(id.toUpperCase()));
    const matchedId = out.similar_problem_found === true && hit ? hit : null;
    return {
      structured: true,
      memoryUsed: Boolean(matchedId),
      matchedIncidentId: matchedId,
      pattern: cleanText(out.likely_pattern),
      checks: out.first_checks.map(cleanText).filter(Boolean).slice(0, 5),
      why: cleanText(out.why),
      safety: cleanText(out.safety_note),
      // Only meaningful when grounded in a recalled incident.
      avoid: matchedId ? cleanText(out.avoid) : "",
      conflict: cleanText(out.conflict_note),
      teamLearned: matchedId ? cleanText(out.team_learned) : ""
    };
  }
  // Unstructured fallback: attribute to a recalled incident only if reflect names it.
  const text = cleanText(reflectData?.text);
  if (!text) throw new ApiError(502, "hindsight_bad_response", "Hindsight reflect returned an empty answer.");
  const named = matches.find((m) => text.includes(m.incidentId));
  return {
    structured: false,
    memoryUsed: Boolean(named),
    matchedIncidentId: named ? named.incidentId : null,
    text
  };
}

function reflectPrompt(incident, matches) {
  return [
    "You are MemoryOps, an assistant that remembers how this team solved problems before.",
    "Use ONLY the past solved problems stored in this memory bank as evidence. Never invent a past problem or a detail that is not in memory.",
    "",
    `TODAY'S PROBLEM: ${incident}`,
    "",
    `Past problems Hindsight recalled for this search: ${matches.map((m) => `${m.incidentId}${m.learned ? " (saved by the team after a real resolution)" : ""}`).join(", ") || "none"}.`,
    "",
    "How to weigh evidence (highest first): human-confirmed successful outcome > human-confirmed failed attempt > team pattern backed by confirmed incidents > suspected cause > team feedback. Earlier AI recommendations are never evidence.",
    "How to weigh evidence:",
    "- Human-confirmed causes and fixes are authoritative. A 'Suspected cause (not confirmed)' is only a lead; say so if you use it.",
    "- Never recommend an action listed under 'Tried but did NOT fix it' as the main fix. Put it in avoid (e.g. 'Restarting the service alone did not fix this before'); otherwise avoid=\"\".",
    "- Similar symptoms do not guarantee the same cause. If more than one recalled problem is plausible, list the distinguishing checks first and explain in conflict_note.",
    "- If recalled past problems disagree about the cause or the fix, describe the disagreement in conflict_note and do not pick one as certain; otherwise conflict_note=\"\".",
    "- 'Team feedback' memories only say whether a past incident was relevant to some problem. Use them as a relevance hint, never as a cause or fix.",
    "- team_learned: one sentence summarising what this team has learned about this kind of problem, based only on stored memory; \"\" if nothing relevant.",
    "",
    "Decide whether one of these past problems is genuinely similar to today's problem (similar symptoms and circumstances, not just shared words).",
    "If yes: similar_problem_found=true and matched_incident_id=its exact id (for example INC-1042).",
    "likely_pattern: one plain-English sentence a non-engineer understands.",
    "first_checks: exactly three specific things to verify today, based on what caused and fixed the past problem. Phrase them as checks, not as blindly re-applying the old fix.",
    "why: one or two sentences on why today's symptoms resemble that past problem.",
    "safety_note: one sentence reminding the team to verify today's system before applying a previous fix.",
    "If no past problem is genuinely similar: similar_problem_found=false, matched_incident_id=\"\", and give three general first checks.",
    "Use plain language; put technical terms in parentheses only when helpful."
  ].join("\n");
}

// ---------- Analysis (used by /api/analyze and scripts/evaluate-memory.mjs) ----------

export async function recallMatches(query) {
  return groupRecall(await recall(query));
}

function logAnalysis(matches, recommendation, evidence) {
  if (process.env.MEMORYOPS_QUIET === "1") return;
  const recalled = matches.map((m) => m.incidentId).slice(0, 5).join(", ") || "none";
  const used = recommendation?.memoryUsed ? `used ${recommendation.matchedIncidentId}` : "no memory used (reflect judged none similar)";
  console.log(`[analyze] recalled ${matches.length}: ${recalled} | ${used} | confidence ${evidence?.confidence?.level ?? "-"}`);
}

export async function analyzeIncident(incident) {
  const facts = normalizeQuery(incident);
  const context = normalizedContext(facts);
  const matches = await recallMatches(NORMALIZE_QUERY && context ? `${incident}\n${context}` : incident);
  const team = await teamKnowledge(facts);
  if (matches.length === 0) {
    if (process.env.MEMORYOPS_QUIET !== "1") console.log("[analyze] recalled 0 memories from this bank");
    const evidence = analyzeEvidence({ incident, matches, patterns: team.patterns });
    const recommendation = { structured: true, memoryUsed: false, matchedIncidentId: null, general: true, source: "GENERAL_KNOWLEDGE", ...GENERAL_TROUBLESHOOTING };
    return withKnowledge(incident, { ok: true, state: "no_experience", matches: [], evidence, team, recommendation, suggestedFix: null });
  }
  let recommendation;
  try {
    recommendation = shapeRecommendation(await reflect(reflectPrompt(incident, matches)), matches);
  } catch (err) {
    // Recall worked; show what was recalled and report the reflect failure honestly.
    const evidence = analyzeEvidence({ incident, matches, patterns: team.patterns });
    return withKnowledge(incident, { ok: true, state: "match_found", matches, evidence, team, recommendation: null, suggestedFix: null, reflectError: { message: err.message || "Reflect failed.", code: err.code || "reflect_failed" } });
  }
  // Reflect's text is team-memory-based only when it used a recalled incident; otherwise it is general reasoning.
  recommendation.source = recommendation.memoryUsed ? "TEAM_MEMORY" : "GENERAL_KNOWLEDGE";
  const evidence = analyzeEvidence({
    incident, matches, patterns: team.patterns,
    reflectMatchedId: recommendation.memoryUsed ? recommendation.matchedIncidentId : null,
    reflectJudgedNone: !recommendation.memoryUsed
  });
  if (Array.isArray(recommendation.checks)) {
    // Negative experience: a known failed action is never presented as the fix.
    const { checks, suppressed } = suppressFailedChecks(recommendation.checks, evidence.failedBefore, evidence.workedBefore);
    recommendation.checks = checks;
    recommendation.suppressed = suppressed;
  }
  // Suggested fix: only from the confirmed incident the recommendation is actually based on.
  let suggestedFix = null;
  if (recommendation.memoryUsed) {
    const match = matches.find((m) => m.incidentId === recommendation.matchedIncidentId);
    const hypothesis = evidence.hypotheses.find((h) => h.supporting_memories.some((s) => s.id === match?.incidentId)) || null;
    suggestedFix = suggestFix({ match, confidence: evidence.confidence.level, hypothesis });
  }
  logAnalysis(matches, recommendation, evidence);
  return withKnowledge(incident, { ok: true, state: recommendation.memoryUsed ? "recommendation_ready" : "no_experience", matches, evidence, team, recommendation, suggestedFix });
}

// Documented knowledge is retrieved separately from team memory, labelled by source, and only fills the
// gaps team experience leaves. It never changes team-memory confidence and is never retained.
function searchCorpus(incident) {
  try {
    return searchKnowledge(incident);
  } catch (err) {
    return { hits: [], docs: [], error: `Knowledge corpus unavailable: ${err.message}` };
  }
}

const overlaps = (a, b) => (a.keywords || []).filter((k) => (b.keywords || []).includes(k)).length >= 2;

export async function withKnowledge(incident, result) {
  const knowledge = searchCorpus(incident);
  if (LIVE_DOCS && knowledge.hits.length) {
    try {
      const live = await liveDocs(incident, knowledge.hits[0], { sources: loadKnowledge().sources });
      knowledge.docs = [...live, ...knowledge.docs].slice(0, 3);
    } catch {
      // Live lookup is best-effort; the local corpus answer stands.
    }
  }
  const evidence = result.evidence;
  const mode = decideMode({ evidence, recommendation: result.recommendation, knowledge });
  // Team hypotheses first; documented hypotheses only fill remaining slots and never duplicate a team one.
  const teamHyps = evidence.hypotheses || [];
  const docHyps = knowledgeHypotheses(knowledge.hits).filter((k) => !teamHyps.some((t) => overlaps(t, k)));
  evidence.hypotheses = [...teamHyps, ...docHyps].slice(0, 3);
  evidence.nextBestCheck = nextBestCheck(evidence.hypotheses) || INSUFFICIENT_CHECK;
  let suggestedFix = result.suggestedFix || null;
  if (!suggestedFix && mode.mode !== "TEAM-LED") {
    // No verified team fix: at most an illustrative, placeholder-only documented example.
    suggestedFix = generalExampleFix(knowledge.hits.slice(0, 2).find((h) => h.example_fix)) || null;
  }
  return { ...result, mode, evidence, suggestedFix, knowledge: { hits: knowledge.hits, docs: knowledge.docs, error: knowledge.error || null, liveDocs: LIVE_DOCS } };
}

// Team patterns / playbook for today's situation (area + timing), read back from Hindsight.
async function teamKnowledge(facts) {
  const out = { patterns: [], playbook: null };
  if (!facts.area || !facts.trigger) return out;
  const key = `${facts.area}-${facts.trigger}`;
  try {
    const list = await hindsightFetch(`${BANK_PATH}/documents?q=${encodeURIComponent(`memoryops-pattern-${key}-`)}&limit=20`, { timeoutMs: TIMEOUTS.status });
    for (const item of list.items || []) {
      const doc = await hindsightFetch(`${BANK_PATH}/documents/${encodeURIComponent(item.id)}`, { timeoutMs: TIMEOUTS.status });
      const p = readPayload(doc);
      if (p) out.patterns.push(p);
    }
    out.playbook = readPayload(await hindsightFetch(`${BANK_PATH}/documents/${encodeURIComponent(`memoryops-playbook-${key}`)}`, { timeoutMs: TIMEOUTS.status }));
  } catch {
    // Missing bank/doc or an error: show no team knowledge rather than guessing.
  }
  return out;
}

// Read every confirmed incident document and upsert TEAM_PATTERN / PLAYBOOK memories.
// Stable ids + unchanged-content skip => updates, never duplicates. Incidents are never modified or deleted.
async function readIncidentDocs() {
  const ids = [];
  for (let offset = 0; ; offset += 100) {
    const page = await hindsightFetch(`${BANK_PATH}/documents?q=memoryops-&limit=100&offset=${offset}`, { timeoutMs: TIMEOUTS.status });
    const items = page.items || [];
    ids.push(...items.map((i) => i.id).filter((id) => /^memoryops-(INC|MO)-/.test(id)));
    if (items.length < 100) break;
  }
  const docs = [];
  for (let i = 0; i < ids.length; i += 8) {
    const batch = await Promise.all(ids.slice(i, i + 8).map((id) => hindsightFetch(`${BANK_PATH}/documents/${encodeURIComponent(id)}`, { timeoutMs: TIMEOUTS.status })));
    batch.forEach((d, k) => docs.push({ documentId: ids[i + k], text: d.original_text || "" }));
  }
  return docs;
}

export async function consolidateMemory() {
  const docs = await readIncidentDocs();
  const result = consolidate(docs);
  const items = [...result.patterns.map(patternToRetainItem), ...result.playbooks.map(playbookToRetainItem)];
  const changes = [];
  for (const item of items) {
    let status = "created";
    try {
      const existing = await hindsightFetch(`${BANK_PATH}/documents/${encodeURIComponent(item.document_id)}`, { timeoutMs: TIMEOUTS.status });
      status = existing.original_text === item.content ? "unchanged" : "updated";
    } catch (err) {
      if (err.code !== "hindsight_not_found") throw err;
    }
    if (status !== "unchanged") await retain([item]);
    changes.push({ id: item.document_id.replace(/^memoryops-/, ""), type: item.metadata.memoryops_type, status });
  }
  return { incidentsRead: docs.length, confirmedIncidents: result.incidents, patterns: result.patterns, playbooks: result.playbooks, changes };
}

// Exact per-kind document counts via GET /documents?q=<id prefix> (the response's total).
async function countDocuments(prefix) {
  try {
    const data = await hindsightFetch(`${BANK_PATH}/documents?q=${encodeURIComponent(prefix)}&limit=1`, { timeoutMs: TIMEOUTS.status });
    return Number.isFinite(data.total) ? data.total : null;
  } catch {
    return null;
  }
}

export async function resolveIncident(body) {
  // Only a human-confirmed outcome enters memory. AI recommendations are never retained.
  if (body.confirmed !== true) {
    throw new ApiError(400, "not_confirmed", "Confirm that this is what actually happened before saving it as experience.");
  }
  const incident = requiredText(body, "incident", "The problem description");
  const worked = typeof body.worked === "string" ? requiredText(body, "worked", "What actually fixed the problem") : requiredText(body, "resolution", "What actually fixed the problem");
  const cause = optionalText(body, "cause");
  const attempted = optionalText(body, "attempted");
  const outcome = optionalText(body, "outcome");
  const lesson = optionalText(body, "lesson");
  const area = optionalText(body, "area", 60).replace(/[()\n]/g, " ") || "Saved from MemoryOps";
  const causeConfirmed = body.causeConfirmed === true;
  // Session observations become memory only now, as part of a human-confirmed outcome.
  // Knowledge promotion: a documented hypothesis a person investigated and confirmed. Only the source id is kept.
  let promotedFrom = null;
  if (body.promotedFrom !== undefined && body.promotedFrom !== null && body.promotedFrom !== "") {
    const ids = new Set(loadKnowledge().pack.entries.map((e) => e.id));
    if (typeof body.promotedFrom !== "string" || !ids.has(body.promotedFrom)) throw new ApiError(400, "validation", "promotedFrom must be a known curated knowledge id.");
    promotedFrom = body.promotedFrom;
  }
  const observations = Array.isArray(body.observations) ? body.observations.filter((o) => typeof o === "string" && o.trim()).slice(0, 10).map((o) => o.trim().slice(0, 300)) : [];

  const now = new Date();
  // Unique per save (timestamp + random suffix) so no earlier experience is ever replaced.
  const id = `MO-${now.toISOString().slice(5, 16).replace(/\D/g, "")}-${Math.random().toString(36).slice(2, 5).toUpperCase().padEnd(3, "0")}`;
  const title = incident.split(/(?<=[.!?])\s/)[0].slice(0, 160);
  const result = await retain([{
    content: [
      `Past solved problem ${id} (${area})`,
      `Title: ${title}`,
      "Status: Human-confirmed resolution (saved by the team after the problem was fixed)",
      `What happened: ${incident}`,
      cause && (causeConfirmed ? `Confirmed cause: ${cause}` : `Suspected cause (not confirmed): ${cause}`),
      attempted && `Tried but did NOT fix it: ${attempted}`,
      `What worked: ${worked}`,
      outcome && `Outcome: ${outcome}`,
      observations.length && `Observations during diagnosis: ${observations.join("; ")}`,
      lesson && `Lesson learned: ${lesson}`,
      promotedFrom && `Originally suggested by: curated knowledge ${promotedFrom} (investigated and confirmed by a person)`,
      `Recorded at: ${now.toISOString()}`
    ].filter(Boolean).join("\n"),
    context: `Human-confirmed resolution ${id} saved by the team in MemoryOps`,
    timestamp: now.toISOString(),
    // A new document per resolution: earlier experience is never overwritten.
    document_id: `memoryops-${id}`,
    metadata: { memoryops_id: id, source: "memoryops-resolution", verification: "human-confirmed", cause_status: cause ? (causeConfirmed ? "confirmed" : "suspected") : "unknown", ...(promotedFrom ? { promoted_from: promotedFrom } : {}) }
  }]);
  overviewCache = null;
  return { ok: true, id, stored: result.items_count ?? 1, causeStatus: cause ? (causeConfirmed ? "confirmed" : "suspected") : "unknown", promotedFrom };
}



// "What MemoryOps knows": real counts per source + maturity per category. Cached briefly; reset on save/seed.
let overviewCache = null;
const OVERVIEW_TTL_MS = 60000;

export async function knowledgeOverview() {
  if (overviewCache && Date.now() - overviewCache.at < OVERVIEW_TTL_MS) return overviewCache.data;
  const kb = loadKnowledge();
  const ks = knowledgeStats(kb);
  const data = {
    ok: true,
    curated: { entries: ks.curatedEntries, technologies: ks.technologies, trustLevel: kb.pack.trust_level || "SYNTHETIC" },
    documentation: { chunks: ks.docChunks, publishers: [...new Set(kb.docs.map((d) => d.publisher))], liveLookup: LIVE_DOCS },
    generalKnowledge: { available: true, note: "Model reasoning without a cited source. Lowest priority; always labelled." },
    team: null,
    maturity: knowledgeMaturity([], kb.pack),
    teamError: null
  };
  if (!API_KEY) data.teamError = "HINDSIGHT_API_KEY is missing, so team memory cannot be counted.";
  else {
    try {
      const [historical, learned, patterns, playbooks] = await Promise.all(["memoryops-INC-", "memoryops-MO-", "memoryops-pattern-", "memoryops-playbook-"].map(countDocuments));
      const docs = await readIncidentDocs();
      data.maturity = knowledgeMaturity(docs, kb.pack);
      data.team = { historical, learned, confirmed: data.maturity.reduce((a, r) => a + r.confirmedIncidents, 0), patterns, playbooks };
    } catch (err) {
      data.teamError = err.code === "hindsight_not_found" ? null : err.message;
      if (err.code === "hindsight_not_found") data.team = { historical: 0, learned: 0, confirmed: 0, patterns: 0, playbooks: 0 };
    }
  }
  overviewCache = { at: Date.now(), data };
  return data;
}

// ---------- Routes ----------

let seedInFlight = false;

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/status") {
    const status = { ok: true, bankId: BANK_ID, hasApiKey: Boolean(API_KEY), connected: false, bankExists: false, documents: null, facts: null, pendingOperations: 0 };
    if (!API_KEY) return send(res, 200, { ...status, error: "HINDSIGHT_API_KEY is missing." });
    try {
      const stats = await hindsightFetch(`${BANK_PATH}/stats`, { timeoutMs: TIMEOUTS.status });
      Object.assign(status, {
        connected: true,
        bankExists: true,
        documents: Number.isFinite(stats.total_documents) ? stats.total_documents : null,
        facts: Number.isFinite(stats.total_nodes) ? stats.total_nodes : null,
        pendingOperations: Number.isFinite(stats.pending_operations) ? stats.pending_operations : 0
      });
      const [historical, learned, feedback, patterns, playbooks] = await Promise.all(["memoryops-INC-", "memoryops-MO-", "memoryops-feedback-", "memoryops-pattern-", "memoryops-playbook-"].map(countDocuments));
      status.counts = { historical, learned, feedback, patterns, playbooks };
    } catch (err) {
      if (err.code === "hindsight_not_found") Object.assign(status, { connected: true, documents: 0, facts: 0 });
      else Object.assign(status, { error: err.message, code: err.code });
    }
    return send(res, 200, status);
  }

  if (req.method === "GET" && url.pathname === "/api/knowledge") {
    return send(res, 200, await knowledgeOverview());
  }

  if (req.method === "POST" && url.pathname === "/api/seed") {
    if (seedInFlight) throw new ApiError(409, "seed_in_progress", "Past incidents are already being loaded. Please wait.");
    seedInFlight = true;
    try {
      const samples = sampleIncidents();
      const result = await retain(samples.map(incidentToRetainItem));
      overviewCache = null;
      return send(res, 200, { ok: true, seeded: samples.length, stored: result.items_count ?? samples.length, incidents: samples.map((i) => i.incident_id) });
    } finally {
      seedInFlight = false;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/analyze") {
    const incident = requiredText(await readJson(req), "incident", "A description of the current problem");
    return send(res, 200, await analyzeIncident(incident));
  }

  if (req.method === "POST" && url.pathname === "/api/resolve") {
    const saved = await resolveIncident(await readJson(req));
    let consolidation = null;
    if (AUTO_CONSOLIDATE) {
      try {
        const c = await consolidateMemory();
        consolidation = { changes: c.changes, patterns: c.patterns.map((p) => ({ id: p.pattern_id, statement: p.statement, supporting: p.supporting_incidents.length })) };
      } catch (err) {
        consolidation = { error: err.message };
      }
    }
    return send(res, 200, { ...saved, consolidation });
  }

  if (req.method === "POST" && url.pathname === "/api/consolidate") {
    const c = await consolidateMemory();
    return send(res, 200, { ok: true, ...c });
  }

  if (req.method === "POST" && url.pathname === "/api/diagnose") {
    // Session evidence only: nothing here is retained.
    const body = await readJson(req);
    if (!Array.isArray(body.hypotheses) || body.hypotheses.length > 3) throw new ApiError(400, "validation", "hypotheses must be a list of up to 3.");
    if (!Array.isArray(body.observations) || body.observations.length > 20 || body.observations.some((o) => typeof o !== "string" || o.length > 500)) {
      throw new ApiError(400, "validation", "observations must be a list of short strings.");
    }
    for (const h of body.hypotheses) {
      if (!h || typeof h.id !== "string" || !Array.isArray(h.keywords)) throw new ApiError(400, "validation", "Malformed hypothesis.");
    }
    return send(res, 200, { ok: true, retained: false, ...applyObservations(body.hypotheses, body.observations) });
  }

  if (req.method === "POST" && url.pathname === "/api/feedback") {
    const body = await readJson(req);
    const incidentId = requiredText(body, "incidentId", "The incident id");
    if (!/^[A-Z]{2,5}-[A-Za-z0-9-]{1,30}$/.test(incidentId)) throw new ApiError(400, "validation", "Unknown incident id.");
    if (typeof body.helpful !== "boolean") throw new ApiError(400, "validation", "helpful must be true or false.");
    const incident = requiredText(body, "incident", "The problem description");
    const now = new Date();
    const verdict = body.helpful ? "Helpful" : "Not relevant";
    await retain([{
      content: [
        `Team feedback on past incident ${incidentId}`,
        `Verdict: ${verdict}`,
        `For problem: ${incident.slice(0, 500)}`,
        "Note: This is feedback about relevance only, not a confirmed cause or fix.",
        `Recorded at: ${now.toISOString()}`
      ].join("\n"),
      context: `Team feedback: ${incidentId} was ${verdict.toLowerCase()} for a new problem`,
      timestamp: now.toISOString(),
      document_id: `memoryops-feedback-${incidentId}-${now.getTime()}`,
      metadata: { source: "memoryops-feedback", about: incidentId, verdict }
    }]);
    return send(res, 200, { ok: true, verdict });
  }

  return false;
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};
const publicRoot = path.join(__dirname, "public");

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        const handled = await api(req, res, url);
        if (handled !== false) return;
        return send(res, 404, { error: "API route not found." });
      }
      const relative = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
      const file = path.normalize(path.join(publicRoot, relative));
      if (!file.startsWith(publicRoot + path.sep)) return send(res, 403, "Forbidden", "text/plain");
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "Not found", "text/plain");
      return send(res, 200, fs.readFileSync(file), mime[path.extname(file)] || "application/octet-stream");
    } catch (err) {
      if (err instanceof ApiError) {
        return send(res, err.status, { error: err.message, code: err.code, ...(err.detail ? { detail: err.detail } : {}) });
      }
      console.error("Unexpected error:", redact(err?.stack || err?.message));
      if (!res.headersSent) send(res, 500, { error: "Unexpected server error.", code: "internal" });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  createServer().listen(PORT, () => {
    console.log(`MemoryOps running at http://localhost:${PORT}`);
    console.log(`Hindsight: ${BASE_URL}  bank: ${BANK_ID}  api key: ${API_KEY ? "set" : "MISSING"}`);
  });
}
