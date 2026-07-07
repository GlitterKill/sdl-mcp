import type { SearchResult, ViewerApi } from "../api.js";
import { setSearchResults } from "../state.js";

export type SearchSelectHandler = (result: SearchResult) => void | Promise<void>;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderSearchResultsHtml(results: SearchResult[]): string {
  if (results.length === 0) return '<div class="empty">No results</div>';
  return results.map((result, index) => {
    const score = typeof result.score === "number" ? " · " + result.score.toFixed(3) : "";
    const path = result.relPath ? '<span class="result-path">' + escapeHtml(result.relPath) + '</span>' : "";
    return '<button type="button" class="result-item" data-index="' + String(index) + '" data-symbol-id="' + escapeHtml(result.symbolId) + '" data-cluster-id="' + escapeHtml(result.clusterId ?? "") + '">' +
      '<span class="result-name">' + escapeHtml(result.name || result.symbolId) + '</span>' +
      '<span class="result-meta">' + escapeHtml(result.kind) + score + '</span>' +
      path +
      '</button>';
  }).join("");
}

export function attachSearch(
  input: HTMLInputElement,
  resultsHost: HTMLElement,
  api: ViewerApi,
  getRepoId: () => string,
  onSelect: SearchSelectHandler,
): void {
  let timer = 0;
  let currentResults: SearchResult[] = [];

  const clear = (): void => {
    currentResults = [];
    setSearchResults([]);
    resultsHost.innerHTML = "";
  };
  const choose = async (result: SearchResult | undefined): Promise<void> => {
    if (!result) return;
    await onSelect(result);
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { input.value = ""; clear(); }
    if (event.key === "Enter") { event.preventDefault(); void choose(currentResults[0]); }
  });
  window.addEventListener("keydown", (event) => { if (event.key === "/" && document.activeElement !== input) { event.preventDefault(); input.focus(); } });
  resultsHost.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-index]");
    if (!button) return;
    void choose(currentResults[Number(button.dataset.index)]);
  });
  input.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const query = input.value.trim();
      if (!query) { clear(); return; }
      const response = await api.search(getRepoId(), query);
      currentResults = response.results ?? [];
      setSearchResults(currentResults);
      resultsHost.innerHTML = renderSearchResultsHtml(currentResults);
    }, 180);
  });
}
