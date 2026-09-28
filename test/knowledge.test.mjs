// Curated knowledge, documentation pipeline and response modes. Offline and deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadKnowledge, searchKnowledge, knowledgeHypotheses, generalExampleFix, tokenize, SOURCE_TYPES } from "../lib/knowledge.mjs";
import { decideMode } from "../lib/modes.mjs";
import { htmlToText, chunkByHeadings, dedupeChunks, robotsAllows } from "../lib/html.mjs";
import { liveDocs, clearLiveDocsCache } from "../lib/live-docs.mjs";
import { categorize, knowledgeMaturity, levelFor } from "../lib/maturity.mjs";

const kb = loadKnowledge();
const SECRET = /(api[_-]?key|secret|password|token)\s*[:=]\s*\S{6,}|\b(sk|hsk|ghp|AKIA)[_-]?[A-Za-z0-9]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

test("curated pack: 150-300 unique, complete, provenance-labelled entries", () => {
  const e = kb.pack.entries;
  assert.ok(e.length >= 150 && e.length <= 300, `${e.length} entries`);
  assert.equal(new Set(e.map((x) => x.id)).size, e.length, "unique ids");
  const sourceIds = new Set(kb.sources.map((s) => s.id));
  for (const x of e) {
    for (const f of ["technology", "category", "title"]) assert.ok(typeof x[f] === "string" && x[f], `${x.id}.${f}`);
    for (const f of ["symptoms", "likely_causes", "diagnostic_checks", "confirming_signals", "disconfirming_signals", "common_failed_actions", "safe_remediation_guidance", "warnings"]) {
      assert.ok(Array.isArray(x[f]) && x[f].length > 0, `${x.id}.${f}`);
    }
    assert.equal(x.source.trust_level, "SYNTHETIC");
    for (const r of x.source.references) assert.ok(sourceIds.has(r), `${x.id} cites unknown source ${r}`);
  }
});

test("sources declare licence, trust level and URL; only permissive sources are fetchable", () => {
  for (const s of kb.sources) {
    assert.ok(["AUTHORITATIVE", "OFFICIAL", "COMMUNITY", "SYNTHETIC"].includes(s.trust_level), s.id);
    assert.ok(s.license && s.license_status, s.id);
    if (s.license_status !== "permissive") assert.equal(s.fetch_urls.length, 0, `${s.id} is reference-only and must not be fetched`);
    for (const u of s.fetch_urls) assert.match(u, /^https:\/\//);
  }
});

test("knowledge corpus contains no secrets or personal email addresses", () => {
  const texts = [fs.readFileSync(new URL("../knowledge/curated/troubleshooting-pack.json", import.meta.url), "utf8"), ...kb.docs.map((d) => d.content)];
  for (const t of texts) {
    assert.doesNotMatch(t, SECRET);
    assert.doesNotMatch(t, EMAIL);
  }
});

test("processed documentation chunks carry full metadata", () => {
  for (const d of kb.docs) {
    for (const f of ["source_id", "title", "source_url", "publisher", "retrieved_at", "document_type", "technology", "topic", "license", "trust_level", "content", "chunk_id"]) {
      assert.ok(d[f] !== undefined && d[f] !== "", `${d.chunk_id}.${f}`);
    }
    assert.match(d.source_url, /^https:\/\//);
  }
});

test("retrieval finds the documented entry and abstains on unrelated text", () => {
  assert.equal(searchKnowledge("Checkout stopped working after today's release.").hits[0].id, "KB-CHECKOUT-001");
  assert.equal(searchKnowledge("Kafka consumer lag keeps growing and the group keeps rebalancing").hits[0].technology, "kafka");
  for (const q of ["The coffee machine is broken", "Our quarterly sales numbers look low", "A laptop battery drains within two hours whenever the editor is open"]) {
    assert.equal(searchKnowledge(q).hits.length, 0, q);
  }
});

test("knowledge hypotheses are labelled CURATED_KNOWLEDGE, capped at 3, never HIGH, each with a next check", () => {
  const hyps = knowledgeHypotheses(searchKnowledge("Checkout stopped working after today's release.").hits);
  assert.ok(hyps.length > 0 && hyps.length <= 3);
  for (const h of hyps) {
    assert.equal(h.source, "CURATED_KNOWLEDGE");
    assert.notEqual(h.source, "TEAM_MEMORY");
    assert.ok(["LOW", "MEDIUM"].includes(h.confidence));
    assert.ok(h.next_check && h.keywords.length);
    assert.equal(h.worked_before, null, "documented knowledge never claims something worked for this team");
  }
  assert.match(hyps[0].next_check, /Compare deployment configuration/);
});

test("general examples use placeholders, never concrete values", () => {
  const withExample = kb.pack.entries.filter((e) => e.example_fix);
  assert.ok(withExample.length > 0);
  for (const e of withExample) {
    assert.equal(e.example_fix.label, "GENERAL EXAMPLE");
    assert.match(e.example_fix.diff, /<[^>]+>/);
    assert.doesNotMatch(e.example_fix.diff, /=\s*\d/);
    const fix = generalExampleFix({ ...e, example_fix: e.example_fix });
    assert.equal(fix.label, "GENERAL EXAMPLE");
    assert.equal(fix.source.type, "CURATED_KNOWLEDGE");
  }
  assert.equal(generalExampleFix(null), null);
});

test("response modes follow the evidence, not the wording", () => {
  const hits = { hits: [{ id: "KB-X" }], docs: [] };
  assert.equal(decideMode({ evidence: { confidence: { level: "HIGH" }, relevant: [{}] }, recommendation: { memoryUsed: true }, knowledge: hits }).mode, "TEAM-LED");
  assert.equal(decideMode({ evidence: { confidence: { level: "LOW" }, relevant: [{}] }, recommendation: { memoryUsed: false }, knowledge: hits }).mode, "HYBRID");
  assert.equal(decideMode({ evidence: { confidence: { level: "INSUFFICIENT" }, relevant: [] }, recommendation: null, knowledge: hits }).mode, "KNOWLEDGE-LED");
  assert.equal(decideMode({ evidence: { confidence: { level: "INSUFFICIENT" }, relevant: [] }, recommendation: null, knowledge: { hits: [], docs: [] } }).mode, "INSUFFICIENT");
  assert.deepEqual(SOURCE_TYPES, ["SESSION_EVIDENCE", "TEAM_MEMORY", "TEAM_PATTERN", "PUBLIC_DOCUMENTATION", "CURATED_KNOWLEDGE", "GENERAL_KNOWLEDGE"]);
});

test("evaluation queries are held out: no long word sequence copied from the pack", () => {
  const cases = JSON.parse(fs.readFileSync(new URL("../data/knowledge-evaluation.json", import.meta.url), "utf8"));
  const packText = JSON.stringify(kb.pack.entries).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ");
  for (const c of cases) {
    const w = c.query.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
    for (let i = 0; i + 6 <= w.length; i++) {
      const gram = w.slice(i, i + 6).join(" ");
      assert.ok(!packText.includes(` ${gram} `), `${c.id} copies "${gram}" from the pack`);
    }
  }
});

test("html pipeline strips boilerplate, chunks by heading, dedupes and honours robots.txt", () => {
  const html = `<html><head><title>T</title><script>var k="x"</script></head><body><nav><a href="/">Home</a></nav>
    <header>Site header</header><main><ul><li><a href="#a">Contents A</a></li><li><a href="#b">Contents B</a></li></ul>
    <h2>Connection limits <a href="#x">#</a></h2><p>${"The server accepts a limited number of concurrent connections. ".repeat(4)}See <a href="/x">the reference</a> for details.</p>
    <h2>Locks</h2><p>${"Row locks are held until the transaction ends. ".repeat(4)}</p></main><footer>Copyright</footer></body></html>`;
  const text = htmlToText(html);
  assert.doesNotMatch(text, /Site header|Copyright|var k|Home|Contents A/);
  assert.match(text, /the reference for details/, "links inside prose are kept");
  const chunks = chunkByHeadings(text, { minLen: 50 });
  assert.deepEqual(chunks.map((c) => c.heading), ["Connection limits", "Locks"]);
  const { chunks: kept, removed } = dedupeChunks([...chunks, { ...chunks[0] }]);
  assert.equal(kept.length, 2);
  assert.equal(removed, 1);
  const robots = "User-agent: *\nDisallow: /private\n\nUser-agent: memoryops-knowledge-fetch\nDisallow: /docs/internal\n";
  assert.equal(robotsAllows(robots, "/docs/internal/x"), false);
  assert.equal(robotsAllows(robots, "/docs/public"), true);
  assert.equal(robotsAllows("", "/anything"), true);
});

test("live docs: fetch only allow-listed permissive pages, honour robots.txt, cite URL and time", async () => {
  clearLiveDocsCache();
  const sources = [
    { id: "ok-src", title: "OK Docs", publisher: "P", license: "MIT", license_status: "permissive", trust_level: "OFFICIAL", fetch_urls: ["https://docs.example/connections"] },
    { id: "blocked", title: "B", publisher: "P", license: "x", license_status: "permissive", trust_level: "OFFICIAL", fetch_urls: ["https://blocked.example/page"] },
    { id: "ref-only", title: "R", publisher: "P", license: "x", license_status: "reference-only", trust_level: "OFFICIAL", fetch_urls: ["https://ref.example/page"] }
  ];
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    const body = url.endsWith("robots.txt")
      ? (url.includes("blocked") ? "User-agent: *\nDisallow: /\n" : "")
      : `<main><h2>Connection pool</h2><p>${"When the connection pool is exhausted new requests wait for a free connection. ".repeat(3)}</p></main>`;
    return { status: 200, text: async () => body };
  };
  const hit = { title: "Connection pool exhausted", citations: sources.map((s) => ({ source_id: s.id })) };
  const out = await liveDocs("database connection pool exhausted", hit, { sources, fetchImpl });
  assert.ok(out.length >= 1);
  assert.equal(out[0].source_type, "PUBLIC_DOCUMENTATION");
  assert.equal(out[0].source_url, "https://docs.example/connections");
  assert.ok(out[0].retrieved_at);
  assert.ok(!fetched.includes("https://blocked.example/page"), "robots.txt disallow is honoured");
  assert.ok(!fetched.some((u) => u.includes("ref.example")), "reference-only sources are never fetched");
});

test("maturity: real counts per category, no percentages", () => {
  assert.equal(levelFor(0), "NO");
  assert.equal(levelFor(2), "SOME");
  assert.equal(levelFor(3), "ESTABLISHED");
  assert.equal(categorize("Past solved problem MO-1 (Payments)\nTitle: Customers charged twice"), "payments");
  const rows = knowledgeMaturity([{ text: "Past solved problem MO-1 (Login)\nStatus: Human-confirmed resolution\nConfirmed cause: x\nWhat worked: y" },
    { text: "Past solved problem MO-2 (Login)\nStatus: Human-confirmed resolution\nSuspected cause (not confirmed): x\nWhat worked: y" }], kb.pack);
  assert.equal(rows.find((r) => r.key === "authentication").confirmedIncidents, 1, "unconfirmed causes do not count as experience");
});

test("tokenizer ignores filler and normalises phrasing", () => {
  assert.deepEqual(tokenize("within two hours"), []);
  assert.ok(tokenize("users cannot log in").includes("login"));
});
