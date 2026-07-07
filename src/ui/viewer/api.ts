export type GalaxyPlacement = { position: [number, number, number]; radius: number };
export type ViewerSettings = {
  enabled?: boolean;
  fps: 15 | 30 | 60 | 90 | 120;
  ambient: { enabled: boolean; idleSeconds: number; fps: 15 | 30 | 60 | 90 | 120 };
  layout: { engine: "auto" | "typescript" | "rust"; iterations: number; maxSymbolsPerClusterExpand: number };
  skins: { maxZipBytes: number; maxEntries: number; maxDecompressedBytes: number };
};
export type UniverseRepo = { repoId: string; symbolCount: number; clusterCount: number; edgeCount: number; galaxy: GalaxyPlacement };
export type UniverseResponse = { settings: ViewerSettings; repos: UniverseRepo[] };
export type Cluster = { clusterId: string; label: string; memberCount: number; topSymbols?: Array<{ symbolId: string; name: string; kind: string }> };
export type ClusterEdge = { from: string; to: string; weight: number; kind?: string; confidence?: number; resolution?: string };
export type SymbolNode = { id: string; name?: string; kind?: string; fanIn?: number; x?: number; y?: number; z?: number };
export type SymbolEdge = ClusterEdge;
export type LayoutPosition = { id: string; x: number; y: number; z: number };
export type LayoutResponse = { layoutSchemaVersion: number; seed: number; iterations: number; inputHash: string; positions: LayoutPosition[] };
export type SymbolCard = { symbolId?: string; name?: string; kind?: string; signature?: unknown; summary?: string; metrics?: Record<string, unknown>; deps?: { in?: Array<{ symbolId?: string; name?: string; kind?: string }>; out?: Array<{ symbolId?: string; name?: string; kind?: string }> } };
export type SearchResult = { symbolId: string; name: string; kind: string; clusterId?: string | null; score?: number | null; relPath?: string | null };
export type ImpactItem = { symbolId: string; name?: string | null; score: number; rank: number };
export type GraphEvent = { type: string; repoId?: string; clusterId?: string; symbolIds?: string[]; count?: number; timestamp?: number; [key: string]: unknown };
export type SkinListEntry = { id: string; fileName: string; bytes: number };

const TOKEN_STORAGE_KEY = "sdl-mcp-observability-token";

export function readAuthTokenFromPage(): string {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const hashToken = params.get("token");
  if (hashToken) {
    localStorage.setItem(TOKEN_STORAGE_KEY, hashToken);
    history.replaceState(null, "", window.location.pathname + window.location.search);
    return hashToken;
  }
  return localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
}

export class ViewerApi {
  private token = readAuthTokenFromPage();

  setToken(token: string): void {
    this.token = token;
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  }

  getToken(): string {
    return this.token;
  }

  private headers(accept = "application/json"): HeadersInit {
    const headers: Record<string, string> = { Accept: accept };
    if (this.token) headers.Authorization = "Bearer " + this.token;
    return headers;
  }

  async json<T>(url: string): Promise<T> {
    const response = await fetch(url, { headers: this.headers() });
    if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
    return response.json() as Promise<T>;
  }

  async universe(): Promise<UniverseResponse> { return this.json<UniverseResponse>("/api/graph/universe"); }
  async clusters(repoId: string): Promise<{ clusters: Cluster[] }> { return this.json<{ clusters: Cluster[] }>("/api/graph/repo/" + encodeURIComponent(repoId) + "/clusters"); }
  async clusterEdges(repoId: string): Promise<{ edges: ClusterEdge[] }> { return this.json<{ edges: ClusterEdge[] }>("/api/graph/repo/" + encodeURIComponent(repoId) + "/edges?scope=clusters"); }
  async layout(repoId: string, lod: "cluster" | "symbol", clusterId?: string): Promise<LayoutResponse> {
    const params = new URLSearchParams({ lod });
    if (clusterId) params.set("clusterId", clusterId);
    return this.json<LayoutResponse>("/api/graph/repo/" + encodeURIComponent(repoId) + "/layout?" + params.toString());
  }
  async symbolEdges(repoId: string, clusterId: string, filters?: { minConfidence?: number; exactOnly?: boolean; kinds?: string[] }): Promise<{ nodes?: SymbolNode[]; edges: SymbolEdge[] }> {
    const params = new URLSearchParams({ clusterId });
    if (filters?.minConfidence !== undefined) params.set("minConfidence", String(filters.minConfidence));
    if (filters?.exactOnly) params.set("exactOnly", "1");
    if (filters?.kinds?.length) params.set("kinds", filters.kinds.join(","));
    return this.json<{ nodes?: SymbolNode[]; edges: SymbolEdge[] }>("/api/graph/repo/" + encodeURIComponent(repoId) + "/edges?" + params.toString());
  }
  async card(repoId: string, symbolId: string): Promise<SymbolCard> { return this.json<SymbolCard>("/api/graph/repo/" + encodeURIComponent(repoId) + "/symbol/" + encodeURIComponent(symbolId) + "/card"); }
  async search(repoId: string, query: string): Promise<{ results: SearchResult[] }> { return this.json<{ results: SearchResult[] }>("/api/graph/repo/" + encodeURIComponent(repoId) + "/search?q=" + encodeURIComponent(query)); }
  async impact(repoId: string, fromVersion: string, toVersion: string): Promise<{ changed: string[]; blastRadius: ImpactItem[] }> {
    return this.json<{ changed: string[]; blastRadius: ImpactItem[] }>("/api/graph/repo/" + encodeURIComponent(repoId) + "/impact?fromVersion=" + encodeURIComponent(fromVersion) + "&toVersion=" + encodeURIComponent(toVersion));
  }
  async skins(): Promise<{ skins: SkinListEntry[] }> { return this.json<{ skins: SkinListEntry[] }>("/api/graph/skins"); }
  async skinBytes(id: string): Promise<ArrayBuffer> {
    const response = await fetch("/api/graph/skins/" + encodeURIComponent(id), { headers: this.headers("application/zip") });
    if (!response.ok) throw new Error("HTTP " + response.status + " for skin " + id);
    return response.arrayBuffer();
  }
  async graphStream(onEvent: (event: GraphEvent) => void, signal: AbortSignal): Promise<void> {
    const response = await fetch("/api/observability/stream?types=graph", { headers: this.headers("text/event-stream"), signal });
    if (!response.ok || !response.body) throw new Error("SSE failed: HTTP " + response.status);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += chunk.value;
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (!data) continue;
        try { onEvent(JSON.parse(data) as GraphEvent); } catch (error) { console.warn("[viewer] bad SSE event", error); }
      }
    }
  }
}
