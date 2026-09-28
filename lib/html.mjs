// Documentation processing: strip boilerplate, split by headings into bounded chunks, de-duplicate.
// Pure functions (no network) so the pipeline is testable offline.
import crypto from "node:crypto";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
const decode = (s) => s.replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (m, e) => {
  if (ENTITIES[e.toLowerCase()] !== undefined) return ENTITIES[e.toLowerCase()];
  if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return m;
});

// Remove navigation, scripts, footers etc. Prefer <main>/<article> when present.
export function htmlToText(html) {
  let h = String(html || "");
  h = h.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of ["head", "title", "script", "style", "noscript", "svg", "nav", "header", "footer", "aside", "form", "button", "iframe", "select"]) {
    h = h.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }
  const main = h.match(/<main\b[\s\S]*?<\/main>/i) || h.match(/<article\b[\s\S]*?<\/article>/i);
  if (main) h = main[0];
  h = h.replace(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, t) => `\n\n§H${lvl} ${t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().replace(/\s*[#¶]$/, "")}\n\n`);
  h = h.replace(/<(p|div|li|pre|tr|br|h[4-6]|dt|dd|table|ul|ol|section|details|summary)\b[^>]*>/gi, "\n");
  h = h.replace(/<\/?(span|code|em|strong|b|i|kbd|var|sup|sub|small|abbr|mark)\b[^>]*>/gi, ""); // inline: no word break
  // Mark link text so navigation / table-of-contents lines can be dropped by link density.
  h = h.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (_, t) => `\u0001${t}\u0002`);
  h = h.replace(/<[^>]+>/g, " ");
  const lines = decode(h).replace(/[ \t\f\v]+/g, " ").split("\n").map((l) => l.trim()).filter((l) => !isLinkLine(l));
  return lines.join("\n").replace(/[\u0001\u0002]/g, "").replace(/\n\s*\n\s*(\n\s*)+/g, "\n\n").trim();
}

// A line that is mostly link text (menus, breadcrumbs, "skip to content", TOC entries) is boilerplate.
function isLinkLine(line) {
  if (!line.includes("\u0001") || line.startsWith("§H")) return false;
  const linked = (line.match(/\u0001[^\u0002]*\u0002?/g) || []).join("").length;
  return linked / line.length > 0.6;
}

// Split on headings; keep chunks under maxLen by paragraph packing.
export function chunkByHeadings(text, { maxLen = 1200, minLen = 120 } = {}) {
  const sections = [];
  let current = { heading: "Overview", body: [] };
  for (const para of text.split(/\n{2,}/)) {
    const m = para.match(/^§H[1-3] (.*)$/);
    if (m) { if (current.body.length) sections.push(current); current = { heading: m[1].trim(), body: [] }; }
    else if (para.trim()) current.body.push(para.replace(/\n/g, " ").trim());
  }
  if (current.body.length) sections.push(current);
  const chunks = [];
  for (const s of sections) {
    let buf = "";
    for (const p of s.body) {
      if (buf && (buf.length + p.length + 1) > maxLen) { chunks.push({ heading: s.heading, content: buf }); buf = ""; }
      buf = buf ? `${buf} ${p}` : p.slice(0, maxLen * 2);
    }
    if (buf) chunks.push({ heading: s.heading, content: buf });
  }
  return chunks.filter((c) => c.content.length >= minLen);
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const shingles = (s, n = 5) => { const w = norm(s).split(" "); const out = new Set(); for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" ")); return out; };
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };

// Drop exact duplicates (mirrors, repeated snippets) and near-duplicates (Jaccard >= threshold).
export function dedupeChunks(chunks, { threshold = 0.85 } = {}) {
  const seen = new Set();
  const kept = [];
  const sh = [];
  let removed = 0;
  for (const c of chunks) {
    const h = crypto.createHash("sha256").update(norm(c.content)).digest("hex");
    if (seen.has(h)) { removed++; continue; }
    const s = shingles(c.content);
    if (sh.some((o) => jaccard(o, s) >= threshold)) { removed++; continue; }
    seen.add(h); sh.push(s); kept.push({ ...c, content_hash: h.slice(0, 16) });
  }
  return { chunks: kept, removed };
}

// robots.txt check for our user agent (and *). Minimal parser: Disallow prefixes only.
export function robotsAllows(robotsTxt, path, agent = "memoryops-knowledge-fetch") {
  const groups = [];
  let cur = null;
  for (const raw of String(robotsTxt || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^(user-agent|disallow|allow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "user-agent") { if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(m[2].toLowerCase()); }
    else if (cur) cur.rules.push({ allow: key === "allow", prefix: m[2] });
  }
  const pick = groups.find((g) => g.agents.some((a) => a !== "*" && agent.toLowerCase().includes(a))) || groups.find((g) => g.agents.includes("*"));
  if (!pick) return true;
  let best = null;
  for (const r of pick.rules) if (r.prefix && path.startsWith(r.prefix) && (!best || r.prefix.length > best.prefix.length)) best = r;
  return !best || best.allow;
}
