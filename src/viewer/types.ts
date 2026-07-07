export type ViewerFps = 15 | 30 | 60 | 90 | 120;
export type GalaxyPosition = readonly [number, number, number];
export type ViewerSettingsDto = {
  enabled: boolean;
  fps: ViewerFps;
  ambient: { enabled: boolean; idleSeconds: number; fps: ViewerFps };
  layout: { engine: "auto" | "typescript" | "rust"; iterations: number; maxSymbolsPerClusterExpand: number };
  skins: { maxZipBytes: number; maxEntries: number; maxDecompressedBytes: number };
};
export type UniverseRepoDto = {
  repoId: string;
  symbolCount: number;
  clusterCount: number;
  edgeCount: number;
  galaxy: { position: GalaxyPosition; radius: number };
};
export type UniverseResponseDto = { settings: ViewerSettingsDto; repos: UniverseRepoDto[] };
export type ClusterDto = {
  clusterId: string;
  label: string;
  memberCount: number;
  topSymbols: Array<{ symbolId: string; name: string; kind: string }>;
};
export type ClusterEdgesResponseDto = { edges: Array<{ from: string; to: string; weight: number; kinds: Record<string, number> }> };
export type SymbolEdgesResponseDto = { edges: Array<{ from: string; to: string; kind: string; confidence: number; resolution: string }> };
