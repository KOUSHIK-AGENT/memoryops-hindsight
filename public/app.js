/**
 * MemoryOps — frontend controller.
 * Everything shown as "memory" comes from the server's real Hindsight recall/reflect results.
 */

// Demo presets: a problem plus the outcome a person would confirm after fixing it.
const PRESETS = {
  round1: {
    problem: "Customers are unable to place orders after today's checkout update. Some checkout requests are failing, and the database appears overloaded. The problem started immediately after the latest update.",
    area: "Checkout",
    cause: "The database connection limit was changed from 30 to 5 in today's update.",
    causeConfirmed: true,
    attempted: "Restarted the checkout service only; the database timeouts came back within minutes.",
    worked: "Restored the database connection limit from 5 to 30, restarted the checkout service, and confirmed orders were working normally again.",
    outcome: "Orders returned to normal and database timeouts stopped.",
    lesson: "For checkout failures plus database timeouts right after an update, compare database connection settings with the last known-good configuration first.",
    observation: "Current pool is 5. Previous version was 30."
  },
  round2: {
    problem: "Customers report that checkout becomes unavailable after today's release. Database requests are timing out and capacity appears exhausted.",
    area: "Checkout",
    cause: "A shared configuration template reset the database connection limit to 5 during the release.",
    causeConfirmed: true,
    attempted: "Added more checkout servers; no improvement, because the database connection limit was still 5.",
    worked: "Fixed the shared configuration template, restored the connection limit to 30, and redeployed checkout.",
    outcome: "Checkout recovered and database connections returned to the normal range.",
    lesson: "If the connection limit drops again after a release, check the shared configuration template, not just the service settings.",
    observation: "Pool is 5 again. The shared configuration template changed in this release."
  },
  round3: {
    problem: "After this afternoon's deployment the order page times out and the database reports it has no free connections left.",
    area: "Checkout",
    cause: "The deployment's new container settings capped each checkout instance at 3 database connections.",
    causeConfirmed: true,
    attempted: "Scaled out checkout instances; errors got worse.",
    worked: "Raised the per-instance database connection limit back to 20 and redeployed checkout.",
    outcome: "Order page recovered and database connection waits disappeared.",
    lesson: "When checkout times out after a deployment, check per-instance database connection limits in the new settings.",
    observation: "Each checkout instance is limited to 3 database connections."
  },
  round4: {
    problem: "Checkout started failing right after today's release; customers see an error when submitting orders, but database connections look healthy.",
    area: "Checkout",
    cause: "The tax service's TLS certificate expired the same morning because automatic renewal had failed.",
    causeConfirmed: true,
    attempted: "Rolled back the release; errors continued.",
    worked: "Renewed the tax service certificate and fixed the renewal job.",
    outcome: "Orders succeeded again.",
    lesson: "If checkout fails after a release but database connections are healthy, check certificate expiry on the services checkout calls.",
    observation: "Connection pool is 30 as usual. Logs show the tax service certificate has expired."
  },
  unrelated: {
    problem: "Product images on the company website load very slowly for visitors in Europe since this morning. Pages open, but pictures take a long time to appear.",
    area: "Website",
    cause: "An image caching rule for European visitors had expired.",
    causeConfirmed: true,
    attempted: "",
    worked: "Restored the regional image caching rule and cleared the cache.",
    outcome: "Images load quickly again for European visitors.",
    lesson: "Slow images in one region: check that region's caching rules first.",
    observation: ""
  }
};
const SAVE_FIELDS = ["area", "cause", "attempted", "outcome", "lesson"];

const EVIDENCE_NOT_CERTAINTY = "Past incidents are evidence, not certainty. Verify today's system before applying a previous fix.";

const $ = (id) => document.getElementById(id);

const state = {
  connected: false,
  documents: null,
  counts: null, // real per-kind document totals from Hindsight: { historical, learned, feedback }
  demoState: "ready",
  analyses: 0,
  lastAnalysis: null, // { incident, matchedId } for feedback
  hypotheses: [],     // current diagnostic hypotheses (session only)
  observations: [],   // what the engineer observed (session evidence; retained only on confirmed save)
  observationHint: "",
  busy: { analyze: false, seed: false, resolve: false }
};

// ============================================================
// API
// ============================================================

async function apiRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  } catch {
    throw Object.assign(new Error("Cannot reach the MemoryOps server. Is it still running?"), { code: "server_unreachable" });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || `Request failed (${response.status}).`), { status: response.status, code: data.code, detail: data.detail });
  }
  return data;
}

// ============================================================
// TOAST & ERROR BANNER
// ============================================================

let toastTimer = null;
function showToast(message, type = "success") {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast show toast-${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4000);
}

function showBannerError(err) {
  $("errorMessage").textContent = err.message || "Memory service error.";
  const detail = [err.code, err.detail].filter(Boolean).join(" — ");
  $("errorDetails").textContent = detail;
  $("errorToggleDetails").style.display = detail ? "inline" : "none";
  $("errorBanner").style.display = "flex";
  setDemoState("error", { message: err.message });
}

function hideBannerError() {
  $("errorBanner").style.display = "none";
  $("errorDetails").style.display = "none";
}

$("errorToggleDetails").addEventListener("click", () => {
  const d = $("errorDetails");
  d.style.display = d.style.display === "none" ? "block" : "none";
});

// ============================================================
// STEPPER + PIPELINE
// ============================================================

function setStep(current, allDone = false) {
  for (let i = 1; i <= 4; i++) {
    const el = $(`step${i}`);
    el.classList.remove("active", "completed");
    const done = i < current || (allDone && i === current);
    if (done) el.classList.add("completed");
    else if (i === current) el.classList.add("active");
    el.querySelector(".step-num").textContent = done ? "✓" : String(i);
  }
}

function setPipeline(nodes) {
  for (const id of ["learnProblem", "learnRecalled", "learnVerify", "learnSaved", "learnFuture"]) {
    $(id).classList.remove("active", "highlighted");
    if (nodes[id]) $(id).classList.add(nodes[id]);
  }
}

function logLearning(html) {
  const log = $("learningLog");
  log.querySelector(".log-empty")?.remove();
  log.insertAdjacentHTML("beforeend", `<li>${html}</li>`);
  while (log.children.length > 6) log.firstElementChild.remove();
}

// ============================================================
// DEMO STATE (single source of truth for the status banner)
// ============================================================

const STATES = {
  ready: { box: "state-empty", headline: "Ready", text: () => "Describe today's problem, then click Analyze problem." },
  memory_available: { box: "state-loaded", headline: "Past experience available", text: () => `${countLabel(state.documents)} stored in Hindsight. Analyze the problem to search them.` },
  no_experience: { box: "state-empty", headline: "No similar solved problem was found", text: (x) => x.searched ? `Hindsight searched ${countLabel(state.documents)} but none matched today's problem. Showing general troubleshooting.` : "Hindsight has no past experience yet. Showing general troubleshooting." },
  match_found: { box: "state-recalled", headline: "Similar solved problem recalled", text: (x) => `Hindsight recalled ${x.id}, but the recommendation step failed: ${x.message}` },
  recommendation_ready: { box: "state-recalled", headline: "Memory used — recommendation ready", text: (x) => `Hindsight recalled ${x.id}, a similar problem your team solved before, and used it to decide what to check first.` },
  saved: { box: "state-loaded", headline: "✓ Experience learned", text: (x) => `Verified solution ${x.id} is stored in Hindsight. MemoryOps can use it when a similar problem happens again.` },
  error: { box: "state-error", headline: "Memory service error", text: (x) => x.message }
};

function countLabel(n) {
  // Hindsight's total_documents: solved problems plus feedback notes.
  if (!Number.isFinite(n)) return "Past experience";
  return n === 1 ? "1 memory" : `${n} memories`;
}

function setDemoState(key, extra = {}) {
  const def = STATES[key];
  state.demoState = key;
  const box = $("memoryStateBanner");
  box.classList.remove("state-empty", "state-loaded", "state-recalled", "state-error");
  box.classList.add(def.box);
  $("stateHeadline").textContent = def.headline;
  $("stateDescription").textContent = def.text(extra);
}

function renderMemoryBadge() {
  const badge = $("memoryBadge");
  if (!state.connected) {
    badge.textContent = "Memory unavailable";
    badge.className = "badge badge-neutral";
  } else if (Number.isFinite(state.counts?.historical) && Number.isFinite(state.counts?.learned) && state.documents > 0) {
    badge.textContent = `${state.counts.historical} historical · ${state.counts.learned} learned${state.counts.patterns ? ` · ${state.counts.patterns} team pattern${state.counts.patterns > 1 ? "s" : ""}` : ""}`;
    badge.title = "Exact counts of documents in this Hindsight bank: dataset/sample incidents and human-confirmed resolutions saved from MemoryOps.";
  } else if (state.documents > 0) {
    badge.textContent = `${countLabel(state.documents)} stored`;
    badge.className = "badge badge-memory";
  } else {
    badge.textContent = "Memory is empty";
    badge.className = "badge badge-neutral";
  }
}

// ============================================================
// STATUS
// ============================================================

async function refreshStatus() {
  try {
    const s = await apiRequest("/api/status");
    state.connected = s.connected;
    state.documents = s.documents;
    state.counts = s.counts || null;
    const dot = $("dot");
    if (s.connected) {
      dot.className = "status-dot ok";
      $("mode").textContent = "Hindsight connected ✓";
      const pending = s.pendingOperations > 0 ? ` · processing ${s.pendingOperations}` : "";
      $("bank").textContent = `Bank: ${s.bankId}${pending}`;
    } else if (!s.hasApiKey) {
      dot.className = "status-dot warn";
      $("mode").textContent = "Hindsight key missing";
      $("bank").textContent = "Add HINDSIGHT_API_KEY to .env";
    } else {
      dot.className = "status-dot error";
      $("mode").textContent = "Hindsight not reachable";
      $("bank").textContent = s.error || `Bank: ${s.bankId}`;
    }
    renderMemoryBadge();
    if (state.demoState === "ready" || state.demoState === "memory_available") {
      setDemoState(state.documents > 0 ? "memory_available" : "ready");
    }
    if (!s.connected && s.hasApiKey) showBannerError({ message: s.error || "Hindsight is not reachable.", code: s.code });
  } catch (err) {
    $("dot").className = "status-dot error";
    $("mode").textContent = "Server unavailable";
    $("bank").textContent = "Unable to reach MemoryOps server";
    showBannerError(err);
  }
}

// ============================================================
// BUTTON BUSY HELPER
// ============================================================

async function withBusy(key, btn, label, fn) {
  if (state.busy[key]) return;
  state.busy[key] = true;
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.innerHTML = `<span class="spinner spinner-inline" aria-hidden="true"></span><span>${label}</span>`;
  try {
    await fn();
  } finally {
    state.busy[key] = false;
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.innerHTML = original;
  }
}

// ============================================================
// SEED (store sample history in Hindsight)
// ============================================================

$("seed").addEventListener("click", () => withBusy("seed", $("seed"), "Storing in Hindsight…", async () => {
  hideBannerError();
  try {
    const res = await apiRequest("/api/seed", { method: "POST", body: "{}" });
    showToast(`Stored ${res.seeded} past solved problems in Hindsight.`, "success");
    logLearning(`Loaded ${res.seeded} sample solved problems into Hindsight`);
    await refreshStatus();
    if (!["recommendation_ready", "match_found", "saved"].includes(state.demoState)) setDemoState("memory_available");
  } catch (err) {
    showToast("Could not store past incidents.", "error");
    showBannerError(err);
  }
}));

// ============================================================
// ANALYZE
// ============================================================

$("analyze").addEventListener("click", () => {
  const text = $("incident").value.trim();
  if (!text) {
    $("incidentError").textContent = "Describe the problem before analyzing it.";
    $("incidentError").style.display = "block";
    $("incident").focus();
    return;
  }
  $("incidentError").style.display = "none";

  return withBusy("analyze", $("analyze"), "Searching memory…", async () => {
    hideBannerError();
    setStep(2);
    setPipeline({ learnProblem: "active" });
    $("analysisEmpty").style.display = "none";
    $("recommendationContent").style.display = "none";
    $("analysisLoading").style.display = "flex";

    try {
      const data = await apiRequest("/api/analyze", { method: "POST", body: JSON.stringify({ incident: text }) });
      $("analysisLoading").style.display = "none";
      const rec = data.recommendation;
      const matched = rec?.memoryUsed ? data.matches.find((m) => m.incidentId === rec.matchedIncidentId) : null;

      if (state.lastAnalysis?.incident !== text) state.observations = [];
      state.hypotheses = data.evidence?.hypotheses || [];
      renderObservations();
      state.analyses += 1;
      state.lastAnalysis = { incident: text, matchedId: matched?.incidentId || null };
      renderMemories(data, matched);
      renderRecommendation(data, matched);
      setStep(3);
      const n = state.analyses;

      if (data.state === "recommendation_ready" && matched) {
        setDemoState("recommendation_ready", { id: matched.incidentId });
        setPipeline({ learnProblem: "active", learnRecalled: "highlighted", ...(matched.learned ? { learnFuture: "highlighted" } : {}) });
        const origin = matched.learned ? ", learned from a previous resolved incident" : matched.verified ? ", confirmed resolution" : "";
        logLearning(`Analysis ${n}: <strong>1 relevant resolved incident recalled</strong> (${esc(matched.incidentId)}${origin}) → recommendation supported by ${matched.verified ? "verified " : ""}history`);
        showToast(`Hindsight recalled ${matched.incidentId}, a similar solved problem.`, "success");
      } else if (data.state === "match_found") {
        setDemoState("match_found", { id: data.matches[0]?.incidentId, message: data.reflectError?.message || "unknown error" });
        setPipeline({ learnProblem: "active", learnRecalled: "highlighted" });
        logLearning(`Analysis ${n}: ${data.matches.length} memories recalled, but the recommendation step failed`);
        showToast("Memory recalled, but the recommendation failed.", "error");
      } else {
        setDemoState("no_experience", { searched: data.matches.length > 0 || state.documents > 0 });
        setPipeline({ learnProblem: "active" });
        logLearning(data.matches.length
          ? `Analysis ${n}: ${data.matches.length} memories recalled, <strong>none judged similar</strong> → general troubleshooting`
          : `Analysis ${n}: <strong>0 relevant memories recalled</strong> → general troubleshooting`);
        showToast("No similar solved problem found. Showing general troubleshooting.", "warn");
      }
    } catch (err) {
      $("analysisLoading").style.display = "none";
      $("analysisEmpty").style.display = "flex";
      setStep(1);
      setPipeline({});
      showToast("Analysis failed.", "error");
      showBannerError(err);
    }
  });
});

// ============================================================
// RENDER: similar problem from the past (left)
// ============================================================

function emptyState(title, body) {
  return `<div class="panel-empty-state">
    <svg class="empty-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>
    <h3>${title}</h3><p>${body}</p></div>`;
}

function renderMemories(data, matched) {
  const list = $("memoriesList");
  const badge = $("recallBadge");
  const matches = data.matches || [];
  list.innerHTML = "";

  if (matched) {
    badge.textContent = "1 similar problem found";
    badge.className = "badge badge-accent";
    list.appendChild(incidentCard(matched, "Most similar — used for today's recommendation"));
    const others = matches.filter((m) => m !== matched);
    if (others.length) list.insertAdjacentHTML("beforeend", otherRecalled(others, "Also recalled by Hindsight, judged less similar"));
    return;
  }
  if (data.state === "match_found" && matches.length) {
    badge.textContent = `${matches.length} recalled`;
    badge.className = "badge badge-accent";
    list.appendChild(incidentCard(matches[0], "Hindsight's top recall result"));
    if (matches.length > 1) list.insertAdjacentHTML("beforeend", otherRecalled(matches.slice(1), "Other recall results"));
    return;
  }
  badge.textContent = "No match";
  badge.className = "badge badge-subtle";
  list.innerHTML = emptyState("No similar solved problem was found.",
    matches.length
      ? "Hindsight searched team memory, but nothing it recalled resembles today's problem closely enough to rely on."
      : "Team memory has nothing relevant yet. Load past solved incidents, or save today's solution once it is fixed.");
  if (matches.length) list.insertAdjacentHTML("beforeend", otherRecalled(matches, "What Hindsight recalled (not similar enough)"));
}

function otherRecalled(items, label) {
  const rows = items.map((m) => `<li><span class="incident-id">${esc(m.incidentId)}</span> ${m.learned ? '<span class="learned-pill">Learned</span> ' : ""}${esc(m.fields?.title || m.facts[0] || "")}</li>`).join("");
  return `<div class="other-recalled"><div class="field-label">${esc(label)}</div><ul>${rows}</ul></div>`;
}

function incidentCard(m, label) {
  const card = document.createElement("div");
  card.className = "memory-card";
  const f = m.fields || {};
  const score = Number.isFinite(m.score) ? `<span class="similarity-score" title="Hindsight reranker relevance score (0–1)">relevance ${m.score.toFixed(2)}</span>` : "";
  const field = (name, value, cls = "") => value ? `<div class="incident-field"><span class="field-label">${name}</span><p class="field-value ${cls}">${esc(value)}</p></div>` : "";
  const structured = m.fields
    ? field("What happened", f.title && f.happened && !f.happened.startsWith(f.title) ? `${f.title}${/[.!?]$/.test(f.title) ? "" : "."} ${f.happened.charAt(0).toUpperCase()}${f.happened.slice(1)}` : f.happened || f.title) +
      field("Confirmed cause", f.cause, "highlight-cause") +
      field("Suspected cause (not confirmed)", f.suspectedCause) +
      field("Tried, but did NOT fix it", f.attempted, "highlight-failed") +
      field("Tried, helped only partially", f.partial) +
      field("What worked", f.worked, "highlight-fix") +
      field("Outcome", f.outcome) +
      field("How the fix was verified", f.verification) +
      field("Lesson learned", f.lesson) +
      (m.feedback?.length ? field("Team feedback", m.feedback.map((x) => `${x.verdict} for “${x.problem || "a similar problem"}”`).join(" · ")) : "")
    : `<div class="incident-field"><span class="field-label">Recalled facts</span><ul class="fact-list">${m.facts.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`;
  const raw = [
    f.technical ? `<p><strong>Technical details:</strong> ${esc(f.technical)}</p>` : "",
    f.context ? `<p><strong>Context:</strong> ${esc(f.context)}</p>` : "",
    f.ruledOut ? `<p><strong>Initially suspected, ruled out:</strong> ${esc(f.ruledOut)}</p>` : "",
    `<p><strong>Facts Hindsight recalled:</strong></p><ul class="fact-list">${m.facts.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`,
    m.documentId ? `<p class="mono">document_id: ${esc(m.documentId)}</p>` : ""
  ].join("");

  card.innerHTML = `
    <div class="memory-provenance">${esc(label)}</div>
    ${m.learned ? `<div class="learned-banner">Learned from a previous resolved incident${f.recordedAt ? ` · saved ${esc(new Date(f.recordedAt).toLocaleString())}` : ""}</div>` : ""}
    <div class="memory-header">
      <div class="incident-badge-row">
        <span class="incident-id">${esc(m.incidentId)}</span>
        ${f.area ? `<span class="service-pill">${esc(f.area)}</span>` : ""}
        ${m.verified ? `<span class="verified-pill" title="${esc(f.status || "")}">✓ ${m.learned ? "Human-confirmed" : "Confirmed"}</span>` : ""}
        ${!m.learned && m.documentId?.startsWith("memoryops-INC-") ? '<span class="service-pill">Historical dataset</span>' : ""}
        <span class="service-pill">Recall rank #${m.rank}</span>
      </div>
      ${score}
    </div>
    <div class="incident-fields">${structured}</div>
    <details class="raw-details"><summary>Show what Hindsight returned</summary>${raw}</details>`;
  return card;
}

// ============================================================
// RENDER: what to check today (right)
// ============================================================

const ICON = {
  memory: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  pattern: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m10 15 5-3-5-3v6Z"/></svg>',
  checks: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  safety: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
};

function block(cls, icon, label, inner) {
  return `<div class="rec-block ${cls}"><div class="rec-label">${icon} ${esc(label)}</div>${inner}</div>`;
}

function checksList(checks) {
  return `<ol class="checks-list">${checks.map((c, i) => `<li class="check-item"><span class="check-num">${i + 1}</span><span>${esc(c)}</span></li>`).join("")}</ol>`;
}

const LEVEL_TEXT = {
  HIGH: "Several confirmed incidents agree with today's facts.",
  MEDIUM: "Supported by confirmed history, with some uncertainty.",
  LOW: "Weak or unconfirmed historical evidence.",
  INSUFFICIENT: "No relevant historical evidence."
};

function confidenceHtml(ev) {
  if (!ev) return "";
  const c = ev.confidence;
  const why = c.reasons.length ? `<details class="rec-details"><summary>How this confidence was decided</summary><ul class="fact-list">${c.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></details>` : "";
  return `<div class="confidence-row conf-${c.level.toLowerCase()}"><span class="field-label">Memory confidence</span><span class="conf-chip">${c.level}</span><span class="conf-text">${esc(LEVEL_TEXT[c.level])}</span></div>
    ${c.statement ? `<p class="rec-text abstain">${esc(c.statement)}</p>` : ""}${why}`;
}

function teamHtml(team) {
  if (!team) return "";
  let html = "";
  for (const p of team.patterns || []) {
    html += block("rec-block-team", ICON.memory, "Team has learned", `<p class="rec-text">${esc(p.statement)}</p>
      <p class="rec-caption">Supporting: ${p.supporting_incidents.map(esc).join(", ")}${p.counterexamples.length ? ` · Exceptions: ${p.counterexamples.map((c) => `${esc(c.id)} (${esc(c.cause.toLowerCase())})`).join(", ")}` : ""}. Consolidated from human-confirmed incidents only.</p>`);
  }
  const b = team.playbook;
  if (b) {
    html += `<details class="rec-block rec-block-team playbook"><summary class="rec-label">${ICON.checks} Team playbook: ${esc(b.title)} · learned from ${b.learned_from} confirmed incidents</summary>
      <ol class="playbook-steps">${b.steps.map((st) => `<li><strong>${esc(st.step)}</strong><span class="rec-caption">Why this check exists: ${esc(st.why)} (${st.supporting_incidents.map(esc).join(", ")})</span></li>`).join("")}</ol>
      ${b.cautions.map((c) => `<p class="rec-caption">⚠ ${esc(c.text)}</p>`).join("")}
      <p class="rec-caption">Guidance learned from verified history. A person runs every step; MemoryOps never acts on systems.</p></details>`;
  }
  return html;
}

function diagnosisHtml() {
  const hyps = state.hypotheses || [];
  const next = state.nextBestCheck;
  const hypList = hyps.length ? `<details class="rec-details" ${state.observations.length ? "open" : ""}><summary>Current hypotheses (${hyps.length})</summary><ul class="hyp-list">${hyps.map((h) => `
      <li class="hyp hyp-${h.status.replace(" ", "-")}"><div><strong>${esc(h.hypothesis)}</strong> <span class="conf-chip small">${h.confidence}</span> <span class="hyp-status">${esc(h.status)}</span></div>
      <div class="rec-caption">Past example: ${esc(h.example_cause || "")} · Supporting: ${h.supporting_memories.map((m) => esc(m.id)).join(", ")}</div>
      ${h.supporting_current_evidence?.length ? `<div class="rec-caption">Matches today: ${h.supporting_current_evidence.map(esc).join("; ")}</div>` : ""}
      ${h.observations_for?.length ? `<div class="rec-caption obs-for">Your observation supports: ${h.observations_for.map(esc).join("; ")}</div>` : ""}
      ${h.evidence_against?.length ? `<div class="rec-caption obs-against">Against: ${h.evidence_against.map(esc).join("; ")}</div>` : ""}</li>`).join("")}</ul></details>` : "";
  const nextHtml = next ? `<p class="rec-text"><strong>${esc(next.text)}</strong></p>${next.expected_if_true ? `<p class="rec-caption">Expected if true: ${esc(next.expected_if_true)}</p>` : ""}` : `<p class="rec-text">No remembered cause to test yet. Record what you check; it is kept only for this session.</p>`;
  return block("rec-block-diagnose", ICON.pattern, "Next best check", `${nextHtml}${hypList}
    <div class="obs-row"><input id="observationInput" type="text" spellcheck="false" placeholder="What did you observe? e.g. ${esc(state.observationHint || "Current pool is 5; previous version was 30")}" />
    <button class="preset-btn" type="button" id="addObservation">Record observation</button></div>
    <p class="rec-caption">Observations are session evidence only. They are saved to memory only if you confirm the final outcome in Step 4.</p>`);
}

function renderRecommendation(data, matched) {
  const container = $("recommendationContent");
  const badge = $("recommendationContextBadge");
  const rec = data.recommendation;
  const ev = data.evidence;
  state.nextBestCheck = ev?.nextBestCheck || null;
  const diag = ev ? `<div id="diagnosisBox">${diagnosisHtml()}</div>` : "";
  const team = teamHtml(data.team);
  let html = confidenceHtml(ev);

  if (!rec) {
    badge.textContent = "Recommendation failed";
    badge.className = "badge badge-subtle";
    html = block("rec-block-safety", ICON.safety, "Could not generate a recommendation",
      `<p class="rec-text">${esc(data.reflectError?.message || "Hindsight reflect failed.")} The recalled memory on the left is still real — try Analyze again.</p>`);
  } else if (matched) {
    badge.textContent = `Memory used: ${matched.incidentId}`;
    badge.className = "badge badge-memory";
    const f = matched.fields || {};
    const prov = [
      ["Similar solved problem", `${f.title || matched.facts[0] || ""} (${matched.incidentId})`],
      [f.cause ? "Past cause (confirmed)" : "Past cause (suspected, not confirmed)", f.cause || f.suspectedCause],
      ["What worked", f.worked],
      ["Why MemoryOps suggests checking this", rec.why]
    ].filter(([, v]) => v).map(([k, v]) => `<div class="prov-row"><span class="field-label">${esc(k)}</span><p class="rec-text">${esc(v)}</p></div>`).join("");
    html += block("rec-block-evidence", ICON.memory, "Memory used", prov);
    if (ev?.why?.reasons?.length) {
      html += `<details class="rec-block rec-block-why"><summary class="rec-label">${ICON.memory} Why this recommendation?</summary><ul class="fact-list">${ev.why.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul><p class="rec-caption">Supporting incidents: ${ev.why.supporting.map(esc).join(", ")}</p></details>`;
    }
    if (ev?.conflicts?.detected) {
      html += block("rec-block-avoid", ICON.memory, "Conflicting history", `<p class="rec-text">${esc(ev.conflicts.text)}</p><ul class="fact-list">${ev.conflicts.causes.map((c) => `<li>${esc(c.cause)}: ${c.incidents.map(esc).join(", ")}</li>`).join("")}</ul>`);
    }
    html += diag;
    if (rec.structured) {
      if (rec.pattern) html += block("rec-block-pattern", ICON.pattern, "Likely pattern", `<p class="rec-text">${esc(rec.pattern)}</p>`);
      if (rec.checks?.length) html += block("rec-block-checks", ICON.checks, "What I would check first", checksList(rec.checks));
      if (ev?.failedBefore?.length) html += block("rec-block-avoid", ICON.safety, "Previously tried, did NOT work", `<ul class="fact-list">${ev.failedBefore.map((f) => `<li>${esc(f.text)}</li>`).join("")}</ul>`);
      else if (rec.avoid) html += block("rec-block-avoid", ICON.safety, "Previously tried, did NOT work", `<p class="rec-text">${esc(rec.avoid)}</p>`);
      if (rec.conflict) html += block("rec-block-avoid", ICON.memory, "Conflicting past evidence", `<p class="rec-text">${esc(rec.conflict)} Neither is treated as certain.</p>`);
      if (rec.teamLearned) html += block("rec-block-evidence", ICON.memory, "Team learned", `<p class="rec-text">${esc(rec.teamLearned)}</p><p class="rec-caption">Summarised by Hindsight reflect from stored team memory.</p>`);
    } else {
      html += block("rec-block-checks", ICON.checks, "Recommendation", `<p class="rec-text pre">${esc(rec.text)}</p>`);
    }
    html += team;
    html += block("rec-block-safety", ICON.safety, "Safety note",
      `<p class="rec-text"><strong>${EVIDENCE_NOT_CERTAINTY}</strong>${rec.safety ? ` ${esc(rec.safety)}` : ""}</p>`);
    html += `<div class="feedback-row" id="feedbackRow"><span>Was this past incident useful?</span>
      <button class="preset-btn" type="button" data-helpful="true">Helpful</button>
      <button class="preset-btn" type="button" data-helpful="false">Not relevant</button></div>`;
  } else {
    badge.textContent = "General troubleshooting — no memory used";
    badge.className = "badge badge-subtle";
    const body = rec.structured
      ? `<p class="rec-text"><strong>No similar solved problem was found.</strong> These are general first steps, not based on team memory:</p>${checksList(rec.checks || [])}`
      : `<p class="rec-text"><strong>No similar solved problem was found.</strong></p><p class="rec-text pre">${esc(rec.text)}</p>`;
    const tip = `<p class="rec-tip"><strong>Next:</strong> once a person has fixed this, save what actually worked in Step 4. The next similar problem will start from that verified experience.</p>`;
    html += diag;
    html += block("rec-block-general", ICON.memory, "What I would check first (general)", body + tip);
    html += team;
    if (rec.safety) html += block("rec-block-safety", ICON.safety, "Safety note", `<p class="rec-text">${esc(rec.safety)}</p>`);
  }

  if (!rec) html += diag + team;
  container.innerHTML = html;
  container.style.display = "flex";
}

function renderObservations() {
  const box = $("sessionObservations");
  box.innerHTML = state.observations.length
    ? `<span class="field-label">Observations this session (saved only if you confirm)</span><ul class="fact-list">${state.observations.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>`
    : "";
}

async function addObservation() {
  const input = $("observationInput");
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  state.observations.push(text);
  renderObservations();
  if (state.hypotheses.length) {
    try {
      const r = await apiRequest("/api/diagnose", { method: "POST", body: JSON.stringify({ hypotheses: state.hypotheses, observations: state.observations }) });
      state.hypotheses = r.hypotheses;
      state.nextBestCheck = r.nextBestCheck;
      const lead = r.hypotheses[0];
      logLearning(`Observation recorded → leading hypothesis: <strong>${esc(lead.hypothesis)}</strong> (${esc(lead.status)})`);
    } catch (err) {
      showToast("Could not update hypotheses.", "error");
      showBannerError(err);
    }
  } else {
    logLearning("Observation recorded (session evidence only)");
  }
  $("diagnosisBox").innerHTML = diagnosisHtml();
}

// ============================================================
// SAVE WHAT WORKED
// ============================================================

$("recommendationContent").addEventListener("click", (e) => {
  if (e.target.closest("#addObservation")) addObservation();
});
$("recommendationContent").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "observationInput") addObservation();
});

$("recommendationContent").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-helpful]");
  if (!btn || !state.lastAnalysis?.matchedId) return;
  const row = $("feedbackRow");
  const helpful = btn.dataset.helpful === "true";
  row.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await apiRequest("/api/feedback", { method: "POST", body: JSON.stringify({ incidentId: state.lastAnalysis.matchedId, helpful, incident: state.lastAnalysis.incident }) });
    row.innerHTML = `<span>Thanks. Saved to Hindsight as a relevance hint for ${esc(state.lastAnalysis.matchedId)} (not as a confirmed fact).</span>`;
    logLearning(`Feedback: ${esc(state.lastAnalysis.matchedId)} marked <strong>${helpful ? "helpful" : "not relevant"}</strong>`);
  } catch (err) {
    row.querySelectorAll("button").forEach((b) => (b.disabled = false));
    showToast("Could not save feedback.", "error");
    showBannerError(err);
  }
});

$("resolve").addEventListener("click", () => {
  const incident = $("incident").value.trim();
  const worked = $("resolution").value.trim();
  const errorEl = $("resolutionError");
  const missing = !worked ? ["resolution", "Enter what actually fixed the problem."]
    : !incident ? ["incident", "Describe the problem (Step 1) before saving its solution."]
    : !$("humanConfirmed").checked ? ["humanConfirmed", "Tick “I confirm this is what actually happened”. Only human-confirmed outcomes are saved as experience."]
    : null;
  if (missing) {
    errorEl.textContent = missing[1];
    errorEl.style.display = "block";
    $(missing[0]).focus();
    return;
  }
  errorEl.style.display = "none";
  const payload = { incident, worked, confirmed: true, causeConfirmed: $("causeConfirmed").checked, observations: state.observations };
  for (const f of SAVE_FIELDS) payload[f] = $(f).value.trim();

  return withBusy("resolve", $("resolve"), "Saving to Hindsight…", async () => {
    hideBannerError();
    try {
      const res = await apiRequest("/api/resolve", { method: "POST", body: JSON.stringify(payload) });
      setStep(4, true);
      setPipeline({ learnProblem: "active", learnRecalled: "active", learnVerify: "highlighted", learnSaved: "highlighted" });
      const causeNote = { confirmed: "cause confirmed", suspected: "cause marked as suspected", unknown: "cause not recorded" }[res.causeStatus] || "";
      $("savedResolutionPreview").textContent = `Stored as ${res.id} (${causeNote}): “${worked}”`;
      $("saveSuccessBox").style.display = "flex";
      $("humanConfirmed").checked = false;
      showToast("Experience learned and saved to Hindsight.", "success");
      await refreshStatus();
      setDemoState("saved", { id: res.id });
      logLearning(`Saved verified experience <strong>${esc(res.id)}</strong>${Number.isFinite(state.documents) ? ` · ${countLabel(state.documents)} now stored` : ""}`);
      state.observations = [];
      renderObservations();
      for (const ch of res.consolidation?.changes || []) {
        if (ch.type === "TEAM_PATTERN" && ch.status !== "unchanged") {
          const p = res.consolidation.patterns.find((x) => x.id === ch.id);
          logLearning(`<strong>Team has learned</strong> (${ch.status}): ${esc(p?.statement || ch.id)}`);
          showToast(`Team pattern ${ch.status}: learned from ${p?.supporting ?? "3+"} confirmed incidents.`, "success");
        }
        if (ch.type === "PLAYBOOK" && ch.status !== "unchanged") logLearning(`<strong>Team playbook</strong> ${ch.status} from verified history`);
      }
    } catch (err) {
      showToast("Could not save the solution.", "error");
      showBannerError(err);
    }
  });
});

// ============================================================
// DEMO EXAMPLE & RESET (screen only — Hindsight memories are kept)
// ============================================================

function applyPreset(key) {
  const p = PRESETS[key];
  $("incident").value = p.problem;
  $("resolution").value = p.worked;
  for (const f of SAVE_FIELDS) $(f).value = p[f];
  $("causeConfirmed").checked = p.causeConfirmed;
  state.observationHint = p.observation || "";
  $("humanConfirmed").checked = false;
  $("incidentError").style.display = "none";
  $("resolutionError").style.display = "none";
  document.querySelectorAll("[data-preset]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.preset === key)));
}

document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
  applyPreset(b.dataset.preset);
  $("saveSuccessBox").style.display = "none";
  showToast(`${b.textContent.trim()} problem filled in. Click Analyze problem.`, "success");
}));

$("resetDemo").addEventListener("click", () => {
  applyPreset("round1");
  for (const id of ["incidentError", "resolutionError", "saveSuccessBox", "recommendationContent", "analysisLoading"]) $(id).style.display = "none";
  $("analysisEmpty").style.display = "flex";
  hideBannerError();
  $("recommendationContextBadge").textContent = "Awaiting analysis";
  $("recommendationContextBadge").className = "badge badge-subtle";
  $("recallBadge").textContent = "Not searched yet";
  $("recallBadge").className = "badge badge-subtle";
  $("memoriesList").innerHTML = emptyState("No search yet.", "Click <strong>Analyze problem</strong>. Anything Hindsight recalls from past solved problems appears here.");
  $("learningLog").innerHTML = '<li class="log-empty">Screen cleared. Memories already stored in Hindsight are kept.</li>';
  state.analyses = 0;
  state.lastAnalysis = null;
  state.hypotheses = [];
  state.observations = [];
  renderObservations();
  setStep(1);
  setPipeline({});
  setDemoState("ready");
  showToast("Screen cleared. Memories stored in Hindsight are kept.", "success");
  refreshStatus();
});

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

applyPreset("round1");
refreshStatus();
