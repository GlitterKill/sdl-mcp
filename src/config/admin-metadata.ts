export type ConfigUiControl =
  | "array"
  | "boolean"
  | "json"
  | "number"
  | "object"
  | "secret"
  | "select"
  | "string";

export type ConfigImpact =
  | "appliesImmediately"
  | "reconnectClients"
  | "reindexRequired"
  | "restartRequired";

export interface ConfigUiSectionMeta {
  id: string;
  label: string;
  path: string;
  description: string;
  docsAnchor: string;
}

export interface ConfigUiFieldMeta {
  path: string;
  section: string;
  label: string;
  control: ConfigUiControl;
  description: string;
  impact: ConfigImpact[];
  options?: string[];
  highRisk?: boolean;
  secret?: boolean;
  pathLike?: boolean;
  commandLike?: boolean;
}

export interface ConfigUiPreset {
  id: string;
  label: string;
  description: string;
  patch: Array<{ op: "set" | "delete"; path: string; value?: unknown }>;
}

const restart = ["restartRequired"] satisfies ConfigImpact[];
const reindex = ["reindexRequired"] satisfies ConfigImpact[];
const reconnect = [
  "restartRequired",
  "reconnectClients",
] satisfies ConfigImpact[];

export const CONFIG_UI_SECTIONS: ConfigUiSectionMeta[] = [
  { id: "repos", label: "Repositories", path: "/repos", description: "Registered repositories, languages, ignore globs, and per-repo overrides.", docsAnchor: "repositories" },
  { id: "graphDatabase", label: "Graph Database", path: "/graphDatabase", description: "LadybugDB storage path and graph persistence settings.", docsAnchor: "graph-database" },
  { id: "policy", label: "Policy", path: "/policy", description: "Raw-code access gates, token caps, and context window policy.", docsAnchor: "policy" },
  { id: "redaction", label: "Redaction", path: "/redaction", description: "Default and custom secret redaction rules.", docsAnchor: "redaction" },
  { id: "indexing", label: "Indexing", path: "/indexing", description: "Indexer pipeline, provider-first planning, file watching, and pass concurrency.", docsAnchor: "indexing" },
  { id: "liveIndex", label: "Live Index", path: "/liveIndex", description: "Draft buffers, checkpoints, and live reconciliation.", docsAnchor: "live-index" },
  { id: "slice", label: "Graph Slices", path: "/slice", description: "Slice budgets and graph edge weights.", docsAnchor: "slice" },
  { id: "diagnostics", label: "Diagnostics", path: "/diagnostics", description: "TypeScript diagnostics mode, scope, limits, and timeout.", docsAnchor: "diagnostics" },
  { id: "cache", label: "Cache", path: "/cache", description: "Symbol card and graph slice cache limits.", docsAnchor: "cache" },
  { id: "plugins", label: "Plugins", path: "/plugins", description: "Plugin search paths and compatibility policy.", docsAnchor: "plugins" },
  { id: "semantic", label: "Semantic Retrieval", path: "/semantic", description: "Embeddings, model selection, summaries, and vector retrieval.", docsAnchor: "semantic" },
  { id: "semanticEnrichment", label: "Semantic Enrichment", path: "/semanticEnrichment", description: "Provider-backed graph precision from SCIP and LSP sources.", docsAnchor: "semantic-enrichment" },
  { id: "scip", label: "SCIP", path: "/scip", description: "SCIP ingest, external symbols, and scip-io generation.", docsAnchor: "scip" },
  { id: "runtime", label: "Runtime", path: "/runtime", description: "Runtime execution timeouts, artifact caps, and environment allowlists.", docsAnchor: "runtime" },
  { id: "mcpSurface", label: "MCP Surface", path: "/gateway", description: "Gateway mode, Code Mode, HTTP, security, and authentication.", docsAnchor: "mcp-surface" },
  { id: "memory", label: "Memory", path: "/memory", description: "Development-memory tools, file sync, surfacing, and hints.", docsAnchor: "memory" },
  { id: "observability", label: "Observability", path: "/observability", description: "Dashboard sampling, retention, metric taps, and SSE behavior.", docsAnchor: "observability" },
  { id: "wire", label: "Wire / Packing", path: "/wire", description: "Packed response thresholds and encoder toggles.", docsAnchor: "wire" },
  { id: "prefetch", label: "Prefetch", path: "/prefetch", description: "Context prefetch behavior and limits.", docsAnchor: "prefetch" },
  { id: "tracing", label: "Tracing", path: "/tracing", description: "OpenTelemetry tracing exporters, sampling, and scope.", docsAnchor: "tracing" },
  { id: "parallelScorer", label: "Parallel Scorer", path: "/parallelScorer", description: "Parallel graph scoring behavior and fallback limits.", docsAnchor: "parallel-scorer" },
  { id: "concurrency", label: "Concurrency", path: "/concurrency", description: "Tool, session, read-pool, and write concurrency limits.", docsAnchor: "concurrency" },
  { id: "performance", label: "Performance Tier", path: "/performanceTier", description: "Hardware-aware defaults and throughput-oriented presets.", docsAnchor: "performance-tier" },
  { id: "advanced", label: "Advanced / Unknown", path: "/", description: "Raw JSON fields not covered by the current UI metadata.", docsAnchor: "advanced" },
];

export const CONFIG_UI_FIELD_METADATA: ConfigUiFieldMeta[] = [
  { path: "/performanceTier", section: "performance", label: "Performance Tier", control: "select", description: "Auto-tune or pin concurrency defaults for the host.", options: ["auto", "mid", "high", "extreme"], impact: restart },
  { path: "/repos", section: "repos", label: "Repositories", control: "array", description: "Registered repos and per-repo indexing settings.", impact: reindex, pathLike: true },
  { path: "/graphDatabase/path", section: "graphDatabase", label: "Graph Database Path", control: "string", description: "LadybugDB file path for graph persistence.", impact: restart, highRisk: true, pathLike: true },
  { path: "/policy", section: "policy", label: "Policy", control: "object", description: "Code-window, break-glass, and token-budget policy.", impact: restart },
  { path: "/redaction", section: "redaction", label: "Redaction", control: "object", description: "Secret redaction defaults and custom regex patterns.", impact: restart, highRisk: true },
  { path: "/indexing", section: "indexing", label: "Indexing", control: "object", description: "Indexer pipeline, watchers, and concurrency.", impact: reindex },
  { path: "/liveIndex", section: "liveIndex", label: "Live Index", control: "object", description: "Draft-buffer and reconciliation controls.", impact: restart },
  { path: "/slice", section: "slice", label: "Graph Slice", control: "object", description: "Default card/token budgets and edge weights.", impact: restart },
  { path: "/diagnostics", section: "diagnostics", label: "Diagnostics", control: "object", description: "Diagnostics mode, scope, timeout, and max error count.", impact: restart },
  { path: "/cache", section: "cache", label: "Cache", control: "object", description: "In-process cache capacity and byte limits.", impact: restart },
  { path: "/plugins", section: "plugins", label: "Plugins", control: "object", description: "Plugin search paths and strict versioning.", impact: reconnect, highRisk: true, pathLike: true },
  { path: "/semantic", section: "semantic", label: "Semantic Retrieval", control: "object", description: "Embedding and summary provider settings.", impact: reindex },
  { path: "/semantic/summaryApiKey", section: "semantic", label: "Summary API Key", control: "secret", description: "Provider API key for summary generation.", impact: restart, secret: true, highRisk: true },
  { path: "/semanticEnrichment", section: "semanticEnrichment", label: "Semantic Enrichment", control: "object", description: "SCIP and LSP precision enrichment settings.", impact: reindex, highRisk: true, commandLike: true },
  { path: "/scip", section: "scip", label: "SCIP", control: "object", description: "SCIP indexes, generator binary, args, and ingest behavior.", impact: reindex, highRisk: true, commandLike: true },
  { path: "/runtime", section: "runtime", label: "Runtime", control: "object", description: "Execution limits, artifact retention, and env allowlist.", impact: restart, highRisk: true },
  { path: "/gateway", section: "mcpSurface", label: "Gateway", control: "object", description: "Gateway registration behavior.", impact: reconnect },
  { path: "/codeMode", section: "mcpSurface", label: "Code Mode", control: "object", description: "Code Mode tool surface and workflow limits.", impact: reconnect },
  { path: "/http", section: "mcpSurface", label: "HTTP", control: "object", description: "HTTP transport behavior.", impact: restart, highRisk: true },
  { path: "/security", section: "mcpSurface", label: "Security", control: "object", description: "Allowed repository roots and transport guardrails.", impact: restart, highRisk: true, pathLike: true },
  { path: "/httpAuth", section: "mcpSurface", label: "HTTP Auth", control: "object", description: "Bearer token authentication and failed-auth rate limits.", impact: restart, highRisk: true },
  { path: "/httpAuth/token", section: "mcpSurface", label: "HTTP Auth Token", control: "secret", description: "Static bearer token; when omitted, startup may generate one.", impact: reconnect, secret: true, highRisk: true },
  { path: "/memory", section: "memory", label: "Memory", control: "object", description: "Development-memory storage, surfacing, and hints.", impact: reconnect },
  { path: "/observability", section: "observability", label: "Observability", control: "object", description: "Metrics service, dashboard retention, and SSE settings.", impact: restart },
  { path: "/wire", section: "wire", label: "Wire / Packing", control: "object", description: "Packed response thresholds and encoder toggles.", impact: restart },
  { path: "/prefetch", section: "prefetch", label: "Prefetch", control: "object", description: "Context prefetch behavior.", impact: restart },
  { path: "/prefetch/policy", section: "prefetch", label: "Predictive Policy", control: "object", description: "Outcome-trained prefetch suppression, boosts, and retention.", impact: restart },
  { path: "/prefetch/policy/enabled", section: "prefetch", label: "Predictive Policy Enabled", control: "boolean", description: "Use persisted outcomes to tune existing prefetch strategies.", impact: restart },
  { path: "/prefetch/policy/mode", section: "prefetch", label: "Policy Mode", control: "select", description: "Observe records outcomes only; safe can suppress or boost within prefetch budget caps.", options: ["observe", "safe"], impact: restart },
  { path: "/prefetch/policy/minSamples", section: "prefetch", label: "Minimum Samples", control: "number", description: "Outcome samples required before learned suppression or boosts apply.", impact: restart },
  { path: "/prefetch/policy/suppressionWasteRate", section: "prefetch", label: "Suppression Waste Rate", control: "number", description: "Waste-rate threshold that can suppress a strategy after enough samples.", impact: restart },
  { path: "/prefetch/policy/boostHitRate", section: "prefetch", label: "Boost Hit Rate", control: "number", description: "Hit-rate threshold that allows bounded priority boosts.", impact: restart },
  { path: "/prefetch/policy/retentionDays", section: "prefetch", label: "Outcome Retention Days", control: "number", description: "Number of days of detailed outcome events retained for audit and debugging.", impact: restart },
  { path: "/prefetch/policy/maxPriorityBoost", section: "prefetch", label: "Max Priority Boost", control: "number", description: "Upper bound for learned priority boosts applied to existing strategies.", impact: restart },
  { path: "/prefetch/policy/maxBudgetTrimPercent", section: "prefetch", label: "Max Budget Trim", control: "number", description: "Upper bound for learned budget trims inside the configured prefetch budget cap.", impact: restart },
  { path: "/tracing", section: "tracing", label: "Tracing", control: "object", description: "OpenTelemetry tracing behavior.", impact: restart },
  { path: "/parallelScorer", section: "parallelScorer", label: "Parallel Scorer", control: "object", description: "Parallel graph scoring controls.", impact: restart },
  { path: "/concurrency", section: "concurrency", label: "Concurrency", control: "object", description: "Tool/session/read-pool concurrency limits.", impact: restart },
];

export const CONFIG_UI_PRESETS: ConfigUiPreset[] = [
  { id: "performance-conservative", label: "Conservative", description: "Favor low resource usage and predictable latency.", patch: [
    { op: "set", path: "/performanceTier", value: "mid" },
    { op: "set", path: "/indexing/concurrency", value: 2 },
    { op: "set", path: "/indexing/pass2Concurrency", value: 1 },
    { op: "set", path: "/semantic/embeddingConcurrency", value: 1 },
    { op: "set", path: "/runtime/maxConcurrentJobs", value: 1 },
  ] },
  { id: "performance-balanced", label: "Balanced", description: "Let SDL-MCP pick host-aware defaults.", patch: [{ op: "set", path: "/performanceTier", value: "auto" }] },
  { id: "performance-throughput", label: "Throughput", description: "Raise indexing and runtime parallelism for larger workstations.", patch: [
    { op: "set", path: "/performanceTier", value: "high" },
    { op: "set", path: "/indexing/pass2Concurrency", value: 8 },
    { op: "set", path: "/semantic/embeddingConcurrency", value: 4 },
    { op: "set", path: "/runtime/maxConcurrentJobs", value: 4 },
    { op: "set", path: "/observability/sampleIntervalMs", value: 5000 },
  ] },
];

const fieldByPath = new Map(CONFIG_UI_FIELD_METADATA.map((field) => [field.path, field]));
const sectionByPath = new Map(CONFIG_UI_SECTIONS.map((section) => [section.path, section]));

export function getConfigUiMetadata(): {
  sections: ConfigUiSectionMeta[];
  fields: ConfigUiFieldMeta[];
  presets: ConfigUiPreset[];
} {
  return {
    sections: CONFIG_UI_SECTIONS,
    fields: CONFIG_UI_FIELD_METADATA,
    presets: CONFIG_UI_PRESETS,
  };
}

export function getFieldMetadata(pointer: string): ConfigUiFieldMeta | undefined {
  const exact = fieldByPath.get(pointer);
  if (exact) return exact;
  const candidates = [...CONFIG_UI_FIELD_METADATA]
    .filter((field) => pointer === field.path || pointer.startsWith(`${field.path}/`))
    .sort((a, b) => b.path.length - a.path.length);
  return candidates[0];
}

export function getSectionForPointer(pointer: string): ConfigUiSectionMeta {
  const candidates = [...CONFIG_UI_SECTIONS]
    .filter((section) => section.path === "/" || pointer === section.path || pointer.startsWith(`${section.path}/`))
    .sort((a, b) => b.path.length - a.path.length);
  return candidates[0] ?? sectionByPath.get("/") ?? CONFIG_UI_SECTIONS[0];
}

export function isSecretPointer(pointer: string, key?: string): boolean {
  const meta = getFieldMetadata(pointer);
  if (meta?.secret) return true;
  if (!key) return false;
  return /^(apiKey|password|secret|token)$/i.test(key);
}

export function getImpactForPointer(pointer: string): ConfigImpact[] {
  const meta = getFieldMetadata(pointer);
  if (meta) return meta.impact;
  if (pointer.startsWith("/repos") || pointer.startsWith("/indexing")) return reindex;
  if (pointer.startsWith("/semantic") || pointer.startsWith("/semanticEnrichment") || pointer.startsWith("/scip")) return reindex;
  if (pointer.startsWith("/gateway") || pointer.startsWith("/codeMode")) return reconnect;
  return restart;
}

export function isHighRiskPointer(pointer: string): boolean {
  const meta = getFieldMetadata(pointer);
  if (meta?.highRisk || meta?.secret || meta?.commandLike || meta?.pathLike) return true;
  return /\/(args|binary|command|envAllowlist|paths?|rootPath)$/i.test(pointer);
}
