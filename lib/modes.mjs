// Response modes: decide how much to lean on team memory vs documented / general knowledge.
// Deterministic, from evidence already computed; never from how confident the text sounds.

export const MODES = {
  "TEAM-LED": { title: "Team experience", text: "Your team previously solved a similar incident. Team evidence comes first." },
  HYBRID: { title: "Team experience + technical knowledge", text: "Some related team experience exists, but it is incomplete. Team evidence and documented knowledge are shown separately." },
  "KNOWLEDGE-LED": { title: "Documented knowledge", text: "MemoryOps has not seen a similar verified team incident yet. Based on documented operational knowledge, these are the possibilities to investigate." },
  INSUFFICIENT: { title: "Not enough evidence yet", text: "Neither team memory nor documented knowledge matches this closely enough. Start with the next best check." }
};

export function decideMode({ evidence, recommendation, knowledge }) {
  const level = evidence?.confidence?.level || "INSUFFICIENT";
  const teamStrong = Boolean(recommendation?.memoryUsed) && (level === "HIGH" || level === "MEDIUM");
  const teamSome = (evidence?.relevant?.length || 0) > 0;
  const knowledgeHits = (knowledge?.hits?.length || 0) + (knowledge?.docs?.length || 0) > 0;
  let mode;
  if (teamStrong) mode = "TEAM-LED";
  else if (teamSome && knowledgeHits) mode = "HYBRID";
  else if (teamSome) mode = "HYBRID";
  else if (knowledgeHits) mode = "KNOWLEDGE-LED";
  else mode = "INSUFFICIENT";
  return { mode, ...MODES[mode] };
}

export const INSUFFICIENT_CHECK = {
  hypothesisId: null,
  source: "GENERAL_KNOWLEDGE",
  text: "Capture the first error message, which service or user journey is affected, and exactly what changed just before it started.",
  expected_if_true: null
};
