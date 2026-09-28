// Curated knowledge + processed public documentation: loading, BM25 retrieval, knowledge hypotheses,
// citations and general-example fixes. This is NOT team memory and is always labelled by source.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PACK_PATH = path.join(root, "knowledge", "curated", "troubleshooting-pack.json");
export const DOCS_PATH = path.join(root, "knowledge", "processed", "docs.json");
export const SOURCES_PATH = path.join(root, "knowledge", "sources.json");

export const SOURCE_TYPES = ["SESSION_EVIDENCE", "TEAM_MEMORY", "TEAM_PATTERN", "PUBLIC_DOCUMENTATION", "CURATED_KNOWLEDGE", "GENERAL_KNOWLEDGE"];

// ---------------------------------------------------------------- tokenisation
const stem = (w) => w.length > 5 && w.endsWith("ing") ? w.slice(0, -3) : w.length > 4 && w.endsWith("es") && !w.endsWith("ses") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
const STOP = new Set(("a an the and or of to in on for with was were is are be been it its this that these those after before our we they their " +
  "from by as at since then than not did does had has have only alone just very really some any all can could would should will may might " +
  "into out up down over about when while whenever within there here what which who how why get got getting " +
  // numbers and time filler: describe duration, not a failure mode
  "one two three four five six seven eight nine ten few several hour hours minute minutes day days week weeks").split(" "));
// Words too common in incident reports (or in any software context) to count as evidence of a match.
// They still contribute to the score, but not to the "at least two specific terms" requirement.
const WEAK = new Set(("see seeing saw error errors fail failing failed failure issue issues problem problems service services users user customers customer today started start broke broken working work works stopped seem seems appears appear look looks " +
  "code developer developers engineer engineers team system systems app application applications tool tools platform").split(" ").map(stem));

// General operational synonyms (query side). Domain vocabulary, not tuned to any evaluation case.
const SYNONYMS = {
  oom: ["memory", "oomkilled"], oomkilled: ["oom", "memory"], "out-of-memory": ["oom", "memory"],
  restart: ["crashloop", "restarts"], restarts: ["crashloop", "restart"], crashing: ["crash", "crashloop"], crash: ["crashloop"],
  pod: ["kubernetes", "container"], pods: ["kubernetes", "container", "pod"], k8s: ["kubernetes"], container: ["containers"],
  cert: ["certificate", "tls"], certificate: ["tls", "cert"], certificates: ["certificate", "tls"], ssl: ["tls", "certificate"], tls: ["certificate"], https: ["tls"],
  login: ["auth", "sign", "authentication"], signin: ["login", "auth"], logged: ["login", "session"], sso: ["saml", "auth"],
  token: ["jwt", "auth"], tokens: ["jwt", "token"], oauth: ["auth", "token"],
  db: ["database"], postgres: ["postgresql", "database"], postgresql: ["database"], sql: ["database", "query"], mysql: ["database"],
  timeout: ["timeouts", "timed"], timeouts: ["timeout"], timing: ["timeout"], timed: ["timeout"], hang: ["timeout", "stall"], hangs: ["timeout", "stall"],
  slow: ["latency", "slower"], slower: ["latency", "slow"], sluggish: ["latency", "slow"], lag: ["latency", "backlog"],
  exhausted: ["exhaustion", "pool", "too"], saturated: ["saturation", "exhausted"], full: ["exhausted"],
  orders: ["checkout", "order"], order: ["checkout"], purchase: ["checkout"], purchases: ["checkout"], cart: ["checkout"],
  release: ["deploy", "deployment", "rollout"], deploy: ["deployment", "release"], deployed: ["deploy", "release"], rollout: ["deploy", "release"], update: ["deploy", "release"],
  dns: ["resolve", "domain"], resolve: ["dns"], domain: ["dns"], nxdomain: ["dns", "resolve"],
  queue: ["queues", "backlog"], backlog: ["queue"], worker: ["workers", "queue"], workers: ["worker", "queue"], job: ["jobs", "cron"], jobs: ["job", "cron"], cron: ["scheduled", "job"],
  disk: ["space", "storage"], space: ["disk"], cpu: ["compute"], memory: ["heap", "oom"], heap: ["memory"],
  cache: ["redis", "caching"], redis: ["cache"], evicted: ["eviction", "evict"], eviction: ["evicted"],
  "502": ["gateway", "5xx", "proxy"], "503": ["unavailable", "5xx"], "504": ["gateway", "timeout", "5xx"], "500": ["5xx", "internal"], "429": ["rate", "limit"], "401": ["unauthorized", "auth"], "403": ["forbidden", "permission"],
  webhook: ["webhooks", "signature"], webhooks: ["webhook"], payment: ["payments"], payments: ["payment"], charged: ["payment", "duplicate"],
  config: ["configuration", "setting"], configuration: ["config"], env: ["environment", "variable"], variable: ["env", "config"],
  proxy: ["nginx", "gateway"], nginx: ["proxy"], ingress: ["kubernetes", "proxy"], balancer: ["load", "lb"], lb: ["balancer"],
  kafka: ["consumer", "partition", "queue"], rabbitmq: ["queue", "consumer"], grpc: ["deadline"], websocket: ["upgrade"],
  permission: ["denied", "forbidden"], denied: ["permission"], bucket: ["storage", "object"]
};

const words = (text) => (String(text || "").toLowerCase().replace(/out of memory/g, "out-of-memory").replace(/\b(log|sign)(ged|ed)? ?(in|on)\b/g, "login").match(/[a-z0-9][a-z0-9_-]*/g) || [])
  .filter((w) => !STOP.has(w) && (w.length > 1 || /\d/.test(w)));
export function tokenize(text) { return words(text).map(stem); }
// Synonyms are keyed by the unstemmed word ("postgres", not its stem).
function expandQuery(text) {
  const raw = words(text);
  const out = raw.map(stem);
  for (const w of raw) for (const s of SYNONYMS[w] || SYNONYMS[stem(w)] || []) out.push(stem(s));
  return out;
}

// ---------------------------------------------------------------- loading + index
let cache = null;
export function loadKnowledge({ packPath = PACK_PATH, docsPath = DOCS_PATH, sourcesPath = SOURCES_PATH } = {}) {
  if (cache && cache.key === `${packPath}|${docsPath}`) return cache;
  const pack = JSON.parse(fs.readFileSync(packPath, "utf8"));
  const sources = JSON.parse(fs.readFileSync(sourcesPath, "utf8")).sources;
  const docs = fs.existsSync(docsPath) ? JSON.parse(fs.readFileSync(docsPath, "utf8")) : [];
  const items = [];
  for (const e of pack.entries) {
    const weighted = [
      [e.title, 3], [e.symptoms.join(" "), 3], [`${e.technology} ${e.category}`, 2],
      [e.likely_causes.join(" "), 1.5], [e.confirming_signals.join(" "), 1], [e.diagnostic_checks.join(" "), 0.5]
    ];
    items.push({ kind: "curated", ref: e, tf: termFreq(weighted) });
  }
  for (const d of docs) items.push({ kind: "doc", ref: d, tf: termFreq([[d.title, 2], [d.topic || "", 2], [d.content, 1]]) });
  // Separate statistics per corpus: fetching more documentation never changes curated rankings.
  const stats = {};
  for (const kind of ["curated", "doc"]) {
    const group = items.filter((it) => it.kind === kind);
    const df = new Map();
    let totalLen = 0;
    for (const it of group) { it.len = [...it.tf.values()].reduce((a, b) => a + b, 0); totalLen += it.len; for (const t of it.tf.keys()) df.set(t, (df.get(t) || 0) + 1); }
    stats[kind] = { N: group.length, df, avgLen: totalLen / Math.max(1, group.length) };
  }
  cache = { key: `${packPath}|${docsPath}`, pack, sources, docs, items, stats };
  return cache;
}
function termFreq(weighted) {
  const tf = new Map();
  for (const [text, w] of weighted) for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + w);
  return tf;
}

// ---------------------------------------------------------------- retrieval
export const MIN_SCORE = 7;       // below this, no curated knowledge is considered relevant (abstain)
export const MIN_STRONG_TERMS = 2; // and at least two non-generic query terms must match
const TECH_NAMED_BOOST = 1.25;

export function searchKnowledge(query, { k = 3, kb = loadKnowledge() } = {}) {
  const base = tokenize(query);
  const qTerms = [...new Set(expandQuery(query))];
  const scored = [];
  for (const it of kb.items) {
    const { N, df, avgLen } = kb.stats[it.kind];
    let score = 0;
    const matched = new Set();
    for (const t of qTerms) {
      const f = it.tf.get(t);
      if (!f) continue;
      const n = df.get(t) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const boost = base.includes(t) ? 1 : 0.6; // synonyms count a little less than the user's own words
      score += boost * idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * it.len / avgLen));
      if (!WEAK.has(t)) matched.add(t);
    }
    // The user explicitly naming the entry's technology ("postgres", "kafka") is strong evidence of relevance.
    if (score > 0 && it.kind === "curated" && tokenize(it.ref.technology.replace(/-/g, " ")).every((t) => qTerms.includes(t))) score *= TECH_NAMED_BOOST;
    if (score > 0) scored.push({ it, score, matched: [...matched] });
  }
  scored.sort((a, b) => b.score - a.score);
  const relevant = scored.filter((s) => s.score >= MIN_SCORE && s.matched.length >= MIN_STRONG_TERMS);
  const curated = relevant.filter((s) => s.it.kind === "curated").slice(0, k).map((s) => shapeCurated(s, kb));
  const docs = relevant.filter((s) => s.it.kind === "doc").slice(0, 2).map((s) => shapeDoc(s));
  return { hits: curated, docs, considered: scored.length };
}

const round = (x) => Math.round(x * 100) / 100;
function citationsFor(ids, kb) {
  return ids.map((id) => kb.sources.find((s) => s.id === id)).filter(Boolean)
    .map((s) => ({ source_id: s.id, title: s.title, url: s.base_url, publisher: s.publisher, trust_level: s.trust_level, license_status: s.license_status }));
}
function shapeCurated(s, kb) {
  const e = s.it.ref;
  return {
    source_type: "CURATED_KNOWLEDGE", id: e.id, title: e.title, technology: e.technology, category: e.category,
    score: round(s.score), matched_terms: s.matched,
    symptoms: e.symptoms, likely_causes: e.likely_causes, diagnostic_checks: e.diagnostic_checks,
    confirming_signals: e.confirming_signals, disconfirming_signals: e.disconfirming_signals,
    common_failed_actions: e.common_failed_actions, safe_remediation_guidance: e.safe_remediation_guidance, warnings: e.warnings,
    example_fix: e.example_fix || null, trust_level: e.source.trust_level,
    citations: citationsFor(e.source.references, kb).filter((c) => c.source_id !== "memoryops-curated")
  };
}
function shapeDoc(s) {
  const d = s.it.ref;
  return { source_type: "PUBLIC_DOCUMENTATION", chunk_id: d.chunk_id, title: d.title, topic: d.topic, source_url: d.source_url, publisher: d.publisher,
    trust_level: d.trust_level, license: d.license, retrieved_at: d.retrieved_at, excerpt: d.content.slice(0, 420), score: round(s.score) };
}

// ---------------------------------------------------------------- knowledge hypotheses
const GENERIC_KW = new Set("check compare current previous value service configuration version latest recent".split(" "));
function kwFor(...texts) { return [...new Set(texts.flatMap((t) => tokenize(t)).filter((w) => !WEAK.has(w) && !GENERIC_KW.has(w) && w.length > 2))]; }

// Up to 3 hypotheses from the best entry's causes (paired with its checks), topped up from the next entries.
export function knowledgeHypotheses(hits, { max = 3 } = {}) {
  const out = [];
  for (const h of hits) {
    const causes = h === hits[0] ? h.likely_causes : h.likely_causes.slice(0, 1);
    causes.forEach((cause, i) => {
      if (out.length >= max) return;
      const check = h.diagnostic_checks[i] || h.diagnostic_checks[0];
      // Pair each cause with its own confirming signal; never reuse another cause's signal.
      const confirm = h.confirming_signals[i] || null;
      out.push({
        id: `${h.id}#${i}`, source: "CURATED_KNOWLEDGE", knowledge_id: h.id,
        hypothesis: cause.charAt(0).toUpperCase() + cause.slice(1),
        example_cause: null,
        supporting_current_evidence: h.matched_terms.length ? [`matches documented symptoms of "${h.title}" (${h.matched_terms.slice(0, 4).join(", ")})`] : [],
        supporting_memories: [],
        evidence_against: [],
        // Knowledge alone never reaches HIGH: it is not evidence about this team's system.
        // Only the best entry's first-listed cause can reach MEDIUM; alternatives stay LOW.
        confidence: h === hits[0] && i === 0 && h.score >= MIN_SCORE * 2 && h.matched_terms.length >= 3 ? "MEDIUM" : "LOW",
        next_check: check.charAt(0).toUpperCase() + check.slice(1) + ".",
        expected_if_true: confirm ? confirm.charAt(0).toUpperCase() + confirm.slice(1) + "." : null,
        worked_before: null,
        status: "open",
        keywords: kwFor(cause, confirm || "", check),
        citations: h.citations
      });
    });
    if (out.length >= max) break;
  }
  return out;
}

// A documented example fix is illustrative only: placeholders, never concrete values.
export function generalExampleFix(hit) {
  if (!hit?.example_fix) return null;
  return {
    kind: "general-example", label: "GENERAL EXAMPLE", title: hit.title, diff: hit.example_fix.diff,
    source: { type: "CURATED_KNOWLEDGE", id: hit.id }, verify: hit.diagnostic_checks[0],
    note: "Illustrative pattern from curated knowledge, not a proven fix for your system. Values are placeholders on purpose; take them from your own last known-good configuration."
  };
}

export function knowledgeStats(kb = loadKnowledge()) {
  const techs = new Set(kb.pack.entries.map((e) => e.technology));
  return { curatedEntries: kb.pack.entries.length, technologies: techs.size, docChunks: kb.docs.length, sources: kb.sources.length };
}
