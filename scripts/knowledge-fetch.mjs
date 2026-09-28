// Fetch authoritative documentation pages listed in knowledge/sources.json.
//   npm run knowledge:fetch [-- --source kubernetes-docs]
// Only sources with license_status "permissive" are fetched; robots.txt is honoured; raw pages go to
// knowledge/raw/ (git-ignored). Nothing here touches Hindsight or team memory.
import fs from "node:fs";
import path from "node:path";
import { SOURCES_PATH } from "../lib/knowledge.mjs";
import { robotsAllows } from "../lib/html.mjs";
import { parseArgs } from "./cli.mjs";

const UA = "memoryops-knowledge-fetch/1.0 (+https://github.com/KOUSHIK-AGENT/memoryops-hindsight)";
const args = parseArgs(process.argv.slice(2));
const RAW = path.join(path.dirname(SOURCES_PATH), "raw");
const { sources } = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
const robotsCache = new Map();

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000), redirect: "follow" });
  return { status: res.status, text: await res.text(), type: res.headers.get("content-type") || "" };
}

let fetched = 0, skipped = 0, failed = 0;
for (const s of sources) {
  if (typeof args.source === "string" && s.id !== args.source) continue;
  if (s.license_status !== "permissive" || !s.fetch_urls.length) {
    if (s.fetch_urls.length) console.log(`skip ${s.id}: ${s.license_status} (${s.license})`);
    skipped += s.fetch_urls.length;
    continue;
  }
  for (const url of s.fetch_urls) {
    const u = new URL(url);
    try {
      if (!robotsCache.has(u.origin)) {
        const r = await get(`${u.origin}/robots.txt`).catch(() => ({ status: 0, text: "" }));
        robotsCache.set(u.origin, r.status === 200 ? r.text : "");
      }
      if (!robotsAllows(robotsCache.get(u.origin), u.pathname)) { console.log(`skip ${url}: disallowed by robots.txt`); skipped++; continue; }
      const r = await get(url);
      if (r.status !== 200 || !/html|text/.test(r.type)) throw new Error(`HTTP ${r.status} ${r.type}`);
      const dir = path.join(RAW, s.id);
      fs.mkdirSync(dir, { recursive: true });
      const slug = (u.pathname.replace(/\/$/, "").split("/").pop() || "index").replace(/\.html?$/i, "").replace(/[^a-z0-9.-]+/gi, "_");
      fs.writeFileSync(path.join(dir, `${slug}.html`), r.text);
      fs.writeFileSync(path.join(dir, `${slug}.meta.json`), JSON.stringify({ source_id: s.id, source_url: url, retrieved_at: new Date().toISOString() }, null, 2));
      console.log(`fetched ${url} (${Math.round(r.text.length / 1024)} KB)`);
      fetched++;
    } catch (err) {
      console.log(`FAILED ${url}: ${err.message}`);
      failed++;
    }
  }
}
console.log(`\n${fetched} fetched, ${skipped} skipped (licence or robots), ${failed} failed. Next: npm run knowledge:process`);
process.exitCode = failed && !fetched ? 1 : 0;
