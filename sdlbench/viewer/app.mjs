export function parseJsonl(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function buildChartModel(records) {
  const variants = [...new Set(records.map((record) => record.variant))].sort();
  const tasks = [...new Set(records.map((record) => record.taskId))].sort();
  const executionModes = [...new Set(records.map((record) => record.workflow?.executionMode ?? "unknown"))].sort();
  const grouped = new Map();

  for (const record of records) {
    const key = record.variant;
    const row = grouped.get(key) ?? { variant: key, sessions: 0, passed: 0, saved: 0, total: 0, cost: 0, duration: 0, failures: 0 };
    row.sessions += 1;
    row.passed += record.quality?.passed ? 1 : 0;
    row.saved += record.tokens?.saved ?? 0;
    row.total += record.tokens?.total ?? 0;
    row.cost += record.cost?.totalUsd ?? 0;
    row.duration += record.durationMs ?? 0;
    row.failures += record.quality?.passed ? 0 : 1;
    grouped.set(key, row);
  }

  const rows = [...grouped.values()].map((row) => ({
    ...row,
    avgDuration: row.sessions ? Math.round(row.duration / row.sessions) : 0,
    errorRate: row.sessions ? Math.round((row.failures / row.sessions) * 10000) / 100 : 0,
    passRate: row.sessions ? Math.round((row.passed / row.sessions) * 10000) / 100 : 0,
  }));

  const pairedDeltas = buildViewerPairedDeltas(records);
  const warnings = buildViewerWarnings(records, executionModes);

  return {
    variants,
    tasks,
    executionModes,
    pairedDeltas,
    warnings,
    tokenSavings: rows,
    timeToCompletion: rows.map((row) => ({ variant: row.variant, avgDuration: row.avgDuration, sessions: row.sessions })),
    correctness: rows.map((row) => ({ variant: row.variant, passRate: row.passRate, errorRate: row.errorRate, sessions: row.sessions })),
    timeline: records.map((record, index) => ({
      index,
      variant: record.variant,
      taskId: record.taskId,
      durationMs: record.durationMs ?? 0,
      tokens: record.tokens?.total ?? 0,
      passed: Boolean(record.quality?.passed),
    })),
  };
}

function buildViewerPairedDeltas(records) {
  const slots = new Map();
  for (const record of records) {
    if (!record.quality?.passed) continue;
    const mode = record.workflow?.executionMode ?? "unknown";
    const key = `${record.taskId}|${record.agent ?? "unknown"}|${record.model ?? "unknown"}|${mode}`;
    let slot = slots.get(key);
    if (!slot) {
      slot = {};
      slots.set(key, slot);
    }
    slot[record.variant] = record;
  }
  const paired = [];
  for (const slot of slots.values()) {
    const baseline = slot.baseline;
    const sdl = slot.sdl;
    if (!baseline || !sdl) continue;
    const baselineTok = baseline.tokens?.total ?? 0;
    const sdlTok = sdl.tokens?.total ?? 0;
    const deltaTok = baselineTok - sdlTok;
    paired.push({
      taskId: baseline.taskId,
      variant: sdl.variant,
      executionMode: baseline.workflow?.executionMode ?? "unknown",
      baselineTok,
      sdlTok,
      deltaTok,
      deltaPct: baselineTok ? Math.round((deltaTok / baselineTok) * 10000) / 100 : 0,
      bothPass: Boolean(baseline.quality?.passed) && Boolean(sdl.quality?.passed),
    });
  }
  return paired;
}

function buildViewerWarnings(records, executionModes) {
  const warnings = [];
  if (executionModes.includes("fixture") && executionModes.includes("behavior")) {
    warnings.push("mixed fixture and behavior sessions");
  }
  const noneGrade = records.filter((record) => record.claimGrade === "none").length;
  if (noneGrade > 0) {
    warnings.push(`${noneGrade} records carry claim-grade none (no savings claimed)`);
  }
  const nonzeroSaved = records.filter((record) => (record.tokens?.saved ?? 0) > 0).length;
  if (nonzeroSaved > 0) {
    warnings.push(`${nonzeroSaved} records report nonzero saved (verify claim-grade)`);
  }
  return warnings;
}

if (typeof window !== "undefined") {
  boot();
}

async function boot() {
  const state = { records: [], variant: "all", task: "all", executionMode: "all", source: "server" };
  document.querySelector("#data-file")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    state.records = parseJsonl(await file.text());
    state.source = file.name;
    wireFilters(state);
    render(state);
  });
  document.querySelector("#reload-data")?.addEventListener("click", async () => {
    await loadServerData(state);
    wireFilters(state);
    render(state);
  });
  document.querySelector("#load-sidecars")?.addEventListener("click", () => loadSidecarFiles(state));
  document.querySelector("#export-token-chart")?.addEventListener("click", () => exportSvg("token-chart"));
  await loadServerData(state);
  wireFilters(state);
  render(state);
}

async function loadServerData(state) {
  try {
    const response = await fetch("/results/sessions.jsonl", { cache: "no-store" });
    state.records = response.ok ? parseJsonl(await response.text()) : [];
    state.source = "/results/sessions.jsonl";
  } catch {
    state.records = [];
    state.source = "unloaded";
  }
}

async function loadSidecarFiles(state) {
  try {
    const response = await fetch("/results/list.json", { cache: "no-store" });
    if (!response.ok) {
      renderWarning(["sidecar listing unavailable"]);
      return;
    }
    const listing = await response.json();
    const files = Array.isArray(listing.files) ? listing.files : [];
    const loaded = [];
    for (const file of files) {
      if (file === "sessions.jsonl") continue;
      const res = await fetch(`/results/${encodeURIComponent(file)}`, { cache: "no-store" });
      if (res.ok) loaded.push(...parseJsonl(await res.text()));
    }
    if (loaded.length) {
      state.records = [...state.records, ...loaded];
      state.source = `server + ${loaded.length} sidecar records`;
      wireFilters(state);
      render(state);
    } else {
      renderWarning(["no sidecar records found"]);
    }
  } catch {
    renderWarning(["sidecar loading failed"]);
  }
}

function wireFilters(state) {
  const model = buildChartModel(state.records);
  fillSelect("variant-filter", ["all", ...model.variants]);
  fillSelect("task-filter", ["all", ...model.tasks]);
  fillSelect("execution-mode-filter", ["all", ...model.executionModes]);
  const variantFilter = document.querySelector("#variant-filter");
  const taskFilter = document.querySelector("#task-filter");
  const modeFilter = document.querySelector("#execution-mode-filter");
  if (variantFilter) variantFilter.onchange = (event) => {
    state.variant = event.target.value;
    render(state);
  };
  if (taskFilter) taskFilter.onchange = (event) => {
    state.task = event.target.value;
    render(state);
  };
  if (modeFilter) modeFilter.onchange = (event) => {
    state.executionMode = event.target.value;
    render(state);
  };
}

function render(state) {
  const records = state.records.filter((record) =>
    (state.variant === "all" || record.variant === state.variant) &&
    (state.task === "all" || record.taskId === state.task) &&
    (state.executionMode === "all" || (record.workflow?.executionMode ?? "unknown") === state.executionMode)
  );
  const model = buildChartModel(records);
  document.querySelector("#data-source").textContent = state.source;
  document.querySelector("#session-count").textContent = String(records.length);
  document.querySelector("#variant-count").textContent = String(model.variants.length);
  document.querySelector("#paired-count").textContent = String(model.pairedDeltas.length);
  document.querySelector("#saved-count").textContent = String(model.pairedDeltas.reduce((sum, row) => sum + Math.max(0, row.deltaTok), 0));
  document.querySelector("#pass-rate").textContent = `${average(model.correctness, "passRate").toFixed(1)}%`;
  document.querySelector("#avg-time").textContent = `${average(model.timeToCompletion, "avgDuration").toFixed(0)}ms`;
  renderWarnings(model.warnings);
  drawPairedBars("paired-chart", model.pairedDeltas);
  drawScalingCurve("scaling-chart", model.pairedDeltas);
  drawBars("token-chart", model.tokenSavings, "saved", "Saved tokens");
  drawBars("cost-chart", model.tokenSavings, "cost", "Cost USD");
  drawBars("time-chart", model.timeToCompletion, "avgDuration", "Time to completion ms");
  drawBars("correctness-chart", model.correctness, "passRate", "Correctness pass rate");
  drawTimeline("timeline-chart", model.timeline);
  drawMatrix("matrix", records);
  document.body.classList.toggle("is-empty", records.length === 0);
}

function renderWarnings(warnings) {
  const banner = document.querySelector("#warning-banner");
  if (!banner) return;
  const items = warnings.length ? warnings : [];
  banner.innerHTML = items.map((warning) => `<p class="warning">${escapeHtml(warning)}</p>`).join("");
  banner.classList.toggle("has-warnings", items.length > 0);
}

function drawPairedBars(id, rows) {
  const svg = document.querySelector(`#${id}`);
  if (!svg) return;
  const maxAbs = Math.max(1, ...rows.map((row) => Math.abs(row.deltaTok)));
  const barX = 180;
  const barMax = 280;
  const center = 150;
  const top = 58;
  const rowGap = 52;
  const barHeight = 24;
  const g = (row, index) => {
    const y = top + index * rowGap;
    const width = Math.max(8, (Math.abs(row.deltaTok) / maxAbs) * barMax);
    const saving = row.deltaTok >= 0;
    const x = saving ? center : center - width;
    const value = format(row.deltaTok);
    const label = `${escapeHtml(row.taskId)} · ${escapeHtml(row.executionMode)}`;
    return `<g><text x="16" y="${y}" class="axis">${label}</text><rect x="${x}" y="${y - 22}" width="${width}" height="${barHeight}" rx="3" class="${saving ? "ok" : "bad"}"/><text x="${center + (saving ? width + 8 : -width - 8)}" y="${y}" class="value" text-anchor="${saving ? "start" : "end"}">${value}</text></g>`;
  };
  svg.innerHTML = rows.map(g).join("") + `<text x="6" y="18" class="title">Pass-gated paired token delta (sdl vs baseline)</text>`;
}

function drawScalingCurve(id, pairedDeltas) {
  const svg = document.querySelector(`#${id}`);
  if (!svg) return;
  const bySize = new Map();
  for (const pair of pairedDeltas) {
    const key = pair.executionMode ?? "unknown";
    let row = bySize.get(key);
    if (!row) { row = { mode: key, total: 0, count: 0 }; bySize.set(key, row); }
    row.total += pair.deltaPct;
    row.count += 1;
  }
  const rows = [...bySize.values()].map((row) => ({ mode: row.mode, avgDeltaPct: row.count ? row.total / row.count : 0 }));
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.avgDeltaPct)));
  const barX = 160;
  const barMax = 300;
  const top = 58;
  const rowGap = 52;
  const barHeight = 28;
  svg.innerHTML = rows.map((row, i) => {
    const y = top + i * rowGap;
    const width = Math.max(10, (Math.abs(row.avgDeltaPct) / max) * barMax);
    const saving = row.avgDeltaPct >= 0;
    return `<g><text x="16" y="${y}" class="axis">${escapeHtml(row.mode)}</text><rect x="${barX}" y="${y - 22}" width="${width}" height="${barHeight}" rx="3" class="${saving ? "ok" : "bad"}"/><text x="${barX + width + 14}" y="${y}" class="value">${row.avgDeltaPct.toFixed(1)}%</text></g>`;
  }).join("") + `<text x="6" y="18" class="title">Avg paired savings by execution mode</text>`;
}

function drawBars(id, rows, field, label) {
  const svg = document.querySelector(`#${id}`);
  const max = Math.max(1, ...rows.map((row) => row[field]));
  const barX = 180;
  const barMax = 560;
  const top = 58;
  const rowGap = 52;
  const barHeight = 28;
  svg.innerHTML = rows.map((row, index) => {
    const width = Math.max(10, (row[field] / max) * barMax);
    const y = top + index * rowGap;
    const valueX = Math.min(barX + width + 14, 815);
    return `<g><text x="16" y="${y}" class="axis">${escapeHtml(row.variant)}</text><rect x="${barX}" y="${y - 22}" width="${width}" height="${barHeight}" rx="3"/><text x="${valueX}" y="${y}" class="value">${format(row[field])}</text></g>`;
  }).join("") + `<text x="6" y="18" class="title">${label}</text>`;
}

function drawTimeline(id, rows) {
  const svg = document.querySelector(`#${id}`);
  const max = Math.max(1, ...rows.map((row) => row.durationMs));
  svg.innerHTML = rows.map((row, index) => {
    const x = 20 + index * 34;
    const height = Math.max(4, (row.durationMs / max) * 120);
    return `<g><rect x="${x}" y="${154 - height}" width="18" height="${height}" class="${row.passed ? "ok" : "bad"}"/><title>${escapeHtml(row.variant)} ${escapeHtml(row.taskId)} ${row.durationMs}ms</title></g>`;
  }).join("") + `<text x="6" y="18" class="title">Per-task timeline</text>`;
}

function drawMatrix(id, records) {
  const host = document.querySelector(`#${id}`);
  host.innerHTML = records.map((record) => `<div class="matrix-row"><span>${escapeHtml(record.variant)}</span><span>${escapeHtml(record.taskId)}</span><span>${format(record.tokens?.total ?? 0)} tok</span><span>${format(record.durationMs ?? 0)}ms</span><span class="${record.quality?.passed ? "win" : "loss"}">${record.status}</span></div>`).join("");
}

function fillSelect(id, values) {
  const select = document.querySelector(`#${id}`);
  const previous = select.value;
  select.innerHTML = values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
  if (values.includes(previous)) select.value = previous;
}

function exportSvg(id) {
  const svg = document.querySelector(`#${id}`);
  const image = new Image();
  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.outerHTML)}`;
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 260;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#070b10";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const link = document.createElement("a");
    link.download = `${id}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };
  image.src = source;
}

function average(rows, field) {
  return rows.length ? rows.reduce((sum, row) => sum + row[field], 0) / rows.length : 0;
}

function format(value) {
  return typeof value === "number" ? Number(value.toFixed(4)).toLocaleString() : value;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}
