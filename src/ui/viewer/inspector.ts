import type { SymbolCard } from "./api.js";
import { subscribe } from "./state.js";

function text(value: unknown): string { return value === undefined || value === null || value === "" ? "-" : String(value); }

export class InspectorPanel {
  constructor(private host: HTMLElement) {
    subscribe((state) => this.render(state.selection?.card ?? null, state.selection?.clusterId));
  }

  render(card: SymbolCard | null, clusterId?: string): void {
    if (!card && !clusterId) {
      this.host.innerHTML = '<header class="panel-head"><h2>INSPECTOR</h2><span class="panel-sub">no selection</span></header><div class="empty">Select a cluster or symbol.</div>';
      return;
    }
    if (!card) {
      this.host.innerHTML = '<header class="panel-head"><h2>CLUSTER</h2><span class="panel-sub">' + text(clusterId) + '</span></header><dl class="inspector-dl"><dt>Cluster ID</dt><dd>' + text(clusterId) + '</dd></dl>';
      return;
    }
    const deps = [...(card.deps?.out ?? []), ...(card.deps?.in ?? [])].slice(0, 8).map((dep) => '<button type="button" data-symbol="' + text(dep.symbolId) + '">' + text(dep.name ?? dep.symbolId) + '</button>').join("");
    this.host.innerHTML = '<header class="panel-head"><h2>' + text(card.name ?? card.symbolId) + '</h2><span class="panel-sub">' + text(card.kind) + '</span></header>' +
      '<dl class="inspector-dl"><dt>Signature</dt><dd><code>' + text(typeof card.signature === "string" ? card.signature : JSON.stringify(card.signature ?? "")) + '</code></dd><dt>Summary</dt><dd>' + text(card.summary) + '</dd></dl>' +
      '<div class="dep-list">' + deps + '</div>';
  }
}
