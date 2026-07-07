import type { GraphEvent, SearchResult, SymbolCard, ViewerSettings } from "./api.js";

export type ActiveLens = "none" | "impact" | "community" | "edges";
export type Selection = { repoId: string; clusterId?: string; symbolId?: string; card?: SymbolCard } | null;
export type ViewerState = {
  visibleRepos: Set<string>;
  expandedClusters: Map<string, number>;
  selection: Selection;
  hoveredId: string | null;
  activeLens: ActiveLens;
  settings: ViewerSettings | null;
  searchResults: SearchResult[];
  graphEvents: GraphEvent[];
  ambient: boolean;
};

type Listener = (state: ViewerState) => void;
const listeners = new Set<Listener>();

export const state: ViewerState = {
  visibleRepos: new Set<string>(),
  expandedClusters: new Map<string, number>(),
  selection: null,
  hoveredId: null,
  activeLens: "none",
  settings: null,
  searchResults: [],
  graphEvents: [],
  ambient: false,
};

function emit(): void { for (const listener of listeners) listener(state); }
export function subscribe(listener: Listener): () => void { listeners.add(listener); listener(state); return () => listeners.delete(listener); }
export function setSettings(settings: ViewerSettings): void { state.settings = settings; emit(); }
export function setVisibleRepos(repoIds: Iterable<string>): void { state.visibleRepos = new Set(repoIds); localStorage.setItem("sdl-viewer.repos", JSON.stringify([...state.visibleRepos])); emit(); }
export function loadVisibleRepos(defaultRepoIds: string[]): void {
  try {
    const parsed = JSON.parse(localStorage.getItem("sdl-viewer.repos") ?? "[]") as string[];
    state.visibleRepos = new Set(parsed.length > 0 ? parsed : defaultRepoIds);
  } catch { state.visibleRepos = new Set(defaultRepoIds); }
  emit();
}
export function touchExpandedCluster(key: string): void {
  state.expandedClusters.set(key, performance.now());
  while (state.expandedClusters.size > 3) {
    const oldest = [...state.expandedClusters.entries()].sort((a, b) => a[1] - b[1])[0]?.[0];
    if (!oldest) break;
    state.expandedClusters.delete(oldest);
  }
  emit();
}
export function removeExpandedCluster(key: string): void { state.expandedClusters.delete(key); emit(); }
export function setSelection(selection: Selection): void { state.selection = selection; emit(); }
export function setHovered(id: string | null): void { state.hoveredId = id; emit(); }
export function setActiveLens(lens: ActiveLens): void { state.activeLens = lens; emit(); }
export function setSearchResults(results: SearchResult[]): void { state.searchResults = results; emit(); }
export function pushGraphEvent(event: GraphEvent): void { state.graphEvents = [event, ...state.graphEvents].slice(0, 240); emit(); }
export function setAmbient(active: boolean): void { state.ambient = active; document.body.classList.toggle("viewer-ambient", active); emit(); }
