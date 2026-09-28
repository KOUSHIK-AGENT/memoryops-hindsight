// Deterministic fact extraction. Only facts whose words are explicitly present in the text are returned;
// nothing is inferred or invented. Used for query normalization, relevance overlap, cause classes and clustering.

const AREAS = [
  ["checkout", /\b(checkout|check-out|place (an |their )?orders?|placing orders?|orders? (became |are |were )?(fail\w*|unavailable|page)|purchases?|shopping cart|cart|(cannot|can't|unable to|could not) order)\b/i],
  ["payments", /\b(payments?|charged|charges?|billed|refunds?|card processor|billing|invoices?|webhooks?)\b/i],
  ["login", /\b(log ?in|logins?|sign[ -]?in|signing in|sso|single sign-on|authenticat\w*|logged out|kicked out|get into (their|your) accounts?|signing key|tokens?)\b/i],
  ["notifications", /\b(e-?mails?|mail sender|sms|text messages|verification codes?|notifications?)\b/i],
  ["search", /\b(search\w*|catalog|product lookup)\b/i],
  ["queues", /\b(queues?|workers?|backlog|background (jobs?|tasks?)|consumers?|scheduler|jobs? (did not|never) (run|start))\b/i],
  ["storage", /\b(disk|drive|volume|storage|no space|quota|uploads?)\b/i],
  ["mobile", /\b(mobile|ios|android|phone apps?)\b/i],
  ["website", /\b(website|web site|homepage|pages?)\b/i]
];

const TRIGGERS = [
  ["after-change", /\b(after|since|right after|immediately after|following|started with|same (morning|day) as)\b[^.]{0,60}\b(releases?|deploy\w*|rollouts?|rolled out|updates?|upgrade\w*|rotat\w*|migrat\w*|rebuil\w*|changes?|changed|chang\w*|switch\w*|swapp\w*|mov\w*)\b|\b(release|deploy\w*|update)\b[^.]{0,30}\b(shipped|went out|bundled)\b/i],
  ["scheduled", /\b(every (night|hour|day)|nightly|overnight|on the hour|at \d{1,2}:\d{2})\b/i],
  ["traffic", /\b(traffic (spike|surge)|flash sale|campaign|scaled out|autoscal\w*|extra (app )?instances)\b/i]
];

const SIGNALS = [
  ["db-timeouts", /\b(database|db)\b[^.]{0,40}\b(time ?outs?|timing out|timed out|slow)\b|\bacquire timeouts?\b/i],
  ["db-connections-exhausted", /\b(connections?|pool|capacity)\b[^.]{0,40}\b(exhausted|full|saturat\w*|maxed|refus\w*|turning away|too many|no free)\b|\b(database|db)\b[^.]{0,40}\b(refus\w*|turning away)\b|\btoo many connections\b|\bno free connections?\b|\bcapacity (looks|appears|seems) exhausted\b/i],
  ["db-overloaded", /\b(database|db)\b[^.]{0,30}\b(overload\w*|saturat\w*|struggling)\b/i],
  ["http-5xx", /\b(5\d\d|502|503|504|500)\b|\bserver errors?\b/i],
  ["certificate", /\b(certificate|cert|tls|ssl|mtls)\b/i],
  ["expired", /\bexpir\w*\b/i],
  ["provider-down", /\b(provider|vendor|third[- ]party|status page)\b[^.]{0,40}\b(down|outage|degraded|time ?outs?|timing out|not responding|failing)\b/i],
  ["duplicates", /\b(duplicate\w*|twice|two times|double)\b/i],
  ["slow", /\b(slow\w*|sluggish|latency|takes? (ages|long)|painfully|response times? (roughly )?(doubled|increased|jumped))\b/i],
  ["restart-helps-briefly", /\b(restart\w*|bouncing|reboot\w*)\b[^.]{0,40}\b(help\w*|relief|improv\w*)\b[^.]{0,30}\b(while|briefly|hour|temporar\w*)\b/i],
  ["region-specific", /\b(only (for|in)|visitors (in|from)|users in|customers in)\b[^.]{0,30}\b(asia|southeast|europe|eu|us|region|country|brazil)\b/i],
  ["stale-lock", /\b(held the (job )?lock|job lock|another instance|other instance)\b/i],
  ["disk-full", /\b(disk|drive|volume)\b[^.]{0,30}\bfull\b|\bno space\b/i],
  ["backlog", /\b(backlog|queue (keeps )?(growing|climbing)|lag)\b/i],
  ["crash-loop", /\b(crash\w*|keeps dying|restart(ed|ing)? repeatedly)\b/i],
  ["auth-failures", /\b(fail\w* to (log|sign)|cannot (log|sign)|can't (log|sign)|rejected|locked out|invalid (token|assertion|signature))\b/i],
  ["cache", /\b(cache|redis|in-memory store)\b/i],
  ["config-change", /\b(config\w*|setting|variable|template|feature flag)\b/i]
];

const IMPACTS = [
  ["customers-cannot-order", /\b(cannot|can't|unable to|could not) order\b|\b(cannot|can't|unable to|could not)\b[^.]{0,20}\b(place|complete)\b[^.]{0,20}\b(orders?|purchases?)\b|\borders? (became unavailable|fail\w*)\b|\bcheckout (is |has been )?(failing|unavailable|down)\b/i],
  ["users-cannot-sign-in", /\b(cannot|can't|unable to|fail to|could not)\b[^.]{0,20}\b(sign|log)\b/i],
  ["slow-experience", /\b(slow\w*|sluggish)\b/i],
  ["double-charges", /\b(billed|charged)\b[^.]{0,20}\b(twice|two times)\b/i]
];

// Cause classes, checked in order (first match wins). Applied to confirmed-cause text only.
const CAUSES = [
  ["connection-config", "Database connection capacity/configuration", /\b(connection (pool|limit)s?|pool size|max_connections|too many connections|connections? (per|limit)|database connections?|connections from all|database limit)\b/i],
  ["resource-limit", "Memory / CPU resource limit", /\b(memory limit|heap|cpu limit|garbage[- ]collection|consumed all cpu)\b/i],
  ["bad-input", "Malformed input / poison message", /\b(malformed|poison|characters the)\b/i],
  ["certificate", "Certificate / TLS problem", /\b(certificate|cert|tls|ssl|trust bundle)\b/i],
  ["external-provider", "External provider outage or change", /\b(provider|vendor|carrier|dns provider|third[- ]party)\b/i],
  ["clock", "Clock drift / time sync", /\b(clock|ntp|time sync\w*)\b/i],
  ["cache", "Cache / session store problem", /\b(cache|redis|evict\w*)\b/i],
  ["storage", "Disk or storage capacity", /\b(disks?|volumes?|quota|space|write-ahead|image garbage)\b/i],
  ["config-regression", "Configuration / deployment setting regression", /\b(config\w*|settings?|variables?|templates?|flags?|defaults?|firewall rules?|environment)\b/i],
  ["code-change", "Code or query change", /\b(validation|query|queries|lock\w*|deadlock|parser|conversion|n\+1|ORM|serializ\w*|idempotency key header)\b/i],
  ["scheduled-job", "Scheduled job interference", /\b(job|cron)\b/i]
];

export const CAUSE_LABELS = Object.fromEntries(CAUSES.map(([k, label]) => [k, label]));

// Words an engineer would use when reporting what they checked, per cause class (observation matching).
export const CLASS_KEYWORDS = {
  "connection-config": ["pool", "connections", "connection", "max_connections", "limit"],
  certificate: ["certificate", "cert", "tls", "ssl", "expired", "expiry", "renewal"],
  "external-provider": ["provider", "vendor", "outage", "status", "carrier"],
  clock: ["clock", "ntp", "drift", "time"],
  cache: ["cache", "redis", "evicted", "eviction", "sessions"],
  storage: ["disk", "volume", "space", "quota", "full"],
  "resource-limit": ["memory", "heap", "cpu", "garbage"],
  "config-regression": ["config", "configuration", "setting", "settings", "variable", "template", "flag"],
  "bad-input": ["message", "malformed", "poison"],
  "code-change": ["query", "queries", "validation", "lock", "deadlock"]
};
CAUSE_LABELS.other = "Other cause";

const pickAll = (list, text) => list.filter(([, re]) => re.test(text)).map(([k]) => k);

export function normalizeQuery(text) {
  const t = String(text || "");
  const facts = {};
  const area = pickAll(AREAS, t);
  if (area.length) { facts.area = area[0]; facts.areas = area; }
  const trigger = pickAll(TRIGGERS, t);
  if (trigger.length) facts.trigger = trigger[0];
  const signals = pickAll(SIGNALS, t);
  if (signals.length) facts.signals = signals;
  const impact = pickAll(IMPACTS, t);
  if (impact.length) facts.impact = impact[0];
  return facts;
}

export function causeClass(causeText) {
  if (!causeText) return null;
  const hit = CAUSES.find(([, , re]) => re.test(causeText));
  return hit ? hit[0] : "other";
}

// Human-readable retrieval context listing only extracted facts.
export function normalizedContext(facts) {
  const lines = [];
  if (facts.area) lines.push(`Area: ${facts.area}`);
  if (facts.impact) lines.push(`Impact: ${facts.impact.replace(/-/g, " ")}`);
  if (facts.trigger) lines.push(`Timing: ${facts.trigger.replace(/-/g, " ")}`);
  if (facts.signals?.length) lines.push(`Signals: ${facts.signals.map((s) => s.replace(/-/g, " ")).join(", ")}`);
  return lines.join("\n");
}

// Facts shared by today's problem and a remembered incident, as reasons a person can check.
export function sharedFacts(query, memory) {
  const out = [];
  const area = (query.areas || []).find((a) => (memory.areas || []).includes(a));
  if (area) out.push({ kind: "area", text: `same affected area: ${area}` });
  if (query.trigger && query.trigger === memory.trigger) out.push({ kind: "trigger", text: query.trigger === "after-change" ? "both started right after a release or change" : `same timing: ${query.trigger.replace(/-/g, " ")}` });
  const sig = (query.signals || []).filter((s) => (memory.signals || []).includes(s) && s !== "config-change");
  for (const s of sig) out.push({ kind: "signal", text: `shared symptom: ${s.replace(/-/g, " ")}` });
  return out;
}
