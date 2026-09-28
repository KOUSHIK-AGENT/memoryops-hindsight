import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.HINDSIGHT_BASE_URL || "https://api.hindsight.vectorize.io").replace(/\/$/, "");
const API_KEY = process.env.HINDSIGHT_API_KEY || "";
const BANK_ID = process.env.HINDSIGHT_BANK_ID || "memoryops-demo";
const MOCK_MODE = process.env.MOCK_MODE === "1";

const mockMemories = [];

const seedIncidents = [
  {
    id: "INC-1042",
    service: "checkout-api",
    severity: "SEV-2",
    symptoms: "After a deployment, checkout requests intermittently return 502. Logs show DB acquire timeout and the pool is exhausted.",
    rootCause: "A deployment reduced the PostgreSQL connection pool from 30 to 5 while traffic stayed constant.",
    resolution: "Restore pool size to 30, restart checkout-api pods, then verify DB connection saturation and 5xx rate.",
    lesson: "When 502s and DB acquire timeouts appear together after checkout-api deployment, inspect connection-pool changes before broad rollback."
  },
  {
    id: "INC-1057",
    service: "payments-worker",
    severity: "SEV-2",
    symptoms: "Payment jobs are retrying every 30 seconds and duplicate webhook deliveries are increasing.",
    rootCause: "The idempotency key cache was unavailable after a Redis failover.",
    resolution: "Restore Redis primary connectivity, drain retries gradually, and verify idempotency-key hit rate.",
    lesson: "Duplicate webhook spikes plus retry storms can indicate idempotency cache loss."
  },
  {
    id: "INC-1088",
    service: "identity-api",
    severity: "SEV-1",
    symptoms: "Login latency jumps above 8 seconds and token validation failures rise after a certificate rotation.",
    rootCause: "One identity-api deployment still referenced the previous signing certificate.",
    resolution: "Update the certificate reference, roll the stale deployment, and validate token signing/verification across all replicas.",
    lesson: "After certificate rotation, mixed signing keys across replicas can produce intermittent auth failures."
  }
];

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
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function authHeaders() {
  return {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json"
  };
}

async function hindsightFetch(urlPath, options = {}) {
  if (!API_KEY) {
    throw new Error("HINDSIGHT_API_KEY is missing. Copy .env.example to .env and add your key.");
  }
  const response = await fetch(`${BASE_URL}${urlPath}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) }
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    const message = data?.detail || data?.message || data?.raw || `${response.status} ${response.statusText}`;
    const error = new Error(`Hindsight API: ${message}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function incidentAsMemory(i) {
  return [
    `Incident ${i.id} (${i.severity}) affected ${i.service}.`,
    `Symptoms: ${i.symptoms}`,
    `Root cause: ${i.rootCause}`,
    `Resolution that worked: ${i.resolution}`,
    `Operational lesson: ${i.lesson}`
  ].join("\n");
}

async function retain(content, context) {
  if (MOCK_MODE) {
    mockMemories.push({ text: content, context });
    return { mock: true };
  }
  return hindsightFetch(`/v1/default/banks/${encodeURIComponent(BANK_ID)}/memories`, {
    method: "POST",
    body: JSON.stringify({
      items: [{
        content,
        context,
        timestamp: new Date().toISOString()
      }]
    })
  });
}

async function recall(query) {
  if (MOCK_MODE) {
    const tokens = query.toLowerCase().split(/\W+/).filter(x => x.length > 3);
    const scored = mockMemories.map(m => ({
      ...m,
      score: tokens.reduce((n, t) => n + (m.text.toLowerCase().includes(t) ? 1 : 0), 0)
    })).sort((a, b) => b.score - a.score).slice(0, 4);
    return { results: scored };
  }
  try {
    return await hindsightFetch(`/v1/default/banks/${encodeURIComponent(BANK_ID)}/memories/recall`, {
      method: "POST",
      body: JSON.stringify({ query })
    });
  } catch (err) {
    if (err.status === 404) return { results: [] };
    throw err;
  }
}

async function reflect(query) {
  if (MOCK_MODE) {
    const relevant = (await recall(query)).results?.[0];
    if (!relevant) {
      return { text: "No prior incident memory is available yet. Start with standard triage: identify the failing service, compare the latest deployment/configuration change, inspect dependency saturation, and capture the final resolution so the agent can learn." };
    }
    const isCheckout = /checkout|502|database|db|pool/i.test(query);
    if (isCheckout) {
      return { text: "Likely pattern: a checkout-api database connection-pool regression seen in a prior incident.\n\nFirst checks:\n1. Compare the current deployment's DB pool setting with the last known-good version.\n2. Inspect DB acquire timeout and pool saturation metrics.\n3. If the pool was reduced, restore the known-good value and roll the service.\n\nWhy: a previous incident with the same 502 + DB acquire-timeout pattern was resolved by restoring the pool from 5 to 30. Treat this as evidence, not certainty; verify current metrics before changing production." };
    }
    return { text: `A related past incident was found. Use it as evidence, verify the current deployment/configuration delta, and only then apply the prior fix.\n\nMemory:\n${relevant.text}` };
  }
  try {
    return await hindsightFetch(`/v1/default/banks/${encodeURIComponent(BANK_ID)}/reflect`, {
      method: "POST",
      body: JSON.stringify({ query })
    });
  } catch (err) {
    if (err.status === 404) {
      return { text: "No memory bank exists yet. Seed or resolve at least one incident first." };
    }
    throw err;
  }
}

function normalizeRecall(data) {
  const items = data?.results || data?.items || [];
  return items.slice(0, 5).map((m, idx) => ({
    id: m.id || `memory-${idx + 1}`,
    text: m.text || m.content || JSON.stringify(m),
    type: m.type || "memory",
    score: m.score ?? m.relevance ?? m.relevance_score ?? null,
    context: m.context || null
  }));
}

function normalizeReflect(data) {
  return data?.text || data?.answer || data?.response || data?.content || JSON.stringify(data);
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/status") {
    let memoryCount = MOCK_MODE ? mockMemories.length : null;
    if (!MOCK_MODE && API_KEY) {
      try {
        const stats = await hindsightFetch(`/v1/default/banks/${encodeURIComponent(BANK_ID)}/stats`);
        memoryCount = stats?.memories ?? stats?.memory_count ?? stats?.count ?? null;
      } catch (_) {}
    }
    return send(res, 200, {
      ok: true,
      mode: MOCK_MODE ? "mock" : "hindsight",
      bankId: BANK_ID,
      hasApiKey: Boolean(API_KEY),
      memoryCount
    });
  }

  if (req.method === "POST" && url.pathname === "/api/seed") {
    for (const i of seedIncidents) {
      await retain(incidentAsMemory(i), `Resolved incident ${i.id} for ${i.service}`);
    }
    return send(res, 200, { ok: true, seeded: seedIncidents.length });
  }

  if (req.method === "POST" && url.pathname === "/api/analyze") {
    const body = await readJson(req);
    const incident = String(body.incident || "").trim();
    if (!incident) return send(res, 400, { error: "Incident description is required." });

    const recalled = normalizeRecall(await recall(incident));
    const prompt = [
      "You are MemoryOps, an incident-response copilot.",
      "Use this memory bank as historical evidence, not as unquestionable truth.",
      "For the CURRENT INCIDENT below, return:",
      "1) likely historical pattern (or say none),",
      "2) three concrete first checks,",
      "3) the prior evidence that motivated them,",
      "4) one verification step before any change.",
      "Be concise. Do not invent a past incident that is not in memory.",
      "",
      `CURRENT INCIDENT: ${incident}`
    ].join("\n");
    const reflection = normalizeReflect(await reflect(prompt));

    return send(res, 200, {
      ok: true,
      recalled,
      recommendation: reflection
    });
  }

  if (req.method === "POST" && url.pathname === "/api/resolve") {
    const body = await readJson(req);
    const incident = String(body.incident || "").trim();
    const resolution = String(body.resolution || "").trim();
    if (!incident || !resolution) {
      return send(res, 400, { error: "Incident and resolution are required." });
    }
    const content = [
      "Resolved incident learned from the current session.",
      `Incident symptoms: ${incident}`,
      `Resolution and outcome: ${resolution}`,
      "Use this as historical evidence for future similar incidents."
    ].join("\n");
    await retain(content, "Resolution captured from MemoryOps demo");
    return send(res, 200, { ok: true });
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      const handled = await api(req, res, url);
      if (handled !== false) return;
      return send(res, 404, { error: "API route not found." });
    }

    let relative = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.normalize(path.join(__dirname, "public", relative));
    const publicRoot = path.join(__dirname, "public");
    if (!file.startsWith(publicRoot)) return send(res, 403, "Forbidden", "text/plain");

    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, "Not found", "text/plain");
    }
    const ext = path.extname(file);
    return send(res, 200, fs.readFileSync(file), mime[ext] || "application/octet-stream");
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: err.message || "Unexpected server error." });
  }
});

server.listen(PORT, () => {
  console.log(`MemoryOps running at http://localhost:${PORT}`);
  console.log(`Mode: ${MOCK_MODE ? "MOCK (do not use for final recording)" : "Hindsight Cloud"}`);
  console.log(`Bank: ${BANK_ID}`);
});
