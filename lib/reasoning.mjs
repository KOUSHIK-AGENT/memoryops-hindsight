// Deterministic evidence reasoning over recalled memories. No LLM calls, no invented numbers:
// every level, reason and hypothesis is derived from fields present in recalled memory or today's text.
import { normalizeQuery, sharedFacts, causeClass, CAUSE_LABELS, CLASS_KEYWORDS } from "./signals.mjs";
import { parseAttempts } from "./memory-text.mjs";

// Typed memory model and evidence authority (higher = more authoritative).
export const MEMORY_TYPES = ["VERIFIED_INCIDENT", "VERIFIED_RESOLUTION", "FAILED_ATTEMPT", "SUSPECTED_CAUSE", "TEAM_FEEDBACK", "TEAM_PATTERN", "PLAYBOOK"];
export const AUTHORITY = { VERIFIED_RESOLUTION: 5, VERIFIED_INCIDENT: 5, FAILED_ATTEMPT: 4, TEAM_PATTERN: 3, PLAYBOOK: 3, SUSPECTED_CAUSE: 2, TEAM_FEEDBACK: 1 };
export const LEVELS = ["INSUFFICIENT", "LOW", "MEDIUM", "HIGH"];
export const ABSTAIN_TEXT = "MemoryOps does not have enough historical evidence for a confident memory-based recommendation.";

const shift = (level, by) => LEVELS[Math.max(0, Math.min(LEVELS.length - 1, LEVELS.indexOf(level) + by))];
const STOP = new Set("the a an and or of to in on for with was were is are be been it its this that after before our we they their from by as at since then than not did does had has have only alone".split(" "));
export const tokens = (t) => (String(t || "").toLowerCase().match(/[a-z][a-z0-9_-]{2,}|\d+/g) || []).filter((w) => !STOP.has(w));


// Turn one recalled incident into typed evidence items.
export function typeMemory(m) {
  const f = m.fields || {};
  const confirmed = /^(human-)?confirmed/i.test(f.status || "") && Boolean(f.cause);
  const items = [];
  if (confirmed) {
    items.push({ type: "VERIFIED_INCIDENT", text: f.cause });
    if (f.worked) items.push({ type: "VERIFIED_RESOLUTION", text: f.worked });
  } else if (f.suspectedCause || f.cause) {
    items.push({ type: "SUSPECTED_CAUSE", text: f.suspectedCause || f.cause });
  }
  for (const a of parseAttempts(f.attempted)) items.push({ type: "FAILED_ATTEMPT", text: a.action });
  for (const fb of m.feedback || []) items.push({ type: "TEAM_FEEDBACK", text: `${fb.verdict} for "${fb.problem || "a similar problem"}"` });
  return { confirmed, items: items.sort((a, b) => AUTHORITY[b.type] - AUTHORITY[a.type]) };
}

function describeMemory(m, facts, reflectMatchedId) {
  const f = m.fields || {};
  const memFacts = normalizeQuery([f.title, f.happened, f.context].filter(Boolean).join(" ") || m.facts?.join(" "));
  const shared = sharedFacts(facts, memFacts);
  const typed = typeMemory(m);
  const cause = typed.confirmed ? f.cause : f.suspectedCause || f.cause || null;
  return {
    id: m.incidentId,
    learned: Boolean(m.learned),
    confirmed: typed.confirmed,
    evidence: typed.items,
    causeClass: causeClass(cause),
    cause,
    worked: typed.confirmed ? f.worked || null : null,
    failed: parseAttempts(f.attempted).map((a) => a.action),
    lesson: f.lesson || null,
    shared,
    overlap: shared.length,
    score: Number.isFinite(m.score) ? m.score : null,
    reflectSelected: m.incidentId === reflectMatchedId,
    feedback: (m.feedback || []).map((x) => x.verdict)
  };
}

function groupLevel(members) {
  const verified = members.filter((x) => x.confirmed);
  const strong = verified.filter((x) => x.overlap >= 2 || x.reflectSelected);
  if (strong.length >= 2) return "HIGH";
  if (strong.length === 1) return "MEDIUM";
  return "LOW";
}

// Words that identify a cause when an engineer reports a check. Generic words (service, checkout,
// release, database...) are excluded so an unrelated observation cannot "support" a hypothesis.
const GENERIC = new Set("service services checkout order orders customers customer release releases update updates today database app application change changed changes during each instance instances new old previous current system team problem incident caused cause".split(" "));
function hypothesisKeywords(members, cls) {
  const words = new Set(CLASS_KEYWORDS[cls] || []);
  for (const x of members) for (const w of tokens(x.cause || "")) if (!GENERIC.has(w)) words.add(w);
  return [...words];
}

export function buildHypotheses(relevant) {
  const groups = new Map();
  for (const x of relevant) {
    if (!x.causeClass) continue;
    if (!groups.has(x.causeClass)) groups.set(x.causeClass, []);
    groups.get(x.causeClass).push(x);
  }
  const ranked = [...groups.entries()].map(([cls, members]) => ({
    cls, members,
    verified: members.filter((x) => x.confirmed).length,
    best: Math.max(...members.map((x) => x.overlap + (x.reflectSelected ? 1 : 0)))
  })).sort((a, b) => b.best - a.best || b.verified - a.verified || a.cls.localeCompare(b.cls));

  return ranked.slice(0, 3).map(({ cls, members }) => {
    const lead = members.find((x) => x.confirmed) || members[0];
    const current = [...new Set(members.flatMap((x) => x.shared.map((s) => s.text)))];
    return {
      id: cls,
      hypothesis: CAUSE_LABELS[cls] || CAUSE_LABELS.other,
      example_cause: lead.cause,
      supporting_current_evidence: current,
      supporting_memories: members.map((x) => ({ id: x.id, confirmed: x.confirmed, learned: x.learned })),
      evidence_against: [],
      confidence: groupLevel(members),
      next_check: lead.lesson || `Check whether this happened again: ${lead.cause}`,
      expected_if_true: `Similar to ${lead.id}: ${lead.cause}`,
      worked_before: lead.worked,
      status: "open",
      keywords: hypothesisKeywords(members, cls)
    };
  });
}

// Failed actions across relevant memories, grouped so repeats are counted truthfully.
export function collectFailedActions(relevant) {
  const map = new Map();
  for (const x of relevant) for (const action of x.failed) {
    const key = tokens(action).slice(0, 4).join(" ");
    if (!key) continue;
    if (!map.has(key)) map.set(key, { action, incidents: [] });
    map.get(key).incidents.push(x.id);
  }
  return [...map.values()].map((a) => ({ ...a, text: `"${a.action}" alone did not resolve ${a.incidents.length === 1 ? "a similar previous incident" : `${a.incidents.length} similar previous incidents`} (${a.incidents.join(", ")}).` }));
}

// Never present a known failed action as the fix: drop checks that repeat a failed action
// unless they also contain what actually worked.
export function suppressFailedChecks(checks, failedBefore, workedBefore) {
  const kept = [];
  const suppressed = [];
  for (const check of checks || []) {
    const c = new Set(tokens(check));
    const hit = failedBefore.find((f) => {
      const ft = tokens(f.action.replace(/\s*\(.*\)$/, ""));
      const need = Math.min(2, ft.length);
      const overlap = ft.filter((w) => c.has(w)).length;
      if (!need || overlap < need) return false;
      const distinctive = workedBefore.flatMap((w) => tokens(w)).filter((w) => !ft.includes(w));
      return !distinctive.some((w) => c.has(w));
    });
    if (hit) suppressed.push({ check, because: hit.text });
    else kept.push(check);
  }
  return { checks: kept, suppressed };
}

export function analyzeEvidence({ incident, matches, reflectMatchedId = null, reflectJudgedNone = false, patterns = [] }) {
  const facts = normalizeQuery(incident);
  const memories = matches.map((m) => describeMemory(m, facts, reflectMatchedId));
  const relevant = memories.filter((x) => x.reflectSelected || x.overlap >= 2);
  const hypotheses = buildHypotheses(relevant);
  // Today's own description can contradict a remembered cause ("database connections look healthy").
  for (const h of hypotheses) {
    const against = contradictingClauses(h, incident);
    if (against.length) {
      h.evidence_against = against.map((c) => `today: "${c}"`);
      h.status = "weakened";
      h.confidence = shift(h.confidence, -1);
      h.base_confidence = h.confidence;
    }
  }
  hypotheses.sort((a, b) => (a.status === "weakened") - (b.status === "weakened"));
  // Conflict = confirmed memories that fit today about as well as the best one but had different causes.
  const bestOverlap = Math.max(0, ...relevant.map((x) => x.overlap));
  const competitive = relevant.filter((x) => x.reflectSelected || x.overlap >= bestOverlap - 1);
  const classes = [...new Set(competitive.filter((x) => x.confirmed && x.causeClass).map((x) => x.causeClass))];
  const conflicts = classes.length >= 2
    ? { detected: true, text: "Several historical causes produced similar symptoms. Use the distinguishing checks before applying any previous fix.", causes: classes.map((c) => ({ cause: CAUSE_LABELS[c], incidents: competitive.filter((x) => x.causeClass === c).map((x) => x.id) })) }
    : { detected: false, causes: [] };
  const failedBefore = collectFailedActions(relevant);
  const workedBefore = [...new Set(relevant.filter((x) => x.worked).map((x) => x.worked))];

  // Confidence: deterministic rules over the evidence above.
  const reasons = [];
  let level;
  if (!relevant.length) {
    level = "INSUFFICIENT";
    reasons.push(matches.length ? `Hindsight recalled ${matches.length} memories, but none shares enough of today's facts to rely on.` : "No memories were recalled.");
  } else {
    const top = hypotheses[0];
    level = top ? top.confidence : "LOW";
    if (top?.status === "weakened") {
      if (level === "HIGH" || level === "MEDIUM") level = "LOW";
      reasons.push(`Today's description contradicts the leading remembered cause (${top.evidence_against.join("; ")}).`);
    }
    const verified = top ? top.supporting_memories.filter((s) => s.confirmed).length : 0;
    reasons.push(verified ? `${verified} confirmed historical incident${verified > 1 ? "s" : ""} support the leading explanation.` : "Only suspected (unconfirmed) causes support the leading explanation.");
    if (conflicts.detected) { if (level === "HIGH") level = "MEDIUM"; reasons.push("Similar symptoms had different confirmed causes in the past."); }
    // Reflect's judgement that nothing is similar caps confidence: memory can suggest leads, not a recommendation.
    if (reflectJudgedNone && (level === "HIGH" || level === "MEDIUM")) { level = "LOW"; reasons.push("Hindsight reflect did not judge any memory similar enough to rely on."); }
    const topIds = new Set(top?.supporting_memories.map((s) => s.id) || []);
    const notRelevant = relevant.filter((x) => topIds.has(x.id) && x.feedback.includes("Not relevant")).length;
    const helpful = relevant.filter((x) => topIds.has(x.id) && x.feedback.includes("Helpful")).length;
    if (notRelevant) { level = shift(level, -1); reasons.push(`The team marked ${notRelevant} of these memories "Not relevant" before.`); }
    if (helpful) reasons.push(`The team marked ${helpful} of these memories "Helpful" before (a relevance hint, not proof).`);
    if (patterns.some((p) => p.cause_class === top?.id)) reasons.push("A team pattern backed by at least 3 confirmed incidents points the same way.");
  }

  // Why this is suggested: only facts that were actually shared or counted.
  const lead = hypotheses[0];
  const leadIds = new Set(lead?.supporting_memories.map((s) => s.id) || []);
  const why = [];
  if (lead) {
    for (const t of lead.supporting_current_evidence) why.push(t);
    const n = lead.supporting_memories.filter((s) => s.confirmed).length;
    if (n) why.push(`${n} confirmed historical incident${n > 1 ? "s" : ""} had similar signals`);
    for (const f of failedBefore.filter((f) => f.incidents.some((id) => leadIds.has(id)))) {
      why.push(`"${f.action}" alone failed ${f.incidents.length === 1 ? "once" : `${f.incidents.length} times`} before`);
    }
  }

  return {
    facts,
    relevant: relevant.map((x) => ({ id: x.id, causeClass: x.causeClass, confirmed: x.confirmed, learned: x.learned, shared: x.shared.map((s) => s.text), types: x.evidence.map((e) => e.type) })),
    hypotheses,
    nextBestCheck: nextBestCheck(hypotheses),
    conflicts,
    failedBefore,
    workedBefore,
    confidence: { level, reasons, statement: level === "LOW" || level === "INSUFFICIENT" ? ABSTAIN_TEXT : null },
    why: { reasons: why, supporting: [...leadIds] }
  };
}

function contradictingClauses(h, text) {
  return String(text || "").split(/[.;]|\bbut\b|\bhowever\b|,/i).map((c) => c.trim()).filter((c) => {
    if (!c || !NEGATION.test(c)) return false;
    const ct = new Set(tokens(c));
    return (CLASS_KEYWORDS[h.id] || []).some((k) => ct.has(k));
  });
}

// ---------- Interactive diagnosis (session evidence only; never retained here) ----------

const NEGATION = /\b(not|no|normal|fine|valid|healthy|unchanged|as usual|as expected|same as before|ok|okay|isn't|wasn't|doesn't|didn't|nothing)\b/i;

export function applyObservations(hypotheses, observations) {
  const list = (observations || []).map((o) => String(o).trim()).filter(Boolean);
  const out = hypotheses.map((h) => ({ ...h, evidence_against: (h.evidence_against || []).filter((e) => e.startsWith("today:")), observations_for: [], status: "open", confidence: h.base_confidence || h.confidence, base_confidence: h.base_confidence || h.confidence }));
  const unmatched = [];
  for (const obs of list) {
    let matchedAny = false;
    for (const clause of obs.split(/[.;]|\bbut\b|\bhowever\b/i).map((c) => c.trim()).filter(Boolean)) {
      const ct = new Set(tokens(clause));
      for (const h of out) {
        const hits = h.keywords.filter((k) => ct.has(k));
        if (!hits.length) continue;
        matchedAny = true;
        if (NEGATION.test(clause)) h.evidence_against.push(clause);
        else h.observations_for.push(clause);
      }
    }
    if (!matchedAny) unmatched.push(obs);
  }
  for (const h of out) {
    const f = h.observations_for.length, a = h.evidence_against.length;
    if (f && !a) { h.status = "supported"; h.confidence = shift(h.base_confidence, 1); }
    else if (a && !f) { h.status = a >= 2 ? "ruled out" : "weakened"; h.confidence = a >= 2 ? "INSUFFICIENT" : shift(h.base_confidence, -1); }
    else if (a && f) h.status = "mixed";
    else if (h.evidence_against.length) h.status = "weakened";
  }
  const order = { supported: 0, open: 1, mixed: 2, weakened: 3, "ruled out": 4 };
  out.sort((x, y) => order[x.status] - order[y.status] || LEVELS.indexOf(y.confidence) - LEVELS.indexOf(x.confidence));
  return { hypotheses: out, nextBestCheck: nextBestCheck(out), unmatched };
}

export function nextBestCheck(hypotheses) {
  const live = hypotheses.filter((h) => h.status !== "ruled out" && h.status !== "weakened");
  if (!hypotheses.length) return null;
  if (!live.length) return { hypothesisId: null, text: "The evidence so far does not fit any remembered cause. Investigate beyond memory; this may be a new kind of problem, and confirming it will teach MemoryOps.", expected_if_true: null };
  const supported = live.find((h) => h.status === "supported");
  if (supported) {
    return { hypothesisId: supported.id, text: `Your observation supports "${supported.hypothesis}". Confirm it on today's system${supported.worked_before ? `, then consider what worked before: ${supported.worked_before}` : ""}.`, expected_if_true: supported.expected_if_true };
  }
  const h = live.find((x) => x.status === "open") || live[0];
  return { hypothesisId: h.id, text: h.next_check, expected_if_true: h.expected_if_true };
}
