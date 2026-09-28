// Runs scripts/seed-memory-dataset.mjs against a fake Hindsight HTTP server (never the real API).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/seed-memory-dataset.mjs", import.meta.url));
const KEY = "hsk_ingest_secret_do_not_print";
const docs = new Map();
let mode = "ok";
let retainCalls = 0;
let server, port;

before(async () => {
  server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const j = (s, o) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (mode === "auth") return j(401, { detail: "bad key" });
    const m = req.url.match(/^\/v1\/default\/banks\/([^/]+)\/(documents\/(.+)|memories)$/);
    if (req.method === "GET" && m?.[3]) {
      const d = docs.get(decodeURIComponent(m[3]));
      return d ? j(200, { id: d.document_id, original_text: d.content }) : j(404, { detail: "not found" });
    }
    if (req.method === "POST" && m?.[2] === "memories") {
      retainCalls++;
      const { items } = JSON.parse(raw);
      for (const it of items) docs.set(it.document_id, it); // upsert by document_id, like Hindsight
      return j(200, { success: true, bank_id: m[1], items_count: items.length, async: false });
    }
    j(404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(() => server.close());

function run(args) {
  return new Promise((resolve) => {
    execFile("node", [SCRIPT, ...args], {
      env: { ...process.env, MEMORYOPS_SKIP_DOTENV: "1", HINDSIGHT_BASE_URL: `http://127.0.0.1:${port}`, HINDSIGHT_API_KEY: KEY }
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
  });
}

test("ingestion is duplicate-safe: a second run skips unchanged incidents", async () => {
  const first = await run(["--bank", "t1", "--only", "INC-1042,INC-1057,INC-1088", "--batch-size", "2"]);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /\[1\/3\] INC-\d+ retained \(new\)/);
  assert.match(first.out, /3 retained\n0 unchanged/);
  assert.equal(docs.size, 3);
  assert.equal(retainCalls, 2, "batched");

  const second = await run(["--bank", "t1", "--only", "INC-1042,INC-1057,INC-1088"]);
  assert.equal(second.code, 0);
  assert.match(second.out, /0 retained\n3 unchanged/);
  assert.equal(retainCalls, 2, "nothing re-sent");
  assert.equal(docs.size, 3, "no duplicates");

  docs.get("memoryops-INC-1042").content = "older wording";
  const third = await run(["--bank", "t1", "--only", "INC-1042,INC-1057"]);
  assert.match(third.out, /INC-1042 retained \(updated\)/);
  assert.equal(docs.size, 3, "changed record replaced in place");
});

test("ingestion requires an explicit bank, stops on auth failure, and never prints the key", async () => {
  const noBank = await run([]);
  assert.equal(noBank.code, 2);
  assert.match(noBank.out, /memory bank is required/);
  mode = "auth";
  const auth = await run(["--bank", "t2", "--only", "INC-1042"]);
  mode = "ok";
  assert.equal(auth.code, 1);
  assert.match(auth.out, /Stopping: Hindsight rejected the API key/);
  for (const r of [noBank, auth]) assert.ok(!r.out.includes(KEY));
});
