// Parse labelled MemoryOps memory text (as retained, and as returned in recalled chunks) back into fields.

export function parseFields(text) {
  const pick = (label) => {
    const m = text.match(new RegExp(`^${label.replace(/[()]/g, "\\$&")}:\\s*(.+)$`, "im"));
    return m ? m[1].trim() : null;
  };
  const head = text.match(/^Past solved problem\s+(\S+)\s*\(([^)]+)\)/im);
  return {
    incidentId: head ? head[1] : null,
    area: head ? head[2] : null,
    title: pick("Title"),
    status: pick("Status"),
    happened: pick("What happened"),
    cause: pick("Confirmed cause"),
    suspectedCause: pick("Suspected cause (not confirmed)"),
    attempted: pick("Tried but did NOT fix it"),
    context: pick("Context"),
    ruledOut: pick("Initially suspected but ruled out"),
    partial: pick("Tried, helped only partially"),
    verification: pick("Verification"),
    worked: pick("What worked"),
    outcome: pick("Outcome"),
    lesson: pick("Lesson learned"),
    technical: pick("Technical details"),
    recordedAt: pick("Recorded at"),
    occurred: pick("Occurred"),
    observations: pick("Observations during diagnosis")
  };
}

// "Tried but did NOT fix it" text -> [{ action, observation }]. Dataset text is "action (observation); ...";
// free text typed by a person is kept as one attempt (first clause = action, the rest = what was observed).
export function parseAttempts(text) {
  const t = String(text || "").trim().replace(/\.$/, "");
  if (!t) return [];
  const parts = t.split(/;\s+/);
  const trimAlone = (a) => a.replace(/\s+(only|alone)$/i, "").trim();
  if (parts.length > 1 && parts.every((p) => /\)$/.test(p))) {
    return parts.map((p) => { const m = p.match(/^(.*?)\s*\((.*)\)$/); return { action: trimAlone(m ? m[1] : p), observation: m ? m[2] : "" }; });
  }
  const m = t.match(/^(.*?)\s*\((.*)\)$/);
  if (m) return [{ action: trimAlone(m[1]), observation: m[2] }];
  const [first, ...rest] = t.split(/;\s+|,\s+(?=the |but |it |errors |timeouts )/i);
  return [{ action: trimAlone(first), observation: rest.join("; ") }];
}

export function parseFeedback(text) {
  const about = text.match(/^Team feedback on past incident\s+(\S+)/im);
  const verdict = text.match(/^Verdict:\s*(.+)$/im);
  const problem = text.match(/^For problem:\s*(.+)$/im);
  return about ? { about: about[1], verdict: verdict ? verdict[1].trim() : null, problem: problem ? problem[1].trim() : null } : null;
}

