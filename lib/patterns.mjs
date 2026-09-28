// Level-2 learning: consolidate human-confirmed incidents into TEAM_PATTERN and PLAYBOOK memories.
// Deterministic and evidence-bound: a pattern needs >= MIN_SUPPORT independently confirmed incidents,
// keeps every counterexample, and has a stable id so updates replace instead of duplicating.
import { parseFields, parseAttempts } from "./memory-text.mjs";
import { normalizeQuery, causeClass, CAUSE_LABELS } from "./signals.mjs";

export const MIN_SUPPORT = 3;
const TRIGGER_TEXT = { "after-change": "right after a release or change", scheduled: "at scheduled times", traffic: "during traffic spikes" };
const clean = (a) => a.replace(/\s*\([^)]*\)\s*$/, "").trim();

// docs: [{ documentId, text }] of incident memories (memoryops-INC-* and memoryops-MO-*).
export function confirmedIncidents(docs) {
  const out = [];
  for (const d of docs) {
    const f = parseFields(d.text || "");
    const id = f.incidentId || d.documentId?.replace(/^memoryops-/, "");
    // Independently confirmed = confirmed status AND a confirmed (not suspected) cause.
    if (!id || !/^(human-)?confirmed/i.test(f.status || "") || !f.cause) continue;
    const facts = normalizeQuery([f.title, f.happened, f.context].filter(Boolean).join(" "));
    out.push({
      id,
      area: facts.area || null,
      trigger: facts.trigger || null,
      signals: facts.signals || [],
      causeClass: causeClass(f.cause),
      cause: f.cause,
      worked: f.worked,
      failed: parseAttempts(f.attempted).map((a) => a.action),
      lesson: f.lesson,
      date: f.recordedAt || f.occurred || null
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const latest = (items) => items.map((x) => x.date).filter(Boolean).sort().pop() || null;
const uniq = (arr) => [...new Set(arr)];

export function consolidate(docs) {
  const incidents = confirmedIncidents(docs);
  const clusters = new Map();
  for (const x of incidents) {
    if (!x.area || !x.trigger) continue;
    const key = `${x.area}-${x.trigger}`;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(x);
  }

  const patterns = [];
  const playbooks = [];
  for (const [key, members] of [...clusters.entries()].sort()) {
    const byCause = new Map();
    for (const x of members) {
      if (!byCause.has(x.causeClass)) byCause.set(x.causeClass, []);
      byCause.get(x.causeClass).push(x);
    }
    const [area, ...rest] = key.split("-");
    const trigger = rest.join("-");
    const groups = [...byCause.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    const distinguishing = groups.map(([cls, g]) => ({ cause_class: cls, cause: CAUSE_LABELS[cls], check: g[0].lesson || `Check for: ${g[0].cause}`, from: g[0].id }));

    for (const [cls, support] of groups) {
      if (support.length < MIN_SUPPORT) continue;
      const counter = members.filter((x) => x.causeClass !== cls);
      const label = CAUSE_LABELS[cls].toLowerCase();
      const otherLabels = uniq(counter.map((x) => CAUSE_LABELS[x.causeClass].toLowerCase()));
      // Anti-overlearning: exceptions are part of the statement, never dropped.
      const statement = counter.length
        ? `${CAUSE_LABELS[cls]} has been a recurring cause of ${area} problems ${TRIGGER_TEXT[trigger] || trigger} (${support.length} confirmed incidents), but similar symptoms have also come from ${otherLabels.join(" and ")} (${counter.length} incident${counter.length > 1 ? "s" : ""}).`
        : `Across ${support.length} confirmed ${area} incidents ${TRIGGER_TEXT[trigger] || trigger}, ${label} was the recurring cause.`;
      const signalCounts = {};
      for (const x of support) for (const s of x.signals) signalCounts[s] = (signalCounts[s] || 0) + 1;
      patterns.push({
        pattern_id: `pattern-${key}-${cls}`,
        area, trigger, cause_class: cls,
        statement,
        supporting_incidents: support.map((x) => x.id),
        counterexamples: counter.map((x) => ({ id: x.id, cause: CAUSE_LABELS[x.causeClass], detail: x.cause })),
        common_signals: Object.entries(signalCounts).filter(([, n]) => n >= 2).map(([s]) => s).sort(),
        successful_actions: support.filter((x) => x.worked).map((x) => ({ id: x.id, action: x.worked })),
        failed_actions: support.flatMap((x) => x.failed.map((a) => ({ id: x.id, action: a }))),
        distinguishing_checks: distinguishing,
        last_updated: latest(members)
      });
    }

    if (patterns.some((p) => p.area === area && p.trigger === trigger)) {
      const failed = new Map();
      for (const x of members) for (const a of x.failed) {
        const k = a.toLowerCase().split(/\s+/).slice(0, 4).join(" ");
        if (!failed.has(k)) failed.set(k, { action: a, incidents: [] });
        failed.get(k).incidents.push(x.id);
      }
      playbooks.push({
        playbook_id: `playbook-${key}`,
        title: `${area[0].toUpperCase()}${area.slice(1)} problems ${TRIGGER_TEXT[trigger] || trigger}`,
        learned_from: members.length,
        steps: groups.map(([cls, g]) => ({
          step: g[0].lesson || `Check for: ${g[0].cause}`,
          why: `${g.length} confirmed incident${g.length > 1 ? "s" : ""} in this situation ${g.length > 1 ? "were" : "was"} caused by ${CAUSE_LABELS[cls].toLowerCase()}.`,
          cause_class: cls,
          supporting_incidents: g.map((x) => x.id)
        })),
        cautions: [...failed.values()].map((f) => ({ text: `"${f.action}" alone did not fix ${f.incidents.join(", ")}.`, incidents: f.incidents })),
        last_updated: latest(members)
      });
    }
  }
  return { incidents: incidents.length, patterns, playbooks };
}

export function patternToRetainItem(p) {
  return {
    content: [
      `Team pattern ${p.pattern_id}`,
      "Type: TEAM_PATTERN (consolidated from human-confirmed incidents; weaker than any single confirmed incident)",
      `Pattern: ${p.statement}`,
      `Supporting confirmed incidents: ${p.supporting_incidents.join(", ")}`,
      p.counterexamples.length && `Counterexamples (similar symptoms, different cause): ${p.counterexamples.map((c) => `${c.id} (${c.cause})`).join("; ")}`,
      p.common_signals.length && `Common signals: ${p.common_signals.join(", ")}`,
      `What worked: ${p.successful_actions.map((a) => `${a.id}: ${a.action}`).join(" | ")}`,
      p.failed_actions.length && `What did NOT work: ${p.failed_actions.map((a) => `${a.id}: ${a.action}`).join(" | ")}`,
      `Distinguishing checks: ${p.distinguishing_checks.map((d) => `${d.cause}: ${d.check}`).join(" | ")}`,
      p.last_updated && `Last updated: ${p.last_updated}`
    ].filter(Boolean).join("\n"),
    context: `Team pattern learned from ${p.supporting_incidents.length} confirmed incidents`,
    ...(p.last_updated ? { timestamp: p.last_updated } : {}),
    document_id: `memoryops-${p.pattern_id}`,
    metadata: { memoryops_type: "TEAM_PATTERN", payload: JSON.stringify(p) }
  };
}

export function playbookToRetainItem(b) {
  return {
    content: [
      `Team playbook ${b.playbook_id}: ${b.title}`,
      `Type: PLAYBOOK (learned from ${b.learned_from} confirmed incidents; guidance, not an automatic action)`,
      ...b.steps.map((s, i) => `Step ${i + 1}: ${s.step} Why: ${s.why} Supporting: ${s.supporting_incidents.join(", ")}`),
      ...b.cautions.map((c) => `Caution: ${c.text}`),
      b.last_updated && `Last updated: ${b.last_updated}`
    ].filter(Boolean).join("\n"),
    context: `Team playbook learned from ${b.learned_from} confirmed incidents`,
    ...(b.last_updated ? { timestamp: b.last_updated } : {}),
    document_id: `memoryops-${b.playbook_id}`,
    metadata: { memoryops_type: "PLAYBOOK", payload: JSON.stringify(b) }
  };
}

export function readPayload(doc) {
  try { return JSON.parse(doc?.document_metadata?.payload); } catch { return null; }
}
