/**
 * MemoryOps frontend.
 * Everything shown as memory comes from the server's real Hindsight recall/reflect results and
 * MemoryOps' deterministic evidence reasoning. Nothing here invents matches, numbers or fixes.
 */

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
const VERIFY_FIRST = "Past incidents are evidence, not certainty. Verify today's system before applying a previous fix.";
const $ = (id) => document.getElementById(id);
const show = (el, on = true) => { if (el) el.hidden = !on; };

const state = {
  connected: false,
  documents: null,
  counts: null,
  demoState: "ready",
  analyses: 0,
  lastAnalysis: null,
  hypotheses: [],
  observations: [],
  observationHint: "",
  nextBestCheck: null,
  suggestedFix: null,
  busy: { analyze: false, seed: false, resolve: false }
};

// ------------------------------------------------------------ API

async function apiRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  } catch {
    throw Object.assign(new Error("Cannot reach the MemoryOps server. Is it still running?"), { code: "server_unreachable" });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status}).`), { status: response.status, code: data.code, detail: data.detail });
  return data;
}

// ------------------------------------------------------------ Toast, error banner

let toastTimer = null;
function showToast(message, type = "success") {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast show toast-${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3600);
}

function showBannerError(err) {
  $("errorMessage").textContent = err.message || "Memory service error.";
  const detail = [err.code, err.detail].filter(Boolean).join(": ");
  $("errorDetails").textContent = detail;
  show($("errorToggleDetails"), Boolean(detail));
  show($("errorBanner"));
  setDemoState("error", { message: err.message });
}
function hideBannerError() { show($("errorBanner"), false); show($("errorDetails"), false); }
$("errorToggleDetails").addEventListener("click", () => { const d = $("errorDetails"); d.hidden = !d.hidden; });

// ------------------------------------------------------------ Steps, loop, log

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

// ------------------------------------------------------------ Status (rail)

const STATES = {
  ready: { tone: "", headline: "Ready", text: () => "Describe today's problem, then analyze it." },
  memory_available: { tone: "memory", headline: "Past experience available", text: () => `${countLabel(state.documents)} in this Hindsight bank.` },
  no_experience: { tone: "", headline: "No similar experience found", text: (x) => x.searched ? "Hindsight searched team memory, but nothing matched closely enough to rely on." : "This team has not solved a closely related problem yet." },
  match_found: { tone: "memory", headline: "Similar experience recalled", text: (x) => `Hindsight recalled ${x.id}, but the recommendation step failed: ${x.message}` },
  recommendation_ready: { tone: "memory", headline: "Memory used", text: (x) => `Recommendation based on ${x.id}, a problem your team solved before.` },
  saved: { tone: "memory", headline: "Experience learned", text: (x) => `${x.id} is stored in Hindsight and can help next time.` },
  error: { tone: "error", headline: "Memory service error", text: (x) => x.message }
};

function countLabel(n) {
  if (!Number.isFinite(n)) return "Past experience";
  return n === 1 ? "1 memory" : `${n} memories`;
}

function setDemoState(key, extra = {}) {
  const def = STATES[key];
  state.demoState = key;
  const box = $("memoryStateBanner");
  box.dataset.tone = def.tone;
  $("stateHeadline").textContent = def.headline;
  $("stateDescription").textContent = def.text(extra);
}

function setStat(id, value) { $(id).textContent = Number.isFinite(value) ? String(value) : "—"; }

function renderCounts() {
  const c = state.counts || {};
  setStat("statHistorical", c.historical);
  setStat("statLearned", c.learned);
  setStat("statPatterns", c.patterns);
  const badge = $("memoryBadge");
  if (!state.connected) badge.textContent = "Memory unavailable";
  else if (Number.isFinite(state.documents)) badge.textContent = state.documents ? `${countLabel(state.documents)}` : "Memory is empty";
  else badge.textContent = "";
}

async function refreshStatus() {
  try {
    const s = await apiRequest("/api/status");
    state.connected = s.connected;
    state.documents = s.documents;
    state.counts = s.counts || null;
    const dot = $("dot");
    if (s.connected) {
      dot.className = "status-dot ok";
      $("mode").textContent = "Hindsight connected";
      $("bank").textContent = `${s.bankId}${s.pendingOperations > 0 ? ` · processing ${s.pendingOperations}` : ""}`;
    } else if (!s.hasApiKey) {
      dot.className = "status-dot warn";
      $("mode").textContent = "Hindsight key missing";
      $("bank").textContent = "Add HINDSIGHT_API_KEY to .env";
    } else {
      dot.className = "status-dot error";
      $("mode").textContent = "Hindsight not reachable";
      $("bank").textContent = s.bankId || "";
    }
    renderCounts();
    if (state.demoState === "ready" || state.demoState === "memory_available") setDemoState(state.documents > 0 ? "memory_available" : "ready");
    if (!s.connected && s.hasApiKey) showBannerError({ message: s.error || "Hindsight is not reachable.", code: s.code });
  } catch (err) {
    $("dot").className = "status-dot error";
    $("mode").textContent = "Server unavailable";
    $("bank").textContent = "";
    showBannerError(err);
  }
}

// ------------------------------------------------------------ Busy buttons

async function withBusy(key, btn, label, fn) {
  if (state.busy[key]) return;
  state.busy[key] = true;
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.innerHTML = `<span class="pulse" aria-hidden="true"></span><span>${label}</span>`;
  try { await fn(); } finally {
    state.busy[key] = false;
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.innerHTML = original;
  }
}

// ------------------------------------------------------------ Load sample history

$("seed").addEventListener("click", () => withBusy("seed", $("seed"), "Storing…", async () => {
  hideBannerError();
  try {
    const res = await apiRequest("/api/seed", { method: "POST", body: "{}" });
    showToast(`Stored ${res.seeded} sample resolved incidents in Hindsight.`);
    logLearning(`Loaded ${res.seeded} sample resolved incidents`);
    await refreshStatus();
    if (!["recommendation_ready", "match_found", "saved"].includes(state.demoState)) setDemoState("memory_available");
  } catch (err) {
    showToast("Could not store sample incidents.", "error");
    showBannerError(err);
  }
}));

// ------------------------------------------------------------ Analyze

let stageTimer = null;
function startStages() {
  const items = [...document.querySelectorAll("#analysisLoading li")];
  items.forEach((li) => li.classList.remove("is-active", "is-done"));
  let i = 0;
  items[0].classList.add("is-active");
  show($("analysisLoading"));
  clearInterval(stageTimer);
  // Stages describe what the pipeline does; the last stays active until the answer arrives (no fake %).
  stageTimer = setInterval(() => {
    if (i >= items.length - 1) return clearInterval(stageTimer);
    items[i].classList.replace("is-active", "is-done");
    items[++i].classList.add("is-active");
  }, 850);
}
function stopStages() { clearInterval(stageTimer); show($("analysisLoading"), false); }

function analyze() {
  const text = $("incident").value.trim();
  if (!text) {
    $("incidentError").textContent = "Describe what is happening first.";
    show($("incidentError"));
    $("incident").focus();
    return;
  }
  show($("incidentError"), false);

  return withBusy("analyze", $("analyze"), "Analyzing…", async () => {
    hideBannerError();
    setStep(2);
    setPipeline({ learnProblem: "active" });
    show($("analysisEmpty"), false);
    show($("results"), false);
    startStages();

    try {
      const data = await apiRequest("/api/analyze", { method: "POST", body: JSON.stringify({ incident: text }) });
      stopStages();
      const rec = data.recommendation;
      const matched = rec?.memoryUsed ? data.matches.find((m) => m.incidentId === rec.matchedIncidentId) : null;
      if (state.lastAnalysis?.incident !== text) state.observations = [];
      state.hypotheses = data.evidence?.hypotheses || [];
      state.analyses += 1;
      state.lastAnalysis = { incident: text, matchedId: matched?.incidentId || null };
      setStat("statRelevant", data.evidence ? data.evidence.relevant.length : data.matches.length);
      renderObservations();
      renderResults(data, matched);
      show($("learnSection"));
      setStep(3);
      const n = state.analyses;

      if (data.state === "recommendation_ready" && matched) {
        setDemoState("recommendation_ready", { id: matched.incidentId });
        setPipeline({ learnProblem: "active", learnRecalled: "highlighted", ...(matched.learned ? { learnFuture: "highlighted" } : {}) });
        const origin = matched.learned ? ", learned from a previous resolution" : matched.verified ? ", confirmed" : "";
        logLearning(`Analysis ${n}: <strong>1 relevant resolved incident recalled</strong> (${esc(matched.incidentId)}${origin})`);
      } else if (data.state === "match_found") {
        setDemoState("match_found", { id: data.matches[0]?.incidentId, message: data.reflectError?.message || "unknown error" });
        setPipeline({ learnProblem: "active", learnRecalled: "highlighted" });
        logLearning(`Analysis ${n}: ${data.matches.length} memories recalled; recommendation step failed`);
      } else {
        setDemoState("no_experience", { searched: data.matches.length > 0 });
        setPipeline({ learnProblem: "active" });
        logLearning(data.matches.length
          ? `Analysis ${n}: ${data.matches.length} memories recalled, <strong>none judged similar</strong>`
          : `Analysis ${n}: <strong>0 relevant memories recalled</strong>`);
      }
      $("results").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    } catch (err) {
      stopStages();
      show($("analysisEmpty"));
      setStep(1);
      setPipeline({});
      showToast("Analysis failed.", "error");
      showBannerError(err);
    }
  });
}
$("analyze").addEventListener("click", analyze);
$("incident").addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") analyze(); });

// ------------------------------------------------------------ Result rendering

const LEVEL_TEXT = {
  HIGH: "Several confirmed incidents agree with today's facts.",
  MEDIUM: "Supported by confirmed history, with some uncertainty.",
  LOW: "Weak or unconfirmed historical evidence.",
  INSUFFICIENT: "No relevant historical evidence."
};

const section = (key, title, body, extra = "") => `<section class="r-section r-${key}" ${extra}><h3 class="r-title">${esc(title)}</h3>${body}</section>`;
const list = (items) => `<ul class="r-list">${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
const numbered = (items) => `<ol class="r-checks">${items.map((t, i) => `<li><span class="n">${i + 1}</span><span>${esc(t)}</span></li>`).join("")}</ol>`;

function confidenceHtml(ev) {
  if (!ev) return "";
  const c = ev.confidence;
  return `<div class="conf conf-${c.level.toLowerCase()}">
    <span class="conf-label">Memory confidence</span>
    <span class="conf-chip">${c.level}</span>
    <span class="conf-text">${esc(LEVEL_TEXT[c.level])}</span>
  </div>${c.statement ? `<p class="abstain">${esc(c.statement)}</p>` : ""}`;
}

function conflictHtml(ev) {
  if (!ev?.conflicts?.detected) return "";
  const rows = ev.conflicts.causes.map((c) => `<li><span>${esc(c.cause)}</span><span class="muted">${c.incidents.length} previous incident${c.incidents.length > 1 ? "s" : ""} · ${c.incidents.map(esc).join(", ")}</span></li>`).join("");
  return section("conflict", "Multiple historical explanations", `<p class="r-text">Similar symptoms had different confirmed causes. Treat these as possibilities, not an answer.</p><ul class="conflict-list">${rows}</ul>`);
}

function memoryCardHtml(m) {
  const f = m.fields || {};
  const failed = f.attempted ? `<div class="mc-row"><dt>Did not work</dt><dd class="bad">${esc(f.attempted)}</dd></div>` : "";
  const partial = f.partial ? `<div class="mc-row"><dt>Helped only partly</dt><dd>${esc(f.partial)}</dd></div>` : "";
  const cause = f.cause
    ? `<div class="mc-row"><dt>Cause</dt><dd>${esc(f.cause)}</dd></div>`
    : f.suspectedCause ? `<div class="mc-row"><dt>Suspected cause</dt><dd>${esc(f.suspectedCause)} <span class="muted">(not confirmed)</span></dd></div>` : "";
  const body = m.fields
    ? `<dl class="mc-rows">${cause}${f.worked ? `<div class="mc-row"><dt>Worked</dt><dd class="good">${esc(f.worked)}</dd></div>` : ""}${failed}${partial}</dl>`
    : list(m.facts);
  const meta = [f.area, m.verified ? (m.learned ? "Human-confirmed" : "Resolved") : null, Number.isFinite(m.score) ? `relevance ${m.score.toFixed(2)}` : null].filter(Boolean);
  return `<article class="memory-card">
    <div class="mc-eyebrow">${m.learned ? "Learned from a past incident resolved by this team" : "Recalled from team memory"}</div>
    <div class="mc-head"><span class="mc-id">${esc(m.incidentId)}</span><span class="mc-meta">${meta.map(esc).join(" · ")}</span></div>
    <p class="mc-title">${esc(f.title || f.happened || m.facts[0] || "")}</p>
    ${body}
    ${f.lesson ? `<p class="mc-lesson"><span>Lesson</span>${esc(f.lesson)}</p>` : ""}
    ${m.feedback?.length ? `<p class="mc-feedback">Team feedback: ${m.feedback.map((x) => esc(x.verdict)).join(", ")}</p>` : ""}
  </article>`;
}

function fixHtml(fix, level) {
  state.suggestedFix = fix || null;
  if (!fix) return "";
  const lines = fix.diff.split("\n").map((l) => `<span class="dl ${l.startsWith("+") ? "add" : "del"}"><span class="sign">${esc(l[0])}</span>${esc(l.slice(2))}</span>`).join("");
  return `<section class="r-section r-fix" id="fixBlock">
    <div class="fix">
      <div class="fix-bar"><span class="fix-kind">Suggested fix · config</span><button class="copy" type="button" id="copyFix" aria-label="Copy suggested change">Copy</button></div>
      <pre class="fix-code"><code>${lines}</code></pre>
      <dl class="fix-meta">
        <div><dt>Based on</dt><dd>${esc(fix.source.incidentId)}${fix.source.learned ? " · learned" : ""}</dd></div>
        <div><dt>Confidence</dt><dd>${esc(level)}</dd></div>
        <div class="wide"><dt>Verify first</dt><dd>${esc(fix.verify || "Compare today's value with the last known-good configuration.")}</dd></div>
      </dl>
      <p class="fix-note">${esc(fix.note)} Review before applying; MemoryOps never runs anything.</p>
      <p class="fix-setaside" hidden>Set aside: your observations do not support this cause.</p>
    </div>
  </section>`;
}

function diagnosisHtml() {
  const hyps = state.hypotheses || [];
  const next = state.nextBestCheck;
  const hypList = hyps.length ? `<details class="disclosure"><summary>Current hypotheses (${hyps.length})</summary><ul class="hyps">${hyps.map((h) => `
    <li class="hyp is-${h.status.replace(" ", "-")}">
      <div class="hyp-head"><span>${esc(h.hypothesis)}</span><span class="tag">${h.confidence}</span><span class="tag tag-quiet">${esc(h.status)}</span></div>
      <div class="muted">Past example: ${esc(h.example_cause || "")} · ${h.supporting_memories.map((m) => esc(m.id)).join(", ")}</div>
      ${h.observations_for?.length ? `<div class="good">Supported by: ${h.observations_for.map(esc).join("; ")}</div>` : ""}
      ${h.evidence_against?.length ? `<div class="bad">Against: ${h.evidence_against.map(esc).join("; ")}</div>` : ""}
    </li>`).join("")}</ul></details>` : "";
  const body = next
    ? `<p class="next">${esc(next.text)}</p>${next.expected_if_true ? `<p class="muted">Expected if true: ${esc(next.expected_if_true)}</p>` : ""}`
    : `<p class="r-text">No remembered cause to test yet. Record what you check; it stays in this session.</p>`;
  return `${body}${hypList}
    <div class="obs"><input id="observationInput" type="text" spellcheck="false" placeholder="What did you observe? e.g. ${esc(state.observationHint || "Current pool is 5; previous version was 30")}" aria-label="Your observation" />
    <button class="btn btn-quiet btn-sm" type="button" id="addObservation">Record</button></div>
    <p class="muted small">Observations are session-only and saved only if you confirm the outcome.</p>`;
}

function teamHtml(team) {
  if (!team) return "";
  let html = "";
  for (const p of team.patterns || []) {
    html += `<section class="r-section r-insight"><div class="insight">
      <div class="insight-k">Team has learned</div>
      <p class="insight-text">${esc(p.statement)}</p>
      <p class="muted">Based on ${p.supporting_incidents.length} confirmed incidents${p.counterexamples.length ? ` · Exception${p.counterexamples.length > 1 ? "s" : ""}: ${p.counterexamples.map((c) => `${esc(c.id)} (${esc(c.cause.toLowerCase())})`).join(", ")}` : ""}</p>
    </div></section>`;
  }
  const b = team.playbook;
  if (b) {
    html += `<details class="disclosure r-section"><summary>Team playbook: ${esc(b.title)} <span class="muted">· learned from ${b.learned_from} confirmed incidents</span></summary>
      <ol class="playbook">${b.steps.map((st) => `<li><span>${esc(st.step)}</span><span class="muted">${esc(st.why)} (${st.supporting_incidents.map(esc).join(", ")})</span></li>`).join("")}</ol>
      ${b.cautions.map((c) => `<p class="bad small">${esc(c.text)}</p>`).join("")}
    </details>`;
  }
  return html;
}

function advancedHtml(data, matched) {
  const others = data.matches.filter((m) => m !== matched);
  const ev = data.evidence;
  const parts = [];
  if (others.length) parts.push(`<h4>Also recalled by Hindsight</h4><ul class="r-list">${others.map((m) => `<li><span class="mono">${esc(m.incidentId)}</span> ${esc(m.fields?.title || m.facts[0] || "")}</li>`).join("")}</ul>`);
  if (ev?.confidence?.reasons?.length) parts.push(`<h4>How confidence was decided</h4>${list(ev.confidence.reasons)}`);
  if (data.recommendation?.suppressed?.length) parts.push(`<h4>Removed suggestions</h4>${list(data.recommendation.suppressed.map((s) => `${s.check}: ${s.because}`))}`);
  if (matched) parts.push(`<h4>What Hindsight returned for ${esc(matched.incidentId)}</h4>${list(matched.facts)}<p class="mono muted small">document_id: ${esc(matched.documentId || "")}</p>`);
  return parts.length ? `<details class="disclosure r-section"><summary>Advanced details</summary><div class="advanced">${parts.join("")}</div></details>` : "";
}

function renderResults(data, matched) {
  const rec = data.recommendation;
  const ev = data.evidence;
  state.nextBestCheck = ev?.nextBestCheck || null;
  state.suggestedFix = null;
  const level = ev?.confidence?.level || "INSUFFICIENT";
  let html = confidenceHtml(ev) + conflictHtml(ev);

  if (!rec) {
    html += section("thinks", "What MemoryOps thinks", `<p class="r-text">${esc(data.reflectError?.message || "The recommendation step failed.")} The recalled memory below is still real; try again.</p>`);
    if (data.matches[0]) html += section("before", "What happened before", memoryCardHtml(data.matches[0]));
  } else if (matched) {
    const thinks = rec.structured
      ? `${rec.pattern ? `<p class="lead">${esc(rec.pattern)}</p>` : ""}${rec.checks?.length ? `<h4>What to check first</h4>${numbered(rec.checks)}` : ""}`
      : `<p class="r-text pre">${esc(rec.text)}</p>`;
    html += section("thinks", "What MemoryOps thinks", thinks);
    html += section("before", "What happened before", memoryCardHtml(matched));
    if (ev?.failedBefore?.length) html += section("failed", "What did not work before", list(ev.failedBefore.map((f) => f.text)));
  } else {
    html += section("thinks", "No similar experience found", `<p class="r-text">${data.matches.length ? "Hindsight searched team memory, but nothing it recalled resembles this problem closely enough to rely on." : "This team has not solved a closely related problem yet."} MemoryOps will learn once the team confirms what solved this incident.</p>
      ${rec.checks?.length ? `<h4>General first steps (not from memory)</h4>${numbered(rec.checks)}` : rec.text ? `<p class="r-text pre">${esc(rec.text)}</p>` : ""}`);
  }

  if (ev) html += section("next", "Next best check", `<div id="diagnosisBox">${diagnosisHtml()}</div>`);
  if (matched) html += fixHtml(data.suggestedFix, level);
  if (matched && ev?.why?.reasons?.length) {
    html += section("why", "Why MemoryOps suggests this", `${list(ev.why.reasons)}<p class="muted">Supporting: ${ev.why.supporting.map((id) => `<span class="mono">${esc(id)}</span>`).join(", ")}</p>`);
  }
  html += teamHtml(data.team);
  html += `<p class="verify"><span>Verify first</span>${esc(VERIFY_FIRST)}${rec?.safety ? ` ${esc(rec.safety)}` : ""}</p>`;
  html += advancedHtml(data, matched);
  if (matched) {
    html += `<div class="feedback" id="feedbackRow"><span>Was this past incident useful?</span>
      <button class="chip" type="button" data-helpful="true">Helpful</button>
      <button class="chip" type="button" data-helpful="false">Not relevant</button></div>`;
  }
  const container = $("recommendationContent");
  container.innerHTML = html;
  show($("results"));
}

function renderObservations() {
  const box = $("sessionObservations");
  box.innerHTML = state.observations.length
    ? `<span class="field-label-ui">Observations this session <span class="muted">(saved only if you confirm)</span></span><ul class="r-list">${state.observations.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>`
    : "";
}

function updateFixForHypotheses() {
  const blockEl = document.getElementById("fixBlock");
  const fix = state.suggestedFix;
  if (!blockEl || !fix?.hypothesisId) return;
  const h = state.hypotheses.find((x) => x.id === fix.hypothesisId);
  const setAside = Boolean(h && (h.status === "weakened" || h.status === "ruled out"));
  blockEl.classList.toggle("is-set-aside", setAside);
  blockEl.querySelector(".fix-setaside").hidden = !setAside;
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
      logLearning(`Observation recorded → leading hypothesis: <strong>${esc(r.hypotheses[0].hypothesis)}</strong> (${esc(r.hypotheses[0].status)})`);
    } catch (err) {
      showToast("Could not update hypotheses.", "error");
      showBannerError(err);
    }
  } else {
    logLearning("Observation recorded (session only)");
  }
  $("diagnosisBox").innerHTML = diagnosisHtml();
  updateFixForHypotheses();
}

$("recommendationContent").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "observationInput") addObservation(); });
$("recommendationContent").addEventListener("click", async (e) => {
  if (e.target.closest("#addObservation")) return addObservation();

  const copy = e.target.closest("#copyFix");
  if (copy && state.suggestedFix) {
    try { await navigator.clipboard.writeText(state.suggestedFix.diff); copy.textContent = "Copied ✓"; copy.classList.add("done"); }
    catch { copy.textContent = "Select & copy"; }
    setTimeout(() => { copy.textContent = "Copy"; copy.classList.remove("done"); }, 1800);
    return;
  }

  const btn = e.target.closest("[data-helpful]");
  if (!btn || !state.lastAnalysis?.matchedId) return;
  const row = $("feedbackRow");
  const helpful = btn.dataset.helpful === "true";
  row.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await apiRequest("/api/feedback", { method: "POST", body: JSON.stringify({ incidentId: state.lastAnalysis.matchedId, helpful, incident: state.lastAnalysis.incident }) });
    row.innerHTML = `<span>Thanks. Saved as a relevance hint for ${esc(state.lastAnalysis.matchedId)}, not as a confirmed fact.</span>`;
    logLearning(`Feedback: ${esc(state.lastAnalysis.matchedId)} marked <strong>${helpful ? "helpful" : "not relevant"}</strong>`);
  } catch (err) {
    row.querySelectorAll("button").forEach((b) => (b.disabled = false));
    showToast("Could not save feedback.", "error");
    showBannerError(err);
  }
});

// ------------------------------------------------------------ Save verified experience

$("resolve").addEventListener("click", () => {
  const incident = $("incident").value.trim();
  const worked = $("resolution").value.trim();
  const errorEl = $("resolutionError");
  const missing = !worked ? ["resolution", "Enter what actually fixed the problem."]
    : !incident ? ["incident", "Describe the problem first."]
    : !$("humanConfirmed").checked ? ["humanConfirmed", "Confirm this is what actually happened. Only confirmed outcomes become memory."]
    : null;
  if (missing) {
    errorEl.textContent = missing[1];
    show(errorEl);
    $(missing[0]).focus();
    return;
  }
  show(errorEl, false);
  const payload = { incident, worked, confirmed: true, causeConfirmed: $("causeConfirmed").checked, observations: state.observations };
  for (const f of SAVE_FIELDS) payload[f] = $(f).value.trim();

  return withBusy("resolve", $("resolve"), "Saving to Hindsight…", async () => {
    hideBannerError();
    try {
      const res = await apiRequest("/api/resolve", { method: "POST", body: JSON.stringify(payload) });
      setStep(4, true);
      setPipeline({ learnProblem: "active", learnRecalled: "active", learnVerify: "highlighted", learnSaved: "highlighted" });
      const causeNote = { confirmed: "cause confirmed", suspected: "cause marked as suspected", unknown: "cause not recorded" }[res.causeStatus] || "";
      $("savedResolutionPreview").textContent = `Stored as ${res.id} · ${causeNote}`;
      const box = $("saveSuccessBox");
      box.hidden = true; void box.offsetWidth; box.hidden = false; // replay the check animation
      $("humanConfirmed").checked = false;
      showToast("Experience learned.");
      await refreshStatus();
      setDemoState("saved", { id: res.id });
      logLearning(`Saved verified experience <strong>${esc(res.id)}</strong>${Number.isFinite(state.documents) ? ` · ${countLabel(state.documents)} stored` : ""}`);
      state.observations = [];
      renderObservations();
      for (const ch of res.consolidation?.changes || []) {
        if (ch.type === "TEAM_PATTERN" && ch.status !== "unchanged") {
          const p = res.consolidation.patterns.find((x) => x.id === ch.id);
          logLearning(`<strong>Team has learned</strong> (${ch.status}): ${esc(p?.statement || ch.id)}`);
          showToast(`Team pattern ${ch.status} from ${p?.supporting ?? "3+"} confirmed incidents.`);
        }
        if (ch.type === "PLAYBOOK" && ch.status !== "unchanged") logLearning(`<strong>Team playbook</strong> ${ch.status}`);
      }
    } catch (err) {
      showToast("Could not save the experience.", "error");
      showBannerError(err);
    }
  });
});

// ------------------------------------------------------------ Presets & reset

function applyPreset(key) {
  const p = PRESETS[key];
  $("incident").value = p.problem;
  $("resolution").value = p.worked;
  for (const f of SAVE_FIELDS) $(f).value = p[f];
  $("causeConfirmed").checked = p.causeConfirmed;
  $("humanConfirmed").checked = false;
  state.observationHint = p.observation || "";
  show($("incidentError"), false);
  show($("resolutionError"), false);
  document.querySelectorAll("[data-preset]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.preset === key)));
}

document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
  applyPreset(b.dataset.preset);
  show($("saveSuccessBox"), false);
  $("incident").focus();
}));

$("resetDemo").addEventListener("click", () => {
  applyPreset("round1");
  for (const id of ["saveSuccessBox", "results", "analysisLoading", "learnSection"]) show($(id), false);
  show($("analysisEmpty"));
  hideBannerError();
  $("learningLog").innerHTML = '<li class="log-empty">Screen cleared. Memories stored in Hindsight are kept.</li>';
  setStat("statRelevant", null);
  Object.assign(state, { analyses: 0, lastAnalysis: null, hypotheses: [], observations: [], suggestedFix: null });
  renderObservations();
  setStep(1);
  setPipeline({});
  setDemoState("ready");
  showToast("Screen cleared. Hindsight memories are kept.");
  refreshStatus();
});

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

applyPreset("round1");

// ------------------------------------------------------------ First-open intro (once per page load)
// At least MIN_MS so it feels intentional, at most MAX_MS so it never holds the app back.

function runIntro(ready) {
  const intro = $("intro");
  const shell = $("appShell");
  if (!intro) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const MIN_MS = reduce ? 500 : 1500;
  const MAX_MS = 2200;
  const started = performance.now();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  shell.inert = true;
  Promise.race([ready.catch(() => {}), wait(MAX_MS)])
    .then(() => wait(Math.max(0, MIN_MS - (performance.now() - started))))
    .then(() => {
      shell.inert = false;
      intro.classList.add("is-leaving");
      document.body.classList.remove("intro-active");
      setTimeout(() => intro.remove(), reduce ? 300 : 700);
    });
}

runIntro(refreshStatus());
