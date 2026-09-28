// "Suggested fix" derived from a recalled, human-confirmed incident. Deterministic and evidence-bound:
// a config diff is produced only when the remembered cause/fix states the setting AND both values
// (the broken value and the last-known-good value). Nothing is invented: no diff when either is missing.

const SETTINGS = [
  "per-instance database connection limit", "database connection pool size", "connection pool size",
  "database connection limit", "database connection pool", "connection limit", "connection pool",
  "pool size", "max_connections", "worker concurrency", "concurrency", "visibility timeout",
  "statement timeout", "heap size", "memory limit", "header size limit", "rate limit"
];
const SETTING_RE = new RegExp(`\\b(${SETTINGS.map((s) => s.replace(/[-_]/g, "[-_ ]?")).join("|")})\\b`, "i");

// Broken -> good values stated in the text, from the most explicit phrasing available.
function extractValues(cause = "", worked = "") {
  const n = (x) => Number(x);
  // Fix text: "restored ... from 5 to 30" (broken -> good).
  let m = worked.match(/\b(restor\w*|rais\w*|increas\w*|set|fix\w*|revert\w*)\b[^.]{0,80}?\bfrom (\d+) to (\d+)\b/i);
  if (m) return { before: n(m[2]), after: n(m[3]) };
  // Cause text: "reduced/changed from 30 to 5" (good -> broken).
  m = cause.match(/\b(reduc\w*|lower\w*|chang\w*|drop\w*|decreas\w*|cut)\b[^.]{0,80}?\bfrom (\d+) to (\d+)\b/i);
  if (m) return { before: n(m[3]), after: n(m[2]) };
  // "default of 1 instead of 50".
  m = cause.match(/\bdefault of (\d+) instead of (\d+)\b/i);
  if (m) return { before: n(m[1]), after: n(m[2]) };
  // Broken value from the cause ("reset ... to 5", "capped ... at 3") + good value from the fix ("restored ... to 30").
  const broken = cause.match(/\b(reset|capp\w*|lower\w*|reduc\w*|drop\w*|set)\b[^.]{0,80}?\b(?:to|at) (\d+)\b/i);
  const good = worked.match(/\b(restor\w*|rais\w*|increas\w*|set)\b[^.]{0,80}?\b(?:back )?to (\d+)\b/i);
  if (broken && good) return { before: n(broken[2]), after: n(good[2]) };
  return null;
}

const keyFor = (setting) => setting.trim().replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").toUpperCase();

/**
 * @param match       recalled incident ({ incidentId, fields }) the recommendation is based on
 * @param confidence  MemoryOps confidence level for the analysis
 * @param hypothesis  leading hypothesis ({ id, hypothesis, status }) if any
 */
export function suggestFix({ match, confidence, hypothesis = null }) {
  const f = match?.fields;
  if (!f) return null;
  const confirmed = /^(human-)?confirmed/i.test(f.status || "") && Boolean(f.cause) && Boolean(f.worked);
  if (!confirmed) return null;                                   // suspected causes never produce a fix
  if (confidence !== "HIGH" && confidence !== "MEDIUM") return null; // abstain when memory is weak
  if (hypothesis && hypothesis.status && hypothesis.status !== "open" && hypothesis.status !== "supported") return null;

  const values = extractValues(f.cause, f.worked);
  const setting = (f.worked.match(SETTING_RE) || f.cause.match(SETTING_RE) || [])[1];
  if (!values || !setting || values.before === values.after) return null;

  const key = keyFor(setting);
  return {
    kind: "config-diff",
    title: hypothesis?.hypothesis || "Configuration change",
    setting: setting.toLowerCase(),
    key,
    before: values.before,
    after: values.after,
    diff: `- ${key}=${values.before}\n+ ${key}=${values.after}`,
    source: { incidentId: match.incidentId, cause: f.cause, worked: f.worked, learned: Boolean(match.learned) },
    verify: f.verification || null,
    hypothesisId: hypothesis?.id || null,
    note: `Values come from ${match.incidentId}'s confirmed fix. The key name mirrors how that incident described the setting ("${setting.toLowerCase()}"); use your system's actual setting and confirm today's last known-good value before changing anything.`
  };
}
