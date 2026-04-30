// SDL-MCP Observability Dashboard
// Vanilla ES module — no bundler. Pulls live data via SSE with REST fallback.

const state = {
  repoId: "sdl-mcp",
  token: "",
  abortController: null,
  reconnectAttempt: 0,
  reconnectTimer: null,
  hitRateHistory: [],
  hitRateMax: 60,
  lastSnapshot: null,
};

const els = {};

function $(sel, root = document) {
  return root.querySelector(sel);
}

function $$(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

function panelField(panel, field) {
  return $(`[data-field="${field}"]`, panel);
}

function setText(el, value) {
  if (!el) return;
  el.textContent = value == null ? "—" : String(value);
}

function setVal(panel, field, value) {
  setText(panelField(panel, field), value);
}

function fmtNum(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return "—";
  if (n === 0) return "0";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return Number(n).toFixed(digits);
}

function fmtMs(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (n < 1) return n.toFixed(2) + "ms";
  if (n < 1000) return n.toFixed(0) + "ms";
  return (n / 1000).toFixed(2) + "s";
}

function fmtPct(n, digits = 1) {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toFixed(digits) + "%";
}

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return v.toFixed(v >= 100 ? 0 : 1) + units[i];
}

function fmtUptime(ms) {
  if (ms == null) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function setStatus(stateName, label) {
  if (!els.connStatus) return;
  els.connStatus.dataset.state = stateName;
  const labelEl = $(".conn-label", els.connStatus);
  if (labelEl) labelEl.textContent = label;
}

// -------- Rendering helpers --------
function renderBarList(container, entries, options = {}) {
  if (!container) return;
  const {
    max,
    valueFormatter = (v) => fmtNum(v),
    keyFormatter = (k) => k,
    sort = true,
  } = options;
  if (!entries || entries.length === 0) {
    container.innerHTML = '<div class="muted">No data.</div>';
    return;
  }
  let rows = entries.slice();
  if (sort) rows.sort((a, b) => b.value - a.value);
  rows = rows.slice(0, options.limit ?? 6);
  const computedMax =
    max != null ? max : Math.max(...rows.map((r) => r.value), 1);
  const html = rows
    .map((r) => {
      const pct = clamp((r.value / computedMax) * 100, 0, 100);
      return `<div class="bar-row">
        <span class="bar-key" title="${escapeAttr(r.key)}">${escapeHtml(keyFormatter(r.key))}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct.toFixed(1)}%"></span></span>
        <span class="bar-val">${escapeHtml(valueFormatter(r.value))}</span>
      </div>`;
    })
    .join("");
  container.innerHTML = html;
}

function renderStackBar(container, segments) {
  if (!container) return;
  const total = segments.reduce((acc, s) => acc + (s.value || 0), 0);
  if (total <= 0) {
    container.innerHTML =
      '<div class="muted" style="font-size:11px">No traffic.</div>';
    return;
  }
  const segHtml = segments
    .map((s) => {
      const pct = (s.value / total) * 100;
      return `<span class="stack-seg" data-key="${escapeAttr(s.key)}" style="width:${pct.toFixed(2)}%" title="${escapeAttr(s.key)}: ${pct.toFixed(1)}%"></span>`;
    })
    .join("");
  const legendHtml = `<div class="stack-legend">${segments
    .map(
      (s) =>
        `<span><i style="background:${legendColor(s.key)}"></i>${escapeHtml(s.key.toUpperCase())} ${fmtPct((s.value / total) * 100, 0)}</span>`,
    )
    .join("")}</div>`;
  container.innerHTML = `<div class="stack-track">${segHtml}</div>` + legendHtml;
}

function legendColor(key) {
  const map = {
    fts: "var(--accent)",
    vector: "#b46aff",
    ppr: "var(--warn)",
    rrf: "var(--ok)",
    hybrid: "var(--ok)",
    native: "var(--accent)",
    js: "var(--kind-ts)",
    fallback: "var(--warn)",
    used: "var(--warn)",
    saved: "var(--ok)",
  };
  return map[key] || "var(--accent)";
}

function renderSparkline(svg, data) {
  if (!svg) return;
  if (!data || data.length < 2) {
    svg.innerHTML = "";
    return;
  }
  const w = 200;
  const h = 40;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const stepX = w / (data.length - 1);
  const points = data
    .map((v, i) => {
      const x = i * stepX;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const areaPoints = `0,${h} ${points} ${w},${h}`;
  svg.innerHTML = `<polygon class="spark-area" points="${areaPoints}"/><polyline points="${points}"/>`;
}

function renderDonut(svg, fillPct) {
  if (!svg) return;
  const fill = clamp(fillPct, 0, 100);
  const fillEl = $(".donut-fill", svg);
  if (fillEl) {
    fillEl.setAttribute(
      "stroke-dasharray",
      `${fill.toFixed(2)} ${(100 - fill).toFixed(2)}`,
    );
  }
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

function escapeAttr(s) {
  return escapeHtml(s);
}

// -------- Per-panel updaters --------
function updateBottleneck(b) {
  const panel = $('[data-panel="bottleneck"]');
  if (!panel) return;
  if (!b) {
    setVal(panel, "dominant", "—");
    setVal(panel, "confidence", "—");
    panelField(panel, "topSignals").innerHTML = "";
    return;
  }
  const badge = panelField(panel, "dominant");
  if (badge) {
    badge.textContent = (b.dominant || "—").toUpperCase().replace(/_/g, " ");
    badge.dataset.class = b.dominant || "";
  }
  setVal(
    panel,
    "confidence",
    b.confidence != null ? `CONF ${(b.confidence * 100).toFixed(0)}%` : "—",
  );
  const fill = panelField(panel, "confidenceBar");
  if (fill)
    fill.style.width = `${clamp((b.confidence || 0) * 100, 0, 100).toFixed(1)}%`;

  const list = panelField(panel, "topSignals");
  if (list) {
    const signals = (b.topSignals || []).slice(0, 3);
    list.innerHTML = signals
      .map(
        (s) =>
          `<li class="chip"><strong>${escapeHtml(s.name)}</strong>${escapeHtml(fmtNum(s.value, 2))}<em>${escapeHtml(s.unit || "")}</em></li>`,
      )
      .join("");
  }
}

function updateCache(c) {
  const panel = $('[data-panel="cache"]');
  if (!panel || !c) return;
  setVal(panel, "hitRate", fmtPct(c.overallHitRatePct, 1));
  setVal(panel, "totalHits", fmtNum(c.totalHits));
  setVal(panel, "totalMisses", fmtNum(c.totalMisses));
  setVal(panel, "avgLookupLatencyMs", fmtMs(c.avgLookupLatencyMs));

  const perSource = c.perSource || {};
  const entries = Object.entries(perSource).map(([k, v]) => ({
    key: k,
    value: v?.hitRatePct ?? 0,
  }));
  renderBarList(panelField(panel, "perSource"), entries, {
    max: 100,
    valueFormatter: (v) => fmtPct(v, 0),
  });

  state.hitRateHistory.push(c.overallHitRatePct ?? 0);
  if (state.hitRateHistory.length > state.hitRateMax) {
    state.hitRateHistory.shift();
  }
  renderSparkline(panelField(panel, "hitRateSpark"), state.hitRateHistory);
}

function updateRetrieval(r) {
  const panel = $('[data-panel="retrieval"]');
  if (!panel || !r) return;
  setVal(panel, "totalRetrievals", fmtNum(r.totalRetrievals));
  setVal(panel, "avgLatencyMs", fmtMs(r.avgLatencyMs));
  setVal(panel, "p95LatencyMs", fmtMs(r.p95LatencyMs));
  setVal(panel, "emptyResultCount", fmtNum(r.emptyResultCount));

  const candPerSource = r.candidateCountPerSource || {};
  const segments = ["fts", "vector", "ppr", "rrf"]
    .filter((k) => candPerSource[k] != null)
    .map((k) => ({ key: k, value: candPerSource[k] || 0 }));
  if (segments.length > 0) {
    renderStackBar(panelField(panel, "hybridMix"), segments);
  } else {
    const byMode = r.byMode || {};
    const modeSegs = Object.entries(byMode).map(([k, v]) => ({
      key: k,
      value: v || 0,
    }));
    renderStackBar(panelField(panel, "hybridMix"), modeSegs);
  }

  const candEntries = Object.entries(candPerSource).map(([k, v]) => ({
    key: k,
    value: v || 0,
  }));
  renderBarList(panelField(panel, "candidateCounts"), candEntries, {
    valueFormatter: (v) => fmtNum(v),
    limit: 6,
  });
}

function updateBeam(b) {
  const panel = $('[data-panel="beam"]');
  if (!panel || !b) return;
  setVal(panel, "totalSliceBuilds", fmtNum(b.totalSliceBuilds));
  setVal(panel, "avgBuildMs", fmtMs(b.avgBuildMs));
  setVal(panel, "p95BuildMs", fmtMs(b.p95BuildMs));
  setVal(panel, "retainedExplainHandles", fmtNum(b.retainedExplainHandles));
  setVal(panel, "avgAccepted", fmtNum(b.avgAccepted, 1));
  setVal(panel, "avgEvicted", fmtNum(b.avgEvicted, 1));
  setVal(panel, "avgRejected", fmtNum(b.avgRejected, 1));
}

function updateIndexing(i) {
  const panel = $('[data-panel="indexing"]');
  if (!panel || !i) return;
  setVal(panel, "filesPerMinute", fmtNum(i.filesPerMinute, 1) + "/min");
  setVal(panel, "avgPass1Ms", fmtMs(i.avgPass1Ms));
  setVal(panel, "avgPass2Ms", fmtMs(i.avgPass2Ms));
  setVal(panel, "failures", fmtNum(i.failures));

  const ed = i.engineDispatch || { rust: 0, ts: 0 };
  const total = (ed.rust || 0) + (ed.ts || 0);
  const rustPct = total > 0 ? (ed.rust / total) * 100 : 0;
  setVal(panel, "rustPct", fmtPct(rustPct, 0));
  setVal(panel, "tsPct", fmtPct(100 - rustPct, 0));
  renderDonut(panelField(panel, "engineDonut"), rustPct);

  const langs = i.perLanguageAvgMs || {};
  const langEntries = Object.entries(langs).map(([k, v]) => ({
    key: k,
    value: v || 0,
  }));
  renderBarList(panelField(panel, "slowestLanguages"), langEntries, {
    valueFormatter: (v) => fmtMs(v),
    limit: 5,
  });
}

function updateTokenEfficiency(t, packed) {
  const panel = $('[data-panel="tokenEfficiency"]');
  if (!panel || !t) return;
  setVal(panel, "savingsRatio", fmtPct((t.savingsRatio || 0) * 100, 1));
  setVal(panel, "totalUsed", fmtNum(t.totalUsed));
  setVal(panel, "totalSaved", fmtNum(t.totalSaved));
  setVal(panel, "avgPerCall", fmtNum(t.avgPerCall, 1));

  renderStackBar(panelField(panel, "usedVsSaved"), [
    { key: "used", value: t.totalUsed || 0 },
    { key: "saved", value: t.totalSaved || 0 },
  ]);

  if (packed) {
    setVal(panel, "packedAdoptionPct", fmtPct(packed.packedAdoptionPct, 1));
    setVal(panel, "packedBytesSaved", fmtBytes(packed.bytesSaved));
    renderPerEncoderBreakdown(panel, packed.byEncoder ?? {});
  }
}

function renderPerEncoderBreakdown(panel, byEncoder) {
  const host = panelField(panel, "packedByEncoder");
  if (!host) return;
  const entries = Object.entries(byEncoder);
  if (entries.length === 0) {
    host.textContent = "—";
    return;
  }
  const rows = entries
    .sort((a, b) => b[1].bytesSaved - a[1].bytesSaved)
    .map(([id, m]) => {
      const adoption = fmtPct(m.packedAdoptionPct, 1);
      const bytes = fmtBytes(m.bytesSaved);
      return `<tr><td class="enc">${escapeHtml(id)}</td><td class="adopt">${escapeHtml(adoption)}</td><td class="saved">${escapeHtml(bytes)}</td><td class="count">${escapeHtml(String(m.totalDecisions))}</td></tr>`;
    });
  host.innerHTML =
    `<table class="per-encoder"><thead><tr><th>encoder</th><th>adoption</th><th>saved</th><th>n</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function updateHealth(h) {
  const panel = $('[data-panel="health"]');
  if (!panel || !h) return;
  setVal(panel, "score", fmtNum(h.score, 0));
  const comps = h.components || {};
  const entries = Object.entries(comps).map(([k, v]) => ({
    key: k,
    value: (v || 0) * 100,
  }));
  renderBarList(panelField(panel, "components"), entries, {
    max: 100,
    valueFormatter: (v) => fmtPct(v, 0),
    sort: false,
  });
  setVal(panel, "watcherRunning", h.watcherRunning ? "ON" : "OFF");
  setVal(panel, "watcherQueueDepth", fmtNum(h.watcherQueueDepth));
  setVal(panel, "watcherStale", h.watcherStale ? "STALE" : "FRESH");
}

function updateLatency(l) {
  const panel = $('[data-panel="latency"]');
  if (!panel || !l) return;
  setVal(panel, "p95Ms", fmtMs(l.p95Ms));
  setVal(panel, "avgMs", fmtMs(l.avgMs));
  setVal(panel, "p50Ms", fmtMs(l.p50Ms));
  setVal(panel, "p99Ms", fmtMs(l.p99Ms));
  setVal(panel, "maxMs", fmtMs(l.maxMs));

  const tools = l.perTool || {};
  const rows = Object.entries(tools)
    .map(([name, m]) => ({
      name,
      count: m?.count ?? 0,
      avgMs: m?.avgMs ?? 0,
      p95Ms: m?.p95Ms ?? 0,
      errors: m?.errorCount ?? 0,
    }))
    .sort((a, b) => b.p95Ms - a.p95Ms)
    .slice(0, 6);

  const container = panelField(panel, "perTool");
  if (!container) return;
  if (rows.length === 0) {
    container.innerHTML = '<div class="muted">No calls yet.</div>';
    return;
  }
  container.innerHTML = `
    <span class="th">TOOL</span>
    <span class="th td-num">N</span>
    <span class="th td-num">P95</span>
    <span class="th td-num">ERR</span>
    ${rows
      .map(
        (r) => `
      <span class="td td-name" title="${escapeAttr(r.name)}">${escapeHtml(r.name)}</span>
      <span class="td td-num">${escapeHtml(fmtNum(r.count))}</span>
      <span class="td td-num">${escapeHtml(fmtMs(r.p95Ms))}</span>
      <span class="td td-num">${escapeHtml(fmtNum(r.errors))}</span>
    `,
      )
      .join("")}`;
}

function updatePool(p) {
  const panel = $('[data-panel="resources"]');
  if (!panel || !p) return;
  setVal(panel, "avgWriteQueued", fmtNum(p.avgWriteQueued, 1));
  setVal(panel, "avgDrainQueueDepth", fmtNum(p.avgDrainQueueDepth, 1));
}

function updateScip(s) {
  const panel = $('[data-panel="scip"]');
  if (!panel || !s) return;
  setVal(
    panel,
    "lastIngestAt",
    s.lastIngestAt ? new Date(s.lastIngestAt).toLocaleTimeString() : "never",
  );
  setVal(panel, "successCount", fmtNum(s.successCount));
  setVal(panel, "failureCount", fmtNum(s.failureCount));
  setVal(panel, "avgIngestMs", fmtMs(s.avgIngestMs));
  setVal(panel, "totalEdgesCreated", fmtNum(s.totalEdgesCreated));
  setVal(panel, "totalEdgesUpgraded", fmtNum(s.totalEdgesUpgraded));
}

function updatePacked(p) {
  // packed metrics also surface in tokenEfficiency panel; nothing else needs updating here
  void p;
}

function updatePpr(p) {
  const panel = $('[data-panel="ppr"]');
  if (!panel || !p) return;
  setVal(panel, "totalRuns", fmtNum(p.totalRuns));
  setVal(panel, "avgComputeMs", fmtMs(p.avgComputeMs));
  setVal(panel, "p95ComputeMs", fmtMs(p.p95ComputeMs));
  setVal(panel, "avgSeedCount", fmtNum(p.avgSeedCount, 1));
  renderStackBar(panelField(panel, "dispatchMix"), [
    { key: "native", value: p.nativeCount || 0 },
    { key: "js", value: p.jsCount || 0 },
    { key: "fallback", value: p.fallbackCount || 0 },
  ]);
}

function updateResources(r, uptimeMs) {
  const panel = $('[data-panel="resources"]');
  if (!panel || !r) return;
  const subEl = panelField(panel, "cpuPctAvg");
  if (subEl) subEl.textContent = fmtPct(r.cpuPctAvg, 1);
  setVal(panel, "cpuPctAvg2", fmtPct(r.cpuPctAvg, 1));
  setVal(panel, "cpuPctMax", fmtPct(r.cpuPctMax, 1));
  setVal(panel, "rssMb", fmtNum(r.rssMb, 0) + " MB");
  setVal(panel, "rssMbMax", fmtNum(r.rssMbMax, 0) + " MB");
  setVal(panel, "heapUsedMb", fmtNum(r.heapUsedMb, 0) + " MB");
  setVal(panel, "heapTotalMb", fmtNum(r.heapTotalMb, 0) + " MB");
  setVal(panel, "eventLoopLagP95Ms", fmtMs(r.eventLoopLagP95Ms));
  setVal(panel, "eventLoopLagMaxMs", fmtMs(r.eventLoopLagMaxMs));
  setVal(panel, "uptimeMs", fmtUptime(uptimeMs));
}

function updateToolVolume(t) {
  const panel = $('[data-panel="toolVolume"]');
  if (!panel || !t) return;
  setVal(panel, "callsPerMinute", fmtNum(t.callsPerMinute, 1) + "/min");
  setVal(panel, "totalCalls", fmtNum(t.totalCalls));

  const perTool = t.perTool || {};
  const errs = t.perToolErrors || {};
  const rows = Object.entries(perTool).map(([k, v]) => ({
    key: k,
    value: v || 0,
    errors: errs[k] || 0,
  }));
  renderBarList(panelField(panel, "perTool"), rows, {
    valueFormatter: (v) => fmtNum(v),
    limit: 8,
  });
}

// -------- Main snapshot apply --------
function applySnapshot(snap) {
  if (!snap || typeof snap !== "object") return;
  state.lastSnapshot = snap;
  try {
    updateBottleneck(snap.bottleneck);
    updateCache(snap.cache);
    updateRetrieval(snap.retrieval);
    updateBeam(snap.beam);
    updateIndexing(snap.indexing);
    updateTokenEfficiency(snap.tokenEfficiency, snap.packed);
    updateHealth(snap.health);
    updateLatency(snap.latency);
    updatePool(snap.pool);
    updateScip(snap.scip);
    updatePacked(snap.packed);
    updatePpr(snap.ppr);
    updateResources(snap.resources, snap.uptimeMs);
    updateToolVolume(snap.toolVolume);
  } catch (err) {
    console.error("[observability] applySnapshot error:", err);
  }
}

// -------- Networking --------
function buildHeaders() {
  const h = { Accept: "application/json" };
  if (state.token) h.Authorization = `Bearer ${state.token}`;
  return h;
}

async function fetchSnapshot() {
  const url = `/api/observability/snapshot?repoId=${encodeURIComponent(state.repoId)}`;
  try {
    const resp = await fetch(url, { headers: buildHeaders() });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    applySnapshot(json);
  } catch (err) {
    console.warn("[observability] fetchSnapshot failed:", err);
  }
}

async function connectStream() {
  if (state.abortController) {
    state.abortController.abort();
  }
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  state.abortController = new AbortController();
  setStatus("connecting", "CONNECTING");

  const url = `/api/observability/stream?repoId=${encodeURIComponent(state.repoId)}`;
  try {
    const resp = await fetch(url, {
      headers: { ...buildHeaders(), Accept: "text/event-stream" },
      signal: state.abortController.signal,
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`SSE failed: HTTP ${resp.status}`);
    }
    setStatus("connected", "LIVE");
    state.reconnectAttempt = 0;
    await consumeSse(resp.body);
    // stream ended naturally — schedule reconnect
    scheduleReconnect();
  } catch (err) {
    if (err && err.name === "AbortError") return;
    console.warn("[observability] SSE error:", err);
    scheduleReconnect();
  }
}

async function consumeSse(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const evt = parseSseEvent(raw);
      handleSseEvent(evt);
    }
  }
}

function parseSseEvent(raw) {
  const out = { event: "message", data: "" };
  const lines = raw.split(/\r?\n/);
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim();
    let val = line.slice(colon + 1);
    if (val.startsWith(" ")) val = val.slice(1);
    if (field === "event") out.event = val;
    else if (field === "data") dataLines.push(val);
  }
  out.data = dataLines.join("\n");
  return out;
}

function handleSseEvent(evt) {
  if (evt.event === "snapshot") {
    try {
      const snap = JSON.parse(evt.data);
      applySnapshot(snap);
    } catch (err) {
      console.warn("[observability] bad snapshot payload:", err);
    }
  } else if (evt.event === "heartbeat") {
    // keep-alive only
  } else if (evt.event === "error") {
    setStatus("error", "ERROR");
  }
}

function scheduleReconnect() {
  state.reconnectAttempt += 1;
  const delay = Math.min(30000, 1000 * Math.pow(2, state.reconnectAttempt - 1));
  setStatus("disconnected", `RETRY ${Math.round(delay / 1000)}s`);
  state.reconnectTimer = setTimeout(() => {
    connectStream();
  }, delay);
}

// -------- Beam explain modal --------
async function fetchBeamExplain(sliceHandle, symbolId) {
  const params = new URLSearchParams({ repoId: state.repoId });
  if (sliceHandle) params.set("sliceHandle", sliceHandle);
  if (symbolId) params.set("symbolId", symbolId);
  const url = `/api/observability/beam-explain?${params.toString()}`;
  const body = els.beamBody;
  if (body) body.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const resp = await fetch(url, { headers: buildHeaders() });
    if (resp.status === 404) {
      if (body)
        body.innerHTML =
          '<p class="muted">No explain data for that handle.</p>';
      return;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    renderBeamExplain(json);
  } catch (err) {
    if (body)
      body.innerHTML = `<p class="muted">Error: ${escapeHtml(err.message || "request failed")}</p>`;
  }
}

function renderBeamExplain(resp) {
  const body = els.beamBody;
  if (!body) return;
  if (!resp || !Array.isArray(resp.entries) || resp.entries.length === 0) {
    body.innerHTML = '<p class="muted">No entries.</p>';
    return;
  }
  const headerHtml = `
    <p class="muted" style="margin-top:0">
      Slice <strong>${escapeHtml(resp.sliceHandle || "")}</strong> · built ${escapeHtml(resp.builtAt || "")}
      ${resp.truncated ? '· <em style="color:var(--warn)">TRUNCATED</em>' : ""}
    </p>`;
  const entriesHtml = resp.entries
    .map((e) => {
      const c = e.components || {};
      const compHtml = Object.entries(c)
        .map(
          ([k, v]) =>
            `<span>${escapeHtml(k)}<strong>${escapeHtml(fmtNum(v, 2))}</strong></span>`,
        )
        .join("");
      const edgeHtml = e.edgeType
        ? `<span class="muted" style="font-size:9px">${escapeHtml(e.edgeType)} w=${escapeHtml(fmtNum(e.edgeWeight ?? 0, 2))}</span>`
        : "";
      return `<div class="beam-entry" data-decision="${escapeAttr(e.decision)}">
        <span class="pill">${escapeHtml(e.decision)}</span>
        <span class="muted">it ${escapeHtml(String(e.iteration ?? 0))}</span>
        <span class="beam-sym" title="${escapeAttr(e.symbolId)}">${escapeHtml(e.symbolId.slice(0, 16))}</span>
        <span class="muted">${escapeHtml(fmtNum(e.totalScore, 3))}</span>
        ${edgeHtml ? `<span class="beam-comp">${edgeHtml}</span>` : ""}
        <span class="beam-why">${escapeHtml(e.why || "")}</span>
        <span class="beam-comp">${compHtml}</span>
      </div>`;
    })
    .join("");
  body.innerHTML = headerHtml + entriesHtml;
}

// -------- Setup --------
function readUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const repoId = params.get("repoId");
  if (repoId) state.repoId = repoId;
  const stored = localStorage.getItem("sdl-mcp-observability-token");
  if (stored) state.token = stored;
  // Hash-bootstrap escape hatch: tokens in the URL hash are NOT sent in
  // Referer headers and don't appear in standard server access logs. Stash
  // and immediately strip from the address bar.
  const hashParams = new URLSearchParams(
    window.location.hash.replace(/^#/, ""),
  );
  const hashToken = hashParams.get("token");
  if (hashToken) {
    state.token = hashToken;
    localStorage.setItem("sdl-mcp-observability-token", hashToken);
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }
}

function bind() {
  els.connStatus = $("#connStatus");
  els.repoInput = $("#repoInput");
  els.tokenInput = $("#tokenInput");
  els.connectBtn = $("#connectBtn");
  els.systemToggleBtn = $("#systemToggleBtn");
  els.dashboard = $("#dashboard");
  els.beamForm = $("#beamExplainForm");
  els.beamModal = $("#beamExplainModal");
  els.beamBody = $("#beamExplainBody");

  if (els.repoInput) els.repoInput.value = state.repoId;
  if (els.tokenInput) els.tokenInput.value = state.token;

  if (els.connectBtn) {
    els.connectBtn.addEventListener("click", () => {
      state.repoId = (els.repoInput?.value || "sdl-mcp").trim() || "sdl-mcp";
      state.token = els.tokenInput?.value?.trim() || "";
      if (state.token)
        localStorage.setItem("sdl-mcp-observability-token", state.token);
      state.reconnectAttempt = 0;
      fetchSnapshot();
      connectStream();
    });
  }

  if (els.systemToggleBtn) {
    els.systemToggleBtn.addEventListener("click", () => {
      const visible = els.dashboard.dataset.systemVisible === "true";
      els.dashboard.dataset.systemVisible = visible ? "false" : "true";
      els.systemToggleBtn.setAttribute(
        "aria-pressed",
        visible ? "false" : "true",
      );
    });
  }

  if (els.beamForm) {
    els.beamForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const handle = $("#beamSliceHandle")?.value?.trim();
      const sym = $("#beamSymbolId")?.value?.trim();
      if (!handle) return;
      if (els.beamModal && typeof els.beamModal.showModal === "function") {
        els.beamModal.showModal();
      }
      fetchBeamExplain(handle, sym || undefined);
    });
  }

  if (els.beamModal) {
    els.beamModal.addEventListener("click", (ev) => {
      const target = ev.target;
      if (target instanceof HTMLElement && target.dataset.close === "modal") {
        els.beamModal.close();
      }
    });
  }
}

function init() {
  readUrlParams();
  bind();
  setStatus("idle", "IDLE");
  // initial best-effort hydration; harmless if endpoints don't exist yet
  fetchSnapshot();
  connectStream();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
