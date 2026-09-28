// Tests run MemoryOps against a fake Hindsight HTTP server. They never call the real Hindsight API.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const FAKE_KEY = "hsk_test_secret_do_not_leak";
let hindsight; // fake Hindsight server
let handler;   // per-test route handler: (req, body) => { status, json } | "hang"
let calls;     // requests the fake Hindsight received
let app;       // MemoryOps server
let base;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

before(async () => {
  hindsight = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    // Document reads (team knowledge / consolidation) 404 unless a test opts in: a bank with no patterns.
    if (req.url.includes("/documents") && !handler.documents) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ detail: "not found" }));
    }
    const out = await handler(req, body);
    if (out === "hang") return; // never respond -> exercises timeout
    res.writeHead(out.status || 200, { "Content-Type": "application/json" });
    res.end(typeof out.raw === "string" ? out.raw : JSON.stringify(out.json ?? {}));
  });
  const hsPort = await listen(hindsight);

  Object.assign(process.env, {
    MEMORYOPS_SKIP_DOTENV: "1",
    MEMORYOPS_QUIET: "1",
    HINDSIGHT_BASE_URL: `http://127.0.0.1:${hsPort}`,
    HINDSIGHT_API_KEY: FAKE_KEY,
    HINDSIGHT_BANK_ID: "test-bank",
    HINDSIGHT_TIMEOUT_MS: "400"
  });
  const { createServer } = await import("../server.mjs");
  app = createServer();
  base = `http://127.0.0.1:${await listen(app)}`;
});

after(() => {
  hindsight.closeAllConnections?.();
  hindsight.close();
  app.close();
});

beforeEach(() => {
  calls = [];
  handler = () => ({ status: 500, json: { detail: "unexpected call" } });
});

async function post(path, body, raw) {
  const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ?? JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}

const INCIDENT = "Customers are unable to place orders after today's checkout update.";
const CHECKOUT_CHUNK = [
  "Past solved problem INC-1042 (Checkout)",
  "Title: Checkout stopped working shortly after a software update.",
  "What happened: Orders failed and database requests started timing out right after the update.",
  "Confirmed cause: The database connection limit had accidentally been changed from 30 to 5.",
  "What worked: Restored the database connection limit to 30 and restarted the checkout service.",
  "Lesson learned: Compare database connection settings with the previous working configuration.",
  "Technical details: checkout-api returned HTTP 502."
].join("\n");

const recallWithCheckout = {
  results: [
    { id: "f1", text: "Checkout failed after an update due to a connection limit change.", document_id: "memoryops-INC-1042", chunk_id: "c1", scores: { final: 0.9, reranker: 0.91 } },
    { id: "f2", text: "Login failed after certificate renewal.", document_id: "memoryops-INC-1088", chunk_id: "c2", scores: { final: 0.2, reranker: 0.12 } }
  ],
  chunks: {
    c1: { id: "c1", text: CHECKOUT_CHUNK, chunk_index: 0 },
    c2: { id: "c2", text: "Past solved problem INC-1088 (Login)\nTitle: Users could not sign in after a security certificate was renewed.", chunk_index: 0 }
  }
};

test("status reports a real connection and document count from /stats", async () => {
  const totals = { "memoryops-INC-": 50, "memoryops-MO-": 2, "memoryops-feedback-": 1, "memoryops-pattern-": 1, "memoryops-playbook-": 1 };
  handler = Object.assign((req) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/v1/default/banks/test-bank/documents") return { json: { items: [], total: totals[u.searchParams.get("q")], limit: 1, offset: 0 } };
    assert.equal(u.pathname, "/v1/default/banks/test-bank/stats");
    return { json: { bank_id: "test-bank", total_nodes: 12, total_documents: 53, pending_operations: 0 } };
  }, { documents: true });
  const res = await fetch(base + "/api/status").then((r) => r.json());
  assert.equal(res.connected, true);
  assert.equal(res.documents, 53);
  assert.equal(res.facts, 12);
  assert.deepEqual(res.counts, { historical: 50, learned: 2, feedback: 1, patterns: 1, playbooks: 1 }, "real per-kind counts from GET /documents?q=");
  assert.equal(calls[0].auth, `Bearer ${FAKE_KEY}`);
});

test("status treats a missing bank as connected and empty", async () => {
  handler = () => ({ status: 404, json: { detail: "Bank not found" } });
  const res = await fetch(base + "/api/status").then((r) => r.json());
  assert.equal(res.connected, true);
  assert.equal(res.documents, 0);
});

test("analyze rejects missing incident and invalid JSON without calling Hindsight", async () => {
  const empty = await post("/api/analyze", { incident: "   " });
  assert.equal(empty.status, 400);
  const bad = await post("/api/analyze", null, "{not json");
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "invalid_json");
  assert.equal(calls.length, 0);
});

test("analyze with empty memory returns general troubleshooting and skips reflect", async () => {
  handler = (req) => req.url.endsWith("/memories/recall") ? { json: { results: [] } } : { status: 500, json: {} };
  const res = await post("/api/analyze", { incident: INCIDENT });
  assert.equal(res.status, 200);
  assert.equal(res.json.state, "no_experience");
  assert.equal(res.json.matches.length, 0);
  assert.equal(res.json.recommendation.memoryUsed, false);
  assert.equal(calls.filter((c) => c.url.endsWith("/reflect")).length, 0, "reflect must not run when nothing was recalled");
  assert.equal(res.json.evidence.confidence.level, "INSUFFICIENT");
  assert.match(res.json.evidence.confidence.statement, /does not have enough historical evidence/);
  assert.doesNotMatch(res.text, /INC-1042/, "no fabricated past incident");
});

test("analyze with recalled memory attributes the recommendation to the real recalled incident", async () => {
  handler = (req, body) => {
    if (req.url.endsWith("/memories/recall")) {
      assert.equal(body.query, INCIDENT);
      assert.deepEqual(body.include.chunks, { max_tokens: 4000 });
      return { json: recallWithCheckout };
    }
    assert.ok(req.url.endsWith("/reflect"));
    assert.ok(body.response_schema, "reflect asks for structured output");
    assert.match(body.query, /INC-1042/);
    return { json: { text: "{}", structured_output: {
      similar_problem_found: true, matched_incident_id: "INC-1042",
      likely_pattern: "A setting changed in the update.",
      first_checks: ["Compare database connection settings", "Check connection saturation", "Check whether the update changed it"],
      why: "Same symptoms right after an update.", safety_note: "Verify first."
    } } };
  };
  const res = await post("/api/analyze", { incident: INCIDENT });
  assert.equal(res.status, 200);
  assert.equal(res.json.state, "recommendation_ready");
  assert.equal(res.json.recommendation.matchedIncidentId, "INC-1042");
  assert.equal(res.json.recommendation.checks.length, 3);
  const top = res.json.matches[0];
  assert.equal(top.incidentId, "INC-1042");
  assert.equal(top.fields.cause, "The database connection limit had accidentally been changed from 30 to 5.");
  assert.equal(top.score, 0.91);
});

test("reflect claiming an incident that was not recalled is not attributed to memory", async () => {
  handler = (req) => req.url.endsWith("/memories/recall")
    ? { json: recallWithCheckout }
    : { json: { text: "x", structured_output: { similar_problem_found: true, matched_incident_id: "INC-9999", likely_pattern: "p", first_checks: ["a"], why: "w", safety_note: "s" } } };
  const res = await post("/api/analyze", { incident: INCIDENT });
  assert.equal(res.json.recommendation.memoryUsed, false);
  assert.equal(res.json.state, "no_experience");
});

test("reflect failure after a successful recall reports match_found honestly", async () => {
  handler = (req) => req.url.endsWith("/memories/recall") ? { json: recallWithCheckout } : { status: 503, json: { detail: "down" } };
  const res = await post("/api/analyze", { incident: INCIDENT });
  assert.equal(res.status, 200);
  assert.equal(res.json.state, "match_found");
  assert.equal(res.json.recommendation, null);
  assert.equal(res.json.reflectError.code, "hindsight_unavailable");
});

test("seed retains three incidents with stable document_ids (no duplicates on re-seed)", async () => {
  handler = (req, body) => ({ json: { success: true, bank_id: "test-bank", items_count: body.items.length, async: false } });
  const first = await post("/api/seed", {});
  const second = await post("/api/seed", {});
  assert.equal(first.status, 200);
  assert.equal(first.json.seeded, 3);
  assert.equal(second.status, 200);
  const ids = calls.map((c) => c.body.items.map((i) => i.document_id));
  assert.deepEqual(ids[0], ["memoryops-INC-1042", "memoryops-INC-1057", "memoryops-INC-1088"]);
  assert.deepEqual(ids[0], ids[1], "same document ids => Hindsight replaces instead of duplicating");
  assert.equal(calls[0].url, "/v1/default/banks/test-bank/memories");
});

test("concurrent seed clicks are rejected while one is in flight", async () => {
  handler = async (req, body) => {
    await new Promise((r) => setTimeout(r, 150));
    return { json: { success: true, bank_id: "test-bank", items_count: body.items.length, async: false } };
  };
  const [a, b] = await Promise.all([post("/api/seed", {}), post("/api/seed", {})]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(calls.length, 1);
});

test("resolve retains a structured, human-confirmed outcome and requires confirmation", async () => {
  const unconfirmed = await post("/api/resolve", { incident: INCIDENT, worked: "Restored the limit." });
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.json.code, "not_confirmed");
  const noFix = await post("/api/resolve", { incident: INCIDENT, confirmed: true });
  assert.equal(noFix.status, 400);
  assert.equal(calls.length, 0);

  handler = (req, body) => ({ json: { success: true, bank_id: "test-bank", items_count: body.items.length, async: false } });
  const res = await post("/api/resolve", {
    incident: INCIDENT, area: "Checkout", confirmed: true, causeConfirmed: true,
    cause: "Connection limit changed from 30 to 5.", attempted: "Restarted the app only.",
    worked: "Restored the limit from 5 to 30.", outcome: "Orders normal.", lesson: "Compare connection settings first."
  });
  assert.equal(res.status, 200);
  assert.match(res.json.id, /^MO-\d{8}-[A-Z0-9]{3}$/);
  const item = calls[0].body.items[0];
  assert.match(item.content, /^Past solved problem MO-\d{8}-[A-Z0-9]{3} \(Checkout\)/);
  assert.match(item.content, /Status: Human-confirmed resolution/);
  assert.match(item.content, /Confirmed cause: Connection limit changed from 30 to 5\./);
  assert.match(item.content, /Tried but did NOT fix it: Restarted the app only\./);
  assert.match(item.content, /What worked: Restored the limit from 5 to 30\./);
  assert.equal(item.metadata.verification, "human-confirmed");
  assert.equal(item.document_id, `memoryops-${res.json.id}`);
});

test("a cause the human did not confirm is stored as suspected, not confirmed", async () => {
  handler = (req, body) => ({ json: { success: true, bank_id: "test-bank", items_count: 1, async: false } });
  const res = await post("/api/resolve", { incident: INCIDENT, confirmed: true, cause: "Maybe the cache.", worked: "Rolled back." });
  assert.equal(res.json.causeStatus, "suspected");
  const content = calls[0].body.items[0].content;
  assert.match(content, /Suspected cause \(not confirmed\): Maybe the cache\./);
  assert.doesNotMatch(content, /Confirmed cause/);
});

test("retain without success confirmation is reported as a failure", async () => {
  handler = () => ({ json: { success: false } });
  const res = await post("/api/resolve", { incident: INCIDENT, worked: "fixed", confirmed: true });
  assert.equal(res.status, 502);
  assert.equal(res.json.code, "hindsight_bad_response");
});

test("feedback is retained as a relevance hint and shown on the incident, never as an incident", async () => {
  handler = (req, body) => ({ json: { success: true, bank_id: "test-bank", items_count: 1, async: false } });
  const bad = await post("/api/feedback", { incidentId: "INC-1042", incident: INCIDENT });
  assert.equal(bad.status, 400);
  const res = await post("/api/feedback", { incidentId: "INC-1042", helpful: true, incident: INCIDENT });
  assert.equal(res.status, 200);
  const fb = calls[0].body.items[0];
  assert.match(fb.content, /not a confirmed cause or fix/);
  assert.match(fb.document_id, /^memoryops-feedback-INC-1042-/);

  calls = [];
  handler = (req) => req.url.endsWith("/memories/recall")
    ? { json: {
        results: [...recallWithCheckout.results, { id: "f9", text: "Feedback: INC-1042 helpful", document_id: "memoryops-feedback-INC-1042-1", chunk_id: "c9" }],
        chunks: { ...recallWithCheckout.chunks, c9: { id: "c9", text: fb.content, chunk_index: 0 } } } }
    : { json: { text: "", structured_output: { similar_problem_found: false, matched_incident_id: "", likely_pattern: "", first_checks: ["a"], why: "", safety_note: "", avoid: "", conflict_note: "", team_learned: "" } } };
  const analyzed = await post("/api/analyze", { incident: INCIDENT });
  assert.deepEqual(analyzed.json.matches.map((m) => m.incidentId), ["INC-1042", "INC-1088"]);
  assert.equal(analyzed.json.matches[0].feedback[0].verdict, "Helpful");
});

test("Hindsight 401 maps to an auth error without leaking the key", async () => {
  handler = () => ({ status: 401, json: { detail: `Invalid token ${FAKE_KEY}` } });
  const res = await post("/api/analyze", { incident: INCIDENT });
  assert.equal(res.status, 502);
  assert.equal(res.json.code, "hindsight_auth");
  assert.ok(!res.text.includes(FAKE_KEY), "API key must never reach the browser");
});

test("Hindsight 500 and 429 map to friendly errors", async () => {
  handler = () => ({ status: 500, json: { detail: "boom" } });
  const r500 = await post("/api/seed", {});
  assert.equal(r500.status, 502);
  assert.equal(r500.json.code, "hindsight_unavailable");
  handler = () => ({ status: 429, json: { detail: "slow down" } });
  const r429 = await post("/api/analyze", { incident: INCIDENT });
  assert.equal(r429.status, 429);
});

test("Hindsight timeout returns 504 instead of hanging", async () => {
  handler = () => "hang";
  const started = Date.now();
  const res = await post("/api/analyze", { incident: INCIDENT });
  assert.equal(res.status, 504);
  assert.equal(res.json.code, "hindsight_timeout");
  assert.ok(Date.now() - started < 3000);
});

test("malformed Hindsight responses are reported, not crashed on", async () => {
  handler = () => ({ raw: "<html>gateway</html>" });
  const html = await post("/api/analyze", { incident: INCIDENT });
  assert.equal(html.status, 502);
  assert.equal(html.json.code, "hindsight_bad_response");
  handler = () => ({ json: { unexpected: true } });
  const noResults = await post("/api/analyze", { incident: INCIDENT });
  assert.equal(noResults.status, 502);
  // Server is still alive afterwards.
  handler = () => ({ json: { total_documents: 0 } });
  assert.equal((await fetch(base + "/api/status")).status, 200);
});

test("the API key is never served to the browser", async () => {
  handler = () => ({ json: { total_documents: 1 } });
  for (const p of ["/", "/app.js", "/styles.css", "/api/status"]) {
    const text = await fetch(base + p).then((r) => r.text());
    assert.ok(!text.includes(FAKE_KEY), `${p} leaked the key`);
  }
  assert.equal((await fetch(base + "/../server.mjs")).status === 200, false);
});

// ---------------- Self-learning loop acceptance scenario ----------------
// A stateful fake Hindsight: retained documents are recalled by word overlap, and reflect
// matches the first recalled incident that shares enough words with today's problem.
// This proves MemoryOps' plumbing (retain -> recall -> attribution); real semantic recall is
// covered by `npm run smoke` against a real Hindsight bank.
test("learning loop: fresh -> save confirmed fix -> reworded problem recalls it -> new outcome kept -> unrelated not matched", async () => {
  const store = new Map();
  const words = (t) => new Set(t.toLowerCase().match(/[a-z]{5,}/g) || []);
  const overlap = (a, b) => [...words(a)].filter((w) => words(b).has(w)).length;
  handler = (req, body) => {
    if (req.url.endsWith("/memories")) {
      for (const it of body.items) store.set(it.document_id, it);
      return { json: { success: true, bank_id: "test-bank", items_count: body.items.length, async: false } };
    }
    if (req.url.endsWith("/memories/recall")) {
      const hits = [...store.values()].filter((d) => overlap(d.content, body.query) >= 3);
      return { json: {
        results: hits.map((d, i) => ({ id: `f${i}`, text: d.content.split("\n")[1], document_id: d.document_id, chunk_id: `c${i}`, metadata: d.metadata })),
        chunks: Object.fromEntries(hits.map((d, i) => [`c${i}`, { id: `c${i}`, text: d.content, chunk_index: 0 }]))
      } };
    }
    if (req.url.endsWith("/reflect")) {
      const today = body.query.match(/TODAY'S PROBLEM: (.*)/)[1];
      const hit = [...store.values()].find((d) => body.query.includes(d.metadata.memoryops_id) && overlap(d.content, today) >= 4);
      return { json: { text: "", structured_output: {
        similar_problem_found: Boolean(hit), matched_incident_id: hit ? hit.metadata.memoryops_id : "",
        likely_pattern: "p", first_checks: ["Compare connection settings", "Check saturation", "Check the release"],
        why: "w", safety_note: "s", avoid: hit ? "Restarting alone did not fix it before." : "", conflict_note: "", team_learned: hit ? "t" : ""
      } } };
    }
    return { status: 404, json: {} };
  };

  // TEST 1: fresh bank -> no fake match.
  const r1 = await post("/api/analyze", { incident: "Customers cannot place orders after today's checkout update; checkout requests failing and the database appears overloaded." });
  assert.equal(r1.json.state, "no_experience");
  assert.equal(r1.json.matches.length, 0);
  // TEST 7: analysis never writes to memory.
  assert.equal([...calls].filter((c) => c.url.endsWith("/memories")).length, 0);
  assert.equal(store.size, 0);

  // TEST 2: save a confirmed checkout resolution.
  const s1 = await post("/api/resolve", {
    incident: "Customers cannot place orders after today's checkout update; checkout requests failing and the database appears overloaded.",
    area: "Checkout", confirmed: true, causeConfirmed: true,
    cause: "Database connection limit changed from 30 to 5 in the release.",
    attempted: "Restarted the checkout service only; database timeouts returned.",
    worked: "Restored the database connection limit to 30 and restarted checkout.",
    lesson: "Checkout failures plus database timeouts after a release: compare database connection settings first."
  });
  assert.equal(s1.status, 200);

  // TEST 3 + 4: reworded problem recalls the learned, verified incident with provenance.
  const r2 = await post("/api/analyze", { incident: "Customers report that checkout becomes unavailable after today's release. Database requests are timing out and capacity appears exhausted." });
  assert.equal(r2.json.state, "recommendation_ready");
  assert.equal(r2.json.recommendation.matchedIncidentId, s1.json.id);
  const m = r2.json.matches[0];
  assert.equal(m.learned, true);
  assert.equal(m.verified, true);
  assert.match(m.fields.cause, /30 to 5/);
  assert.match(m.fields.attempted, /Restarted the checkout service only/);
  assert.match(r2.json.recommendation.avoid, /did not fix/);

  // TEST 5: a different outcome is added without destroying the old one.
  const s2 = await post("/api/resolve", {
    incident: "Checkout unavailable after release; database requests timing out again.", area: "Checkout", confirmed: true, causeConfirmed: true,
    cause: "A configuration template reset the database connection limit to 5.", worked: "Fixed the template and restored the limit to 30."
  });
  assert.equal(s2.status, 200);
  assert.notEqual(s2.json.id, s1.json.id);
  assert.equal(store.size, 2, "old experience kept");
  assert.ok(!calls.some((c) => c.method === "DELETE"));

  // TEST 6: unrelated problem is not matched to the checkout experience.
  const r3 = await post("/api/analyze", { incident: "Marketing images on the company website load slowly for visitors in Europe." });
  assert.equal(r3.json.recommendation.memoryUsed, false);
  assert.notEqual(r3.json.state, "recommendation_ready");
});

// ---------------- Diagnostic loop & consolidation (server) ----------------
test("diagnose updates hypotheses from session observations and never calls Hindsight", async () => {
  const hyp = [{ id: "connection-config", hypothesis: "Database connection capacity/configuration", keywords: ["pool", "connection", "30"], confidence: "MEDIUM", next_check: "Compare pool size", expected_if_true: "pool reduced", supporting_memories: [] }];
  const res = await post("/api/diagnose", { hypotheses: hyp, observations: ["Current pool is 5. Previous version was 30."] });
  assert.equal(res.status, 200);
  assert.equal(res.json.retained, false);
  assert.equal(res.json.hypotheses[0].status, "supported");
  assert.equal(calls.length, 0, "session evidence is not sent to memory");
  assert.equal((await post("/api/diagnose", { hypotheses: "x", observations: [] })).status, 400);
});

test("observations are stored only as part of a confirmed resolution", async () => {
  handler = (req, body) => ({ json: { success: true, bank_id: "test-bank", items_count: body.items.length, async: false } });
  const refused = await post("/api/resolve", { incident: INCIDENT, worked: "Restored pool", observations: ["pool was 5"] });
  assert.equal(refused.status, 400);
  assert.equal(calls.length, 0);
  const ok = await post("/api/resolve", { incident: INCIDENT, worked: "Restored pool", confirmed: true, observations: ["pool was 5", "previous was 30"] });
  assert.equal(ok.status, 200);
  assert.match(calls.find((c) => c.url.endsWith("/memories")).body.items[0].content, /Observations during diagnosis: pool was 5; previous was 30/);
});

test("consolidation: pattern + playbook appear at 3 confirmed incidents, update in place, never delete", async () => {
  const store = new Map();
  handler = Object.assign((req, body) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.endsWith("/memories") && req.method === "POST") {
      for (const it of body.items) store.set(it.document_id, it);
      return { json: { success: true, bank_id: "test-bank", items_count: body.items.length, async: false } };
    }
    if (u.pathname.endsWith("/documents")) {
      const q = u.searchParams.get("q") || "";
      const items = [...store.keys()].filter((k) => k.includes(q)).map((id) => ({ id }));
      return { json: { items, total: items.length, limit: 100, offset: 0 } };
    }
    const m = u.pathname.match(/\/documents\/(.+)$/);
    if (m) {
      const d = store.get(decodeURIComponent(m[1]));
      return d ? { json: { id: d.document_id, original_text: d.content, document_metadata: d.metadata } } : { status: 404, json: { detail: "nf" } };
    }
    return { status: 404, json: {} };
  }, { documents: true });
  const save = (cause) => post("/api/resolve", { incident: "Checkout failing after today's release; database connections exhausted.", area: "Checkout", confirmed: true, causeConfirmed: true, cause, worked: "Restored the database connection limit", attempted: "Restarted the checkout service", lesson: "Compare database connection settings with the last known-good configuration." });

  const r1 = await save("Database connection limit lowered to 5 in the release");
  const r2 = await save("Connection pool size reduced by a shared template");
  assert.deepEqual(r2.json.consolidation.changes, [], "two incidents: no pattern yet");
  const r3 = await save("Per-instance database connection limit capped at 3");
  assert.deepEqual(r3.json.consolidation.changes.map((c) => `${c.type}:${c.status}`), ["TEAM_PATTERN:created", "PLAYBOOK:created"]);
  assert.equal(r3.json.consolidation.patterns[0].supporting, 3);

  const again = await post("/api/consolidate", {});
  assert.deepEqual(again.json.changes.map((c) => c.status), ["unchanged", "unchanged"], "no duplicate or rewrite");
  const r4 = await post("/api/resolve", { incident: "Checkout failing after today's release; errors when orders are submitted.", confirmed: true, causeConfirmed: true, cause: "Tax service TLS certificate expired", worked: "Renewed the certificate" });
  assert.deepEqual(r4.json.consolidation.changes.map((c) => c.status), ["updated", "updated"]);
  assert.equal([...store.keys()].filter((k) => k.startsWith("memoryops-pattern-")).length, 1);
  assert.equal([...store.keys()].filter((k) => /^memoryops-MO-/.test(k)).length, 4, "incidents are never removed");
  assert.ok(!calls.some((c) => c.method === "DELETE"));

  // Analysis reads team knowledge back and shows the counterexample-aware statement.
  const a = await post("/api/analyze", { incident: "Orders fail right after today's release and database connections are exhausted." });
  assert.match(a.json.team.patterns[0].statement, /but similar symptoms have also come from certificate/);
  assert.equal(a.json.team.playbook.learned_from, 4);
  for (const r of [r1, r3, r4, again, a]) assert.ok(!r.text.includes(FAKE_KEY));
});

test("analysis includes a suggested fix only when based on a recalled confirmed incident", async () => {
  const confirmedChunk = CHECKOUT_CHUNK.replace("Title:", "Status: Confirmed resolved incident\nTitle:");
  const confirmedRecall = { ...recallWithCheckout, chunks: { ...recallWithCheckout.chunks, c1: { id: "c1", text: confirmedChunk, chunk_index: 0 } } };
  handler = (req) => req.url.endsWith("/memories/recall")
    ? { json: confirmedRecall }
    : { json: { text: "", structured_output: { similar_problem_found: true, matched_incident_id: "INC-1042", likely_pattern: "p", first_checks: ["Compare connection settings"], why: "w", safety_note: "s", avoid: "", conflict_note: "", team_learned: "" } } };
  const withFix = await post("/api/analyze", { incident: "Orders fail right after today's release and database connections are exhausted." });
  assert.equal(withFix.json.suggestedFix.diff, "- DATABASE_CONNECTION_LIMIT=5\n+ DATABASE_CONNECTION_LIMIT=30");
  assert.equal(withFix.json.suggestedFix.source.incidentId, "INC-1042");
  handler = (req) => req.url.endsWith("/memories/recall")
    ? { json: confirmedRecall }
    : { json: { text: "", structured_output: { similar_problem_found: false, matched_incident_id: "", likely_pattern: "", first_checks: ["a"], why: "", safety_note: "", avoid: "", conflict_note: "", team_learned: "" } } };
  const without = await post("/api/analyze", { incident: "Orders fail right after today's release and database connections are exhausted." });
  // No verified team fix; at most a clearly labelled, placeholder-only documented example.
  const fix = without.json.suggestedFix;
  assert.ok(!fix || (fix.label === "GENERAL EXAMPLE" && fix.kind === "general-example" && !/=\s*\d/.test(fix.diff) && fix.source.type === "CURATED_KNOWLEDGE"));
  assert.equal(withFix.json.suggestedFix.label, "VERIFIED TEAM FIX");
});

test("reflect naming a recalled incident in a wrapped format is still attributed", async () => {
  handler = (req) => req.url.endsWith("/memories/recall")
    ? { json: recallWithCheckout }
    : { json: { text: "", structured_output: { similar_problem_found: true, matched_incident_id: "inc-1042 (checkout pool regression)", likely_pattern: "p", first_checks: ["a"], why: "w", safety_note: "s", avoid: "", conflict_note: "", team_learned: "" } } };
  const res = await post("/api/analyze", { incident: INCIDENT });
  assert.equal(res.json.recommendation.matchedIncidentId, "INC-1042");
  assert.equal(res.json.state, "recommendation_ready");
});

// ---------- Knowledge-led behaviour (curated knowledge is never team memory) ----------

test("empty team memory + known symptom -> KNOWLEDGE-LED with labelled hypotheses, nothing retained", async () => {
  handler = (req) => req.url.endsWith("/memories/recall") ? { json: { results: [] } } : { status: 500, json: {} };
  const res = await post("/api/analyze", { incident: "Checkout stopped working after today's release." });
  assert.equal(res.status, 200);
  assert.equal(res.json.mode.mode, "KNOWLEDGE-LED");
  assert.equal(res.json.evidence.confidence.level, "INSUFFICIENT", "team-memory confidence is not inflated by documented knowledge");
  assert.equal(res.json.knowledge.hits[0].id, "KB-CHECKOUT-001");
  assert.ok(res.json.evidence.hypotheses.length >= 1 && res.json.evidence.hypotheses.length <= 3);
  for (const h of res.json.evidence.hypotheses) {
    assert.equal(h.source, "CURATED_KNOWLEDGE");
    assert.notEqual(h.confidence, "HIGH", "knowledge alone never reaches HIGH");
  }
  assert.equal(res.json.evidence.nextBestCheck.source, "CURATED_KNOWLEDGE");
  assert.match(res.json.evidence.nextBestCheck.text, /configuration/i);
  assert.ok(!calls.some((c) => c.url.endsWith("/memories") && c.method === "POST"), "AI hypotheses are never stored");
  assert.doesNotMatch(res.text, /INC-\d/, "no invented team incident");
});

test("no team memory and no knowledge match -> INSUFFICIENT with one next best check", async () => {
  handler = (req) => req.url.endsWith("/memories/recall") ? { json: { results: [] } } : { status: 500, json: {} };
  const res = await post("/api/analyze", { incident: "The office printer on the third floor keeps jamming." });
  assert.equal(res.json.mode.mode, "INSUFFICIENT");
  assert.equal(res.json.knowledge.hits.length, 0);
  assert.equal(res.json.evidence.hypotheses.length, 0);
  assert.equal(res.json.evidence.nextBestCheck.source, "GENERAL_KNOWLEDGE");
  assert.equal(res.json.suggestedFix, null);
});

test("recalled confirmed team incident -> TEAM-LED, team hypotheses first and labelled TEAM_MEMORY", async () => {
  const confirmedChunk = CHECKOUT_CHUNK.replace("Title:", "Status: Confirmed resolved incident\nTitle:");
  const confirmedRecall = { ...recallWithCheckout, chunks: { ...recallWithCheckout.chunks, c1: { id: "c1", text: confirmedChunk, chunk_index: 0 } } };
  handler = (req) => req.url.endsWith("/memories/recall")
    ? { json: confirmedRecall }
    : { json: { text: "", structured_output: { similar_problem_found: true, matched_incident_id: "INC-1042", likely_pattern: "p", first_checks: ["Compare connection settings"], why: "w", safety_note: "s", avoid: "", conflict_note: "", team_learned: "" } } };
  const res = await post("/api/analyze", { incident: "Orders fail right after today's release and database connections are exhausted." });
  assert.equal(res.json.mode.mode, "TEAM-LED");
  assert.equal(res.json.evidence.hypotheses[0].source, "TEAM_MEMORY");
  assert.equal(res.json.recommendation.source, "TEAM_MEMORY");
  assert.equal(res.json.suggestedFix.label, "VERIFIED TEAM FIX");
  const kb = res.json.evidence.hypotheses.filter((h) => h.source === "CURATED_KNOWLEDGE");
  assert.ok(kb.every((h) => !/pool|connection/i.test(h.hypothesis)), "documented hypotheses do not duplicate the team one");
});

test("resolve promotes a documented hypothesis only after human confirmation and validates the id", async () => {
  handler = (req, body) => ({ json: { success: true, bank_id: "test-bank", items_count: body.items.length, async: false } });
  const bad = await post("/api/resolve", { incident: INCIDENT, worked: "Rolled back the config", confirmed: true, promotedFrom: "KB-NOT-REAL" });
  assert.equal(bad.status, 400);
  assert.equal(calls.length, 0);
  const unconfirmed = await post("/api/resolve", { incident: INCIDENT, worked: "Rolled back the config", promotedFrom: "KB-CHECKOUT-001" });
  assert.equal(unconfirmed.status, 400);
  const ok = await post("/api/resolve", { incident: INCIDENT, worked: "Rolled back the config", cause: "Pool size reset by the release", causeConfirmed: true, confirmed: true, promotedFrom: "KB-CHECKOUT-001" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.promotedFrom, "KB-CHECKOUT-001");
  const item = calls.find((c) => c.url.endsWith("/memories")).body.items[0];
  assert.match(item.content, /Status: Human-confirmed resolution/);
  assert.match(item.content, /Originally suggested by: curated knowledge KB-CHECKOUT-001 \(investigated and confirmed by a person\)/);
  assert.equal(item.metadata.promoted_from, "KB-CHECKOUT-001");
});

test("/api/knowledge reports real counts and maturity per category", async () => {
  const docs = {
    "memoryops-INC-1": "Past solved problem INC-1 (checkout-api)\nTitle: Checkout down\nStatus: Confirmed resolved incident\nService: checkout-api | Category: Checkout / ordering | Severity: high | Environment: production\nConfirmed cause: pool reset\nWhat worked: restored pool",
    "memoryops-INC-2": "Past solved problem INC-2 (checkout-api)\nTitle: Checkout slow\nStatus: Confirmed resolved incident\nService: checkout-api | Category: Checkout / ordering | Severity: high | Environment: production\nConfirmed cause: db\nWhat worked: x",
    "memoryops-INC-3": "Past solved problem INC-3 (checkout-api)\nTitle: Orders fail\nStatus: Confirmed resolved incident\nService: checkout-api | Category: Checkout / ordering | Severity: high | Environment: production\nConfirmed cause: cert\nWhat worked: y",
    "memoryops-MO-1": "Past solved problem MO-1 (Login)\nTitle: Users cannot sign in\nStatus: Human-confirmed resolution\nConfirmed cause: key rotation\nWhat worked: reload keys"
  };
  handler = Object.assign((req) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.endsWith("/documents")) {
      const q = u.searchParams.get("q") || "";
      const items = Object.keys(docs).filter((k) => k.startsWith(q)).map((id) => ({ id }));
      return { json: { items, total: items.length, limit: 100, offset: 0 } };
    }
    const m = u.pathname.match(/\/documents\/(.+)$/);
    if (m && docs[decodeURIComponent(m[1])]) return { json: { id: m[1], original_text: docs[decodeURIComponent(m[1])] } };
    return { status: 404, json: {} };
  }, { documents: true });
  const res = await fetch(base + "/api/knowledge").then((r) => r.json());
  assert.equal(res.curated.entries >= 150, true);
  assert.equal(res.team.historical, 3);
  assert.equal(res.team.learned, 1);
  const row = (k) => res.maturity.find((r) => r.key === k);
  assert.equal(row("checkout").level, "ESTABLISHED");
  assert.equal(row("checkout").confirmedIncidents, 3);
  assert.equal(row("authentication").level, "SOME");
  assert.equal(row("certificates").level, "NO");
  assert.ok(row("certificates").documentedEntries > 0, "documented knowledge is shown separately from team experience");
  assert.ok(!JSON.stringify(res).includes("%"), "no fabricated percentages");
  assert.ok(!JSON.stringify(res).includes(FAKE_KEY));
});
