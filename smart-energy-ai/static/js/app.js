(() => {
  "use strict";

  const page = document.body.dataset.page || "overview";
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  const state = {
    building: localStorage.getItem("smart_energy_building") || "CAMPUS",
    dashboard: null,
    health: null,
    energy: null,
    events: [],
    agent: null,
    verification: null,
    chart: null,
    chartReady: null,
    requestBusy: false,
    replaying: false,
    openWhy: new Set()
  };

  const lifecycle = [
    "MONITORING", "INVESTIGATING", "GATHERING_EVIDENCE", "ANALYZING",
    "FORECASTING", "SIMULATING", "VALIDATING", "WAITING_FOR_APPROVAL",
    "EXECUTING", "VERIFYING", "COMPLETED"
  ];

  const stateLabel = {
    MONITORING: "Monitoring",
    INVESTIGATING: "Investigating",
    GATHERING_EVIDENCE: "Gathering evidence",
    ANALYZING: "Analyzing",
    FORECASTING: "Forecasting",
    SIMULATING: "Simulating",
    VALIDATING: "Validating",
    WAITING_FOR_APPROVAL: "Waiting for approval",
    EXECUTING: "Executing",
    VERIFYING: "Verifying",
    COMPLETED: "Completed",
    FAILED: "Failed"
  };

  const num = value => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  const fmt = (value, digits = 1) => {
    const n = num(value);
    return n === null ? "—" : n.toFixed(digits);
  };

  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));

  const safeArray = value => Array.isArray(value) ? value : [];

  function humanState(value) {
    return stateLabel[value] || String(value || "—").replaceAll("_", " ");
  }

  function setText(selector, value) {
    const el = $(selector);
    if (el) el.textContent = value == null || value === "" ? "—" : String(value);
  }

  async function api(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const body = await res.json().catch(() => ({}));
    if (body.success === false) throw new Error(body.error || `HTTP ${res.status}`);
    if (!body.success) throw new Error(body.error || `Invalid API response (HTTP ${res.status})`);
    return body.data;
  }

  function toast(message) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("show"), 3200);
  }

  function setBusy(busy) {
    state.requestBusy = busy;
    $$("button").forEach(btn => {
      if (btn.dataset.persistentDisabled === "true") return;
      // The decision gates stay live while the agent works. The replanning
      // dialog appears during that same busy window, so its buttons belong on
      // this list too: disabling them leaves a dialog that ignores clicks.
      if (["approve-agent", "reject-agent",
           "replan-approve", "replan-reject", "replan-later"].includes(btn.id)) return;
      btn.disabled = busy && !btn.classList.contains("seg");
    });
    const run = $("#run-agent");
    if (run) run.disabled = busy || state.replaying;
  }

  function setDecisionButtons() {
    setExplainButtons();
    const waiting = state.agent?.state === "WAITING_FOR_APPROVAL";
    const canAct = waiting && !state.requestBusy && !state.replaying;
    const approve = $("#approve-agent");
    const reject = $("#reject-agent");
    if (approve) approve.disabled = !canAct;
    if (reject) reject.disabled = !canAct;

    // Once the gate has closed, Approve and Reject are dead controls sitting on
    // the page. The question the reader has at that point is "did it work?",
    // and the answer lives on the Verification page, so the primary button
    // becomes the way there. It is relabelled rather than silently repurposed:
    // a button that still says "Approve" must never do something else.
    const settled = ["COMPLETED", "FAILED"].includes(state.agent?.state);
    if (approve) {
      if (settled) {
        approve.disabled = false;
        approve.textContent = "View verification";
        approve.dataset.role = "verification";
      } else {
        approve.textContent = "Approve";
        delete approve.dataset.role;
      }
    }
  }

  /** The Approve button after the cycle closes: go and see the outcome. */
  function goToVerification() {
    const href = document.querySelector('.nav-item[href$="verification"]')?.getAttribute("href");
    window.location.assign(href || "/verification");
  }

  function setStatus(label, healthy) {
    ["#top-status", "#sidebar-status"].forEach(s => setText(s, label));
    ["#top-status-dot", "#sidebar-status-dot"].forEach(s => {
      const el = $(s);
      if (el) el.style.background = healthy ? "var(--success)" : "var(--danger)";
    });
  }

  async function loadHealth() {
    try {
      const h = await api("/api/health");
      state.health = h;
      const healthy = Boolean(h.database && h.ml_service);
      setStatus(healthy ? "Online" : "Degraded", healthy);
      renderHealth(h);
    } catch (e) {
      state.health = null;
      setStatus("Offline", false);
      renderHealth(null, e.message);
    }
  }

  function renderHealth(h, error = null) {
    const root = $("#overview-health");
    if (!root) return;

    if (!h) {
      root.innerHTML = ["database", "ml_service", "optimizer", "rag"].map(k =>
        `<div class="health-row"><span>${esc(k.replaceAll("_", " ").toUpperCase())}</span><b>Unavailable</b></div>`
      ).join("");
    } else {
      root.innerHTML = ["database", "ml_service", "optimizer", "rag"].map(k => `
        <div class="health-row">
          <span>${esc(k.replaceAll("_", " ").toUpperCase())}</span>
          <b>${h[k] ? "OK" : "Unavailable"}</b>
        </div>`).join("");

      const mock = $("#mock-data-warning");
      if (mock) mock.hidden = !h.mock_data;
      setText("#overview-ml", h.ml_service ? "Available" : "Unavailable");
      setText("#overview-rag", h.rag ? "Available" : "Unavailable");
    }
    if (error) {
      const mock = $("#mock-data-warning");
      if (mock) { mock.hidden = false; mock.textContent = `Health unavailable: ${error}`; }
    }
  }

  async function loadDashboard() {
    try {
      const d = await api(`/api/dashboard?building=${encodeURIComponent(state.building)}`);
      state.dashboard = d;
      renderDashboard(d);
      return d;
    } catch (e) {
      toast(`Dashboard: ${e.message}`);
      return null;
    }
  }

  function renderDashboard(d) {
    if (!d) return;
    const k = d.kpis || {};
    setText("#overview-load", num(k.current_load_kw) == null ? "—" : `${fmt(k.current_load_kw)} kW`);
    setText("#overview-solar", num(k.solar_kw) == null ? "—" : `${fmt(k.solar_kw)} kW`);
    setText("#overview-anomalies", num(k.anomalies) == null ? "—" : k.anomalies);
    const anomalyButton = $("#show-anomalies");
    if (anomalyButton) anomalyButton.disabled = !num(k.anomalies);
    const high = num(k.anomalies_high);
    const risks = num(k.peak_risks);
    const anomalyMeta = $("#overview-anomalies")?.nextElementSibling;
    if (anomalyMeta) anomalyMeta.textContent =
      `${high == null ? "—" : high} high severity, plus ${risks == null ? "—" : risks} campus peak-demand risks`;
    const asOf = $("#overview-as-of");
    if (asOf) asOf.textContent = d.as_of ? `Latest reading in the database: ${d.as_of}` : "Latest reading in the database: —";

    const achieved = num(k.achieved_reduction_kw);
    const estimated = num(k.estimated_reduction_kw);
    if (achieved != null) {
      setText("#overview-reduction", `${fmt(achieved)} kW`);
      setText("#overview-reduction-meta", "Achieved in verification");
    } else if (estimated != null) {
      setText("#overview-reduction", `${fmt(estimated)} kW`);
      setText("#overview-reduction-meta", `Simulated, ${k.estimated_reduction_action || "selected action"}`);
    } else {
      setText("#overview-reduction", "—");
      setText("#overview-reduction-meta", "Run an analysis first");
    }

    const agent = d.agent || {};
    setText("#overview-agent-state", humanState(agent.state));
    setText("#overview-agent-event", state.agent?.problem?.headline || "No active event.");
    setText("#overview-approval", approvalText(state.agent || agent));
    renderRagStatus(d.rag);
  }

  function renderRagStatus(rag) {
    const el = $("#overview-rag-detail");
    if (!el || !rag) return;
    if (!rag.available) el.textContent = "Unavailable";
    else if (rag.generation === "llm") el.textContent = rag.model ? `LLM · ${rag.model}` : "LLM";
    else el.textContent = "Extractive, no language model configured";
  }

  function approvalText(a) {
    if (!a) return "—";
    if (a.last_decision?.decision === "REJECTED") return `Rejected at ${a.last_decision.time}. Nothing was executed.`;
    if (a.state === "WAITING_FOR_APPROVAL") return "Human approval required";
    if (a.state === "EXECUTING") return "Simulated execution in progress";
    if (a.state === "VERIFYING") return "Verification in progress";
    if (a.state === "COMPLETED") return "Completed";
    if (a.approval_required) return "Approval required";
    return "No approval gate active";
  }

  function normalizeEnergy(d) {
    return {
      labels: safeArray(d?.labels),
      consumption: safeArray(d?.energy_kw),
      solar: safeArray(d?.solar_kw),
      hvac: safeArray(d?.hvac_kw),
      ev: safeArray(d?.ev_kw),
      occupancy: safeArray(d?.occupancy_pct),
      center: d?.center ?? null,
      end: d?.end ?? null
    };
  }

  function loadChartLibrary() {
    if (window.Chart) return Promise.resolve(window.Chart);
    if (state.chartReady) return state.chartReady;
    state.chartReady = new Promise(resolve => {
      const script = document.createElement("script");
      script.src = "/static/vendor/chart.umd.min.js";
      script.onload = () => resolve(window.Chart || null);
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    });
    return state.chartReady;
  }

  async function buildChart(canvasId, data) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const chart = await loadChartLibrary();
    const wrap = canvas.closest(".chart-wrap");
    if (!chart) {
      if (wrap) wrap.innerHTML = `<div class="empty-state chart-error">Chart library failed to load</div>`;
      return;
    }
    if (state.chart) state.chart.destroy();

    const datasets = [
      { key: "consumption", label: "Consumption", data: data.consumption, borderColor: "#F4EFE4", backgroundColor: "rgba(244,239,228,.04)" },
      { key: "solar", label: "Solar", data: data.solar, borderColor: "#DEB85C", backgroundColor: "rgba(222,184,92,.04)" },
      { key: "hvac", label: "HVAC", data: data.hvac, borderColor: "#A45261", backgroundColor: "rgba(164,82,97,.04)" }
    ].map(x => ({ ...x, borderWidth: 2, pointRadius: 0, tension: .35 }));

    state.chart = new Chart(canvas, {
      type: "line",
      data: { labels: data.labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: "#171319", borderColor: "rgba(222,184,92,.2)", borderWidth: 1 }
        },
        scales: {
          x: { grid: { color: "rgba(255,255,255,.035)" }, ticks: { color: "#68625d", maxTicksLimit: 10, font: { size: 9 } } },
          y: { grid: { color: "rgba(255,255,255,.045)" }, ticks: { color: "#68625d", font: { size: 9 } } }
        }
      }
    });

    const centerIndex = data.center == null ? -1 : data.labels.indexOf(data.center);
    if (centerIndex >= 0) {
      const annotationPlugin = {
        id: "eventLine",
        afterDraw(chart) {
          const x = chart.scales.x.getPixelForValue(centerIndex);
          const { ctx, chartArea: { top, bottom } } = chart;
          ctx.save();
          ctx.setLineDash([6, 5]);
          ctx.strokeStyle = "#DEB85C";
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
          ctx.restore();
        }
      };
      Chart.register(annotationPlugin);
      state.chart.config.plugins = [annotationPlugin];
      state.chart.update();
    }
  }

  async function loadEnergy(canvasId) {
    try {
      const d = await api(`/api/energy?building=${encodeURIComponent(state.building)}&hours=48`);
      state.energy = normalizeEnergy(d);
      await buildChart(canvasId, state.energy);
      renderEnergyTiles();
      renderEnergyCaption(d);
      return d;
    } catch (e) {
      toast(`Energy data: ${e.message}`);
      return null;
    }
  }

  function renderEnergyTiles() {
    const e = state.energy;
    if (!e) return;
    const last = arr => arr.length ? arr[arr.length - 1] : null;
    setText("#energy-load", last(e.consumption) == null ? "—" : `${fmt(last(e.consumption))} kW`);
    setText("#energy-solar", last(e.solar) == null ? "—" : `${fmt(last(e.solar))} kW`);
    setText("#energy-hvac", last(e.hvac) == null ? "—" : `${fmt(last(e.hvac))} kW`);
    setText("#energy-occupancy", last(e.occupancy) == null ? "—" : `${fmt(last(e.occupancy))}%`);
    const lastTs = e.labels[e.labels.length - 1];
    ["#energy-load-time", "#energy-solar-time", "#energy-hvac-time", "#energy-occupancy-time"].forEach(id => {
      const el = $(id); if (el) el.textContent = lastTs ? `Chart window: ${lastTs}` : "Chart window timestamp unavailable";
    });
  }

  function renderEnergyCaption(d) {
    const el = $("#energy-caption");
    if (!el) return;
    el.textContent = d.center
      ? `48 hours around the event at ${d.center}`
      : `last 48 hours to ${d.end || "—"}`;
  }

  function eventText(ev) {
    const label = ev?.event_label || "Event";
    const building = ev?.building_id
      ? `${ev.building_id} ${ev.building_name || ""}`.trim()
      : "campus";
    return `${label}, ${building}`;
  }

  async function loadEvents(targetId) {
    try {
      const d = await api(`/api/events?building=${encodeURIComponent(state.building)}&limit=60`);
      state.events = safeArray(d.events);
      renderEvents(targetId);
      return state.events;
    } catch (e) {
      const target = $(targetId);
      if (target) target.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
      return [];
    }
  }

  function renderEvents(targetId) {
    const target = $(targetId);
    if (!target) return;
    target.innerHTML = state.events.slice(0, 10).map((ev, i) => {
      const sev = String(ev.severity || "—");
      const bad = ["high", "critical"].includes(sev.toLowerCase());
      const action = ev.actionable
        ? `<button class="text-link event-analyze" data-index="${i}" type="button">Analyze</button>`
        : `<button class="text-link" type="button" disabled>No simulation</button>`;
      return `<div class="event-row">
        <span class="event-dot ${bad ? "bad" : ""}"></span>
        <div>
          <b>${esc(eventText(ev))}</b>
          <span style="display:block;margin-top:4px">${esc(ev.timestamp || "—")} · ${esc(sev)}</span>
        </div>
        ${action}
      </div>`;
    }).join("") || `<div class="empty-state">No events returned.</div>`;

    $$(".event-analyze", target).forEach(btn => btn.addEventListener("click", () => {
      const ev = state.events[Number(btn.dataset.index)];
      if (ev) runAgent(ev);
    }));
  }

  async function loadAgent() {
    try {
      state.agent = await api("/api/agent/status");
      renderAgentEverywhere();
      return state.agent;
    } catch (e) {
      toast(`Agent: ${e.message}`);
      return null;
    }
  }

  function renderAgentEverywhere() {
    if (!state.agent) return;
    renderLifecycle(state.agent.state);
    renderOperation(state.agent);
    renderTwin(state.agent);
    renderActivitySession(state.agent);
    renderOverviewAgent(state.agent);
    setDecisionButtons();
  }

  function renderOverviewAgent(a) {
    setText("#overview-agent-state", humanState(a.state));
    setText("#overview-agent-event", a.problem?.headline || "No active event.");
    setText("#overview-approval", approvalText(a));
  }

  function renderLifecycle(stateName) {
    const current = lifecycle.indexOf(stateName);
    const failed = stateName === "FAILED";
    let lastReached = current;
    if (failed && state.agent?.trail?.length) {
      lastReached = Math.max(...state.agent.trail.map(x => lifecycle.indexOf(x.state)).filter(x => x >= 0), 0);
    }

    $$(".life-step").forEach(el => {
      const i = lifecycle.indexOf(el.dataset.state);
      el.classList.toggle("active", !failed && i === current);
      el.classList.toggle("done", !failed && i >= 0 && i < current);
      el.classList.toggle("failed", failed && i === lastReached);
      const trail = safeArray(state.agent?.trail).find(x => x.state === el.dataset.state);
      let time = el.querySelector(".life-time");
      if (trail?.time) {
        if (!time) { time = document.createElement("small"); time.className = "life-time"; el.appendChild(time); }
        time.textContent = trail.time;
      }
    });
  }

  function renderOperation(a) {
    const p = a.problem || {};
    setText("#op-problem-title", p.headline || "No active event");
    const facts = safeArray(p.facts);
    const factText = facts.join(" · ");
    const problemText = [
      factText,
      p.event_label || "—",
      p.building_name ? `${p.building_id || "—"} ${p.building_name}` : p.building_id || "campus",
      p.timestamp || "—",
      p.value != null ? `${p.value} ${p.value_meaning || ""}`.trim() : ""
    ].filter(Boolean).join(" · ");
    setText("#op-problem-text", problemText || "Run an analysis first.");
    setText("#op-event-id", p.timestamp ? `${p.timestamp} · ${p.event_label || "Event"}` : "—");
    renderSelectionNotice(a.selection_note);
    renderEvidence(a.evidence);
    renderCandidates(a.candidate_actions);
    renderRecommendation(a);
    renderDecision(a);
    renderVerification(a.verification, a.verification_log);
    renderReplan(a);
    const scope = $("#op-replan-scope");
    if (scope) {
      scope.hidden = !a.recommendation_scope_note;
      scope.textContent = a.recommendation_scope_note || "";
    }
    const constraints = $("#op-constraints");
    if (constraints) {
      constraints.innerHTML = safeArray(a.optimizer_constraints).map(x => `<span>${esc(x)}</span>`).join("");
    }
    const error = $("#op-error");
    if (error) {
      error.hidden = a.state !== "FAILED";
      error.textContent = a.state === "FAILED" ? (a.error || "Agent failed.") : "";
    }
  }

  function renderSelectionNotice(note) {
    const root = $("#op-selection-note");
    if (!root) return;
    root.hidden = !note;
    root.textContent = note || "";
  }

  function renderEvidence(e) {
    const root = $("#op-evidence");
    if (!root) return;
    const vals = [
      ["Energy", e?.energy_kw, "kW"],
      ["HVAC", e?.hvac_kw, "kW"],
      ["Occupancy", e?.occupancy_pct, "%"],
      ["Solar", e?.solar_kw, "kW"],
      ["Historical readings", e?.history_count, "readings"],
      ["Grid status", e?.grid?.status, ""]
    ];
    root.innerHTML = vals.map(([name, value, unit]) => {
      const hvacWarning = name === "HVAC" && num(e?.hvac_kw) != null && num(e?.energy_kw) != null && e.hvac_kw > e.energy_kw;
      const sub = name === "HVAC" && num(e?.hvac_kw) != null && num(e?.energy_kw) != null
        ? `${fmt((e.hvac_kw / e.energy_kw) * 100)}% of metered load`
        : name === "Occupancy" && e?.occupancy_is_average ? "Average across buildings" : "";
      return `<div class="evidence-tile ${hvacWarning ? "warning" : ""}">
        <span>${esc(name)}</span>
        <b>${esc(value == null ? "—" : (unit ? `${fmt(value)} ${unit}` : value))}</b>
        ${sub ? `<small>${esc(sub)}</small>` : ""}
        ${hvacWarning ? `<small class="warning-text">HVAC reading exceeds total load (data quality)</small>` : ""}
      </div>`;
    }).join("");

    const pb = safeArray(e?.per_building);
    const table = $("#op-per-building");
    if (table) {
      table.hidden = pb.length <= 1;
      table.innerHTML = pb.length > 1 ? `
        <div class="table-scroll"><table>
          <thead><tr><th>Building</th><th>Energy kW</th><th>HVAC kW</th><th>Occupancy</th><th>Solar kW</th><th>EV kW</th></tr></thead>
          <tbody>${pb.map(x => `<tr>
            <td>${esc(`${x.building_id} ${x.building_name || ""}`)}</td>
            <td>${esc(fmt(x.energy_kw))}</td><td>${esc(fmt(x.hvac_kw))}</td>
            <td>${esc(fmt(x.occupancy_pct))}%</td><td>${esc(fmt(x.solar_kw))}</td><td>${esc(fmt(x.ev_kw))}</td>
          </tr>`).join("")}</tbody>
        </table></div>` : "";
    }
    const foot = $("#op-evidence-foot");
    if (foot) foot.textContent = e?.reading_time
      ? `Readings at the event hour (${e.reading_time}). History covers the 24 hours up to the event.${e?.grid?.description ? ` ${e.grid.description}` : ""}`
      : "Readings at the event hour (—). History covers the 24 hours up to the event.";
  }

  function whyLabel(verdict) {
    return ({
      failed_constraints: "Why was it rejected?",
      missed_target: "Why was it rejected?",
      not_selected: "Why wasn't it chosen?",
      selected: "Why was it chosen?",
      verified: "What happened?"
    })[verdict] || "Why?";
  }

  function renderCandidates(list) {
    const html = safeArray(list).map((c, i) => {
      const exp = c.explanation;
      const verdict = exp?.verdict;
      const selected = c.is_selected === true;
      const reduction = num(c.estimated_reduction_kw);
      const maxReduction = Math.max(...safeArray(list).map(x => num(x.estimated_reduction_kw) || 0), 1);
      const missed = safeArray(state.agent?.verification_log).some(v =>
        v?.needs_replanning && v?.intended_action === c.action
      );
      const statusTag = missed ? "Missed target" : selected ? "Recommended" : (c.passes_constraints ? "Passes constraints" : "Fails constraints");
      const open = state.openWhy.has(i);
      return `<article class="candidate ${selected ? "selected" : ""}">
        <div class="candidate-top">
          <span class="candidate-name">${esc(c.label || c.action || "—")}</span>
          <span class="candidate-score">Score ${esc(fmt(c.optimization_score, 2))}</span>
        </div>
        <div class="candidate-meta">
          <span class="tag">${esc(statusTag)}</span>
          <span class="tag">${esc(fmt(reduction))} kW</span>
          <span class="tag">${esc(fmt(c.reduction_percent))}%</span>
          <span class="tag">Load → ${esc(fmt(c.new_predicted_load))} kW</span>
          <span class="tag">Battery ${esc(fmt(c.battery_soc_percent))}%</span>
          <span class="tag">EV ${esc(fmt(c.ev_load_kw))} kW</span>
        </div>
        <div class="bar"><i style="width:${Math.max(0, Math.min(100, ((reduction || 0) / maxReduction) * 100))}%"></i></div>
        ${verdict ? `<button class="why-btn" type="button" data-why="${i}" aria-expanded="${open}">${esc(whyLabel(verdict))}</button>
          <div class="why-panel" ${open ? "" : "hidden"}>
            <span class="tag">${esc(exp.title || verdict)}</span>
            <ul>${safeArray(exp.points).map(x => `<li>${esc(x)}</li>`).join("")}</ul>
            ${safeArray(c.constraint_checks).length ? `<div class="constraint-list">${c.constraint_checks.map(x =>
        `<div><b>${!x.applies ? "–" : x.passed ? "✓" : "✗"}</b><span>${esc(x.detail || x.rule || "Constraint")}</span></div>`
      ).join("")}</div>` : ""}
            ${exp.comparison ? `<div class="comparison"><table><thead><tr><th></th><th>This</th><th>Selected</th></tr></thead><tbody>
              <tr><td>Reduction × weight</td><td>${esc(fmt(exp.comparison.this?.reduction_term, 2))}</td><td>${esc(fmt(exp.comparison.selected?.reduction_term, 2))}</td></tr>
              <tr><td>Disruption rank × penalty</td><td>−${esc(fmt(exp.comparison.this?.penalty_term, 2))}</td><td>−${esc(fmt(exp.comparison.selected?.penalty_term, 2))}</td></tr>
              <tr><td>Score</td><td>${esc(fmt(exp.comparison.this?.score, 2))}</td><td>${esc(fmt(exp.comparison.selected?.score, 2))}</td></tr>
            </tbody></table></div>` : ""}
            <p class="why-basis">${esc(exp.basis || "")}</p>
          </div>` : ""}
      </article>`;
    }).join("") || `<div class="empty-state">No candidate actions available. Run an analysis first.</div>`;

    const roots = [$("#op-candidates"), $("#twin-candidates")].filter(Boolean);
    roots.forEach(root => root.innerHTML = html);
    roots.forEach(root => $$(".why-btn", root).forEach(btn => btn.addEventListener("click", () => {
      const i = Number(btn.dataset.why);
      state.openWhy.has(i) ? state.openWhy.delete(i) : state.openWhy.add(i);
      renderCandidates(state.agent?.candidate_actions || []);
    })));
  }

  function renderRecommendation(a) {
    const root = $("#op-recommendation");
    const r = a.recommendation;
    if (!root) return;
    if (!r) {
      root.innerHTML = `<div class="empty-state">Waiting for simulation results.</div>`;
      return;
    }
    const executing = ["EXECUTING", "VERIFYING"].includes(a.state);
    const action = executing && a.last_decision?.action
      ? (safeArray(a.candidate_actions).find(x => x.action === a.last_decision.action) || r)
      : r;
    root.innerHTML = `
      <div class="recommendation-title">${esc(action.label || action.action || "—")}</div>
      <div class="candidate-meta">
        <span class="tag">${esc(fmt(action.estimated_reduction_kw))} kW</span>
        <span class="tag">Load → ${esc(fmt(action.new_predicted_load))} kW</span>
        <span class="tag">${esc(r.approval_status || "—")}</span>
        <span class="tag">${r.source === "replanning" ? "Alternative after replanning" : "From optimizer"}</span>
      </div>
      <ul class="reason-list">${safeArray(r.reason?.points).map(x => `<li>${esc(x)}</li>`).join("")}</ul>
      <p class="reason-basis">${esc(r.reason?.basis || "Assembled from recorded outputs, not generated text.")}</p>
    `;
  }

  function renderDecision(a) {
    const status = $("#op-decision-state");
    const text = $("#op-decision-text");
    if (!status || !text) return;
    status.textContent = humanState(a.state);
    if (a.state === "WAITING_FOR_APPROVAL" && a.replanned) {
      text.textContent = "Human approval required.";
    } else if (a.last_decision?.decision === "REJECTED") {
      text.textContent = `Rejected at ${a.last_decision.time}. Nothing was executed.`;
    } else if (a.state === "EXECUTING") {
      text.textContent = "Simulated execution in progress. No equipment is being controlled.";
    } else if (a.state === "VERIFYING") {
      text.textContent = "Verification is comparing the simulated outcome with the expected target.";
    } else {
      text.textContent = approvalText(a);
    }
  }

  function renderReplan(a) {
    const root = $("#op-replan");
    if (!root) return;
    const v = a.verification;
    const show = a.replanned && a.state === "WAITING_FOR_APPROVAL" && v;
    root.hidden = !show;
    if (show) showReplanDialog(a);
    else closeReplanDialog();
    if (show) root.textContent =
      `Replanning round ${a.replan_count}: ${v.intended_label || "Previous action"} reached ${fmt(v.performance_ratio_percent)}% of its expected reduction (target ${fmt(v.threshold_percent)}%). The agent proposes ${a.recommendation?.label || "an alternative"}, which needs your approval.`;
  }

  function renderVerification(v, log) {
    const root = $("#op-verification");
    if (!root) return;
    if (!v) {
      root.className = "verification-result empty-state";
      root.textContent = "No execution has been verified yet.";
      return;
    }
    const ok = v.verification_status === "SUCCESS";
    root.className = `verification-result ${ok ? "pass" : "fail"}`;
    root.innerHTML = `
      <div class="verification-main-title">${ok ? "Verified" : "Target not met. The agent is replanning."}</div>
      <div class="verification-grid">
        <div><span>Expected</span><b>${esc(fmt(v.expected_reduction_kw))} kW</b></div>
        <div><span>Actual</span><b>${esc(fmt(v.achieved_reduction_kw))} kW</b></div>
        <div><span>Performance</span><b>${esc(fmt(v.performance_ratio_percent))}%</b></div>
        <div><span>Verified action</span><b>${esc(v.verified_label || "—")}</b></div>
      </div>
      <div class="threshold-marker">Threshold ${esc(fmt(v.threshold_percent))}%</div>
      ${v.action_mismatch ? `<div class="warning-text">This verification record belongs to ${esc(v.verified_label || "the verified action")}.</div>` : ""}
      ${safeArray(log).length > 1 ? `<details class="verification-history"><summary>Verification history</summary>${safeArray(log).map(x =>
      `<div class="timeline-row"><b>${esc(x.intended_label || "—")}</b><span>${esc(x.time || "—")} · ${esc(fmt(x.achieved_reduction_kw))} / ${esc(fmt(x.expected_reduction_kw))} kW · ${esc(x.verification_status || "—")}</span></div>`
    ).join("")}</details>` : ""}
    `;
  }

  function renderTwin(a) {
    const p = a.problem || {};
    setText("#twin-event", p.timestamp ? `${p.timestamp} · ${p.event_label || "Event"}` : "No active event");
    setText("#twin-selected", a.recommendation?.label || "No action selected");
    const meta = $("#twin-selected-meta");
    if (meta) meta.innerHTML = a.recommendation ? `
      <div><span>Reduction</span><b>${esc(fmt(a.recommendation.estimated_reduction_kw))} kW</b></div>
      <div><span>New predicted load</span><b>${esc(fmt(a.recommendation.new_predicted_load))} kW</b></div>
    ` : `<div><span>Status</span><b>Run an analysis first</b></div>`;
    renderCandidates(a.candidate_actions);
  }

  function renderActivitySession(a) {
    setText("#activity-state", humanState(a.state));
    setText("#activity-event", a.problem?.timestamp ? `${a.problem.timestamp} · ${a.problem.event_label || "Event"}` : "—");
    setText("#activity-approval", approvalText(a));
  }

  async function runAgent(event = null) {
    if (state.requestBusy || state.replaying) return;
    const oldTrail = safeArray(state.agent?.trail);
    state.openWhy.clear();
    setBusy(true);
    try {
      const body = event
        ? { timestamp: event.timestamp, building_id: event.building_id, event_type: event.event_type }
        : { building: state.building, scenario: $("#demo-path")?.value || "auto" };
      const snapshot = await api("/api/agent/run", {
        method: "POST", body: JSON.stringify(body)
      });
      state.agent = snapshot;

      // Analyze pressed on another page: continue on Operations, where the
      // lifecycle and the decision gate live. `event` here is runAgent's own
      // parameter, not the global window.event.
      if (event && page !== "operations") {
        const href = document.querySelector('.nav-item[href$="operations"]')?.getAttribute("href");
        window.location.assign(href || "/operations");
        return;
      }

      await replayNewTrail(oldTrail, snapshot.trail || []);
      toast(snapshot.state === "WAITING_FOR_APPROVAL" ? "Analysis complete. Human approval required." : "Analysis completed.");
    } catch (e) {
      toast(`Agent: ${e.message}`);
    } finally {
      setBusy(false);
      setDecisionButtons();
    }
  }

  async function replayNewTrail(oldTrail, newTrail) {
    state.replaying = true;
    setDecisionButtons();
    const oldKeys = new Set(oldTrail.map(x => `${x.state}|${x.time}`));
    const fresh = safeArray(newTrail).filter(x => !oldKeys.has(`${x.state}|${x.time}`));
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (!fresh.length || reduceMotion) {
      renderAgentEverywhere();
      state.replaying = false;
      setDecisionButtons();
      return;
    }
    for (const entry of fresh) {
      const partial = { ...state.agent, state: entry.state };
      renderLifecycle(entry.state);
      renderOperation(partial);
      renderTwin(partial);
      await new Promise(r => setTimeout(r, 340));
    }
    renderAgentEverywhere();
    state.replaying = false;
    setDecisionButtons();
  }

  async function decision(path) {
    if (state.requestBusy || state.replaying) return;
    const oldTrail = safeArray(state.agent?.trail);
    setBusy(true);
    try {
      const snapshot = await api(`/api/agent/${path}`, { method: "POST", body: "{}" });
      state.agent = snapshot;

      await replayNewTrail(oldTrail, snapshot.trail || []);
      if (path === "approve") {
        if (snapshot.state === "WAITING_FOR_APPROVAL" && snapshot.replanned) toast("Target not met. The agent proposes an alternative.");
        else if (snapshot.state === "COMPLETED") toast("Approved. Simulated execution verified.");
      } else {
        toast("Rejected. Nothing was executed.");
      }
      if (page === "verification") await loadVerification();
      if (page === "activity") await loadActivity();
      await loadDashboard();
    } catch (e) {
      toast(`Decision: ${e.message}`);
    } finally {
      setBusy(false);
      setDecisionButtons();
    }
  }

  async function loadVerification() {
    try {
      state.verification = await api("/api/verification");
      const v = state.verification.latest;
      setText("#ver-status", v ? (v.verification_status === "SUCCESS" ? "Verified" : "Target not met") : "—");
      setText("#ver-expected", v ? `${fmt(v.expected_reduction_kw)} kW` : "—");
      setText("#ver-observed", v ? `${fmt(v.achieved_reduction_kw)} kW` : "—");
      setText("#ver-threshold", v ? `${fmt(v.threshold_percent)}%` : "—");
      const main = $("#verification-main");
      if (main) {
        main.className = `verification-card ${v?.verification_status === "SUCCESS" ? "pass" : v ? "fail" : ""}`;
        main.innerHTML = v ? `
          <div class="verification-main-title">${v.verification_status === "SUCCESS" ? "Verified" : "Target not met"}</div>
          <div class="verification-main-sub">${esc(v.intended_label || "—")} → ${esc(v.verified_label || "—")}</div>
          <div class="verification-grid">
            <div><span>Expected</span><b>${esc(fmt(v.expected_reduction_kw))} kW</b></div>
            <div><span>Actual</span><b>${esc(fmt(v.achieved_reduction_kw))} kW</b></div>
            <div><span>Performance</span><b>${esc(fmt(v.performance_ratio_percent))}%</b></div>
            <div><span>Threshold</span><b>${esc(fmt(v.threshold_percent))}%</b></div>
          </div>
          ${v.action_mismatch ? `<div class="warning-text">This record belongs to ${esc(v.verified_label || "the verified action")}.</div>` : ""}
        ` : `<div class="empty-state">No verification result available yet.</div>`;
      }
      const history = $("#verification-history");
      if (history) history.innerHTML = safeArray(state.verification.log).map(x =>
        `<div class="timeline-row"><b>${esc(x.intended_label || "—")}</b><span>${esc(x.time || "—")} · ${esc(fmt(x.expected_reduction_kw))} / ${esc(fmt(x.achieved_reduction_kw))} kW · ${esc(x.verification_status || "—")}</span></div>`
      ).join("") || `<div class="empty-state">No verification history.</div>`;
    } catch (e) {
      toast(`Verification: ${e.message}`);
    }
  }

  async function loadActivity() {
    try {
      const d = await api("/api/agent/history");
      const root = $("#activity-history");
      if (root) root.innerHTML = safeArray(d.history).slice().sort((a, b) => String(a.time).localeCompare(String(b.time))).map(x =>
        `<div class="timeline-row ${/reject|fail/i.test(x.message || "") ? "danger" : /wait/i.test(x.state || "") ? "waiting" : /approv/i.test(x.message || "") ? "success" : ""}">
          <b>${esc(humanState(x.state))}</b><span>${esc(x.time || "—")} · ${esc(x.message || "—")}</span>
        </div>`).join("") || `<div class="empty-state">No activity recorded.</div>`;
    } catch (e) { toast(`Activity: ${e.message}`); }
  }

  function renderRagSources(sources) {
    return safeArray(sources).map((s, i) => `
      <details class="rag-source" open>
        <summary>[${i + 1}] ${esc(s.title || s.document || "Source")}</summary>
        <div><b>${esc(s.section || "—")}</b> · ${esc(s.document || "—")}</div>
        <p>${esc(s.excerpt || "")}</p>
      </details>`).join("");
  }

  async function askRag(question) {
    if (!question) return;
    const root = $("#rag-answer");
    if (root) root.innerHTML = `<div class="empty-state">Retrieving…</div>`;
    try {
      const d = await api("/api/rag/query", {
        method: "POST",
        body: JSON.stringify({ question, include_live_context: Boolean($("#rag-context")?.checked) })
      });
      const modeText = d.mode === "llm"
        ? `Generated by ${d.model || "the configured model"} from retrieved sections`
        : d.mode === "extractive"
          ? "Quoted from retrieved sections"
          : "No matching document";
      if (root) root.innerHTML = `
        <div class="rag-mode tag">${esc(modeText)}</div>
        <div class="rag-content">${esc(d.answer || "—").replace(/\[(\d+)\]/g, '<mark>[$1]</mark>')}</div>
        ${d.notice ? `<div class="notice">${esc(d.notice)}</div>` : ""}
        ${d.live_context ? `<section class="live-context"><b>Live operational data, from the agent (not from the knowledge base)</b><pre>${esc(JSON.stringify(d.live_context, null, 2))}</pre></section>` : ""}
        <div class="rag-sources">${renderRagSources(d.sources)}</div>`;
      setText("#rag-status", modeText);
    } catch (e) {
      if (root) root.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
    }
  }

  function bindGlobal() {
    const sel = $("#building-select");
    if (sel) {
      sel.value = state.building;
      sel.addEventListener("change", async () => {
        setBuilding(sel.value);
        await Promise.all([loadDashboard(), loadEnergy(page === "energy" ? "energy-chart" : "overview-chart"), loadEvents(page === "overview" ? "#overview-events" : "#energy-events")]);
        if (page === "operations" || page === "digital_twin" || page === "activity") await loadAgent();
      });
    }
    const menu = $("#mobile-menu");
    if (menu) menu.addEventListener("click", () => $("#sidebar")?.classList.toggle("open"));
  }

  function setBuilding(value) {
    state.building = value;
    localStorage.setItem("smart_energy_building", value);
  }

  async function initPage() {
    bindGlobal();
    bindReplanDialog();
    await loadHealth();
    await loadDashboard();

    if (page === "overview") {
      $("#show-anomalies")?.addEventListener("click", () => toggleAnomalies());
      $("#close-anomalies")?.addEventListener("click", () => {
        const panel = $("#anomaly-panel");
        if (panel) panel.hidden = true;
      });
      $$("#anomaly-filters .seg").forEach(btn => btn.addEventListener("click", () => {
        $$("#anomaly-filters .seg").forEach(other => other.classList.toggle("active", other === btn));
        anomalyState.kind = btn.dataset.kind;
        renderAnomalies();
      }));
      await Promise.all([loadEnergy("overview-chart"), loadEvents("#overview-events"), loadAgent()]);
      startLiveStream();
    } else if (page === "history") {
      await initHistoryPage();
    } else if (page === "energy") {
      await Promise.all([loadEnergy("energy-chart"), loadEvents("#energy-events")]);
      startLiveStream();
      $$(".seg").forEach(btn => btn.addEventListener("click", () => {
        btn.classList.toggle("active");
        const key = btn.dataset.series;
        const ds = state.chart?.data?.datasets?.find(x => x.key === key);
        if (ds) { ds.hidden = !btn.classList.contains("active"); state.chart.update(); }
      }));
    } else if (page === "operations") {
      const run = $("#run-agent");
      if (run) run.addEventListener("click", () => runAgent());
      $("#approve-agent")?.addEventListener("click", e => {
        if (e.currentTarget.dataset.role === "verification") goToVerification();
        else decision("approve");
      });
      $("#reject-agent")?.addEventListener("click", () => decision("reject"));
      $("#explain-forecast")?.addEventListener("click", () => loadExplanation());
      $("#download-pdf")?.addEventListener("click", () => downloadReport());
      await loadEvents("#op-events");
      await loadAgent();
    } else if (page === "digital_twin") {
      await loadAgent();
      startLiveStream();
    } else if (page === "verification") {
      await loadVerification();
    } else if (page === "knowledge") {
      $("#rag-form")?.addEventListener("submit", e => {
        e.preventDefault();
        askRag($("#rag-input")?.value.trim());
      });
      $$(".quick-questions button").forEach(btn => btn.addEventListener("click", () => askRag(btn.dataset.question)));
      await loadAgent();
    } else if (page === "activity") {
      $("#reset-agent")?.addEventListener("click", async () => {
        if (state.requestBusy) return;
        setBusy(true);
        try {
          state.agent = await api("/api/agent/reset", { method: "POST", body: "{}" });
          toast("Agent session reset.");
          await loadActivity();
          renderAgentEverywhere();
        } catch (e) { toast(`Reset: ${e.message}`); }
        finally { setBusy(false); }
      });
      await Promise.all([loadActivity(), loadEvents("#activity-events"), loadAgent()]);
    }
  }

  // =========================================================
  // LIVE OPERATIONAL SIMULATION STREAM ENGINE
  // =========================================================

  let lastStreamFetchTime = Date.now();
  let liveStreamWarned = false;

  function startLiveStream() {
    updateLiveStream();
    setInterval(updateLiveStream, 5000);
    setInterval(updateUpdatedTicker, 1000);
  }

  function updateUpdatedTicker() {
    const elapsed = Math.floor((Date.now() - lastStreamFetchTime) / 1000);
    const val = Math.max(0, elapsed);
    // Update whichever "Xs ago" span exists on the current page
    const ids = ["#live-updated-ago", "#live-updated-ago-energy", "#live-updated-ago-dt"];
    ids.forEach(id => { const el = $(id); if (el) el.textContent = val; });
  }

  async function updateLiveStream() {
    if (page === "history") return;
    try {
      const live = await api(`/api/live/stream?building=${encodeURIComponent(state.building)}`);
      lastStreamFetchTime = Date.now();
      liveStreamWarned = false;
      renderLiveStream(live);
    } catch (e) {
      // The stream must not interrupt the page, but swallowing the error
      // silently leaves a stalled dashboard with no way to tell why. Log it,
      // and say so on screen once rather than on every 5s tick.
      console.error("Live stream failed:", e);
      if (!liveStreamWarned) {
        liveStreamWarned = true;
        toast(`Live stream: ${e.message}`);
        setText("#live-op-time", "Stream unavailable");
        setText("#live-op-time-energy", "Stream unavailable");
        setText("#dt-op-time", "Stream unavailable");
      }
    }
  }

  function renderLiveStream(live) {
    if (!live) return;
    state.liveState = live;

    // 1. Overview Page Live Elements
    setText("#live-op-time", live.operational_time || "—");
    setText("#overview-load", `${fmt(live.current_load_kw)} kW`);
    setText("#overview-solar", `${fmt(live.solar_kw)} kW`);
    const asOf = $("#overview-as-of");
    if (asOf) asOf.textContent = `Historical Source Baseline: ${live.historical_source_time}`;

    // NASA POWER Weather Details
    const w = live.weather || {};
    setText("#weather-temp", `${fmt(w.temperature_c)} °C`);
    setText("#weather-rh", `${fmt(w.humidity_pct)}% RH`);
    setText("#weather-irradiance", `${fmt(w.solar_irradiance_wm2)} W/m²`);
    setText("#weather-wind", `${fmt(w.wind_speed_ms)} m/s`);
    setText("#weather-source", w.source || "NASA POWER");
    setText("#weather-utc-time", w.nasa_observation_utc || "—");
    setText("#weather-jordan-time", w.jordan_local_time || "—");
    setText("#weather-retrieved-time", w.last_retrieved_at || "—");

    // 2. Energy Monitor Page Live Elements
    if (page === "energy") {
      setText("#energy-load", `${fmt(live.current_load_kw)} kW`);
      setText("#energy-solar", `${fmt(live.solar_kw)} kW`);
      setText("#energy-hvac", `${fmt(live.hvac_kw)} kW`);
      setText("#energy-occupancy", `${fmt(live.occupancy_pct)}%`);
      setText("#energy-grid-import", `${fmt(live.grid_import_kw)} kW`);
      setText("#live-op-time-energy", live.operational_time || "—");
    }

    // 3. Digital Twin Page Live Elements
    if (page === "digital_twin") {
      setText("#dt-load", `${fmt(live.current_load_kw)} kW`);
      setText("#dt-solar", `${fmt(live.solar_kw)} kW`);
      setText("#dt-grid", `${fmt(live.grid_import_kw)} kW`);
      setText("#dt-op-time", live.operational_time || "—");
    }
  }

  // =========================================================
  // HISTORICAL DATA EXPLORER
  // =========================================================

  async function initHistoryPage() {
    // Dynamically populate available years from database
    try {
      const yearsData = await api("/api/history/years");
      const years = safeArray(yearsData.years);
      const yearSelect = $("#hist-year-select");
      if (yearSelect && years.length) {
        yearSelect.innerHTML = years.map(y => `<option value="${y}" ${y === "2017" ? "selected" : ""}>${y}</option>`).join("");
        setText("#hist-years-range", `${years[0]} – ${years[years.length - 1]}`);
      }
    } catch (e) {
      // Fallback if network check fails
    }

    const form = $("#history-form");
    if (form) {
      form.addEventListener("submit", async e => {
        e.preventDefault();
        await executeHistoryQuery();
      });
    }
    await executeHistoryQuery();
  }

  async function executeHistoryQuery() {
    const yr = $("#hist-year-select")?.value || "2017";
    const mo = $("#hist-month-select")?.value || "09";
    const dy = $("#hist-day-select")?.value || "23";
    const hr = $("#hist-hour-select")?.value || "20";
    const mn = $("#hist-min-select")?.value || "00";
    const timestamp = `${yr}-${mo}-${dy} ${hr}:${mn}:00`;

    setText("#hist-selected-ts", timestamp);

    try {
      const data = await api(`/api/history/query?building=${encodeURIComponent(state.building)}&timestamp=${encodeURIComponent(timestamp)}`);
      renderHistoryResults(data);
    } catch (e) {
      toast(`History query: ${e.message}`);
    }
  }

  async function renderHistoryResults(data) {
    if (!data) return;
    const r = data.reading || {};
    const s = data.solar_reading || {};

    setText("#hist-load", r.energy_kw != null ? `${fmt(r.energy_kw)} kW` : "—");
    setText("#hist-solar", s.solar_kw != null ? `${fmt(s.solar_kw)} kW` : (r.solar_kw != null ? `${fmt(r.solar_kw)} kW` : "—"));
    setText("#hist-hvac", r.hvac_kw != null ? `${fmt(r.hvac_kw)} kW` : "—");
    setText("#hist-occupancy", r.occupancy_pct != null ? `${fmt(r.occupancy_pct)}%` : "—");
    setText("#hist-temp", r.temperature_c != null ? `${fmt(r.temperature_c)} °C` : "—");

    // Render historical events list
    const evList = $("#hist-events-list");
    if (evList) {
      const events = safeArray(data.incidents);
      evList.innerHTML = events.length ? events.map(ev => `
        <div class="event-row">
          <span class="event-dot bad"></span>
          <div>
            <b>${esc(ev.incident_type || "Incident")}</b>
            <span style="display:block;margin-top:4px">${esc(ev.created_at || "—")} · Severity: ${esc(ev.severity || "NORMAL")}</span>
          </div>
        </div>
      `).join("") : `<div class="empty-state">No recorded incidents at this historical timestamp.</div>`;
    }

    // Render historical 24h window chart with vertical marker at selected timestamp
    if (data.series) {
      const norm = normalizeEnergy(data.series);
      await buildChart("history-chart", norm);
    }
  }



  // =========================================================
  // LIME EXPLANATION
  // =========================================================

  /** The active event carries the timestamp and building the explainer needs. */
  function activeEvent() {
    return state.agent?.event || null;
  }

  function setExplainButtons() {
    const busy = state.requestBusy || state.replaying;
    const explain = $("#explain-forecast");
    if (explain) explain.disabled = busy || !activeEvent();
    const report = $("#download-pdf");
    if (report) report.disabled = busy || !state.agent?.has_run;
  }

  async function loadExplanation() {
    const ev = activeEvent();
    if (!ev) {
      toast("Run an analysis first, then explain its forecast.");
      return;
    }
    if (state.requestBusy || state.replaying) return;

    const box = $("#explanation-result");
    if (box) {
      box.className = "empty-state";
      box.textContent = "Fitting a local surrogate around this prediction…";
    }

    setBusy(true);
    try {
      state.explanation = await api("/api/ml/explain", {
        method: "POST",
        body: JSON.stringify({
          timestamp: ev.timestamp,
          building_id: ev.building_id || "CAMPUS",
          num_features: 8
        })
      });
      renderExplanation();
    } catch (e) {
      state.explanation = null;
      if (box) {
        box.className = "";
        box.innerHTML = `<div class="error-banner">${esc(e.message)}</div>`;
      }
      toast(`Explain: ${e.message}`);
    } finally {
      setBusy(false);
      setExplainButtons();
    }
  }

  function renderExplanation() {
    const box = $("#explanation-result");
    if (!box) return;

    const exp = state.explanation;
    if (!exp) {
      box.className = "empty-state";
      box.textContent = "Run an analysis, then explain its forecast.";
      return;
    }

    // A CAMPUS explanation nests one result per building.
    const parts = safeArray(exp.buildings).length ? exp.buildings : [exp];

    // The paragraph is optional: it is absent when no language model is
    // configured, and the bars below carry the explanation on their own.
    const summary = exp.summary
      ? `<p class="lime-summary-text">${esc(exp.summary)}</p>`
      : "";

    box.className = "";
    box.innerHTML = summary + parts.map(part => limeBlock(part, parts.length > 1)).join("");
  }

  function limeBlock(part, showHeading) {
    const rows = safeArray(part.contributions);
    const span = Math.max(...rows.map(r => Math.abs(num(r.weight_kw) ?? 0)), 1e-9);

    const bars = rows.map(r => {
      const w = num(r.weight_kw) ?? 0;
      const width = (Math.abs(w) / span) * 100;
      return `<li class="lime-row">
        <span class="lime-label">${esc(r.condition || r.feature || "—")}</span>
        <span class="lime-bar ${w >= 0 ? "up" : "down"}"><i style="width:${width.toFixed(1)}%"></i></span>
        <span class="lime-weight">${w >= 0 ? "+" : "−"}${Math.abs(w).toFixed(2)} kW</span>
      </li>`;
    }).join("");

    return `
      ${showHeading ? `<h4 class="lime-heading">${esc(building_label(part.building_id))}</h4>` : ""}
      <div class="lime-summary">
        <div><span class="lime-k">Model forecast</span><b>${fmt(part.predicted_kw)} kW</b></div>
        <div><span class="lime-k">Actual reading</span><b>${fmt(part.actual_kw)} kW</b></div>
        <div><span class="lime-k">Residual</span><b>${fmt(part.residual_percent)}%</b></div>
        <div><span class="lime-k">Surrogate baseline</span><b>${fmt(part.lime_intercept)} kW</b></div>
        <div><span class="lime-k">Local fit R²</span><b>${fmt(part.lime_score, 3)}</b></div>
      </div>
      <ul class="lime-list">${bars || `<li class="empty-state">No contributing features returned.</li>`}</ul>
      <p class="panel-footnote">Each bar is one feature's contribution to this single forecast.
      Red pushes the forecast up, green pulls it down. A low R² means the local surrogate fits
      poorly here, so read the weights with that in mind.</p>`;
  }

  function building_label(id) {
    return id === "CAMPUS" ? "Campus total" : `Building ${id}`;
  }

  // =========================================================
  // PDF REPORT
  // =========================================================

  async function downloadReport() {
    if (state.requestBusy || state.replaying) return;
    if (!state.agent?.has_run) {
      toast("Run an analysis first, then download the report.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/report/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ include_explanation: true })
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `HTTP ${res.status}`);
      }

      const name = (res.headers.get("Content-Disposition") || "")
        .match(/filename="?([^";]+)"?/)?.[1] || "incident-report.pdf";

      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast("Report downloaded.");
    } catch (e) {
      toast(`Report: ${e.message}`);
    } finally {
      setBusy(false);
      setExplainButtons();
    }
  }


  // =========================================================
  // ANOMALY BREAKDOWN
  // =========================================================
  //
  // Answers what the KPI count raises but cannot show: which hours were
  // flagged, in which building, and how far the reading sat from the forecast.
  // Built entirely on /api/events, so the backend needs no change.

  // Opens on ENERGY_ANOMALY, because the button sits on the anomalies card and
  // the first view has to match the number printed above it.
  const anomalyState = { kind: "ENERGY_ANOMALY", events: null, loading: false };

  async function toggleAnomalies() {
    const panel = $("#anomaly-panel");
    if (!panel) return;

    if (!panel.hidden) {
      panel.hidden = true;
      return;
    }

    panel.hidden = false;
    panel.scrollIntoView({
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth",
      block: "start"
    });

    if (anomalyState.events) renderAnomalies();
    else await loadAnomalies();
  }

  async function loadAnomalies() {
    if (anomalyState.loading) return;
    anomalyState.loading = true;

    const button = $("#show-anomalies");
    if (button) button.disabled = true;

    const body = $("#anomaly-body");
    if (body) body.innerHTML = `<div class="empty-state">Loading the flagged hours…</div>`;

    try {
      // Each kind is fetched separately. One combined call is capped, and the
      // 348 peak-demand risks crowd out the 83 anomalies in the ordering, so a
      // single request would make this panel contradict the card above it.
      const building = encodeURIComponent(state.building);
      const [anomalies, peaks] = await Promise.all([
        api(`/api/events?building=${building}&type=ENERGY_ANOMALY&limit=500`),
        api(`/api/events?building=${building}&type=PEAK_DEMAND_RISK&limit=500`)
      ]);

      anomalyState.events = [...safeArray(anomalies.events), ...safeArray(peaks.events)]
        .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
      renderAnomalies();
    } catch (e) {
      anomalyState.events = null;
      if (body) body.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`;
    } finally {
      anomalyState.loading = false;
      if (button) button.disabled = false;
    }
  }

  function renderAnomalies() {
    const body = $("#anomaly-body");
    if (!body) return;

    const all = safeArray(anomalyState.events);
    const rows = anomalyState.kind === "all"
      ? all
      : all.filter(e => e.event_type === anomalyState.kind);

    if (!rows.length) {
      body.innerHTML = `<div class="empty-state">No events of this kind for this building.</div>`;
      return;
    }

    const tally = rows.reduce((acc, e) => {
      const key = e.severity || "UNKNOWN";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    const chips = ["CRITICAL", "HIGH", "ELEVATED"]
      .filter(level => tally[level])
      .map(level => `<span class="sev-chip ${level.toLowerCase()}">${tally[level]} ${level.toLowerCase()}</span>`)
      .join("");

    const shown = rows.slice(0, 60);

    body.innerHTML = `
      <div class="anomaly-tally"><b>${rows.length}</b> event${rows.length === 1 ? "" : "s"} ${chips}</div>
      <div class="table-scroll">
        <table class="anomaly-table">
          <thead>
            <tr>
              <th>When</th><th>Building</th><th>Kind</th>
              <th>Severity</th><th>Measure</th><th></th>
            </tr>
          </thead>
          <tbody>${shown.map(anomalyRow).join("")}</tbody>
        </table>
      </div>
      ${rows.length > shown.length
        ? `<p class="panel-footnote">Showing the ${shown.length} most recent of ${rows.length}. The Activity page lists them all.</p>`
        : ""}`;

    $$(".anomaly-analyze", body).forEach(btn => btn.addEventListener("click", () => {
      const ev = shown[Number(btn.dataset.index)];
      if (ev) runAgent(ev);
    }));
  }

  function anomalyRow(ev, index) {
    const value = num(ev.value);

    // `value` is a percentage in both cases, but it means two different things.
    // For an anomaly it is the residual: how far the measured load sat from the
    // forecast, as a share of the forecast. For a peak-demand risk it is the
    // campus total as a share of the grid limit. Printing either as kW, or
    // under one label, would be wrong.
    const measure = value == null
      ? "—"
      : ev.event_type === "PEAK_DEMAND_RISK"
        ? `${value.toFixed(1)}% of grid limit`
        : `${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}% vs forecast`;

    return `
      <tr>
        <td class="nowrap">${esc(ev.timestamp || "—")}</td>
        <td>${esc(ev.building_name || ev.building_id || "—")}</td>
        <td>${esc(ev.event_label || ev.event_type || "—")}</td>
        <td><span class="sev-chip ${esc(String(ev.severity || "").toLowerCase())}">${esc(ev.severity || "—")}</span></td>
        <td class="nowrap">${esc(measure)}</td>
        <td>${ev.actionable
          ? `<button class="text-link anomaly-analyze" data-index="${index}" type="button">Analyze</button>`
          : `<span class="muted-note">Not actionable</span>`}</td>
      </tr>`;
  }


  // =========================================================
  // REPLANNING DIALOG
  // =========================================================
  //
  // When a verified action misses its target the agent proposes an
  // alternative and waits again. That second gate is easy to miss: it appears
  // as one more line on a long page the reader has already scrolled past. This
  // surfaces it as a dialog instead.
  //
  // It decides nothing on its own: both buttons call decision(), the same
  // function the panel buttons use, so there is one approval path, not two.

  let replanDialogRound = null;      // the round currently on screen
  let replanDialogDismissed = null;  // a round the reader chose to postpone

  function showReplanDialog(a) {
    const overlay = $("#replan-overlay");
    if (!overlay) return;

    const round = a.replan_count ?? 1;

    // Already showing this round, or the reader asked to decide later.
    if (replanDialogRound === round || replanDialogDismissed === round) return;

    const v = a.verification || {};
    setText("#replan-round", round);
    setText("#replan-proposal", a.recommendation?.label || "an alternative action");

    const stats = $("#replan-stats");
    if (stats) {
      stats.innerHTML = `
        <div><span>Action</span><b>${esc(v.intended_label || "Previous action")}</b></div>
        <div><span>Expected</span><b>${esc(fmt(v.expected_reduction_kw))} kW</b></div>
        <div><span>Achieved</span><b>${esc(fmt(v.achieved_reduction_kw))} kW</b></div>
        <div class="miss"><span>Reached</span><b>${esc(fmt(v.performance_ratio_percent))}%</b></div>
        <div><span>Target</span><b>${esc(fmt(v.threshold_percent))}%</b></div>`;
    }

    const body = $("#replan-body");
    if (body) {
      body.textContent =
        `It reached ${fmt(v.performance_ratio_percent)}% of the reduction it was expected to deliver, `
        + `short of the ${fmt(v.threshold_percent)}% target. Nothing further runs until you decide.`;
    }

    replanDialogRound = round;
    overlay.hidden = false;
    document.body.classList.add("modal-open");

    // Focus the primary action so the dialog is usable from the keyboard,
    // and so a screen reader lands inside it rather than behind it.
    setTimeout(() => $("#replan-approve")?.focus(), 30);
  }

  function closeReplanDialog() {
    const overlay = $("#replan-overlay");
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    document.body.classList.remove("modal-open");
    replanDialogRound = null;
  }

  function bindReplanDialog() {
    const overlay = $("#replan-overlay");
    if (!overlay) return;

    $("#replan-approve")?.addEventListener("click", () => {
      replanDialogDismissed = replanDialogRound;
      closeReplanDialog();
      decision("approve");
    });

    $("#replan-reject")?.addEventListener("click", () => {
      // Close first, unconditionally. decision() bails out early while another
      // request is in flight, and a dialog that stays open after a click reads
      // as broken even when the refusal is deliberate.
      replanDialogDismissed = replanDialogRound;
      closeReplanDialog();
      decision("reject");
    });

    // Postponing keeps the proposal on the page; it does not decide anything.
    $("#replan-later")?.addEventListener("click", () => {
      replanDialogDismissed = replanDialogRound;
      closeReplanDialog();
      toast("The proposal is still waiting in the decision panel.");
    });

    // Escape postpones rather than approves or rejects, and a click on the
    // backdrop does nothing at all: this gate should not be closed by accident.
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && !overlay.hidden) $("#replan-later")?.click();
    });
  }


  initPage();
})();