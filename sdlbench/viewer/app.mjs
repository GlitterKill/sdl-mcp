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

  return {
    variants,
    tasks,
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

if (typeof window !== "undefined") {
  boot();
}

async function boot() {
  const state = { records: [], variant: "all", task: "all", source: "server" };
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

function wireFilters(state) {
  const model = buildChartModel(state.records);
  fillSelect("variant-filter", ["all", ...model.variants]);
  fillSelect("task-filter", ["all", ...model.tasks]);
  const variantFilter = document.querySelector("#variant-filter");
  const taskFilter = document.querySelector("#task-filter");
  if (variantFilter) variantFilter.onchange = (event) => {
    state.variant = event.target.value;
    render(state);
  };
  if (taskFilter) taskFilter.onchange = (event) => {
    state.task = event.target.value;
    render(state);
  };
}

function render(state) {
  const records = state.records.filter((record) =>
    (state.variant === "all" || record.variant === state.variant) &&
    (state.task === "all" || record.taskId === state.task)
  );
  const model = buildChartModel(records);
  document.querySelector("#data-source").textContent = state.source;
  document.querySelector("#session-count").textContent = String(records.length);
  document.querySelector("#variant-count").textContent = String(model.variants.length);
  document.querySelector("#saved-count").textContent = String(model.tokenSavings.reduce((sum, row) => sum + row.saved, 0));
  document.querySelector("#pass-rate").textContent = `${average(model.correctness, "passRate").toFixed(1)}%`;
  document.querySelector("#avg-time").textContent = `${average(model.timeToCompletion, "avgDuration").toFixed(0)}ms`;
  drawBars("token-chart", model.tokenSavings, "saved", "Saved tokens");
  drawBars("cost-chart", model.tokenSavings, "cost", "Cost USD");
  drawBars("time-chart", model.timeToCompletion, "avgDuration", "Time to completion ms");
  drawBars("correctness-chart", model.correctness, "passRate", "Correctness pass rate");
  drawTimeline("timeline-chart", model.timeline);
  drawMatrix("matrix", records);
  document.body.classList.toggle("is-empty", records.length === 0);
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
