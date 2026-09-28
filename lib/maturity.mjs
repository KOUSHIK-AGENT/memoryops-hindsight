// Knowledge maturity per incident category, from real counts only (no percentages, no estimates).
// Team experience = confirmed incident documents read from Hindsight; documented knowledge = curated entries.
import { CATEGORIES } from "./dataset.mjs";
import { parseFields } from "./memory-text.mjs";

// Applied to the saved area first, then title / description. Order: most specific first.
const RULES = [
  ["certificates", /\b(certificat\w*|tls|ssl|mtls)\b/i],
  ["payments", /\b(payments?|charged?|refunds?|billing|invoices?|webhooks?)\b/i],
  ["checkout", /\b(checkout|orders?|cart|purchases?)\b/i],
  ["authentication", /\b(log ?in|sign[ -]?in|auth\w*|sso|tokens?|sessions?)\b/i],
  ["queues", /\b(queues?|workers?|backlog|consumers?|jobs?|cron)\b/i],
  ["storage", /\b(disk|storage|volumes?|no space|uploads?)\b/i],
  ["external-dependency", /\b(provider|vendor|third[- ]party|external)\b/i],
  ["database", /\b(database|db|postgres\w*|sql|connection pool|quer(y|ies))\b/i],
  ["latency", /\b(slow\w*|latency|timeouts?|timing out)\b/i],
  ["deployment", /\b(deploy\w*|release|config\w*|rollout)\b/i]
];

// Curated technologies that document each category (for "no team experience yet, but documented").
export const CATEGORY_TECHNOLOGIES = {
  checkout: ["ecommerce"], payments: ["payments", "webhooks"], authentication: ["auth", "oauth"],
  database: ["postgresql", "database"], latency: ["http", "api-gateway", "grpc", "nginx", "load-balancer"],
  deployment: ["deployment", "kubernetes", "docker", "containers"], storage: ["storage"], certificates: ["tls"],
  queues: ["queues", "kafka", "rabbitmq", "cron"], "external-dependency": ["external", "dns"]
};

const LABEL_TO_KEY = Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [v.toLowerCase(), k]));

export function categorize(text) {
  const cat = String(text).match(/^Service:.*\|\s*Category:\s*([^|\n]+?)\s*(\||$)/im);
  if (cat && LABEL_TO_KEY[cat[1].toLowerCase()]) return LABEL_TO_KEY[cat[1].toLowerCase()];
  const f = parseFields(String(text));
  for (const part of [f.area, f.title, f.happened, f.cause]) {
    if (!part) continue;
    const hit = RULES.find(([, re]) => re.test(part));
    if (hit) return hit[0];
  }
  return "other";
}

export const isConfirmed = (text) => {
  const f = parseFields(String(text));
  return /confirmed/i.test(f.status || "") && Boolean(f.cause) && Boolean(f.worked);
};

export function levelFor(n) {
  return n >= 3 ? "ESTABLISHED" : n >= 1 ? "SOME" : "NO";
}

// docs: [{ text }] incident documents; pack: curated pack. Returns one row per category.
export function knowledgeMaturity(docs, pack) {
  const team = new Map();
  for (const d of docs) {
    if (!isConfirmed(d.text)) continue;
    const key = categorize(d.text);
    team.set(key, (team.get(key) || 0) + 1);
  }
  const rows = Object.entries(CATEGORIES).map(([key, label]) => {
    const confirmedIncidents = team.get(key) || 0;
    const techs = CATEGORY_TECHNOLOGIES[key] || [];
    const documentedEntries = pack ? pack.entries.filter((e) => techs.includes(e.technology)).length : 0;
    return { key, label, confirmedIncidents, level: levelFor(confirmedIncidents), documentedEntries };
  });
  if (team.get("other")) rows.push({ key: "other", label: "Other", confirmedIncidents: team.get("other"), level: levelFor(team.get("other")), documentedEntries: 0 });
  return rows;
}
