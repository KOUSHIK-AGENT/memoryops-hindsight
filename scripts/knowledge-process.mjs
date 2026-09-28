// Turn fetched pages into clean, de-duplicated, metadata-rich chunks: knowledge/processed/docs.json
//   npm run knowledge:process [-- --raw <dir>]
import fs from "node:fs";
import path from "node:path";
import { SOURCES_PATH, DOCS_PATH } from "../lib/knowledge.mjs";
import { htmlToText, chunkByHeadings, dedupeChunks } from "../lib/html.mjs";
import { parseArgs } from "./cli.mjs";

const args = parseArgs(process.argv.slice(2));
const RAW = typeof args.raw === "string" ? args.raw : path.join(path.dirname(SOURCES_PATH), "raw");
const OUT = typeof args.out === "string" ? args.out : DOCS_PATH;
const { sources } = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));

// Remove anything that looks like a credential or personal contact before storing.
const SECRET = /(AKIA[0-9A-Z]{16}|hsk_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,})/g;

const all = [];
if (fs.existsSync(RAW)) {
  for (const sid of fs.readdirSync(RAW)) {
    const src = sources.find((s) => s.id === sid);
    if (!src || src.license_status !== "permissive") { console.log(`skip ${sid}: not a permissive registered source`); continue; }
    for (const f of fs.readdirSync(path.join(RAW, sid)).filter((x) => x.endsWith(".html"))) {
      const meta = JSON.parse(fs.readFileSync(path.join(RAW, sid, f.replace(/\.html$/, ".meta.json")), "utf8"));
      const html = fs.readFileSync(path.join(RAW, sid, f), "utf8");
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || src.title).replace(/\s+/g, " ").trim();
      chunkByHeadings(htmlToText(html)).forEach((c, i) => all.push({
        source_id: sid, title, source_url: meta.source_url, publisher: src.publisher, retrieved_at: meta.retrieved_at,
        document_type: src.document_type, technology: src.technologies[0], topic: c.heading, version: null,
        license: src.license, trust_level: src.trust_level, content: c.content.replace(SECRET, "[removed]"),
        chunk_id: `${sid}:${f.replace(/\.html$/, "")}:${i}`
      }));
    }
  }
}
const { chunks, removed } = dedupeChunks(all);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(chunks, null, 1));
console.log(`${all.length} chunks, ${removed} duplicates removed, ${chunks.length} written to ${path.relative(process.cwd(), OUT)}`);
