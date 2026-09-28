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
    const out = await handler(req, body);
    if (out === "hang") return; // never respond -> exercises timeout
    res.writeHead(out.status || 200, { "Content-Type": "application/json" });
    res.end(typeof out.raw === "string" ? out.raw : JSON.stringify(out.json ?? {}));
  });
  const hsPort = await listen(hindsight);

  Object.assign(process.env, {
    MEMORYOPS_SKIP_DOTENV: "1",
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
  handler = (req) => {
    assert.equal(req.url, "/v1/default/banks/test-bank/stats");
    return { json: { bank_id: "test-bank", total_nodes: 12, total_documents: 3, pending_operations: 0 } };
  };
  const res = await fetch(base + "/api/status").then((r) => r.json());
  assert.equal(res.connected, true);
  assert.equal(res.documents, 3);
  assert.equal(res.facts, 12);
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
  assert.equal(calls.length, 1, "reflect must not run when nothing was recalled");
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

test("resolve retains today's solution and requires both fields", async () => {
  const missing = await post("/api/resolve", { incident: INCIDENT });
  assert.equal(missing.status, 400);
  handler = (req, body) => ({ json: { success: true, bank_id: "test-bank", items_count: body.items.length, async: false } });
  const res = await post("/api/resolve", { incident: INCIDENT, resolution: "Restored the limit from 5 to 30." });
  assert.equal(res.status, 200);
  assert.match(res.json.id, /^MO-\d{12}$/);
  const item = calls[0].body.items[0];
  assert.match(item.content, /What worked: Restored the limit from 5 to 30\./);
  assert.equal(item.document_id, `memoryops-${res.json.id}`);
});

test("retain without success confirmation is reported as a failure", async () => {
  handler = () => ({ json: { success: false } });
  const res = await post("/api/resolve", { incident: INCIDENT, resolution: "fixed" });
  assert.equal(res.status, 502);
  assert.equal(res.json.code, "hindsight_bad_response");
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
