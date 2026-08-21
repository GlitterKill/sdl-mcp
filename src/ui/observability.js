// SDL-MCP Observability Dashboard
// Vanilla ES module — no bundler. Pulls live data via SSE with REST fallback.

import { buildToolOutputViewModel } from "./observability-tool-output.js";
import {
  lifetimePresentation,
  METRIC_DISPOSITIONS,
  sessionPanelState as deriveSessionPanelState,
  TIMESERIES_PANEL_MAP,
  validObservabilitySnapshot,
  validTimeseries15mResponse,
} from "./observability-dashboard-model.js";
import {
  GRID,
  migrateV2Layout,
  movePanel,
  normalizeV3Layout,
  resizePanel,
} from "./observability-layout.js";

const state = {
  repoId: "sdl-mcp",
  token: "",
  abortController: null,
  reconnectAttempt: 0,
  reconnectTimer: null,
  lastSnapshot: null,
};
let dashboardClient = null;

const els = {};

const DEFAULT_SAMPLE_INTERVAL_MS = 2_000;

export function clampDashboardSampleInterval(value) {
  return Number.isFinite(value)
    ? Math.max(250, Math.min(60_000, Math.round(value)))
    : DEFAULT_SAMPLE_INTERVAL_MS;
}

export function createDashboardClient(options) {
  const now = options.now ?? (() => performance.now());
  const fetchImpl = options.fetchImpl ?? fetch;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const applyClientSnapshot = options.applySnapshot ?? (() => {});
  const applyClientLifetime = options.applyLifetime ?? (() => {});
  const applyClientTimeseries = options.applyTimeseries ?? (() => {});
  const onChange = options.onChange ?? (() => {});
  const onError = options.onError ?? (() => {});
  let fallbackTimer = null;
  let pollInFlight = null;
  let repoGeneration = 0;
  const channels = {
    snapshot: { acceptedGeneratedAt: null, receiptVersion: 0 },
    lifetime: { acceptedGeneratedAt: null, receiptVersion: 0 },
    timeseries: { requestSequence: 0 },
  };
  let resetPromise = null;
  let lifetimeBarrier = null;
  let value = {
    repoId: "",
    snapshot: null,
    lifetime: null,
    sessionReceivedAtMs: Number.NEGATIVE_INFINITY,
    lifetimeReceivedAtMs: Number.NEGATIVE_INFINITY,
    sampleIntervalMs: DEFAULT_SAMPLE_INTERVAL_MS,
    streamConnected: false,
  };

  const notify = () => onChange(api.view());
  const replace = (next) => {
    value = next;
    notify();
  };
  const getUrl = (path, extra = "", repoId = value.repoId) =>
    `${path}?repoId=${encodeURIComponent(repoId)}${extra}`;
  const requestJson = async (url, init = {}) => {
    const response = await fetchImpl(url, {
      ...init,
      headers: { ...options.buildHeaders(), ...init.headers },
    });
    let json = null;
    try {
      json = await response.json();
    } catch {
      if (response.ok) throw new Error("Invalid JSON response");
    }
    return { response, json };
  };

  const lifetimeIsCurrentFor = (snapshot, lifetime) =>
    deriveSessionPanelState({
      sessionRepoId: snapshot.repoId,
      lifetimeRepoId: lifetime.repoId,
      monotonicNowMs: 0,
      sessionReceivedAtMs: 0,
      lifetimeReceivedAtMs: 0,
      sessionGeneratedAt: snapshot.generatedAt,
      lifetimeGeneratedAt: lifetime.generatedAt,
      freshnessAvailable: true,
      sectionPresent: false,
      lastEventAt: null,
      sampleIntervalMs: lifetime.sampleIntervalMs,
    }) !== "FRESHNESS UNAVAILABLE";

  const plainRecord = (candidate) =>
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    && Object.getPrototypeOf(candidate) === Object.prototype;
  const acceptedTimestamp = (candidate) => lifetimeIsCurrentFor(candidate, {
    repoId: candidate.repoId,
    generatedAt: candidate.generatedAt,
    sampleIntervalMs: value.sampleIntervalMs,
  });
  const captureRequest = (kind) => ({
    repoId: value.repoId,
    repoGeneration,
    receiptVersion: channels[kind].receiptVersion,
  });
  const sameRepository = (request) =>
    request.repoId === value.repoId && request.repoGeneration === repoGeneration;
  // Request-start versions gate only negative outcomes. Valid successes are
  // ordered against the channel's currently accepted server timestamp.
  const negativeIsCurrent = (request, kind) =>
    sameRepository(request) && request.receiptVersion === channels[kind].receiptVersion;
  const lifetimeSatisfiesBarrier = (lifetime, barrier = lifetimeBarrier) =>
    barrier?.repoId === lifetime?.repoId &&
    lifetime?.persistenceState !== "recoveryRequired" &&
    barrier.epoch !== null && Number.isSafeInteger(lifetime?.epoch) &&
    lifetime.epoch >= barrier.epoch &&
    lifetimeIsCurrentFor({ repoId: barrier.repoId, generatedAt: barrier.resetAt }, lifetime);

  const acceptSnapshot = (snapshot) => {
    if (
      !validObservabilitySnapshot(snapshot) || snapshot.repoId !== value.repoId ||
      !acceptedTimestamp(snapshot)
    ) return false;
    if (channels.snapshot.acceptedGeneratedAt && !lifetimeIsCurrentFor({
      repoId: value.repoId,
      generatedAt: channels.snapshot.acceptedGeneratedAt,
    }, {
      repoId: snapshot.repoId,
      generatedAt: snapshot.generatedAt,
      sampleIntervalMs: value.sampleIntervalMs,
    })) return false;
    const discardLifetime = value.lifetime && !lifetimeIsCurrentFor(snapshot, value.lifetime);
    channels.snapshot.acceptedGeneratedAt = snapshot.generatedAt;
    channels.snapshot.receiptVersion += 1;
    if (discardLifetime) {
      channels.lifetime.acceptedGeneratedAt = null;
      channels.lifetime.receiptVersion += 1;
    }
    replace({
      ...value,
      snapshot,
      sessionReceivedAtMs: now(),
      ...(discardLifetime && {
        lifetime: null,
        lifetimeReceivedAtMs: Number.NEGATIVE_INFINITY,
      }),
    });
    applyClientSnapshot(snapshot);
    if (discardLifetime) applyClientLifetime(lifetimePresentation(null, 0), null);
    return true;
  };

  const acceptLifetime = (lifetime) => {
    const presentation = lifetimePresentation(lifetime, 0);
    if (presentation.state === "UNAVAILABLE" || lifetime.repoId !== value.repoId) return false;
    if (
      lifetimeBarrier?.repoId === value.repoId &&
      lifetime.persistenceState !== "recoveryRequired" &&
      !lifetimeSatisfiesBarrier(lifetime)
    ) return false;
    if (value.snapshot && !lifetimeIsCurrentFor(value.snapshot, lifetime)) return false;
    if (channels.lifetime.acceptedGeneratedAt && !lifetimeIsCurrentFor({
      repoId: value.repoId,
      generatedAt: channels.lifetime.acceptedGeneratedAt,
    }, lifetime)) return false;
    const interval = clampDashboardSampleInterval(lifetime.sampleIntervalMs);
    const intervalChanged = interval !== value.sampleIntervalMs;
    channels.lifetime.acceptedGeneratedAt = lifetime.generatedAt;
    channels.lifetime.receiptVersion += 1;
    replace({
      ...value,
      lifetime,
      lifetimeReceivedAtMs: now(),
      sampleIntervalMs: interval,
    });
    applyClientLifetime(presentation, lifetime);
    if (intervalChanged && fallbackTimer !== null) restartFallback();
    return true;
  };

  const fetchSnapshot = async () => {
    const request = captureRequest("snapshot");
    try {
      const { response, json } = await requestJson(
        getUrl("/api/observability/snapshot", "", request.repoId),
      );
      if (!sameRepository(request)) return false;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return acceptSnapshot(json);
    } catch (error) {
      if (!negativeIsCurrent(request, "snapshot")) return false;
      onError("snapshot", error);
      notify();
      return false;
    }
  };

  const fetchLifetime = async () => {
    const request = captureRequest("lifetime");
    try {
      const { response, json } = await requestJson(
        getUrl("/api/observability/lifetime", "", request.repoId),
      );
      if (!sameRepository(request)) return false;
      if (response.status === 404) {
        if (!negativeIsCurrent(request, "lifetime")) return false;
        const intervalChanged = value.sampleIntervalMs !== DEFAULT_SAMPLE_INTERVAL_MS;
        channels.lifetime.acceptedGeneratedAt = null;
        channels.lifetime.receiptVersion += 1;
        replace({
          ...value,
          lifetime: null,
          lifetimeReceivedAtMs: Number.NEGATIVE_INFINITY,
          sampleIntervalMs: DEFAULT_SAMPLE_INTERVAL_MS,
        });
        applyClientLifetime(lifetimePresentation(null, 0), null);
        if (intervalChanged && fallbackTimer !== null) restartFallback();
        return false;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return acceptLifetime(json);
    } catch (error) {
      if (!negativeIsCurrent(request, "lifetime")) return false;
      onError("lifetime", error);
      notify();
      return false;
    }
  };

  const fetchTimeseries = async (windowName = "15m") => {
    const request = { repoId: value.repoId, repoGeneration };
    const requestSequence = ++channels.timeseries.requestSequence;
    const isLatestRequest = () =>
      sameRepository(request) && requestSequence === channels.timeseries.requestSequence;
    try {
      const { response, json } = await requestJson(
        getUrl(
          "/api/observability/timeseries",
          `&window=${encodeURIComponent(windowName)}`,
          request.repoId,
        ),
      );
      if (!isLatestRequest()) return false;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!validTimeseries15mResponse(json, request.repoId)) return false;
      applyClientTimeseries(json);
      return true;
    } catch (error) {
      if (!isLatestRequest()) return false;
      onError("timeseries", error);
      return false;
    }
  };

  const poll = () => {
    if (value.streamConnected) {
      notify();
      return Promise.resolve();
    }
    if (pollInFlight) return pollInFlight;
    pollInFlight = Promise.allSettled([
      fetchSnapshot(), fetchLifetime(), fetchTimeseries("15m"),
    ]).then(notify).finally(() => {
      pollInFlight = null;
    });
    return pollInFlight;
  };
  const stopFallback = () => {
    if (fallbackTimer !== null) clearIntervalFn(fallbackTimer);
    fallbackTimer = null;
  };
  const restartFallback = () => {
    stopFallback();
    fallbackTimer = setIntervalFn(poll, value.sampleIntervalMs);
  };

  const resetBarrierFrom = (receipt, repoId) => {
    if (
      plainRecord(receipt) && receipt.repoId === repoId &&
      Number.isSafeInteger(receipt.epoch) && receipt.epoch >= 0 &&
      acceptedTimestamp({ repoId, generatedAt: receipt.resetAt })
    ) return { repoId, epoch: receipt.epoch, resetAt: receipt.resetAt };
    // A successful POST may have committed even if its receipt is unusable.
    // Fail closed for ready envelopes while still allowing recovery state through.
    return { repoId, epoch: null, resetAt: null };
  };

  const resetLifetime = ({ control, confirmReset }) => {
    const restoreFocus = (promise) => promise.finally(() => control?.focus?.());
    if (resetPromise) return restoreFocus(resetPromise);
    if (value.lifetime?.persistenceState === "recoveryRequired") {
      return restoreFocus(Promise.resolve(false));
    }
    const repoId = value.repoId;
    const resetGeneration = repoGeneration;
    if (!confirmReset(repoId)) return restoreFocus(Promise.resolve(false));

    const operation = (async () => {
      try {
        const { response, json } = await requestJson("/api/observability/lifetime/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repoId,
            confirmation: `RESET REPOSITORY LIFETIME: ${repoId}`,
          }),
        });
        const resetRequest = { repoId, repoGeneration: resetGeneration };
        if (!sameRepository(resetRequest)) return false;
        if (!response.ok) throw new Error(json?.error?.code ?? `HTTP ${response.status}`);
        lifetimeBarrier = resetBarrierFrom(json, repoId);
        channels.lifetime.receiptVersion += 1;
        // A poll may publish the committed epoch while the POST is in flight.
        // The receipt fences older negative requests; withhold only values that
        // it cannot already prove current.
        if (!lifetimeSatisfiesBarrier(value.lifetime)) {
          channels.lifetime.acceptedGeneratedAt = null;
          value = {
            ...value,
            lifetime: null,
            lifetimeReceivedAtMs: Number.NEGATIVE_INFINITY,
          };
          applyClientLifetime(lifetimePresentation(null, 0), null);
          notify();
        }
        await fetchLifetime();
        if (!sameRepository(resetRequest)) return false;
        return lifetimeSatisfiesBarrier(value.lifetime)
          ? true
          : "committed-refresh-failed";
      } catch (error) {
        if (repoId === value.repoId && resetGeneration === repoGeneration) onError("reset", error);
        return false;
      }
    })();
    resetPromise = operation.finally(() => {
      resetPromise = null;
    });
    return restoreFocus(resetPromise);
  };

  const api = {
    getState: () => ({ ...value }),
    switchRepo(repoId) {
      if (repoId === value.repoId) return false;
      stopFallback();
      repoGeneration += 1;
      lifetimeBarrier = null;
      channels.snapshot.acceptedGeneratedAt = null;
      channels.snapshot.receiptVersion = 0;
      channels.lifetime.acceptedGeneratedAt = null;
      channels.lifetime.receiptVersion = 0;
      channels.timeseries.requestSequence = 0;
      value = {
        repoId,
        snapshot: null,
        lifetime: null,
        sessionReceivedAtMs: Number.NEGATIVE_INFINITY,
        lifetimeReceivedAtMs: Number.NEGATIVE_INFINITY,
        sampleIntervalMs: DEFAULT_SAMPLE_INTERVAL_MS,
        streamConnected: false,
      };
      applyClientSnapshot(null, repoId);
      applyClientLifetime(lifetimePresentation(null, 0), null);
      notify();
      return true;
    },
    acceptSnapshot,
    acceptLifetime,
    fetchSnapshot,
    fetchLifetime,
    fetchTimeseries,
    start() {
      if (fallbackTimer === null) restartFallback();
    },
    stop: stopFallback,
    hydrate: () => Promise.allSettled([
      fetchSnapshot(), fetchLifetime(), fetchTimeseries("15m"),
    ]),
    setStreamConnected(connected) {
      value = { ...value, streamConnected: connected };
      if (fallbackTimer === null) restartFallback();
      notify();
    },
    handleSseEvent(event) {
      if (event?.event !== "snapshot" && event?.event !== "lifetime") return false;
      try {
        const payload = JSON.parse(event.data);
        return event.event === "snapshot"
          ? acceptSnapshot(payload)
          : acceptLifetime(payload);
      } catch (error) {
        onError(event.event, error);
        return false;
      }
    },
    view() {
      const currentNow = now();
      return {
        snapshotAgeMs: Number.isFinite(value.sessionReceivedAtMs)
          ? Math.max(0, currentNow - value.sessionReceivedAtMs)
          : null,
        lifetime: lifetimePresentation(
          value.lifetime,
          Number.isFinite(value.lifetimeReceivedAtMs)
            ? Math.max(0, currentNow - value.lifetimeReceivedAtMs)
            : Number.POSITIVE_INFINITY,
        ),
        resetDisabled: value.lifetime?.persistenceState === "recoveryRequired",
      };
    },
    sectionState(section) {
      return deriveSessionPanelState({
        sessionRepoId: value.snapshot?.repoId ?? value.repoId,
        lifetimeRepoId: value.lifetime?.repoId ?? null,
        monotonicNowMs: now(),
        sessionReceivedAtMs: value.sessionReceivedAtMs,
        lifetimeReceivedAtMs: value.lifetimeReceivedAtMs,
        sessionGeneratedAt: value.snapshot?.generatedAt ?? null,
        lifetimeGeneratedAt: value.lifetime?.generatedAt ?? null,
        freshnessAvailable: value.lifetime?.persistenceState !== "recoveryRequired"
          && value.lifetime?.freshness !== undefined,
        sectionPresent: section === "postIndex"
          ? value.snapshot?.postIndexSession != null
          : value.snapshot?.[section] != null,
        lastEventAt: value.lifetime?.freshness?.[section] ?? null,
        sampleIntervalMs: value.sampleIntervalMs,
      });
    },
    resetLifetime,
  };
  return api;
}

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
          `<li class="chip"><strong>${escapeHtml(s.name)}</strong>${escapeHtml(fmtNum(s.value, 2))}<em>${escapeHtml(s.unit || "")} · w ${escapeHtml(fmtNum(s.weight, 2))}</em></li>`,
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
  renderNativeTable(panelField(panel, "perSource"), {
    caption: "Cache by source",
    columns: [
      { key: "source", label: "Source" },
      { key: "hits", label: "Hits", format: fmtNum },
      { key: "misses", label: "Misses", format: fmtNum },
      { key: "hitRatePct", label: "Hit rate", format: fmtPct },
      { key: "avgLatencyMs", label: "Avg latency", format: fmtMs },
    ],
    rows: Object.entries(perSource).map(([source, value]) => ({ source, ...value })),
  });

}

function updatePredictiveContext(p) {
  const panel = $('[data-panel="predictiveContext"]');
  if (!panel || !p) return;
  setVal(panel, "policyMode", (p.policyMode || "disabled").toUpperCase());
  setVal(panel, "outcomeSamples", fmtNum(p.outcomeSamples));
  setVal(panel, "hitRatePct", fmtPct(p.hitRatePct, 1));
  setVal(panel, "wasteRatePct", fmtPct(p.wasteRatePct, 1));
  setVal(panel, "acceptedPrefetch", fmtNum(p.acceptedPrefetch));
  setVal(panel, "suppressedPrefetch", fmtNum(p.suppressedPrefetch));
  setVal(panel, "avgLatencyReductionMs", fmtMs(p.avgLatencyReductionMs));
  renderNativeTable(panelField(panel, "topStrategies"), {
    caption: "Predictive strategies",
    columns: [
      { key: "strategy", label: "Strategy" },
      { key: "resourceKind", label: "Resource" },
      { key: "samples", label: "Samples", format: fmtNum },
      { key: "hitRatePct", label: "Hit", format: fmtPct },
      { key: "acceptedRatePct", label: "Accepted", format: fmtPct },
      { key: "wasteRatePct", label: "Waste", format: fmtPct },
      { key: "score", label: "Score", format: (value) => fmtNum(value, 2) },
      { key: "suppressed", label: "Suppressed", format: fmtNum },
    ],
    rows: p.topStrategies || [],
  });
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

  const phaseEntries = Object.entries(r.phaseLatencyMs || {}).map(
    ([k, v]) => ({
      key: k,
      value: v && typeof v.avgMs === "number" ? v.avgMs : 0,
    }),
  );
  renderBarList(panelField(panel, "phaseLatencyMs"), phaseEntries, {
    valueFormatter: (v) => fmtMs(v),
    limit: 6,
  });
  renderNativeTable(panelField(panel, "retrievalDetails"), {
    caption: "Retrieval modes, types, and phases",
    columns: [
      { key: "name", label: "Mode / type / phase" },
      { key: "count", label: "Count", format: fmtNum },
      { key: "avgMs", label: "Avg", format: fmtMs },
      { key: "p95Ms", label: "P95", format: fmtMs },
      { key: "maxMs", label: "Max", format: fmtMs },
    ],
    rows: [
      ...Object.entries(r.byMode || {}).map(([name, count]) => ({ name: `mode:${name}`, count })),
      ...Object.entries(r.byRetrievalType || {}).map(([name, count]) => ({ name: `type:${name}`, count })),
      ...Object.entries(r.phaseLatencyMs || {}).map(([name, values]) => ({ name: `phase:${name}`, ...values })),
    ],
  });
}

function updateIndexing(i) {
  const panel = $('[data-panel="indexing"]');
  if (!panel || !i) return;
  setVal(panel, "filesPerMinute", fmtNum(i.filesPerMinute, 1) + "/min");
  setVal(panel, "totalEvents", fmtNum(i.totalEvents));
  setVal(panel, "avgPass1Ms", fmtMs(i.avgPass1Ms));
  setVal(panel, "avgPass2Ms", fmtMs(i.avgPass2Ms));
  setVal(panel, "failures", fmtNum(i.failures));
  setVal(panel, "derivedStateLagMs", fmtMs(i.derivedStateLagMs));

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
  renderNativeTable(panelField(panel, "indexingPhases"), {
    caption: "Indexing phases",
    columns: [
      { key: "phase", label: "Phase" },
      { key: "count", label: "Events", format: fmtNum },
    ],
    rows: Object.entries(i.phaseCounts || {}).map(([phase, count]) => ({ phase, count })),
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
    setVal(panel, "packedTokensSaved", fmtNum(packed.tokensSaved || 0));
    setVal(panel, "packedBytesSaved", fmtBytes(packed.bytesSaved));
    renderPackedSummary(panel, packed);
    renderEncoderTable(panel, packed);
  }
  renderCompressionTable(panel, t.compressionLayers);
}

function renderCompressionTable(panel, layers) {
  const host = panelField(panel, "compressionLayers");
  const rows = [
    {
      kind: "total",
      name: "ALL",
      events: layers?.totalEvents,
      realizedEvents: layers?.totalRealizedEvents,
      estimatedTokensAvoided: layers?.totalEstimatedTokensAvoided,
      originalTokens: layers?.totalOriginalTokens,
      returnedTokens: layers?.totalReturnedTokens,
      savedTokens: layers?.totalSavedTokens,
      storedBytes: layers?.totalStoredBytes,
    },
    ...Object.entries(layers?.bySource || {}).map(([source, metric]) => ({ kind: "source", name: source, ...metric })),
    ...Object.entries(layers?.byTool || {}).map(([tool, metric]) => ({ kind: "tool", name: metric.tool ?? tool, ...metric })),
  ];
  renderNativeTable(host, {
    caption: "Compression by source",
    columns: [
      { key: "name", label: "Source / tool" },
      { key: "kind", label: "Kind" },
      { key: "source", label: "Source" },
      { key: "events", label: "Events", format: fmtNum },
      { key: "realizedEvents", label: "Realized", format: fmtNum },
      { key: "estimatedTokensAvoided", label: "Est saved", format: fmtNum },
      { key: "originalTokens", label: "Original", format: fmtNum },
      { key: "returnedTokens", label: "Returned", format: fmtNum },
      { key: "savedTokens", label: "Saved", format: fmtNum },
      { key: "opportunities", label: "Opps", format: fmtNum },
      { key: "hits", label: "Hits", format: fmtNum },
      { key: "hitRatePct", label: "Hit rate", format: fmtPct },
      { key: "storedBytes", label: "Stored", format: fmtBytes },
    ],
    rows,
  });
}

function renderEncoderTable(panel, packed) {
  const host = panelField(panel, "packedByEncoder");
  const counts = packed?.perEncoder || {};
  const names = new Set([...Object.keys(counts), ...Object.keys(packed?.byEncoder || {})]);
  const rows = [...names].sort().map((encoder) => {
    const metric = packed?.byEncoder?.[encoder] || {};
    return { encoder, perEncoderCount: counts[encoder], ...metric };
  });
  renderNativeTable(host, {
    caption: "Packed wire encoders",
    columns: [
      { key: "encoder", label: "Encoder" },
      { key: "perEncoderCount", label: "Per-encoder count", format: fmtNum },
      { key: "totalDecisions", label: "Total decisions", format: fmtNum },
      { key: "packedCount", label: "Packed", format: fmtNum },
      { key: "fallbackCount", label: "Fallback", format: fmtNum },
      { key: "packedAdoptionPct", label: "Adoption", format: fmtPct },
      { key: "jsonBaselineBytesTotal", label: "JSON bytes", format: fmtBytes },
      { key: "packedBytesTotal", label: "Packed bytes", format: fmtBytes },
      { key: "bytesSaved", label: "Saved bytes", format: fmtBytes },
      { key: "bytesSavedRatio", label: "Byte ratio", format: (value) => fmtPct(value * 100) },
      { key: "jsonBaselineTokensTotal", label: "JSON tokens", format: fmtNum },
      { key: "packedTokensTotal", label: "Packed tokens", format: fmtNum },
      { key: "tokensSaved", label: "Saved tokens", format: fmtNum },
      { key: "tokensSavedRatio", label: "Token ratio", format: (value) => fmtPct(value * 100) },
    ],
    rows,
  });
}

function renderPackedSummary(panel, packed) {
  renderNativeTable(panelField(panel, "packedSummary"), {
    caption: "Packed wire totals",
    columns: [{ key: "name", label: "Metric" }, { key: "value", label: "Session" }],
    rows: [
      { name: "Decisions", value: fmtNum(packed.totalDecisions) },
      { name: "Packed / fallback", value: `${fmtNum(packed.packedCount)} / ${fmtNum(packed.fallbackCount)}` },
      { name: "Packed / JSON bytes", value: `${fmtBytes(packed.packedBytesTotal)} / ${fmtBytes(packed.jsonBaselineBytesTotal)}` },
      { name: "Bytes saved / ratio", value: `${fmtBytes(packed.bytesSaved)} / ${fmtPct(packed.bytesSavedRatio * 100)}` },
      { name: "Packed / JSON tokens", value: `${fmtNum(packed.packedTokensTotal)} / ${fmtNum(packed.jsonBaselineTokensTotal)}` },
      { name: "Tokens saved / ratio", value: `${fmtNum(packed.tokensSaved)} / ${fmtPct(packed.tokensSavedRatio * 100)}` },
      { name: "Axis bytes / tokens / none", value: `${fmtNum(packed.axisHits?.bytes)} / ${fmtNum(packed.axisHits?.tokens)} / ${fmtNum(packed.axisHits?.none)}` },
    ],
  });
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
  setVal(panel, "watcherProvider", h.watcherProvider || "—");
  setVal(panel, "watcherConfiguredProvider", h.watcherConfiguredProvider || "—");
  setVal(panel, "watcherErrors", fmtNum(h.watcherErrors ?? 0));
  setVal(panel, "watcherRestartCount", fmtNum(h.watcherRestartCount ?? 0));
  setVal(panel, "watcherQueueDepth", fmtNum(h.watcherQueueDepth));
  setVal(panel, "watcherStale", h.watcherStale ? "STALE" : "FRESH");
  setVal(
    panel,
    "watcherWatchmanWarningCount",
    fmtNum(h.watcherWatchmanWarningCount ?? 0),
  );
  setVal(
    panel,
    "watcherWatchmanRecrawlCount",
    fmtNum(h.watcherWatchmanRecrawlCount ?? 0),
  );
  setVal(
    panel,
    "watcherWatchmanFreshInstanceCount",
    fmtNum(h.watcherWatchmanFreshInstanceCount ?? 0),
  );
  setVal(panel, "watcherWatchmanVersion", h.watcherWatchmanVersion || "—");
  setVal(panel, "watcherWatchmanLastClock", h.watcherWatchmanLastClock || "—");
  const watchRoot = h.watcherWatchmanWatchRoot
    ? `watch ${h.watcherWatchmanWatchRoot}${
        h.watcherWatchmanRelativePath
          ? ` / ${h.watcherWatchmanRelativePath}`
          : ""
      }`
    : "—";
  const watchmanWarnings =
    Array.isArray(h.watcherWatchmanWarnings) &&
    h.watcherWatchmanWarnings.length > 0
      ? `wm warnings ${h.watcherWatchmanWarnings.join(" | ")}`
      : "—";
  setVal(panel, "watcherWatchmanRoot", watchRoot);
  setVal(panel, "watcherWatchmanWarnings", watchmanWarnings);
  setVal(panel, "watcherFallbackReason", h.watcherFallbackReason || "—");
}

function updateLatency(l) {
  const panel = $('[data-panel="latency"]');
  if (!panel || !l) return;
  setVal(panel, "p95Ms", fmtMs(l.p95Ms));
  setVal(panel, "avgMs", fmtMs(l.avgMs));
  setVal(panel, "p50Ms", fmtMs(l.p50Ms));
  setVal(panel, "p99Ms", fmtMs(l.p99Ms));
  setVal(panel, "maxMs", fmtMs(l.maxMs));

  renderLatencyTable(panel, l.perTool || {});
}

function renderLatencyTable(panel, tools) {
  const rows = [];
  for (const [tool, metric] of Object.entries(tools)) {
    rows.push({ name: tool, ...metric });
    for (const [phase, phaseMetric] of Object.entries(metric?.phases || {})) {
      rows.push({ name: `${tool} / ${phase}`, errorCount: null, ...phaseMetric });
    }
  }
  renderNativeTable(panelField(panel, "perTool"), {
    caption: "Latency by tool and phase",
    columns: [
      { key: "name", label: "Tool / phase" },
      { key: "count", label: "Calls", format: fmtNum },
      { key: "avgMs", label: "Avg", format: fmtMs },
      { key: "p95Ms", label: "P95", format: fmtMs },
      { key: "maxMs", label: "Max", format: fmtMs },
      { key: "errorCount", label: "Errors", format: fmtNum },
    ],
    rows,
    empty: "No calls yet.",
  });
}

function updatePool(p) {
  const panel = $('[data-panel="resources"]');
  if (!panel || !p) return;
  renderNativeTable(panelField(panel, "poolTable"), {
    caption: "Session pool and queues",
    columns: [{ key: "name", label: "Metric" }, { key: "value", label: "Session" }],
    rows: [
      { name: "Dispatch active / queued / max", value: `${fmtNum(p.dispatchActive)} / ${fmtNum(p.dispatchQueued)} / ${fmtNum(p.dispatchMax)}` },
      { name: "Dispatch active / queued peak", value: `${fmtNum(p.maxDispatchActive)} / ${fmtNum(p.maxDispatchQueued)}` },
      { name: "Write queued avg / max", value: `${fmtNum(p.avgWriteQueued, 1)} / ${fmtNum(p.maxWriteQueued)}` },
      { name: "Write active avg", value: fmtNum(p.avgWriteActive, 1) },
      { name: "Drain depth avg / max", value: `${fmtNum(p.avgDrainQueueDepth, 1)} / ${fmtNum(p.maxDrainQueueDepth)}` },
      { name: "Drain failures", value: fmtNum(p.totalDrainFailures) },
    ],
  });
}

function updatePpr(p) {
  const panel = $('[data-panel="ppr"]');
  if (!panel || !p) return;
  setVal(panel, "totalRuns", fmtNum(p.totalRuns));
  setVal(panel, "avgComputeMs", fmtMs(p.avgComputeMs));
  setVal(panel, "p95ComputeMs", fmtMs(p.p95ComputeMs));
  setVal(panel, "avgSeedCount", fmtNum(p.avgSeedCount, 1));
  setVal(panel, "avgTouched", fmtNum(p.avgTouched, 1));
  setVal(panel, "nativeRatio", fmtPct(p.nativeRatio * 100, 1));
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

  renderToolVolumeTable(panel, t);
}

function renderToolVolumeTable(panel, volume) {
  const names = new Set([
    ...Object.keys(volume.perTool || {}),
    ...Object.keys(volume.perToolErrors || {}),
  ]);
  renderNativeTable(panelField(panel, "perTool"), {
    caption: "Tool calls and errors",
    columns: [
      { key: "tool", label: "Tool" },
      { key: "calls", label: "Calls", format: fmtNum },
      { key: "errors", label: "Errors", format: fmtNum },
    ],
    rows: [...names].sort().map((tool) => ({
      tool,
      calls: volume.perTool?.[tool] || 0,
      errors: volume.perToolErrors?.[tool] || 0,
    })),
  });
}

function updatePostIndex(p, audit) {
  const panel = $('[data-panel="postIndex"]');
  if (!panel) return;
  if (p) {
    setVal(panel, "lastDurationMs", fmtMs(p.lastDurationMs));
    setVal(panel, "totalSessions", fmtNum(p.totalSessions));
    setVal(panel, "avgDurationMs", fmtMs(p.avgDurationMs));
    setVal(panel, "p50DurationMs", fmtMs(p.p50DurationMs));
    setVal(panel, "p95DurationMs", fmtMs(p.p95DurationMs));
    setVal(panel, "p99DurationMs", fmtMs(p.p99DurationMs));
    setVal(panel, "maxDurationMs", fmtMs(p.maxDurationMs));
    setVal(panel, "timeoutCount", fmtNum(p.timeoutCount));
    setVal(panel, "lastTimedOut", p.lastTimedOut ? "YES" : "NO");
    setVal(panel, "lastEndedAt", p.lastEndedAt ? new Date(p.lastEndedAt).toLocaleTimeString() : "never");
  }
  if (audit) {
    setVal(panel, "auditBufferDepth", fmtNum(audit.depth));
    setVal(panel, "auditBufferMaxDepth", fmtNum(audit.maxDepth));
    setVal(panel, "auditBufferDropped", fmtNum(audit.droppedTotal));
    setVal(panel, "auditBufferActive", audit.sessionActive ? "YES" : "NO");
  }
}

function updateToolOutput(toolOutput) {
  const panel = $('[data-panel="toolOutput"]');
  if (!panel) return;

  const view = buildToolOutputViewModel(toolOutput);
  const noData = panelField(panel, "noData");
  const content = panelField(panel, "content");
  noData.hidden = view.hasData;
  content.hidden = !view.hasData;

  if (!view.hasData) {
    setVal(panel, "reduction", "NO DATA");
    return;
  }

  const summary = view.summary;
  setVal(panel, "reduction", `${fmtPct(summary.reductionRatio * 100)} REDUCTION`);
  setVal(panel, "calls", fmtNum(summary.calls));
  setVal(panel, "errors", fmtNum(summary.errors));
  setVal(panel, "handled", `${fmtNum(summary.handledCount)} / ${fmtNum(summary.calls)}`);
  setVal(panel, "truncated", `${fmtNum(summary.truncatedCount)} / ${fmtNum(summary.calls)}`);
  setVal(panel, "p50Tokens", fmtNum(summary.p50ProjectedTokens));
  setVal(panel, "p95Tokens", fmtNum(summary.p95ProjectedTokens));
  setVal(
    panel,
    "detail",
    `C ${fmtNum(summary.detailCounts.compact)} · S ${fmtNum(summary.detailCounts.standard)} · F ${fmtNum(summary.detailCounts.full)}`,
  );
  setVal(
    panel,
    "recovery",
    `${fmtNum(summary.recoveryEmittedCount)} emitted · ${fmtNum(summary.invalidRecoveryCount)} invalid`,
  );

  renderToolOutputTable(panel, toolOutput);
}

function renderToolOutputTable(panel, toolOutput) {
  const rows = [
    { tool: "OVERALL", schemaVersion: toolOutput.schemaVersion, ...toolOutput.overall },
    ...(toolOutput.perTool || []).slice(0, 12),
  ];
  const detail = (value = {}) => `Σ${fmtNum(value.summary)} C${fmtNum(value.compact)} S${fmtNum(value.standard)} F${fmtNum(value.full)}`;
  const profiles = (value = {}) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${name}:${count}`).join(" · ") || "—";
  renderNativeTable(panelField(panel, "perTool"), {
    caption: "Tool output health",
    columns: [
      { key: "tool", label: "Tool" },
      { key: "schemaVersion", label: "Schema", format: fmtNum },
      { key: "calls", label: "Calls", format: fmtNum },
      { key: "errors", label: "Errors", format: fmtNum },
      { key: "rawBytesTotal", label: "Raw bytes", format: fmtBytes },
      { key: "projectedBytesTotal", label: "Projected bytes", format: fmtBytes },
      { key: "rawTokensTotal", label: "Raw tokens", format: fmtNum },
      { key: "projectedTokensTotal", label: "Projected tokens", format: fmtNum },
      { key: "reductionRatio", label: "Reduction", format: (value) => fmtPct(value * 100) },
      { key: "removedFieldTotal", label: "Removed", format: fmtNum },
      { key: "handledCount", label: "Handled", format: fmtNum },
      { key: "handledRate", label: "Handled rate", format: (value) => fmtPct(value * 100) },
      { key: "truncatedCount", label: "Truncated", format: fmtNum },
      { key: "truncatedRate", label: "Truncated rate", format: (value) => fmtPct(value * 100) },
      { key: "detailCounts", label: "Detail", format: detail },
      { key: "profileCounts", label: "Profiles", format: profiles },
      { key: "recoveryEmittedCount", label: "Recovery", format: fmtNum },
      { key: "invalidRecoveryCount", label: "Invalid", format: fmtNum },
      { key: "p50ProjectedBytes", label: "P50 bytes", format: fmtBytes },
      { key: "p95ProjectedBytes", label: "P95 bytes", format: fmtBytes },
      { key: "maxProjectedBytes", label: "Max bytes", format: fmtBytes },
      { key: "p50ProjectedTokens", label: "P50 tokens", format: fmtNum },
      { key: "p95ProjectedTokens", label: "P95 tokens", format: fmtNum },
      { key: "maxProjectedTokens", label: "Max tokens", format: fmtNum },
    ],
    rows,
  });
}

const metricRenderers = Object.create(null);

function registerMetricConsumer(path, renderer) {
  if (Object.hasOwn(metricRenderers, path)) throw new Error(`Duplicate metric consumer: ${path}`);
  metricRenderers[path] = function consumeMetric(snapshot, rendered = new Set()) {
    if (rendered.has(renderer)) return;
    rendered.add(renderer);
    renderer(snapshot);
  };
}

function registerScalarConsumer(path, panelName, field, format = String) {
  const parts = path.split(".");
  registerMetricConsumer(path, function renderScalarMetric(snapshot) {
    const panel = document.querySelector(`[data-panel="${panelName}"]`);
    if (!panel) return;
    const value = parts.reduce((current, part) => current?.[part], snapshot);
    setVal(panel, field, format(value));
  });
}

function registerDashboardConsumer(path, field) {
  registerMetricConsumer(path, function renderDashboardMetric(snapshot) {
    const value = snapshot?.[path];
    setText(document.querySelector(`[data-dashboard-field="${field}"]`), value);
  });
}

function registerGroupedConsumers(paths, renderer) {
  for (const path of paths) registerMetricConsumer(path, renderer);
}

registerDashboardConsumer("generatedAt", "generatedAt");
registerDashboardConsumer("repoId", "repoId");
registerGroupedConsumers([
  "bottleneck.dominant",
  "bottleneck.confidence",
  "bottleneck.topSignals[].name",
  "bottleneck.topSignals[].value",
  "bottleneck.topSignals[].unit",
  "bottleneck.topSignals[].weight",
], (snapshot) => updateBottleneck(snapshot.bottleneck));

registerScalarConsumer("cache.overallHitRatePct", "cache", "hitRate", (value) => fmtPct(value, 1));
registerScalarConsumer("cache.totalHits", "cache", "totalHits", fmtNum);
registerScalarConsumer("cache.totalMisses", "cache", "totalMisses", fmtNum);
registerGroupedConsumers([
  "cache.perSource[].source",
  "cache.perSource[].hits",
  "cache.perSource[].misses",
  "cache.perSource[].hitRatePct",
  "cache.perSource[].avgLatencyMs",
], (snapshot) => updateCache(snapshot.cache));
registerScalarConsumer("cache.avgLookupLatencyMs", "cache", "avgLookupLatencyMs", fmtMs);

registerScalarConsumer("retrieval.totalRetrievals", "retrieval", "totalRetrievals", fmtNum);
registerScalarConsumer("retrieval.avgLatencyMs", "retrieval", "avgLatencyMs", fmtMs);
registerScalarConsumer("retrieval.p95LatencyMs", "retrieval", "p95LatencyMs", fmtMs);
registerGroupedConsumers([
  "retrieval.byMode[]",
  "retrieval.candidateCountPerSource[]",
  "retrieval.phaseLatencyMs[].count",
  "retrieval.phaseLatencyMs[].avgMs",
  "retrieval.phaseLatencyMs[].p95Ms",
  "retrieval.phaseLatencyMs[].maxMs",
  "retrieval.byRetrievalType[]",
], (snapshot) => updateRetrieval(snapshot.retrieval));
registerScalarConsumer("retrieval.emptyResultCount", "retrieval", "emptyResultCount", fmtNum);

registerScalarConsumer("beam.totalSliceBuilds", "beam", "totalSliceBuilds", fmtNum);
registerScalarConsumer("beam.avgBuildMs", "beam", "avgBuildMs", fmtMs);
registerScalarConsumer("beam.p95BuildMs", "beam", "p95BuildMs", fmtMs);
registerScalarConsumer("beam.avgAccepted", "beam", "avgAccepted", (value) => fmtNum(value, 1));
registerScalarConsumer("beam.avgEvicted", "beam", "avgEvicted", (value) => fmtNum(value, 1));
registerScalarConsumer("beam.avgRejected", "beam", "avgRejected", (value) => fmtNum(value, 1));
registerScalarConsumer("beam.avgFrontierMaxSize", "beam", "avgFrontierMaxSize", (value) => fmtNum(value, 1));
registerScalarConsumer("beam.p95FrontierMaxSize", "beam", "p95FrontierMaxSize", (value) => fmtNum(value, 1));
registerScalarConsumer("beam.retainedExplainHandles", "beam", "retainedExplainHandles", fmtNum);

registerScalarConsumer("delta.totalBlastRadiusComputations", "delta", "totalBlastRadiusComputations", fmtNum);
registerScalarConsumer("delta.avgBlastRadiusLatencyMs", "delta", "avgBlastRadiusLatencyMs", fmtMs);
registerScalarConsumer("delta.p95BlastRadiusLatencyMs", "delta", "p95BlastRadiusLatencyMs", fmtMs);
registerScalarConsumer("delta.avgDbRoundTripsPerChangedSymbol", "delta", "avgDbRoundTripsPerChangedSymbol", (value) => fmtNum(value, 1));
registerScalarConsumer("delta.avgPathExplanationLatencyMs", "delta", "avgPathExplanationLatencyMs", fmtMs);
registerScalarConsumer("delta.p95PathExplanationLatencyMs", "delta", "p95PathExplanationLatencyMs", fmtMs);
registerScalarConsumer("delta.fallbackPathQueryCount", "delta", "fallbackPathQueryCount", fmtNum);

registerScalarConsumer("indexing.totalEvents", "indexing", "totalEvents", fmtNum);
registerScalarConsumer("indexing.filesPerMinute", "indexing", "filesPerMinute", (value) => `${fmtNum(value, 1)}/min`);
registerScalarConsumer("indexing.avgPass1Ms", "indexing", "avgPass1Ms", fmtMs);
registerScalarConsumer("indexing.avgPass2Ms", "indexing", "avgPass2Ms", fmtMs);
registerGroupedConsumers([
  "indexing.phaseCounts[]",
  "indexing.perLanguageAvgMs[]",
  "indexing.engineDispatch.rust",
  "indexing.engineDispatch.ts",
], (snapshot) => updateIndexing(snapshot.indexing));
registerScalarConsumer("indexing.failures", "indexing", "failures", fmtNum);
registerScalarConsumer("indexing.derivedStateLagMs", "indexing", "derivedStateLagMs", fmtMs);

registerScalarConsumer("tokenEfficiency.totalUsed", "tokenEfficiency", "totalUsed", fmtNum);
registerScalarConsumer("tokenEfficiency.totalSaved", "tokenEfficiency", "totalSaved", fmtNum);
registerScalarConsumer("tokenEfficiency.savingsRatio", "tokenEfficiency", "savingsRatio", (value) => fmtPct((value || 0) * 100, 1));
registerScalarConsumer("tokenEfficiency.avgPerCall", "tokenEfficiency", "avgPerCall", (value) => fmtNum(value, 1));
registerGroupedConsumers([
  "tokenEfficiency.compressionLayers.totalEvents",
  "tokenEfficiency.compressionLayers.totalRealizedEvents",
  "tokenEfficiency.compressionLayers.totalEstimatedTokensAvoided",
  "tokenEfficiency.compressionLayers.totalOriginalTokens",
  "tokenEfficiency.compressionLayers.totalReturnedTokens",
  "tokenEfficiency.compressionLayers.totalSavedTokens",
  "tokenEfficiency.compressionLayers.totalStoredBytes",
  "tokenEfficiency.compressionLayers.bySource[].source",
  "tokenEfficiency.compressionLayers.bySource[].events",
  "tokenEfficiency.compressionLayers.bySource[].realizedEvents",
  "tokenEfficiency.compressionLayers.bySource[].estimatedTokensAvoided",
  "tokenEfficiency.compressionLayers.bySource[].originalTokens",
  "tokenEfficiency.compressionLayers.bySource[].returnedTokens",
  "tokenEfficiency.compressionLayers.bySource[].savedTokens",
  "tokenEfficiency.compressionLayers.bySource[].opportunities",
  "tokenEfficiency.compressionLayers.bySource[].hits",
  "tokenEfficiency.compressionLayers.bySource[].hitRatePct",
  "tokenEfficiency.compressionLayers.bySource[].storedBytes",
  "tokenEfficiency.compressionLayers.byTool[].tool",
  "tokenEfficiency.compressionLayers.byTool[].source",
  "tokenEfficiency.compressionLayers.byTool[].events",
  "tokenEfficiency.compressionLayers.byTool[].realizedEvents",
  "tokenEfficiency.compressionLayers.byTool[].estimatedTokensAvoided",
  "tokenEfficiency.compressionLayers.byTool[].originalTokens",
  "tokenEfficiency.compressionLayers.byTool[].returnedTokens",
  "tokenEfficiency.compressionLayers.byTool[].savedTokens",
  "tokenEfficiency.compressionLayers.byTool[].opportunities",
  "tokenEfficiency.compressionLayers.byTool[].hits",
  "tokenEfficiency.compressionLayers.byTool[].hitRatePct",
  "tokenEfficiency.compressionLayers.byTool[].storedBytes",
  "packed.totalDecisions",
  "packed.packedCount",
  "packed.fallbackCount",
  "packed.packedAdoptionPct",
  "packed.packedBytesTotal",
  "packed.jsonBaselineBytesTotal",
  "packed.bytesSaved",
  "packed.bytesSavedRatio",
  "packed.packedTokensTotal",
  "packed.jsonBaselineTokensTotal",
  "packed.tokensSaved",
  "packed.tokensSavedRatio",
  "packed.axisHits.bytes",
  "packed.axisHits.tokens",
  "packed.axisHits.none",
  "packed.perEncoder[]",
  "packed.byEncoder[].totalDecisions",
  "packed.byEncoder[].packedCount",
  "packed.byEncoder[].fallbackCount",
  "packed.byEncoder[].packedAdoptionPct",
  "packed.byEncoder[].jsonBaselineBytesTotal",
  "packed.byEncoder[].packedBytesTotal",
  "packed.byEncoder[].bytesSaved",
  "packed.byEncoder[].bytesSavedRatio",
  "packed.byEncoder[].jsonBaselineTokensTotal",
  "packed.byEncoder[].packedTokensTotal",
  "packed.byEncoder[].tokensSaved",
  "packed.byEncoder[].tokensSavedRatio",
], (snapshot) => updateTokenEfficiency(snapshot.tokenEfficiency, snapshot.packed));

registerScalarConsumer("predictiveContext.policyMode", "predictiveContext", "policyMode", (value) => (value || "disabled").toUpperCase());
registerScalarConsumer("predictiveContext.outcomeSamples", "predictiveContext", "outcomeSamples", fmtNum);
registerScalarConsumer("predictiveContext.suppressedPrefetch", "predictiveContext", "suppressedPrefetch", fmtNum);
registerScalarConsumer("predictiveContext.acceptedPrefetch", "predictiveContext", "acceptedPrefetch", fmtNum);
registerScalarConsumer("predictiveContext.hitRatePct", "predictiveContext", "hitRatePct", (value) => fmtPct(value, 1));
registerScalarConsumer("predictiveContext.wasteRatePct", "predictiveContext", "wasteRatePct", (value) => fmtPct(value, 1));
registerScalarConsumer("predictiveContext.avgLatencyReductionMs", "predictiveContext", "avgLatencyReductionMs", fmtMs);
registerGroupedConsumers([
  "predictiveContext.topStrategies[].strategy",
  "predictiveContext.topStrategies[].resourceKind",
  "predictiveContext.topStrategies[].samples",
  "predictiveContext.topStrategies[].hitRatePct",
  "predictiveContext.topStrategies[].acceptedRatePct",
  "predictiveContext.topStrategies[].wasteRatePct",
  "predictiveContext.topStrategies[].score",
  "predictiveContext.topStrategies[].suppressed",
], (snapshot) => updatePredictiveContext(snapshot.predictiveContext));

registerScalarConsumer("health.score", "health", "score", (value) => fmtNum(value, 0));
const renderHealthMetrics = (snapshot) => updateHealth(snapshot.health);
registerGroupedConsumers([
  "health.components.freshness",
  "health.components.coverage",
  "health.components.errorRate",
  "health.components.edgeQuality",
  "health.components.callResolution",
], renderHealthMetrics);
registerScalarConsumer("health.watcherRunning", "health", "watcherRunning", (value) => value ? "ON" : "OFF");
registerScalarConsumer("health.watcherProvider", "health", "watcherProvider", (value) => value || "—");
registerScalarConsumer("health.watcherConfiguredProvider", "health", "watcherConfiguredProvider", (value) => value || "—");
registerScalarConsumer("health.watcherFallbackReason", "health", "watcherFallbackReason", (value) => value || "—");
registerScalarConsumer("health.watcherQueueDepth", "health", "watcherQueueDepth", fmtNum);
registerScalarConsumer("health.watcherStale", "health", "watcherStale", (value) => value ? "STALE" : "FRESH");
registerScalarConsumer("health.watcherErrors", "health", "watcherErrors", fmtNum);
registerScalarConsumer("health.watcherRestartCount", "health", "watcherRestartCount", fmtNum);
registerScalarConsumer("health.watcherWatchmanWarningCount", "health", "watcherWatchmanWarningCount", fmtNum);
registerGroupedConsumers([
  "health.watcherWatchmanWarnings[]",
  "health.watcherWatchmanVersion",
  "health.watcherWatchmanWatchRoot",
  "health.watcherWatchmanRelativePath",
  "health.watcherWatchmanLastClock",
], renderHealthMetrics);
registerScalarConsumer("health.watcherWatchmanRecrawlCount", "health", "watcherWatchmanRecrawlCount", fmtNum);
registerScalarConsumer("health.watcherWatchmanFreshInstanceCount", "health", "watcherWatchmanFreshInstanceCount", fmtNum);

registerScalarConsumer("latency.avgMs", "latency", "avgMs", fmtMs);
registerScalarConsumer("latency.p50Ms", "latency", "p50Ms", fmtMs);
registerScalarConsumer("latency.p95Ms", "latency", "p95Ms", fmtMs);
registerScalarConsumer("latency.p99Ms", "latency", "p99Ms", fmtMs);
registerScalarConsumer("latency.maxMs", "latency", "maxMs", fmtMs);
registerGroupedConsumers([
  "latency.perTool[].count",
  "latency.perTool[].avgMs",
  "latency.perTool[].p95Ms",
  "latency.perTool[].errorCount",
  "latency.perTool[].phases[].count",
  "latency.perTool[].phases[].avgMs",
  "latency.perTool[].phases[].p95Ms",
  "latency.perTool[].phases[].maxMs",
], (snapshot) => updateLatency(snapshot.latency));

registerScalarConsumer("scip.totalIngests", "scip", "totalIngests", fmtNum);
registerScalarConsumer("scip.successCount", "scip", "successCount", fmtNum);
registerScalarConsumer("scip.failureCount", "scip", "failureCount", fmtNum);
registerScalarConsumer("scip.totalEdgesCreated", "scip", "totalEdgesCreated", fmtNum);
registerScalarConsumer("scip.totalEdgesUpgraded", "scip", "totalEdgesUpgraded", fmtNum);
registerScalarConsumer("scip.avgIngestMs", "scip", "avgIngestMs", fmtMs);
registerScalarConsumer("scip.lastIngestAt", "scip", "lastIngestAt", (value) => value ? new Date(value).toLocaleTimeString() : "never");

registerScalarConsumer("ppr.totalRuns", "ppr", "totalRuns", fmtNum);
registerGroupedConsumers([
  "ppr.nativeCount",
  "ppr.jsCount",
  "ppr.fallbackCount",
], (snapshot) => updatePpr(snapshot.ppr));
registerScalarConsumer("ppr.nativeRatio", "ppr", "nativeRatio", (value) => fmtPct(value * 100, 1));
registerScalarConsumer("ppr.avgComputeMs", "ppr", "avgComputeMs", fmtMs);
registerScalarConsumer("ppr.p95ComputeMs", "ppr", "p95ComputeMs", fmtMs);
registerScalarConsumer("ppr.avgTouched", "ppr", "avgTouched", (value) => fmtNum(value, 1));
registerScalarConsumer("ppr.avgSeedCount", "ppr", "avgSeedCount", (value) => fmtNum(value, 1));

registerScalarConsumer("toolVolume.totalCalls", "toolVolume", "totalCalls", fmtNum);
registerGroupedConsumers([
  "toolVolume.perTool[]",
  "toolVolume.perToolErrors[]",
], (snapshot) => updateToolVolume(snapshot.toolVolume));
registerScalarConsumer("toolVolume.callsPerMinute", "toolVolume", "callsPerMinute", (value) => `${fmtNum(value, 1)}/min`);

registerScalarConsumer("postIndexSession.totalSessions", "postIndex", "totalSessions", fmtNum);
registerScalarConsumer("postIndexSession.avgDurationMs", "postIndex", "avgDurationMs", fmtMs);
registerScalarConsumer("postIndexSession.p50DurationMs", "postIndex", "p50DurationMs", fmtMs);
registerScalarConsumer("postIndexSession.p95DurationMs", "postIndex", "p95DurationMs", fmtMs);
registerScalarConsumer("postIndexSession.p99DurationMs", "postIndex", "p99DurationMs", fmtMs);
registerScalarConsumer("postIndexSession.maxDurationMs", "postIndex", "maxDurationMs", fmtMs);
registerScalarConsumer("postIndexSession.timeoutCount", "postIndex", "timeoutCount", fmtNum);
registerScalarConsumer("postIndexSession.lastDurationMs", "postIndex", "lastDurationMs", fmtMs);
registerScalarConsumer("postIndexSession.lastTimedOut", "postIndex", "lastTimedOut", (value) => value ? "YES" : "NO");
registerScalarConsumer("postIndexSession.lastEndedAt", "postIndex", "lastEndedAt", (value) => value ? new Date(value).toLocaleTimeString() : "never");

registerGroupedConsumers([
  "toolOutput.schemaVersion",
  "toolOutput.overall.calls",
  "toolOutput.overall.errors",
  "toolOutput.overall.rawBytesTotal",
  "toolOutput.overall.projectedBytesTotal",
  "toolOutput.overall.rawTokensTotal",
  "toolOutput.overall.projectedTokensTotal",
  "toolOutput.overall.reductionRatio",
  "toolOutput.overall.removedFieldTotal",
  "toolOutput.overall.handledCount",
  "toolOutput.overall.handledRate",
  "toolOutput.overall.truncatedCount",
  "toolOutput.overall.truncatedRate",
  "toolOutput.overall.detailCounts.summary",
  "toolOutput.overall.detailCounts.compact",
  "toolOutput.overall.detailCounts.standard",
  "toolOutput.overall.detailCounts.full",
  "toolOutput.overall.profileCounts[]",
  "toolOutput.overall.recoveryEmittedCount",
  "toolOutput.overall.invalidRecoveryCount",
  "toolOutput.overall.p50ProjectedBytes",
  "toolOutput.overall.p95ProjectedBytes",
  "toolOutput.overall.maxProjectedBytes",
  "toolOutput.overall.p50ProjectedTokens",
  "toolOutput.overall.p95ProjectedTokens",
  "toolOutput.overall.maxProjectedTokens",
  "toolOutput.perTool[].tool",
  "toolOutput.perTool[].calls",
  "toolOutput.perTool[].errors",
  "toolOutput.perTool[].rawBytesTotal",
  "toolOutput.perTool[].projectedBytesTotal",
  "toolOutput.perTool[].rawTokensTotal",
  "toolOutput.perTool[].projectedTokensTotal",
  "toolOutput.perTool[].reductionRatio",
  "toolOutput.perTool[].removedFieldTotal",
  "toolOutput.perTool[].handledCount",
  "toolOutput.perTool[].handledRate",
  "toolOutput.perTool[].truncatedCount",
  "toolOutput.perTool[].truncatedRate",
  "toolOutput.perTool[].detailCounts.summary",
  "toolOutput.perTool[].detailCounts.compact",
  "toolOutput.perTool[].detailCounts.standard",
  "toolOutput.perTool[].detailCounts.full",
  "toolOutput.perTool[].profileCounts[]",
  "toolOutput.perTool[].recoveryEmittedCount",
  "toolOutput.perTool[].invalidRecoveryCount",
  "toolOutput.perTool[].p50ProjectedBytes",
  "toolOutput.perTool[].p95ProjectedBytes",
  "toolOutput.perTool[].maxProjectedBytes",
  "toolOutput.perTool[].p50ProjectedTokens",
  "toolOutput.perTool[].p95ProjectedTokens",
  "toolOutput.perTool[].maxProjectedTokens",
], (snapshot) => updateToolOutput(snapshot.toolOutput));

export const METRIC_RENDERERS = Object.freeze({ ...metricRenderers });

export function assertMetricRendererCoverage(dispositions, renderers, verify) {
  const claimed = Object.entries(dispositions).filter(([, entry]) => entry.disposition !== "sessionOnly");
  for (const [path, entry] of claimed) {
    if (typeof renderers[path] !== "function") {
      throw new Error(`Missing or invalid metric consumer: ${path}`);
    }
    verify?.(path, entry, renderers[path]);
  }
  for (const path of Object.keys(renderers)) {
    if (!Object.hasOwn(dispositions, path) || dispositions[path].disposition === "sessionOnly") {
      throw new Error(`Unclaimed metric consumer: ${path}`);
    }
  }
}

assertMetricRendererCoverage(METRIC_DISPOSITIONS, METRIC_RENDERERS);

function renderMappedSeries(points, destination, seriesName) {
  const panel = document.querySelector(`[data-panel="${destination.panel}"]`);
  if (!panel) return;
  let svg = panel.querySelector(`[data-series="${seriesName}"]`);
  if (!svg) {
    let bank = panel.querySelector(".trend-bank");
    if (!bank) {
      bank = document.createElement("div");
      bank.className = "trend-bank";
      panel.append(bank);
    }
    const figure = document.createElement("figure");
    figure.className = "metric-trend";
    const caption = document.createElement("figcaption");
    caption.textContent = `${destination.field} · 15M`;
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 200 40");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("spark");
    svg.dataset.series = seriesName;
    figure.append(caption, svg);
    bank.append(figure);
  }
  const values = (points || []).map((point) => {
    const field = Object.keys(point).find((key) => key !== "t");
    return field ? point[field] : 0;
  });
  renderSparkline(svg, values);
}

const timeseriesRenderers = Object.create(null);

function registerTimeseriesRenderer(series, panel, field) {
  const destination = Object.freeze({ panel, field });
  timeseriesRenderers[series] = function renderTimeseries(points) {
    renderMappedSeries(points, destination, series);
  };
}

registerTimeseriesRenderer("cacheHitRate", "cache", "hitRateSpark");
registerTimeseriesRenderer("p95LatencyMs", "latency", "p95Ms");
registerTimeseriesRenderer("queueDepth", "resources", "avgWriteQueued");
registerTimeseriesRenderer("drainQueueDepth", "resources", "avgDrainQueueDepth");
registerTimeseriesRenderer("filesPerMinute", "indexing", "filesPerMinute");
registerTimeseriesRenderer("errorRate", "health", "components.errorRate");
registerTimeseriesRenderer("tokensUsedPerMin", "tokenEfficiency", "totalUsed");
registerTimeseriesRenderer("tokensSavedPerMin", "tokenEfficiency", "totalSaved");
registerTimeseriesRenderer("toolOutputRawBytes", "toolOutput", "overall.rawBytesTotal");
registerTimeseriesRenderer("toolOutputProjectedBytes", "toolOutput", "overall.projectedBytesTotal");
registerTimeseriesRenderer("toolOutputRawTokens", "toolOutput", "overall.rawTokensTotal");
registerTimeseriesRenderer("toolOutputProjectedTokens", "toolOutput", "overall.projectedTokensTotal");
registerTimeseriesRenderer("cpuPct", "resources", "cpuPctAvg");
registerTimeseriesRenderer("rssMb", "resources", "rssMb");
registerTimeseriesRenderer("heapUsedMb", "resources", "heapUsedMb");
registerTimeseriesRenderer("eventLoopLagMs", "resources", "eventLoopLagP95Ms");

export const TIMESERIES_RENDERERS = Object.freeze({ ...timeseriesRenderers });

export function assertTimeseriesRendererCoverage(destinations, renderers, verify) {
  for (const [series, destination] of Object.entries(destinations)) {
    if (typeof renderers[series] !== "function") {
      throw new Error(`Missing or invalid timeseries consumer: ${series}`);
    }
    verify?.(series, destination, renderers[series]);
  }
  for (const series of Object.keys(renderers)) {
    if (!Object.hasOwn(destinations, series)) throw new Error(`Unclaimed timeseries consumer: ${series}`);
  }
}

assertTimeseriesRendererCoverage(TIMESERIES_PANEL_MAP, TIMESERIES_RENDERERS);

export function applyTimeseries(timeseries) {
  if (!timeseries || timeseries.window !== "15m") return;
  for (const series of Object.keys(TIMESERIES_RENDERERS)) {
    TIMESERIES_RENDERERS[series](timeseries.series?.[series]);
  }
}

// -------- Main snapshot apply --------
export function applySnapshot(snap, repoId) {
  if (!snap || typeof snap !== "object") {
    state.lastSnapshot = null;
    setText(document.querySelector('[data-dashboard-field="repoId"]'), repoId);
    setText(document.querySelector('[data-dashboard-field="generatedAt"]'), null);
    const dashboard = document.querySelector("#dashboard");
    if (!dashboard) return;
    for (const element of dashboard.querySelectorAll(
      "output[data-field], span[data-field], em[data-field]",
    )) setText(element, null);
    // Only generated SVG children are disposable; the donut reuses its static circles.
    for (const element of dashboard.querySelectorAll(
      'div[data-field]:not([data-field="content"]):not([data-field="noData"]), ul[data-field], svg.spark[data-field], [data-series]',
    )) element.replaceChildren();
    renderDonut(dashboard.querySelector('svg[data-field="engineDonut"]'), 0);
    const confidence = dashboard.querySelector('[data-field="confidenceBar"]');
    confidence?.style?.setProperty("width", "0%");
    const content = dashboard.querySelector('[data-field="content"]');
    const noData = dashboard.querySelector('[data-field="noData"]');
    if (content) content.hidden = true;
    if (noData) {
      noData.hidden = false;
      noData.textContent = "No session metrics yet.";
    }
    return;
  }
  state.lastSnapshot = snap;
  try {
    const rendered = new Set();
    for (const consumer of Object.values(METRIC_RENDERERS)) consumer(snap, rendered);
    updatePool(snap.pool);
    updateResources(snap.resources, snap.uptimeMs);
    updatePostIndex(null, snap.auditBuffer);
  } catch (err) {
    console.error("[observability] applySnapshot error:", err);
  }
}

const PANEL_SECTIONS = Object.freeze({
  cache: ["cache"],
  predictiveContext: ["predictiveContext"],
  retrieval: ["retrieval"],
  beam: ["beam"],
  delta: ["delta"],
  indexing: ["indexing"],
  tokenEfficiency: ["tokenEfficiency", "packed"],
  health: ["health"],
  latency: ["latency"],
  ppr: ["ppr"],
  scip: ["scip"],
  toolVolume: ["latency"],
  toolOutput: ["toolOutput"],
  postIndex: ["postIndex", "auditBuffer"],
  resources: ["pool", "resources"],
});

const average = (sample) => sample?.count ? sample.sum / sample.count : 0;
const percentage = (part, total) => total ? (part / total) * 100 : 0;

function lifetimeDisplayValues(presentation) {
  const section = presentation.sections ?? {};
  const cache = section.cache;
  const predictive = section.predictiveContext;
  const retrieval = section.retrieval;
  const beam = section.beam;
  const delta = section.delta;
  const indexing = section.indexing;
  const token = section.tokenEfficiency;
  const packed = section.packed;
  const health = section.health;
  const latency = section.latency;
  const ppr = section.ppr;
  const scip = section.scip;
  const output = section.toolOutput;
  const postIndex = section.postIndex;
  return {
    cache: cache && {
      totalHits: cache.hits,
      totalMisses: cache.misses,
      avgLookupLatencyMs: average(cache.lookupMs),
    },
    predictiveContext: predictive && {
      outcomeSamples: predictive.outcomeSamples,
      hitRatePct: percentage(predictive.hitOutcomes, predictive.outcomeSamples),
      wasteRatePct: percentage(predictive.wasteOutcomes, predictive.outcomeSamples),
      acceptedPrefetch: predictive.accepted,
      suppressedPrefetch: predictive.suppressed,
      avgLatencyReductionMs: average(predictive.latencyReductionMs),
    },
    retrieval: retrieval && {
      avgLatencyMs: average(retrieval.latencyMs),
      emptyResultCount: retrieval.emptyResults,
    },
    beam: beam && {
      avgBuildMs: average(beam.buildMs),
      retainedHandlesPeak: beam.retainedHandlesPeak,
      avgAccepted: beam.builds ? beam.accepted / beam.builds : 0,
      avgEvicted: beam.builds ? beam.evicted / beam.builds : 0,
      avgRejected: beam.builds ? beam.rejected / beam.builds : 0,
      avgFrontierMaxSize: average(beam.frontierMax),
    },
    delta: delta && {
      avgBlastRadiusLatencyMs: average(delta.blastRadiusMs),
      avgDbRoundTripsPerChangedSymbol: average(delta.dbRoundTrips),
      avgPathExplanationLatencyMs: average(delta.pathExplanationMs),
      fallbackPathQueryCount: delta.fallbackPathQueries,
    },
    indexing: indexing && {
      totalEvents: indexing.events,
      avgPass1Ms: average(indexing.pass1Ms),
      avgPass2Ms: average(indexing.pass2Ms),
      failures: indexing.failures,
      derivedStateLagMs: average(indexing.derivedLagMs),
    },
    tokenEfficiency: {
      ...(token && {
        totalUsed: token.usedTokens,
        totalSaved: token.savedTokens,
        avgPerCall: token.calls ? token.usedTokens / token.calls : 0,
      }),
      ...(packed && {
        packedAdoptionPct: percentage(packed.packed, packed.decisions),
        packedTokensSaved: Math.max(0, packed.baselineTokens - packed.packedTokens),
        packedBytesSaved: Math.max(0, packed.baselineBytes - packed.packedBytes),
      }),
    },
    health: health && {
      watcherErrors: health.watcherErrors,
      watcherRestartCount: health.watcherRestarts,
      watcherWatchmanWarningCount: health.watchmanWarnings,
      watcherWatchmanRecrawlCount: health.watchmanRecrawls,
      watcherWatchmanFreshInstanceCount: health.watchmanFreshInstances,
    },
    latency: latency && { avgMs: average(latency.durationMs), maxMs: latency.durationMs.max },
    ppr: ppr && {
      avgComputeMs: average(ppr.computeMs),
      avgSeedCount: average(ppr.seeds),
      avgTouched: average(ppr.touched),
      nativeRatio: percentage(ppr.native, ppr.runs),
    },
    scip: scip && {
      totalIngests: scip.ingests,
      successCount: scip.successes,
      failureCount: scip.failures,
      avgIngestMs: average(scip.ingestMs),
      totalEdgesCreated: scip.edgesCreated,
      totalEdgesUpgraded: scip.edgesUpgraded,
    },
    toolVolume: latency && { totalCalls: latency.calls },
    toolOutput: output && {
      calls: output.calls,
      errors: output.errors,
      handled: output.handled,
      truncated: output.truncated,
      detail: Object.entries(output.detailCounts).map(([key, count]) => `${key}:${count}`).join(" · "),
      recovery: output.recoveryEmitted,
    },
    postIndex: postIndex && {
      totalSessions: postIndex.sessions,
      avgDurationMs: average(postIndex.durationMs),
      maxDurationMs: postIndex.durationMs.max,
      timeoutCount: postIndex.timeouts,
    },
    resources: presentation.processPeaks && {
      "processPeaks.cpuPct": presentation.processPeaks.cpuPct,
      "processPeaks.rssMb": presentation.processPeaks.rssMb,
      "processPeaks.heapUsedMb": presentation.processPeaks.heapUsedMb,
      "processPeaks.heapTotalMb": presentation.processPeaks.heapTotalMb,
      "processPeaks.eventLoopLagMs": presentation.processPeaks.eventLoopLagMs,
    },
  };
}

function formatLifetimeValue(field, value) {
  if (field.includes("Pct") || field === "nativeRatio") return fmtPct(value);
  if (field.toLowerCase().includes("ms")) return fmtMs(value);
  if (field === "packedBytesSaved") return fmtBytes(value);
  return typeof value === "number" ? fmtNum(value) : value;
}

function applyLifetime(presentation) {
  const values = lifetimeDisplayValues(presentation);
  for (const panel of document.querySelectorAll("[data-panel]")) {
    const panelValues = values[panel.dataset.panel] ?? null;
    for (const output of panel.querySelectorAll("[data-lifetime-field]")) {
      const field = output.dataset.lifetimeField;
      setText(output, panelValues && Object.hasOwn(panelValues, field)
        ? formatLifetimeValue(field, panelValues[field])
        : null);
    }
  }
}

function fmtAge(ms) {
  if (!Number.isFinite(ms)) return "—";
  return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

function renderClientView(view) {
  setText(els.snapshotAge, fmtAge(view.snapshotAgeMs));
  setText(els.checkpointAge, fmtAge(view.lifetime.checkpointAgeMs));
  setText(els.persistenceState, view.lifetime.state);
  if (els.lifetimeWarning) {
    els.lifetimeWarning.textContent = view.lifetime.warning ?? "";
    els.lifetimeWarning.hidden = !view.lifetime.warning;
  }
  if (els.lifetimeResetBtn) {
    els.lifetimeResetBtn.disabled = view.resetDisabled;
  }
  if (!dashboardClient) return;
  const clientState = dashboardClient.getState();
  const staleAfter = Math.max(clientState.sampleIntervalMs * 3, 10_000);
  if (!clientState.streamConnected && view.snapshotAgeMs > staleAfter) {
    setStatus("error", "STALE");
  }
  for (const [panelName, sections] of Object.entries(PANEL_SECTIONS)) {
    const panel = document.querySelector(`[data-panel="${panelName}"]`);
    const host = panel?.querySelector(":scope > .panel-head .section-states");
    if (!host) continue;
    for (const badge of host.children) {
      const sectionState = dashboardClient.sectionState(badge.dataset.section);
      badge.dataset.state = sectionState;
      badge.textContent = `${badge.dataset.section} ${sectionState}`;
    }
  }
}

// -------- Networking --------
function buildHeaders() {
  const h = { Accept: "application/json" };
  if (state.token) h.Authorization = `Bearer ${state.token}`;
  return h;
}

function createRuntimeDashboardClient() {
  return createDashboardClient({
    buildHeaders,
    applySnapshot,
    applyLifetime,
    applyTimeseries,
    onChange: renderClientView,
    onError: (area, error) => {
      console.warn(`[observability] ${area} request failed:`, error);
      if (area === "reset" && els.lifetimeResetStatus) {
        els.lifetimeResetStatus.textContent = `Repository lifetime reset failed: ${error?.message ?? "request failed"}.`;
      }
    },
  });
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
    dashboardClient.setStreamConnected(true);
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
  if (evt.event === "snapshot" || evt.event === "lifetime") {
    dashboardClient.handleSseEvent(evt);
  } else if (evt.event === "heartbeat") {
    // keep-alive only
  } else if (evt.event === "error") {
    setStatus("error", "ERROR");
  }
}

function scheduleReconnect() {
  dashboardClient.setStreamConnected(false);
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
  els.lifetimeResetBtn = $("#lifetimeResetBtn");
  els.lifetimeResetStatus = $("#lifetimeResetStatus");
  els.snapshotAge = $("#snapshotAge");
  els.checkpointAge = $("#checkpointAge");
  els.persistenceState = $("#persistenceState");
  els.lifetimeWarning = $("#lifetimeWarning");
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
      dashboardClient.switchRepo(state.repoId);
      dashboardClient.setStreamConnected(false);
      dashboardClient.hydrate();
      connectStream();
    });
  }

  if (els.lifetimeResetBtn) {
    els.lifetimeResetBtn.addEventListener("click", async () => {
      const repoId = state.repoId;
      const reset = await dashboardClient.resetLifetime({
        control: els.lifetimeResetBtn,
        confirmReset: () => window.confirm(`Reset repository lifetime metrics for "${repoId}"?`),
      });
      if (els.lifetimeResetStatus && reset) {
        els.lifetimeResetStatus.textContent = reset === true
          ? `Repository lifetime reset for ${repoId}.`
          : `Repository lifetime reset committed for ${repoId}, but refreshed lifetime data is unavailable.`;
      }
    });
  }

  for (const [panelName, sections] of Object.entries(PANEL_SECTIONS)) {
    const head = document.querySelector(`[data-panel="${panelName}"] > .panel-head`);
    if (!head) continue;
    const host = document.createElement("span");
    host.className = "section-states";
    for (const section of sections) {
      const badge = document.createElement("span");
      badge.className = "section-state";
      badge.dataset.section = section;
      badge.textContent = `${section} FRESHNESS UNAVAILABLE`;
      host.append(badge);
    }
    head.append(host);
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
  dashboardClient = createRuntimeDashboardClient();
  dashboardClient.switchRepo(state.repoId);
  initDashboardLayoutEditor();
  setStatus("idle", "IDLE");
  dashboardClient.setStreamConnected(false);
  dashboardClient.hydrate();
  connectStream();
}

const LAYOUT_V3_KEY = "sdl-observability-panel-layout-v3";
const LAYOUT_V2_KEY = "sdl-observability-panel-layout-v2";

function parseMigratableV2(raw) {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function renderNativeTable(host, { caption, columns, rows, empty = "No data." }) {
  if (!host) return;
  host.replaceChildren();
  if (rows.length === 0) {
    const message = document.createElement("p");
    message.className = "muted";
    message.textContent = empty;
    host.append(message);
    return;
  }

  const table = document.createElement("table");
  const captionElement = document.createElement("caption");
  captionElement.textContent = caption;
  table.append(captionElement);
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of columns) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = column.label;
    headRow.append(th);
  }
  head.append(headRow);
  table.append(head);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    columns.forEach((column, index) => {
      const cell = document.createElement(index === 0 ? "th" : "td");
      if (index === 0) cell.scope = "row";
      cell.textContent = column.format ? column.format(row[column.key], row) : String(row[column.key] ?? "—");
      tr.append(cell);
    });
    body.append(tr);
  }
  table.append(body);
  host.append(table);
}

function loadDashboardLayout(panelIds, storage) {
  const defaults = migrateV2Layout({}, panelIds);
  try {
    const savedV3 = storage.getItem(LAYOUT_V3_KEY);
    if (savedV3 !== null) {
      try {
        return normalizeV3Layout(JSON.parse(savedV3), panelIds);
      } catch {
        return defaults;
      }
    }

    const savedV2 = parseMigratableV2(storage.getItem(LAYOUT_V2_KEY));
    if (savedV2 === null) return defaults;
    const migrated = migrateV2Layout(savedV2, panelIds);
    storage.setItem(LAYOUT_V3_KEY, JSON.stringify(migrated));
    return migrated;
  } catch {
    return defaults;
  }
}

function resetDashboardLayoutStorage(storage) {
  const savedV2 = storage.getItem(LAYOUT_V2_KEY);
  if (parseMigratableV2(savedV2) !== null) storage.removeItem(LAYOUT_V2_KEY);
  storage.removeItem(LAYOUT_V3_KEY);
}

function resetDashboardLayout(storage, current, defaults, apply, announce) {
  try {
    resetDashboardLayoutStorage(storage);
    apply(defaults);
    announce("Panel layout reset.");
    return defaults;
  } catch {
    apply(current);
    announce("Panel layout reset failed.");
    return current;
  }
}

const sameLayoutRect = (left, right) =>
  left.col === right.col &&
  left.row === right.row &&
  left.cols === right.cols &&
  left.rows === right.rows;

function restoreLayoutTransaction(transaction, getLayout, setLayout, applyPanelRect) {
  const restored = { ...getLayout(), [transaction.id]: transaction.origin };
  setLayout(restored);
  applyPanelRect(transaction.panel, transaction.origin);
}

function commitLayoutTransaction(
  transaction,
  storage,
  getLayout,
  setLayout,
  applyPanelRect,
  announce,
) {
  const rect = getLayout()[transaction.id];
  if (sameLayoutRect(rect, transaction.origin)) return;
  try {
    storage.setItem(LAYOUT_V3_KEY, JSON.stringify(getLayout()));
    announce(
      `${transaction.name}, column ${rect.col}, row ${rect.row}, width ${rect.cols}, height ${rect.rows}`,
    );
  } catch {
    restoreLayoutTransaction(transaction, getLayout, setLayout, applyPanelRect);
    announce("Panel layout update failed.");
    transaction.panel.focus();
  }
}

function installKeyboardLayoutTransactions({
  entries,
  storage,
  getLayout,
  setLayout,
  applyPanelRect,
  announce,
  isEditMode,
  visibilityTarget,
  windowTarget,
  cancelOtherTransaction = () => {},
}) {
  let active = null;
  // A cancelled physical key can keep auto-repeating until its keyup arrives.
  const cancelledHeld = new Set();

  const restoreOrigin = (transaction) => {
    restoreLayoutTransaction(transaction, getLayout, setLayout, applyPanelRect);
  };

  const cancel = () => {
    if (!active) return;
    const cancelled = active;
    active = null;
    for (const key of cancelled.held) cancelledHeld.add(key);
    cancelled.held.clear();
    restoreOrigin(cancelled);
  };

  const commit = () => {
    const completed = active;
    active = null;
    completed.held.clear();
    commitLayoutTransaction(
      completed,
      storage,
      getLayout,
      setLayout,
      applyPanelRect,
      announce,
    );
  };

  const arrowDelta = (key) => {
    if (key === "ArrowLeft") return [-1, 0];
    if (key === "ArrowRight") return [1, 0];
    if (key === "ArrowUp") return [0, -1];
    if (key === "ArrowDown") return [0, 1];
    return null;
  };

  for (const entry of entries) {
    entry.panel.addEventListener("keydown", (event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Escape" && active) {
        event.preventDefault();
        cancel();
        return;
      }
      const delta = arrowDelta(event.key);
      if (!delta || !isEditMode()) return;
      if (cancelledHeld.has(event.key)) {
        if (event.repeat) {
          event.preventDefault();
          return;
        }
        cancelledHeld.delete(event.key);
      }
      event.preventDefault();
      if (active && active.panel !== entry.panel) cancel();
      if (!active) {
        cancelOtherTransaction();
        active = {
          ...entry,
          origin: { ...getLayout()[entry.id] },
          held: new Set(),
        };
      }
      active.held.add(event.key);
      const next = event.shiftKey
        ? resizePanel(getLayout(), entry.id, delta[0], delta[1])
        : movePanel(getLayout(), entry.id, delta[0], delta[1]);
      setLayout(next);
      applyPanelRect(entry.panel, next[entry.id]);
    });

    entry.panel.addEventListener("keyup", (event) => {
      const delta = arrowDelta(event.key);
      if (!delta) return;
      if (cancelledHeld.delete(event.key)) return;
      if (!isEditMode() || active?.panel !== entry.panel) return;
      event.preventDefault();
      if (!active.held.delete(event.key) || active.held.size !== 0) return;
      commit();
    });
    entry.panel.addEventListener("blur", cancel);
  }

  visibilityTarget.addEventListener("visibilitychange", () => {
    if (visibilityTarget.visibilityState !== "visible") cancel();
  });
  windowTarget.addEventListener("blur", cancel);
  return { cancel };
}

const INTERACTIVE_HEADER_TARGET = [
  "a[href]",
  "area[href]",
  "button",
  'input:not([type="hidden"])',
  "select",
  "textarea",
  "summary",
  "iframe",
  "audio[controls]",
  "video[controls]",
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="grid"]',
  '[role="gridcell"]',
  '[role="link"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="radiogroup"]',
  '[role="searchbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="tablist"]',
  '[role="textbox"]',
  '[role="tree"]',
  '[role="treegrid"]',
  '[role="treeitem"]',
].join(", ");

function installPointerLayoutTransactions({
  entries,
  grid,
  storage,
  getLayout,
  setLayout,
  applyPanelRect,
  announce,
  isEditMode,
  visibilityTarget,
  windowTarget,
  cancelOtherTransaction = () => {},
}) {
  let active = null;

  const releaseCapture = (transaction) => {
    try {
      if (transaction.captureTarget.hasPointerCapture(transaction.pointerId)) {
        transaction.captureTarget.releasePointerCapture(transaction.pointerId);
      }
    } catch {
      // The browser may drop capture between the check and release.
    }
  };

  const cancel = () => {
    if (!active) return;
    const cancelled = active;
    // lostpointercapture may fire synchronously from release; clear ownership first.
    active = null;
    releaseCapture(cancelled);
    restoreLayoutTransaction(cancelled, getLayout, setLayout, applyPanelRect);
  };

  const commit = () => {
    const completed = active;
    // A synthetic lostpointercapture from release must not turn a commit into rollback.
    active = null;
    releaseCapture(completed);
    commitLayoutTransaction(
      completed,
      storage,
      getLayout,
      setLayout,
      applyPanelRect,
      announce,
    );
  };

  const roundCells = (pixels, step) =>
    Math.sign(pixels) * Math.floor((Math.abs(pixels) / step) + 0.5);

  const gridSteps = () => {
    const style = getComputedStyle(grid);
    const gap = Number.parseFloat(style.columnGap);
    const padding =
      (Number.parseFloat(style.paddingLeft) || 0) +
      (Number.parseFloat(style.paddingRight) || 0);
    const contentWidth = grid.getBoundingClientRect().width - padding;
    const track = (contentWidth - (gap * (GRID.columns - 1))) / GRID.columns;
    const column = track + gap;
    return Number.isFinite(column) && column > 0
      ? { column, row: GRID.rowPx + GRID.gapPx }
      : null;
  };

  const preview = (event) => {
    if (event.pointerId !== active?.pointerId) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    const steps = gridSteps();
    if (!steps) return;
    event.preventDefault();
    const dx = roundCells(event.clientX - active.startX, steps.column);
    const dy = roundCells(event.clientY - active.startY, steps.row);
    // Absolute origin-based previews avoid accumulating sub-cell pointer jitter.
    const originLayout = { ...getLayout(), [active.id]: active.origin };
    const candidate = active.mode === "resize"
      ? resizePanel(originLayout, active.id, dx, dy)
      : movePanel(originLayout, active.id, dx, dy);
    if (candidate === originLayout) return;
    active.lastValid = candidate[active.id];
    const next = { ...getLayout(), [active.id]: active.lastValid };
    setLayout(next);
    applyPanelRect(active.panel, active.lastValid);
  };

  const finish = (event) => {
    if (event.pointerId !== active?.pointerId) return;
    commit();
  };

  const cancelled = (event) => {
    if (event.pointerId !== active?.pointerId) return;
    cancel();
  };

  const start = (entry, mode, captureTarget, event) => {
    if (
      !isEditMode() ||
      event.button !== 0 ||
      event.isPrimary !== true ||
      !Number.isInteger(event.pointerId) ||
      !Number.isFinite(event.clientX) ||
      !Number.isFinite(event.clientY)
    ) return;
    cancel();
    cancelOtherTransaction();
    try {
      captureTarget.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    const origin = { ...getLayout()[entry.id] };
    active = {
      ...entry,
      mode,
      pointerId: event.pointerId,
      captureTarget,
      startX: event.clientX,
      startY: event.clientY,
      origin,
      lastValid: origin,
    };
    entry.panel.focus();
    event.preventDefault();
  };

  for (const entry of entries) {
    entry.header.addEventListener("pointerdown", (event) => {
      const interactive = event.target?.closest?.(INTERACTIVE_HEADER_TARGET);
      if (
        interactive &&
        interactive !== entry.header &&
        entry.header.contains(interactive)
      ) return;
      start(entry, "move", entry.header, event);
    });
    entry.resizeGrip.addEventListener("pointerdown", (event) => {
      if (event.target !== event.currentTarget) return;
      start(entry, "resize", entry.resizeGrip, event);
    });
    for (const target of [entry.header, entry.resizeGrip]) {
      target.addEventListener("pointermove", preview);
      target.addEventListener("pointerup", finish);
      target.addEventListener("pointercancel", cancelled);
      target.addEventListener("lostpointercapture", cancelled);
    }
    entry.panel.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !active) return;
      event.preventDefault();
      cancel();
    });
    entry.panel.addEventListener("blur", cancel);
  }

  visibilityTarget.addEventListener("visibilitychange", () => {
    if (visibilityTarget.visibilityState !== "visible") cancel();
  });
  windowTarget.addEventListener("blur", cancel);
  return { cancel };
}

function initDashboardLayoutEditor() {
  const grid = document.querySelector("#dashboard.dashboard-grid");
  const layoutEditBtn = document.querySelector("#layoutEditBtn");
  const layoutResetBtn = document.querySelector("#layoutResetBtn");
  const layoutStatus = document.querySelector("#layoutStatus");
  if (!grid || !layoutEditBtn || !layoutResetBtn) return;

  const panels = Array.from(grid.querySelectorAll(":scope > .panel[data-panel]"));
  const panelIds = panels.map((panel) => panel.dataset.panel);
  const mobile = window.matchMedia("(max-width: 720px)");
  const defaults = migrateV2Layout({}, panelIds);
  let layout = loadDashboardLayout(panelIds, localStorage);
  let cancelKeyboardTransaction = () => {};
  let cancelPointerTransaction = () => {};

  const applyPanelRect = (panel, rect) => {
    panel.style.setProperty("--panel-col", String(rect.col));
    panel.style.setProperty("--panel-row", String(rect.row));
    panel.style.setProperty("--panel-cols", String(rect.cols));
    panel.style.setProperty("--panel-rows", String(rect.rows));
  };

  const setEditMode = (requested) => {
    const enabled = requested && !mobile.matches;
    if (!enabled) {
      cancelKeyboardTransaction();
      cancelPointerTransaction();
    }
    grid.dataset.layoutEdit = String(enabled);
    layoutEditBtn.setAttribute("aria-pressed", String(enabled));
    for (const panel of panels) {
      if (enabled) panel.tabIndex = 0;
      else panel.removeAttribute("tabindex");
      const resizeGrip = panel.querySelector(":scope > .panel-resize-grip");
      if (resizeGrip) resizeGrip.hidden = !enabled;
    }
  };

  layoutEditBtn.addEventListener("click", () => {
    setEditMode(layoutEditBtn.getAttribute("aria-pressed") !== "true");
  });

  layoutResetBtn.addEventListener("click", () => {
    try {
      if (!window.confirm("Reset dashboard panel layout?")) return;
      cancelKeyboardTransaction();
      cancelPointerTransaction();
      layout = resetDashboardLayout(
        localStorage,
        layout,
        defaults,
        (next) => {
          for (const panel of panels) applyPanelRect(panel, next[panel.dataset.panel]);
        },
        (message) => {
          if (layoutStatus) layoutStatus.textContent = message;
        },
      );
    } finally {
      layoutResetBtn.focus();
    }
  });

  mobile.addEventListener("change", () => setEditMode(false));

  const keyboardEntries = [];
  const pointerEntries = [];
  for (const panel of panels) {
    try {
      const heading = panel.querySelector(":scope > .panel-head h2");
      if (!heading) continue;
      const panelName = heading.textContent.trim();
      heading.id ||= `panel-${panel.dataset.panel}-title`;
      panel.removeAttribute("aria-label");
      panel.setAttribute("aria-labelledby", heading.id);
      panel.setAttribute("aria-describedby", "layoutInstructions");
      applyPanelRect(panel, layout[panel.dataset.panel]);
      keyboardEntries.push({ panel, id: panel.dataset.panel, name: panelName });

      const resizeGrip = document.createElement("button");
      resizeGrip.type = "button";
      resizeGrip.className = "panel-resize-grip";
      resizeGrip.tabIndex = -1;
      resizeGrip.hidden = true;
      resizeGrip.setAttribute("aria-label", `Resize ${panelName}`);
      resizeGrip.setAttribute("aria-describedby", "layoutInstructions");
      panel.append(resizeGrip);
      pointerEntries.push({
        panel,
        header: panel.querySelector(":scope > .panel-head"),
        resizeGrip,
        id: panel.dataset.panel,
        name: panelName,
      });
    } catch {
      panel.removeAttribute("tabindex");
    }
  }

  ({ cancel: cancelKeyboardTransaction } = installKeyboardLayoutTransactions({
    entries: keyboardEntries,
    storage: localStorage,
    getLayout: () => layout,
    setLayout: (next) => {
      layout = next;
    },
    applyPanelRect,
    announce: (message) => {
      if (layoutStatus) layoutStatus.textContent = message;
    },
    isEditMode: () => grid.dataset.layoutEdit === "true",
    visibilityTarget: document,
    windowTarget: window,
    cancelOtherTransaction: () => cancelPointerTransaction(),
  }));
  ({ cancel: cancelPointerTransaction } = installPointerLayoutTransactions({
    entries: pointerEntries,
    grid,
    storage: localStorage,
    getLayout: () => layout,
    setLayout: (next) => {
      layout = next;
    },
    applyPanelRect,
    announce: (message) => {
      if (layoutStatus) layoutStatus.textContent = message;
    },
    isEditMode: () => grid.dataset.layoutEdit === "true",
    visibilityTarget: document,
    windowTarget: window,
    cancelOtherTransaction: () => cancelKeyboardTransaction(),
  }));

  setEditMode(false);
}

if (typeof document !== "undefined" && document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else if (typeof document !== "undefined") {
  init();
}
