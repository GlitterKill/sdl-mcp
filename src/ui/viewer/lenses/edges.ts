import { edgeCounts } from "../edges.js";
import type { SymbolEdge } from "../api.js";

export function renderEdgeCounts(host: HTMLElement, edges: SymbolEdge[]): void {
  host.innerHTML = [...edgeCounts(edges)].map(([kind, count]) => '<label><input type="checkbox" value="' + kind + '" checked />' + kind + ' <span>' + count + '</span></label>').join("");
}
