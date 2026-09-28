/**
 * MemoryOps — frontend controller.
 * Everything shown as "memory" comes from the server's real Hindsight recall/reflect results.
 */

const DEFAULT_INCIDENT = "Customers are unable to place orders after today's checkout update. Some checkout requests are failing, and the database appears overloaded. The problem started immediately after the latest update.";
const DEFAULT_RESOLUTION = "Restored the database connection limit from 5 to 30, restarted the checkout service, and confirmed orders were working normally again.";
const EVIDENCE_NOT_CERTAINTY = "Past incidents are evidence, not certainty. Verify today's system before applying a previous fix.";

const $ = (id) => document.getElementById(id);

const state = {
  connected: false,
  documents: null,
  demoState: "ready",
  lastGeneral: null, // most recent analysis without memory (for the before/after comparison)
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
  for (const id of ["pipelineSearch", "pipelineRecalled", "pipelineBetter", "pipelineSave"]) {
    $(id).classList.remove("active", "highlighted");
    if (nodes[id]) $(id).classList.add(nodes[id]);
  }
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
  saved: { box: "state-loaded", headline: "Experience saved", text: (x) => `Today's solution (${x.id}) is stored in Hindsight and can help next time.` },
  error: { box: "state-error", headline: "Memory service error", text: (x) => x.message }
};

function countLabel(n) {
  if (!Number.isFinite(n)) return "Past solved problems";
  return n === 1 ? "1 solved problem" : `${n} solved problems`;
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
  } else if (state.documents > 0) {
    badge.textContent = `${countLabel(state.documents)} in memory`;
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
    setPipeline({ pipelineSearch: "active" });
    $("analysisEmpty").style.display = "none";
    $("recommendationContent").style.display = "none";
    $("analysisLoading").style.display = "flex";

    try {
      const data = await apiRequest("/api/analyze", { method: "POST", body: JSON.stringify({ incident: text }) });
      $("analysisLoading").style.display = "none";
      const rec = data.recommendation;
      const matched = rec?.memoryUsed ? data.matches.find((m) => m.incidentId === rec.matchedIncidentId) : null;

      renderMemories(data, matched);
      renderRecommendation(data, matched);
      setStep(3);

      if (data.state === "recommendation_ready" && matched) {
        setDemoState("recommendation_ready", { id: matched.incidentId });
        setPipeline({ pipelineSearch: "active", pipelineRecalled: "highlighted", pipelineBetter: "highlighted" });
        updateCompare("after", matched);
        showToast(`Hindsight recalled ${matched.incidentId} — a similar solved problem.`, "success");
      } else if (data.state === "match_found") {
        setDemoState("match_found", { id: data.matches[0]?.incidentId, message: data.reflectError?.message || "unknown error" });
        setPipeline({ pipelineSearch: "active", pipelineRecalled: "highlighted" });
        showToast("Memory recalled, but the recommendation failed.", "error");
      } else {
        setDemoState("no_experience", { searched: data.matches.length > 0 || state.documents > 0 });
        setPipeline({ pipelineSearch: "active" });
        updateCompare("before");
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

function updateCompare(which, matched) {
  if (which === "before") {
    state.lastGeneral = true;
    $("compareBeforeText").textContent = "Just now: no similar past problem, so only general troubleshooting was possible.";
    $("compareBefore").style.opacity = "1";
    $("compareAfter").style.opacity = "0.6";
  } else {
    $("compareAfterText").textContent = `Now: Hindsight recalled ${matched.incidentId} and the checks point at what caused it before.`;
    if (!state.lastGeneral) $("compareBeforeText").textContent = "Without memory, MemoryOps could only suggest general troubleshooting.";
    $("compareBefore").style.opacity = "0.6";
    $("compareAfter").style.opacity = "1";
  }
}

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
  const rows = items.map((m) => `<li><span class="incident-id">${esc(m.incidentId)}</span> ${esc(m.fields?.title || m.facts[0] || "")}</li>`).join("");
  return `<div class="other-recalled"><div class="field-label">${esc(label)}</div><ul>${rows}</ul></div>`;
}

function incidentCard(m, label) {
  const card = document.createElement("div");
  card.className = "memory-card";
  const f = m.fields || {};
  const score = Number.isFinite(m.score) ? `<span class="similarity-score" title="Hindsight reranker relevance score (0–1)">relevance ${m.score.toFixed(2)}</span>` : "";
  const field = (name, value, cls = "") => value ? `<div class="incident-field"><span class="field-label">${name}</span><p class="field-value ${cls}">${esc(value)}</p></div>` : "";
  const structured = m.fields
    ? field("What happened", f.title && f.happened ? `${f.title} ${f.happened}` : f.title || f.happened) +
      field("What caused it", f.cause, "highlight-cause") +
      field("What worked", f.worked, "highlight-fix") +
      field("Lesson learned", f.lesson)
    : `<div class="incident-field"><span class="field-label">Recalled facts</span><ul class="fact-list">${m.facts.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`;
  const raw = [
    f.technical ? `<p><strong>Technical details:</strong> ${esc(f.technical)}</p>` : "",
    `<p><strong>Facts Hindsight recalled:</strong></p><ul class="fact-list">${m.facts.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`,
    m.documentId ? `<p class="mono">document_id: ${esc(m.documentId)}</p>` : ""
  ].join("");

  card.innerHTML = `
    <div class="memory-provenance">${esc(label)}</div>
    <div class="memory-header">
      <div class="incident-badge-row">
        <span class="incident-id">${esc(m.incidentId)}</span>
        ${f.area ? `<span class="service-pill">${esc(f.area)}</span>` : ""}
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

function renderRecommendation(data, matched) {
  const container = $("recommendationContent");
  const badge = $("recommendationContextBadge");
  const rec = data.recommendation;
  let html = "";

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
      ["Past cause", f.cause],
      ["What worked", f.worked],
      ["Why MemoryOps suggests checking this", rec.why]
    ].filter(([, v]) => v).map(([k, v]) => `<div class="prov-row"><span class="field-label">${esc(k)}</span><p class="rec-text">${esc(v)}</p></div>`).join("");
    html += block("rec-block-evidence", ICON.memory, "Memory used", prov);
    if (rec.structured) {
      if (rec.pattern) html += block("rec-block-pattern", ICON.pattern, "Likely pattern", `<p class="rec-text">${esc(rec.pattern)}</p>`);
      if (rec.checks?.length) html += block("rec-block-checks", ICON.checks, "What I would check first", checksList(rec.checks));
    } else {
      html += block("rec-block-checks", ICON.checks, "Recommendation", `<p class="rec-text pre">${esc(rec.text)}</p>`);
    }
    html += block("rec-block-safety", ICON.safety, "Safety note",
      `<p class="rec-text"><strong>${EVIDENCE_NOT_CERTAINTY}</strong>${rec.safety ? ` ${esc(rec.safety)}` : ""}</p>`);
  } else {
    badge.textContent = "General troubleshooting — no memory used";
    badge.className = "badge badge-subtle";
    const body = rec.structured
      ? `<p class="rec-text"><strong>No similar solved problem was found.</strong> These are general first steps, not based on team memory:</p>${checksList(rec.checks || [])}`
      : `<p class="rec-text"><strong>No similar solved problem was found.</strong></p><p class="rec-text pre">${esc(rec.text)}</p>`;
    const tip = state.documents > 0 ? "" : `<p class="rec-tip"><strong>Tip:</strong> click <em>Load past solved incidents</em>, then analyze again to see how team memory changes the answer.</p>`;
    html += block("rec-block-general", ICON.memory, "What I would check first (general)", body + tip);
    if (rec.safety) html += block("rec-block-safety", ICON.safety, "Safety note", `<p class="rec-text">${esc(rec.safety)}</p>`);
  }

  container.innerHTML = html;
  container.style.display = "flex";
}

// ============================================================
// SAVE WHAT WORKED
// ============================================================

$("resolve").addEventListener("click", () => {
  const incident = $("incident").value.trim();
  const resolution = $("resolution").value.trim();
  const errorEl = $("resolutionError");
  const missing = !resolution ? ["resolution", "Enter how the problem was resolved before saving."] : !incident ? ["incident", "Describe the problem (Step 1) before saving its solution."] : null;
  if (missing) {
    errorEl.textContent = missing[1];
    errorEl.style.display = "block";
    $(missing[0]).focus();
    return;
  }
  errorEl.style.display = "none";

  return withBusy("resolve", $("resolve"), "Saving to Hindsight…", async () => {
    hideBannerError();
    try {
      const res = await apiRequest("/api/resolve", { method: "POST", body: JSON.stringify({ incident, resolution }) });
      setStep(4, true);
      setPipeline({ pipelineSearch: "active", pipelineRecalled: "active", pipelineBetter: "active", pipelineSave: "highlighted" });
      $("savedResolutionPreview").textContent = `Stored as ${res.id}: “${resolution}”`;
      $("saveSuccessBox").style.display = "flex";
      showToast("Saved to Hindsight.", "success");
      await refreshStatus();
      setDemoState("saved", { id: res.id });
    } catch (err) {
      showToast("Could not save the solution.", "error");
      showBannerError(err);
    }
  });
});

// ============================================================
// DEMO EXAMPLE & RESET (screen only — Hindsight memories are kept)
// ============================================================

$("useDemoExample").addEventListener("click", () => {
  $("incident").value = DEFAULT_INCIDENT;
  $("incidentError").style.display = "none";
  showToast("Demo problem filled in.", "success");
});

$("resetDemo").addEventListener("click", () => {
  $("incident").value = DEFAULT_INCIDENT;
  $("resolution").value = DEFAULT_RESOLUTION;
  for (const id of ["incidentError", "resolutionError", "saveSuccessBox", "recommendationContent", "analysisLoading"]) $(id).style.display = "none";
  $("analysisEmpty").style.display = "flex";
  hideBannerError();
  $("recommendationContextBadge").textContent = "Awaiting analysis";
  $("recommendationContextBadge").className = "badge badge-subtle";
  $("recallBadge").textContent = "Not searched yet";
  $("recallBadge").className = "badge badge-subtle";
  $("memoriesList").innerHTML = emptyState("No search yet.", "Click <strong>Analyze problem</strong>. Anything Hindsight recalls from past solved problems appears here.");
  $("compareBeforeText").textContent = "MemoryOps can only suggest general troubleshooting steps.";
  $("compareAfterText").textContent = "MemoryOps can use a similar problem your team solved before.";
  $("compareBefore").style.opacity = "1";
  $("compareAfter").style.opacity = "1";
  state.lastGeneral = null;
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

refreshStatus();
