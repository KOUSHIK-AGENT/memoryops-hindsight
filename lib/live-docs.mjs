// Optional live documentation lookup (MEMORYOPS_LIVE_DOCS=1). Off by default: most requests are answered
// from team memory + the local knowledge corpus. When on, it fetches only the permissive, allow-listed pages
// cited by the top curated entry, honours robots.txt, and returns short excerpts with their URL and time.
// Results are PUBLIC_DOCUMENTATION: shown as documentation, never stored as team memory.
import { htmlToText, chunkByHeadings, robotsAllows } from "./html.mjs";
import { tokenize } from "./knowledge.mjs";

const UA = "memoryops-knowledge-fetch/1.0 (+https://github.com/KOUSHIK-AGENT/memoryops-hindsight)";
const TTL_MS = 60 * 60 * 1000;
const pageCache = new Map();   // url -> { at, chunks, retrievedAt }
const robotsCache = new Map(); // origin -> robots.txt text ("" when absent)

async function getText(fetchImpl, url, timeoutMs) {
  const res = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  return { status: res.status, text: await res.text() };
}

async function pageChunks(url, { fetchImpl, timeoutMs }) {
  const hit = pageCache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    const r = await getText(fetchImpl, `${u.origin}/robots.txt`, timeoutMs).catch(() => null);
    if (!r) return null; // cannot check robots.txt: do not fetch
    robotsCache.set(u.origin, r.status === 200 ? r.text : "");
  }
  if (!robotsAllows(robotsCache.get(u.origin), u.pathname)) return null;
  const r = await getText(fetchImpl, url, timeoutMs);
  if (r.status !== 200) return null;
  const entry = { at: Date.now(), retrievedAt: new Date().toISOString(), chunks: chunkByHeadings(htmlToText(r.text)) };
  pageCache.set(url, entry);
  return entry;
}

export async function liveDocs(query, hit, { sources, fetchImpl = fetch, timeoutMs = 5000, maxPages = 2, max = 2 } = {}) {
  if (!hit) return [];
  const refs = new Set(hit.citations.map((c) => c.source_id));
  const allowed = sources.filter((s) => refs.has(s.id) && s.license_status === "permissive" && s.fetch_urls?.length);
  const q = new Set(tokenize(`${query} ${hit.title}`));
  const found = [];
  for (const s of allowed) {
    for (const url of s.fetch_urls.slice(0, maxPages)) {
      let page = null;
      try { page = await pageChunks(url, { fetchImpl, timeoutMs }); } catch { page = null; }
      if (!page) continue;
      for (const c of page.chunks) {
        const terms = new Set(tokenize(`${c.heading} ${c.content}`));
        const overlap = [...q].filter((t) => terms.has(t));
        if (overlap.length < 2) continue;
        found.push({
          source_type: "PUBLIC_DOCUMENTATION", live: true, source_id: s.id, title: s.title, topic: c.heading,
          source_url: url, publisher: s.publisher, license: s.license, trust_level: s.trust_level,
          retrieved_at: page.retrievedAt, excerpt: c.content.slice(0, 420), score: overlap.length
        });
      }
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, max);
}

export function clearLiveDocsCache() { pageCache.clear(); robotsCache.clear(); }
