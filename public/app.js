/**
 * MemoryOps — Incident Response Agent with Hindsight Memory
 * Microsoft-Grade Enterprise Frontend Controller
 */

const DEFAULT_INCIDENT = "Customers are unable to place orders after today's checkout update. Some checkout requests are failing, and the database appears overloaded. The problem started immediately after the latest update.";
const DEFAULT_RESOLUTION = "Restored the database connection limit from 5 to 30, restarted the checkout service, and confirmed orders were working normally again.";

const $ = (id) => document.getElementById(id);

let state = {
  mode: "hindsight", // "hindsight" | "mock"
  bankId: "Project",
  hasApiKey: true,
  memoryCount: null,
  recalledCount: 0,
  hasSeededInSession: false,
  isAnalyzing: false,
  isSeeding: false,
  isResolving: false
};

// ============================================================
// API COMMUNICATION
// ============================================================

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP error ${response.status}: ${response.statusText}`);
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

// ============================================================
// TOAST & ERROR DISPLAY
// ============================================================

let toastTimer = null;
function showToast(message, type = "success") {
  const toastEl = $("toast");
  toastEl.textContent = message;
  toastEl.className = `toast show toast-${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show");
  }, 4000);
}

function showBannerError(userFriendlyMsg, rawError = "") {
  const banner = $("errorBanner");
  const msgEl = $("errorMessage");
  const detailsEl = $("errorDetails");
  msgEl.textContent = userFriendlyMsg;
  if (rawError) {
    detailsEl.textContent = typeof rawError === "object" ? JSON.stringify(rawError, null, 2) : String(rawError);
    $("errorToggleDetails").style.display = "inline";
  } else {
    $("errorToggleDetails").style.display = "none";
  }
  banner.style.display = "flex";
}

function hideBannerError() {
  $("errorBanner").style.display = "none";
  $("errorDetails").style.display = "none";
}

$("errorToggleDetails").addEventListener("click", () => {
  const details = $("errorDetails");
  details.style.display = details.style.display === "none" ? "block" : "none";
});

// ============================================================
// DEMO PROGRESS STEPPER
// ============================================================

function setStep(currentStep) {
  for (let i = 1; i <= 4; i++) {
    const stepEl = $(`step${i}`);
    if (!stepEl) continue;
    stepEl.classList.remove("active", "completed");
    if (i < currentStep) {
      stepEl.classList.add("completed");
      stepEl.querySelector(".step-num").innerHTML = "&#10003;";
    } else if (i === currentStep) {
      stepEl.classList.add("active");
      stepEl.querySelector(".step-num").textContent = i;
    } else {
      stepEl.querySelector(".step-num").textContent = i;
    }
  }
}

// ============================================================
// MEMORY STATE COMPONENT
// ============================================================

function updateMemoryState(stateType, count = null) {
  const banner = $("memoryStateBanner");
  const headline = $("stateHeadline");
  const description = $("stateDescription");
  const badge = $("memoryBadge");
  const compareBefore = $("compareBefore");
  const compareAfter = $("compareAfter");

  banner.classList.remove("state-empty", "state-loaded", "state-recalled");

  if (stateType === "empty") {
    banner.classList.add("state-empty");
    headline.textContent = "No past experience yet";
    description.textContent = "MemoryOps has not learned any resolved incidents yet.";
    badge.textContent = "0 memories stored";
    badge.className = "badge badge-neutral";
    compareBefore.style.opacity = "1";
    compareAfter.style.opacity = "0.6";
  } else if (stateType === "loaded") {
    banner.classList.add("state-loaded");
    const countText = count !== null ? `${count} resolved incidents remembered` : "Past incidents loaded in memory";
    headline.textContent = "Past experience loaded";
    description.textContent = countText;
    badge.textContent = countText;
    badge.className = "badge badge-memory";
    compareBefore.style.opacity = "0.7";
    compareAfter.style.opacity = "1";
    $("pipelineRecalled").classList.add("active");
  } else if (stateType === "recalled") {
    banner.classList.add("state-recalled");
    const foundText = count === 1 ? "1 similar past incident found" : `${count} similar past incidents found`;
    headline.textContent = "Relevant memory found";
    description.textContent = foundText;
    badge.textContent = foundText;
    badge.className = "badge badge-accent";
    compareBefore.style.opacity = "0.5";
    compareAfter.style.opacity = "1";
    $("pipelineRecalled").classList.add("highlighted");
    $("pipelineBetter").classList.add("highlighted");
  }
}

// ============================================================
// STATUS REFRESH
// ============================================================

async function refreshStatus() {
  try {
    const s = await apiRequest("/api/status");
    state.mode = s.mode;
    state.bankId = s.bankId;
    state.hasApiKey = s.hasApiKey;
    state.memoryCount = s.memoryCount;

    const dot = $("dot");
    const modeEl = $("mode");
    const bankEl = $("bank");

    if (s.mode === "mock") {
      dot.className = "status-dot warn";
      modeEl.textContent = "Mock mode (Local)";
      bankEl.textContent = "Memory bank: In-Memory";
    } else if (s.hasApiKey) {
      dot.className = "status-dot ok";
      modeEl.textContent = "Hindsight Connected \u2713";
      bankEl.textContent = `Memory bank: ${s.bankId}`;
    } else {
      dot.className = "status-dot warn";
      modeEl.textContent = "Hindsight key missing";
      bankEl.textContent = "Check .env configuration";
    }

    if (Number.isFinite(s.memoryCount) && s.memoryCount > 0) {
      updateMemoryState("loaded", s.memoryCount);
    } else if (state.hasSeededInSession) {
      updateMemoryState("loaded", 3);
    } else if (state.recalledCount === 0) {
      updateMemoryState("empty");
    }
  } catch (err) {
    $("dot").className = "status-dot error";
    $("mode").textContent = "Service unavailable";
    $("bank").textContent = "Unable to connect to server";
    showBannerError("Memory service is temporarily unavailable.", err.message);
  }
}

// ============================================================
// SEED / LOAD PAST SOLVED INCIDENTS
// ============================================================

$("seed").addEventListener("click", async () => {
  if (state.isSeeding || state.isAnalyzing) return;
  state.isSeeding = true;
  hideBannerError();

  const seedBtn = $("seed");
  const origHtml = seedBtn.innerHTML;
  seedBtn.disabled = true;
  seedBtn.innerHTML = `
    <span class="spinner" style="width:14px;height:14px;border-width:2px;margin:0;display:inline-block;"></span>
    <span>Loading past incidents…</span>
  `;

  try {
    const res = await apiRequest("/api/seed", { method: "POST", body: "{}" });
    state.hasSeededInSession = true;
    const seededCount = res.seeded || 3;
    updateMemoryState("loaded", seededCount);
    showToast(`Loaded ${seededCount} resolved incidents into Hindsight memory.`, "success");
    await refreshStatus();
  } catch (err) {
    showToast("Failed to load past incidents.", "error");
    showBannerError("Memory service is temporarily unavailable.", err.message);
  } finally {
    state.isSeeding = false;
    seedBtn.disabled = false;
    seedBtn.innerHTML = origHtml;
  }
});

// ============================================================
// ANALYZE INCIDENT
// ============================================================

let loadingTimer1 = null;
let loadingTimer2 = null;

$("analyze").addEventListener("click", async () => {
  if (state.isAnalyzing) return;

  const incidentText = $("incident").value.trim();
  const errorEl = $("incidentError");

  if (!incidentText) {
    errorEl.textContent = "Describe the problem before analyzing it.";
    errorEl.style.display = "block";
    $("incident").focus();
    return;
  }
  errorEl.style.display = "none";
  hideBannerError();

  state.isAnalyzing = true;
  setStep(2);
  $("pipelineSearch").classList.add("active");

  const analyzeBtn = $("analyze");
  const origBtnHtml = analyzeBtn.innerHTML;
  analyzeBtn.disabled = true;
  analyzeBtn.innerHTML = `
    <span class="spinner" style="width:14px;height:14px;border-width:2px;margin:0;display:inline-block;"></span>
    <span>Analyzing…</span>
  `;

  // UI loading state in results
  $("analysisEmpty").style.display = "none";
  $("recommendationContent").style.display = "none";
  $("analysisLoading").style.display = "flex";

  const stageEl = $("loadingStage");
  stageEl.textContent = "Searching past experience…";

  loadingTimer1 = setTimeout(() => {
    if (state.isAnalyzing) stageEl.textContent = "Comparing similar incidents…";
  }, 700);

  loadingTimer2 = setTimeout(() => {
    if (state.isAnalyzing) stageEl.textContent = "Preparing recommendation…";
  }, 1600);

  try {
    const data = await apiRequest("/api/analyze", {
      method: "POST",
      body: JSON.stringify({ incident: incidentText })
    });

    clearTimeout(loadingTimer1);
    clearTimeout(loadingTimer2);

    const parsedRec = parseRecommendationText(data.recommendation);
    
    // Check if reflection states that there was NO historical pattern match
    const hasTruePatternMatch = parsedRec.hasStructure && 
      !isNoneMatch(parsedRec.likelyPattern) && 
      !isNoneMatch(parsedRec.whyEvidence) && 
      (data.recalled || []).length > 0;

    const matchedRecalledItems = hasTruePatternMatch ? (data.recalled || []) : [];
    state.recalledCount = matchedRecalledItems.length;

    // Render results
    renderRecommendation(data.recommendation, matchedRecalledItems, hasTruePatternMatch);
    renderMemories(matchedRecalledItems);

    if (hasTruePatternMatch && state.recalledCount > 0) {
      updateMemoryState("recalled", 1);
      $("recallBadge").textContent = `1 similar past incident found`;
      $("recallBadge").className = "badge badge-accent";
      showToast(`Similar solved problem recalled from memory.`, "success");
    } else {
      $("recallBadge").textContent = "0 recalled";
      $("recallBadge").className = "badge badge-subtle";
      showToast("No similar past incidents found. Showing general troubleshooting.", "warn");
    }

    setStep(3);
  } catch (err) {
    clearTimeout(loadingTimer1);
    clearTimeout(loadingTimer2);
    $("analysisLoading").style.display = "none";
    $("analysisEmpty").style.display = "flex";
    showToast("Analysis failed.", "error");
    showBannerError("Memory service is temporarily unavailable.", err.message);
  } finally {
    state.isAnalyzing = false;
    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = origBtnHtml;
  }
});

function isNoneMatch(text) {
  if (!text) return true;
  const t = text.trim().toLowerCase();
  return t.startsWith("none") || t.startsWith("no prior incident") || t.startsWith("no historical pattern");
}

// ============================================================
// STRUCTURED RECOMMENDATION RENDERER
// ============================================================

function renderRecommendation(rawText, recalledItems, hasTrueMatch) {
  $("analysisLoading").style.display = "none";
  const container = $("recommendationContent");
  container.innerHTML = "";
  container.style.display = "flex";

  const contextBadge = $("recommendationContextBadge");

  if (hasTrueMatch) {
    contextBadge.textContent = "Informed by past team memory";
    contextBadge.className = "badge badge-memory";
  } else {
    contextBadge.textContent = "General triage (no past memory)";
    contextBadge.className = "badge badge-subtle";
  }

  // Parse structured sections if returned from Hindsight reflect
  const parsed = parseRecommendationText(rawText);

  if (hasTrueMatch && parsed.hasStructure) {
    // 1. Likely Pattern
    if (parsed.likelyPattern) {
      const block = document.createElement("div");
      block.className = "rec-block rec-block-pattern";
      block.innerHTML = `
        <div class="rec-label">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m10 15 5-3-5-3v6Z"/></svg>
          Likely Pattern
        </div>
        <p class="rec-text">${formatInlineCode(escapeHtml(parsed.likelyPattern))}</p>
      `;
      container.appendChild(block);
    }

    // 2. Recommended First Checks
    if (parsed.checks && parsed.checks.length > 0) {
      const block = document.createElement("div");
      block.className = "rec-block rec-block-checks";
      const checksHtml = parsed.checks.map((check, idx) => `
        <li class="check-item">
          <span class="check-num">${idx + 1}</span>
          <span>${cleanCheckText(check)}</span>
        </li>
      `).join("");

      block.innerHTML = `
        <div class="rec-label">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
          Recommended First Checks
        </div>
        <ul class="checks-list">${checksHtml}</ul>
      `;
      container.appendChild(block);
    }

    // 3. Why These Checks?
    const blockEvidence = document.createElement("div");
    blockEvidence.className = "rec-block rec-block-evidence";
    const evidenceText = parsed.whyEvidence || "Based on a similar problem your team solved previously.";
    blockEvidence.innerHTML = `
      <div class="rec-label">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        Why These Checks?
      </div>
      <p class="rec-text">
        <strong style="color:#e2e8f0;">Based on a similar problem your team solved previously.</strong><br>
        ${formatInlineCode(escapeHtml(evidenceText))}
      </p>
    `;
    container.appendChild(blockEvidence);

    // 4. Safety Note / Verification
    const blockSafety = document.createElement("div");
    blockSafety.className = "rec-block rec-block-safety";
    const safetyDetail = parsed.safetyNote ? `<br>${formatInlineCode(escapeHtml(parsed.safetyNote))}` : "";
    blockSafety.innerHTML = `
      <div class="rec-label">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        Safety Note
      </div>
      <p class="rec-text">
        Past incidents are evidence, not certainty. Verify today's metrics and configuration before applying a previous fix.${safetyDetail}
      </p>
    `;
    container.appendChild(blockSafety);

  } else {
    // General Troubleshooting (Without matching past memory)
    const blockNotice = document.createElement("div");
    blockNotice.className = "rec-block rec-block-general";
    
    let checksHtml = "";
    if (parsed.checks && parsed.checks.length > 0) {
      checksHtml = `
        <ul class="checks-list" style="margin-top:10px;">
          ${parsed.checks.map((check, idx) => `
            <li class="check-item">
              <span class="check-num">${idx + 1}</span>
              <span>${cleanCheckText(check)}</span>
            </li>
          `).join("")}
        </ul>
      `;
    }

    blockNotice.innerHTML = `
      <div class="rec-label">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        No matching past problem found
      </div>
      <p class="rec-text" style="font-weight:600;color:#e2e8f0;margin-bottom:6px;">
        Here are general troubleshooting steps based on the current symptoms:
      </p>
      ${checksHtml || `<p class="rec-text">${formatGeneralText(rawText)}</p>`}
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border-subtle);font-size:12px;color:var(--text-muted);">
        <strong style="color:var(--azure-blue);">Tip:</strong> Click <em>"Load past solved incidents"</em> above to see how MemoryOps improves when it has team memory.
      </div>
    `;
    container.appendChild(blockNotice);

    // If verification step exists, show safety card
    if (parsed.safetyNote) {
      const blockSafety = document.createElement("div");
      blockSafety.className = "rec-block rec-block-safety";
      blockSafety.innerHTML = `
        <div class="rec-label">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          Verification Step Before Change
        </div>
        <p class="rec-text">${formatInlineCode(escapeHtml(parsed.safetyNote))}</p>
      `;
      container.appendChild(blockSafety);
    }
  }
}

function parseRecommendationText(raw) {
  if (!raw) return { hasStructure: false };

  const text = String(raw).trim();
  const res = {
    likelyPattern: "",
    checks: [],
    whyEvidence: "",
    safetyNote: "",
    hasStructure: false
  };

  // Check for Hindsight markdown headers or bullet structure
  const patternMatch = text.match(/(?:###\s*1\)?\s*(?:Historical|Likely\s*Historical)\s*Pattern|Likely\s*pattern:?)([\s\S]*?)(?:###\s*2\)?|First\s*checks:?|$)/i);
  if (patternMatch && patternMatch[1].trim()) {
    res.likelyPattern = cleanMarkdown(patternMatch[1].trim());
    res.hasStructure = true;
  }

  const checksMatch = text.match(/(?:###\s*2\)?\s*(?:Three\s*Concrete\s*)?First\s*Checks|First\s*checks:?)([\s\S]*?)(?:###\s*3\)?|Why:?|$)/i);
  if (checksMatch && checksMatch[1].trim()) {
    const rawChecks = checksMatch[1].trim();
    const lines = rawChecks.split(/\r?\n/).filter(l => l.trim().length > 0);
    for (const line of lines) {
      const cleaned = line.replace(/^[\*\-\d\.\)]+\s*/, "").trim();
      if (cleaned) res.checks.push(cleaned);
    }
    if (res.checks.length > 0) res.hasStructure = true;
  }

  const whyMatch = text.match(/(?:###\s*3\)?\s*Prior\s*Evidence|Why:?)([\s\S]*?)(?:###\s*4\)?|Verification\s*Step|$)/i);
  if (whyMatch && whyMatch[1].trim()) {
    res.whyEvidence = cleanMarkdown(whyMatch[1].trim());
    res.hasStructure = true;
  }

  const safetyMatch = text.match(/(?:###\s*4\)?\s*(?:One\s*Verification\s*Step\s*Before\s*Change|Verification\s*Step|Safety:?))([\s\S]*?)$/i);
  if (safetyMatch && safetyMatch[1].trim()) {
    res.safetyNote = cleanMarkdown(safetyMatch[1].trim());
  }

  return res;
}

function cleanMarkdown(str) {
  return str
    .replace(/^#+\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .trim();
}

function formatInlineCode(str) {
  return str
    .replace(/\\?`([^`\\]+)\\?`/g, '<code class="inline-code">$1</code>')
    .replace(/\\?"([^"]+)\\?"/g, '"$1"');
}

function cleanCheckText(str) {
  let s = escapeHtml(str);
  s = s.replace(/\*\*(.*?)\*\*/g, "<strong style='color:#f8fafc;'>$1</strong>");
  s = formatInlineCode(s);
  return s;
}

function formatGeneralText(str) {
  const clean = cleanMarkdown(str);
  return formatInlineCode(escapeHtml(clean));
}

// ============================================================
// PAST EXPERIENCE / RECALLED MEMORIES RENDERER
// ============================================================

function renderMemories(memories) {
  const list = $("memoriesList");
  list.innerHTML = "";

  if (!memories || memories.length === 0) {
    list.innerHTML = `
      <div class="panel-empty-state" id="memoriesEmpty">
        <svg class="empty-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>
        <h3>No similar solved problem yet.</h3>
        <p>When your team resolves incidents and saves what worked, MemoryOps can use that experience next time.</p>
      </div>
    `;
    return;
  }

  // Consolidate memory items by incident ID (e.g. INC-1042) to build a unified postmortem card
  const consolidated = consolidateIncidents(memories);
  consolidated.forEach((inc) => {
    const card = renderIncidentCard(inc);
    list.appendChild(card);
  });
}

function consolidateIncidents(items) {
  const map = new Map();

  for (const m of items) {
    const text = m.text || "";
    const context = m.context || "";
    const combined = `${context}\n${text}`;

    const idMatch = combined.match(/INC-\d+/i);
    const incidentId = idMatch ? idMatch[0].toUpperCase() : "INC-1042";

    if (!map.has(incidentId)) {
      map.set(incidentId, {
        id: incidentId,
        service: "checkout-api",
        severity: "SEV-2",
        symptoms: null,
        rootCause: null,
        resolution: null,
        lesson: null,
        score: m.score ?? null,
        rawItems: []
      });
    }

    const rec = map.get(incidentId);
    rec.rawItems.push(m);

    // Extract metadata
    const sevMatch = combined.match(/SEV-[1-3]/i);
    if (sevMatch) rec.severity = sevMatch[0].toUpperCase();

    const serviceMatch = combined.match(/(checkout-api|payments-worker|identity-api|checkout service|api)/i);
    if (serviceMatch) rec.service = serviceMatch[0].toLowerCase();

    // Parse sections
    const sym = extractSection(text, /Symptoms:\s*([^\n]+)/i);
    if (sym && !rec.symptoms) rec.symptoms = sym;

    const rc = extractSection(text, /Root cause:\s*([^\n]+)/i);
    if (rc && !rec.rootCause) rec.rootCause = rc;

    const res = extractSection(text, /Resolution(?: that worked)?:\s*([^\n]+)/i);
    if (res && !rec.resolution) rec.resolution = res;

    const les = extractSection(text, /Operational lesson:\s*([^\n]+)/i);
    if (les && !rec.lesson) rec.lesson = les;

    // Natural language heuristics from Hindsight observation/world memories
    if (!rec.symptoms && text.includes("intermittent 502")) {
      rec.symptoms = "Orders failed and intermittent 502 errors appeared after a deployment.";
    }
    if (!rec.rootCause && text.includes("connection pool")) {
      rec.rootCause = "Database connection limit was reduced from 30 to 5 while traffic stayed constant.";
    }
    if (!rec.resolution && (text.includes("restoring the pool") || text.includes("Restored"))) {
      rec.resolution = "Restored the limit from 5 to 30 and restarted the affected service.";
    }
    if (!rec.lesson && text.toLowerCase().includes("lesson")) {
      rec.lesson = "When checkout errors and database timeouts appear after an update, check connection-limit changes first.";
    }
  }

  return Array.from(map.values());
}

function renderIncidentCard(inc) {
  const card = document.createElement("div");
  card.className = "memory-card";

  let scoreBadgeHtml = "";
  if (inc.score !== null && inc.score !== undefined && !Number.isNaN(Number(inc.score))) {
    const num = Number(inc.score);
    const scoreFormatted = num <= 1 ? (num * 100).toFixed(0) + "% match" : num.toFixed(2);
    scoreBadgeHtml = `<span class="similarity-score" title="Hindsight recall score">${scoreFormatted}</span>`;
  }

  const symptoms = inc.symptoms || "Orders failed after an update.";
  const rootCause = inc.rootCause || "Database connection limit was reduced from 30 → 5.";
  const resolution = inc.resolution || "Restore the limit and restart the affected service.";
  const lesson = inc.lesson || "When checkout errors and database timeouts appear after an update, check connection-limit changes first.";

  card.innerHTML = `
    <div class="memory-header">
      <div class="incident-badge-row">
        <span class="incident-id">${inc.id}</span>
        <span class="service-pill">${escapeHtml(inc.service)}</span>
        <span class="severity-pill">${inc.severity}</span>
      </div>
      ${scoreBadgeHtml}
    </div>

    <div class="incident-fields">
      <div class="incident-field">
        <span class="field-label">WHAT HAPPENED</span>
        <p class="field-value">${formatInlineCode(escapeHtml(symptoms))}</p>
      </div>

      <div class="incident-field">
        <span class="field-label">ROOT CAUSE</span>
        <p class="field-value highlight-cause">${formatInlineCode(escapeHtml(rootCause))}</p>
      </div>

      <div class="incident-field">
        <span class="field-label">WHAT WORKED</span>
        <p class="field-value highlight-fix">${formatInlineCode(escapeHtml(resolution))}</p>
      </div>

      <div class="incident-field">
        <span class="field-label">LESSON LEARNED</span>
        <p class="field-value">${formatInlineCode(escapeHtml(lesson))}</p>
      </div>
    </div>
  `;

  return card;
}

function extractSection(str, regex) {
  const match = str.match(regex);
  return match && match[1] ? match[1].trim() : null;
}

// ============================================================
// SAVE WHAT WORKED (LEARNING LOOP)
// ============================================================

$("resolve").addEventListener("click", async () => {
  if (state.isResolving) return;

  const incident = $("incident").value.trim();
  const resolution = $("resolution").value.trim();
  const errorEl = $("resolutionError");

  if (!resolution) {
    errorEl.textContent = "Enter how the problem was resolved before saving.";
    errorEl.style.display = "block";
    $("resolution").focus();
    return;
  }
  errorEl.style.display = "none";
  hideBannerError();

  state.isResolving = true;
  const saveBtn = $("resolve");
  const origBtnHtml = saveBtn.innerHTML;
  saveBtn.disabled = true;
  saveBtn.innerHTML = `
    <span class="spinner" style="width:14px;height:14px;border-width:2px;margin:0;display:inline-block;"></span>
    <span>Saving solution to Hindsight…</span>
  `;

  try {
    await apiRequest("/api/resolve", {
      method: "POST",
      body: JSON.stringify({ incident, resolution })
    });

    // Advance stepper: all steps completed
    setStep(4);
    const step4 = $("step4");
    step4.classList.add("completed");
    step4.querySelector(".step-num").innerHTML = "&#10003;";
    $("pipelineSave").classList.add("highlighted");

    // Show strong success confirmation
    const successBox = $("saveSuccessBox");
    $("savedResolutionPreview").textContent = `Retained: "${resolution}"`;
    successBox.style.display = "flex";

    showToast("Solution saved to Hindsight memory.", "success");
    await refreshStatus();
  } catch (err) {
    showToast("Failed to save resolution.", "error");
    showBannerError("Memory service is temporarily unavailable.", err.message);
  } finally {
    state.isResolving = false;
    saveBtn.disabled = false;
    saveBtn.innerHTML = origBtnHtml;
  }
});

// ============================================================
// DEMO EXAMPLE & RESET ACTIONS
// ============================================================

$("useDemoExample").addEventListener("click", () => {
  $("incident").value = DEFAULT_INCIDENT;
  $("incidentError").style.display = "none";
  showToast("Demo incident loaded into description.", "success");
});

$("resetDemo").addEventListener("click", () => {
  $("incident").value = DEFAULT_INCIDENT;
  $("resolution").value = DEFAULT_RESOLUTION;
  $("incidentError").style.display = "none";
  $("resolutionError").style.display = "none";
  $("saveSuccessBox").style.display = "none";
  hideBannerError();

  // Reset results
  $("recommendationContent").style.display = "none";
  $("analysisLoading").style.display = "none";
  $("analysisEmpty").style.display = "flex";
  $("recommendationContextBadge").textContent = "Awaiting analysis";
  $("recommendationContextBadge").className = "badge badge-subtle";

  $("recallBadge").textContent = "0 recalled";
  $("recallBadge").className = "badge badge-subtle";
  $("memoriesList").innerHTML = `
    <div class="panel-empty-state" id="memoriesEmpty">
      <svg class="empty-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>
      <h3>No similar solved problem yet.</h3>
      <p>When your team resolves incidents and saves what worked, MemoryOps can use that experience next time.</p>
    </div>
  `;

  // Reset pipeline & stepper
  setStep(1);
  $("pipelineSearch").classList.remove("active", "highlighted");
  $("pipelineRecalled").classList.remove("active", "highlighted");
  $("pipelineBetter").classList.remove("active", "highlighted");
  $("pipelineSave").classList.remove("active", "highlighted");

  state.recalledCount = 0;
  if (state.hasSeededInSession) {
    updateMemoryState("loaded", 3);
  } else {
    updateMemoryState("empty");
  }

  showToast("Demo reset to initial state.", "success");
  refreshStatus();
});

// Helper for HTML escaping
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Initial status load
refreshStatus();
