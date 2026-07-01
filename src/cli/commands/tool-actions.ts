/**
 * CLI action definitions for gateway tool actions.
 *
 * Each definition maps CLI flags (kebab-case) to handler field names (camelCase),
 * specifying types, required/optional, and descriptions for help rendering.
 */

import { RUNTIME_NAMES } from "../../runtime/runtimes.js";


export interface ActionArgDef {
  /** CLI flag name, e.g. "--query" */
  flag: string;
  /** Handler field name, e.g. "query" */
  field: string;
  /** Value type */
  type: "string" | "number" | "boolean" | "string[]" | "json";
  /** Whether the flag is required */
  required?: boolean;
  /** Description for --help rendering */
  description: string;
  /** Short alias, e.g. "-q" */
  short?: string;
  /** Invert a boolean flag before assigning it to the handler field. */
  invertBoolean?: boolean;
}

export interface ActionDefinition {
  /** Action name matching gateway action map, e.g. "symbol.search" */
  action: string;
  /** Namespace grouping for --list display */
  namespace: "meta" | "query" | "code" | "repo" | "agent";
  /** One-line description */
  description: string;
  /** Argument definitions */
  args: ActionArgDef[];
  /** Example CLI invocations */
  examples: string[];
}

// ---------------------------------------------------------------------------
// Shared arg definitions used across multiple actions
// ---------------------------------------------------------------------------

const REPO_ID_ARG: ActionArgDef = {
  flag: "--repo-id",
  field: "repoId",
  type: "string",
  required: true,
  description: "Repository ID (auto-resolved from cwd if omitted)",
};

const SYMBOL_ID_ARG: ActionArgDef = {
  flag: "--symbol-id",
  field: "symbolId",
  type: "string",
  required: true,
  description: "Symbol ID",
};

const MIN_CALL_CONFIDENCE_ARG: ActionArgDef = {
  flag: "--min-call-confidence",
  field: "minCallConfidence",
  type: "number",
  description: "Minimum call confidence threshold (0-1)",
};

const INCLUDE_RESOLUTION_METADATA_ARG: ActionArgDef = {
  flag: "--include-resolution-metadata",
  field: "includeResolutionMetadata",
  type: "boolean",
  description: "Include call resolution metadata",
};

// ---------------------------------------------------------------------------
// Meta actions (2)
// ---------------------------------------------------------------------------

const actionSearch: ActionDefinition = {
  action: "action.search",
  namespace: "meta",
  description:
    "Search the SDL-MCP action catalog without opening the graph database",
  args: [
    {
      flag: "--query",
      field: "query",
      type: "string",
      required: true,
      description: "Catalog search query",
      short: "-q",
    },
    {
      flag: "--limit",
      field: "limit",
      type: "number",
      description: "Maximum actions to return (1-50)",
    },
    {
      flag: "--offset",
      field: "offset",
      type: "number",
      description: "Skip the first N ranked actions",
    },
    {
      flag: "--include-schemas",
      field: "includeSchemas",
      type: "boolean",
      description: "Include schema summaries for matched actions",
    },
    {
      flag: "--include-examples",
      field: "includeExamples",
      type: "boolean",
      description: "Include examples for matched actions",
    },
    {
      flag: "--summary-only",
      field: "summaryOnly",
      type: "boolean",
      description: "Return only counts and matched action names",
    },
    {
      flag: "--exclude-disabled",
      field: "excludeDisabled",
      type: "boolean",
      description: "Hide disabled actions from results",
    },
  ],
  examples: [
    "sdl-mcp tool action.search --query memory",
    "sdl-mcp tool sdl.action.search --query repo.status --limit 1 --include-schemas",
  ],
};

const manual: ActionDefinition = {
  action: "manual",
  namespace: "meta",
  description:
    "Render focused SDL-MCP API manual content without opening the graph database",
  args: [
    {
      flag: "--query",
      field: "query",
      type: "string",
      description: "Filter manual actions by query",
      short: "-q",
    },
    {
      flag: "--actions",
      field: "actions",
      type: "string[]",
      description: "Action names to include (comma-separated or repeated)",
    },
    {
      flag: "--format",
      field: "format",
      type: "string",
      description: "Manual format: typescript|markdown|json",
    },
    {
      flag: "--include-schemas",
      field: "includeSchemas",
      type: "boolean",
      description: "Include schema summaries",
    },
    {
      flag: "--no-include-schemas",
      field: "includeSchemas",
      type: "boolean",
      invertBoolean: true,
      description: "Omit schema summaries",
    },
    {
      flag: "--include-examples",
      field: "includeExamples",
      type: "boolean",
      description: "Include examples",
    },
  ],
  examples: [
    "sdl-mcp tool manual --actions repo.status --format typescript",
    "sdl-mcp tool sdl.manual --query workflow --include-examples",
    "sdl-mcp tool manual --actions action.search,manual --format json",
  ],
};

// ---------------------------------------------------------------------------
// Query actions (8)
// ---------------------------------------------------------------------------

const symbolSearch: ActionDefinition = {
  action: "symbol.search",
  namespace: "query",
  description: "Search for symbols by name or summary",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--query",
      field: "query",
      type: "string",
      required: true,
      description: "Search query",
      short: "-q",
    },
    {
      flag: "--limit",
      field: "limit",
      type: "number",
      description: "Max results (default: 20)",
    },
    {
      flag: "--semantic",
      field: "semantic",
      type: "boolean",
      description: "Enable semantic reranking",
    },
  ],
  examples: [
    'sdl-mcp tool symbol.search --repo-id my-repo --query "handleAuth"',
    'sdl-mcp tool symbol.search -q "parseArgs" --limit 5',
  ],
};

const symbolGetCard: ActionDefinition = {
  action: "symbol.getCard",
  namespace: "query",
  description: "Get a single symbol card by ID",
  args: [
    { ...REPO_ID_ARG },
    { ...SYMBOL_ID_ARG },
    {
      flag: "--if-none-match",
      field: "ifNoneMatch",
      type: "string",
      description: "ETag for conditional fetch",
    },
    { ...MIN_CALL_CONFIDENCE_ARG },
    { ...INCLUDE_RESOLUTION_METADATA_ARG },
  ],
  examples: [
    'sdl-mcp tool symbol.getCard --repo-id my-repo --symbol-id "file:src/server.ts::MCPServer"',
  ],
};

const symbolEdit: ActionDefinition = {
  action: "symbol.edit",
  namespace: "repo",
  description:
    "Preview or apply a symbol-scoped edit with astFingerprint, range, file sha, and parse-after validation",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--mode",
      field: "mode",
      type: "string",
      required: true,
      description:
        "Mode: preview|applyNow for CLI. apply requires an MCP/server session because plan handles are process-local.",
    },
    {
      flag: "--symbol-id",
      field: "symbolId",
      type: "string",
      description: "Symbol ID or file::name shorthand",
    },
    {
      flag: "--symbol-ref",
      field: "symbolRef",
      type: "json",
      description:
        'JSON symbol ref, e.g. {"name":"handleAuth","file":"src/auth.ts"}',
    },
    {
      flag: "--operation",
      field: "operation",
      type: "json",
      description:
        'JSON operation, e.g. {"kind":"replaceBody","content":"return true;\\n"}',
    },
    {
      flag: "--plan-handle",
      field: "planHandle",
      type: "string",
      description:
        "Plan handle from symbol.edit preview. apply is MCP/server-session only, not a separate CLI invocation.",
    },
    {
      flag: "--expected-ast-fingerprint",
      field: "expectedAstFingerprint",
      type: "string",
      description: "Required for applyNow: expected current symbol fingerprint",
    },
    {
      flag: "--expected-range",
      field: "expectedRange",
      type: "json",
      description:
        'Required for applyNow: JSON range {"startLine":1,"startCol":0,"endLine":3,"endCol":1}',
    },
    {
      flag: "--create-backup",
      field: "createBackup",
      type: "boolean",
      description: "Create .bak backup for saved-file applies",
    },
  ],
  examples: [
    'sdl-mcp tool symbol.edit --repo-id my-repo --mode preview --symbol-id "src/auth.ts::handleAuth" --operation "{\\"kind\\":\\"replaceBody\\",\\"content\\":\\"return true;\\\\n\\"}"',
    'sdl-mcp tool symbol.edit --repo-id my-repo --mode applyNow --symbol-id "src/auth.ts::handleAuth" --expected-ast-fingerprint fp123 --expected-range "{\\"startLine\\":1,\\"startCol\\":0,\\"endLine\\":3,\\"endCol\\":1}" --operation "{\\"kind\\":\\"replaceBody\\",\\"content\\":\\"return true;\\\\n\\"}"',
  ],
};

const sliceBuild: ActionDefinition = {
  action: "slice.build",
  namespace: "query",
  description: "Build a graph slice for a task context",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--task-text",
      field: "taskText",
      type: "string",
      description: "Natural language task description",
    },
    {
      flag: "--entry-symbols",
      field: "entrySymbols",
      type: "string[]",
      description: "Comma-separated entry symbol IDs",
    },
    {
      flag: "--edited-files",
      field: "editedFiles",
      type: "string[]",
      description: "Comma-separated edited file paths",
    },
    {
      flag: "--stack-trace",
      field: "stackTrace",
      type: "string",
      description: "Stack trace for debugging",
    },
    {
      flag: "--failing-test-path",
      field: "failingTestPath",
      type: "string",
      description: "Path to failing test",
    },
    {
      flag: "--card-detail",
      field: "cardDetail",
      type: "string",
      description: "Card detail level: minimal|signature|deps|compact|full",
    },
    {
      flag: "--adaptive-detail",
      field: "adaptiveDetail",
      type: "boolean",
      description: "Enable adaptive detail level",
    },
    {
      flag: "--wire-format",
      field: "wireFormat",
      type: "string",
      description: "Wire format: standard|readable|compact",
    },
    {
      flag: "--wire-format-version",
      field: "wireFormatVersion",
      type: "number",
      description: "Wire format version: 1|2|3",
    },
    {
      flag: "--max-cards",
      field: "_budgetMaxCards",
      type: "number",
      description: "Budget: max cards (1-500)",
    },
    {
      flag: "--max-tokens",
      field: "_budgetMaxTokens",
      type: "number",
      description: "Budget: max estimated tokens (1-200000)",
    },
    {
      flag: "--min-confidence",
      field: "minConfidence",
      type: "number",
      description: "Minimum confidence threshold (0-1)",
    },
    { ...MIN_CALL_CONFIDENCE_ARG },
    { ...INCLUDE_RESOLUTION_METADATA_ARG },
    {
      flag: "--known-card-etags",
      field: "knownCardEtags",
      type: "json",
      description: "JSON map of symbolId→ETag for incremental fetch",
    },
  ],
  examples: [
    'sdl-mcp tool slice.build --repo-id my-repo --task-text "debug auth flow"',
    'sdl-mcp tool slice.build --repo-id my-repo --entry-symbols "sym1,sym2" --max-cards 50',
  ],
};

const sliceRefresh: ActionDefinition = {
  action: "slice.refresh",
  namespace: "query",
  description: "Refresh an existing slice handle and return incremental delta",
  args: [
    {
      flag: "--slice-handle",
      field: "sliceHandle",
      type: "string",
      required: true,
      description: "Slice handle from a previous slice.build",
    },
    {
      flag: "--known-version",
      field: "knownVersion",
      type: "string",
      required: true,
      description: "Known version for incremental refresh",
    },
  ],
  examples: [
    'sdl-mcp tool slice.refresh --slice-handle "handle-abc" --known-version "v1"',
  ],
};

const sliceSpilloverGet: ActionDefinition = {
  action: "slice.spillover.get",
  namespace: "query",
  description: "Fetch overflow symbols via spillover handle with pagination",
  args: [
    {
      flag: "--spillover-handle",
      field: "spilloverHandle",
      type: "string",
      required: true,
      description: "Spillover handle from a truncated slice",
    },
    {
      flag: "--cursor",
      field: "cursor",
      type: "string",
      description: "Pagination cursor",
    },
    {
      flag: "--page-size",
      field: "pageSize",
      type: "number",
      description: "Page size (1-100)",
    },
  ],
  examples: ['sdl-mcp tool slice.spillover.get --spillover-handle "spill-abc"'],
};

const deltaGet: ActionDefinition = {
  action: "delta.get",
  namespace: "query",
  description: "Get delta pack between two versions with blast radius",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--from-version",
      field: "fromVersion",
      type: "string",
      required: true,
      description: "Source version ID",
    },
    {
      flag: "--to-version",
      field: "toVersion",
      type: "string",
      required: true,
      description: "Target version ID",
    },
    {
      flag: "--max-cards",
      field: "_budgetMaxCards",
      type: "number",
      description: "Budget: max cards (1-500)",
    },
    {
      flag: "--max-tokens",
      field: "_budgetMaxTokens",
      type: "number",
      description: "Budget: max estimated tokens",
    },
  ],
  examples: [
    "sdl-mcp tool delta.get --repo-id my-repo --from-version v1 --to-version v2",
  ],
};

const prRiskAnalyze: ActionDefinition = {
  action: "pr.risk.analyze",
  namespace: "query",
  description: "Analyze PR risk with blast radius and test recommendations",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--from-version",
      field: "fromVersion",
      type: "string",
      required: true,
      description: "Base version",
    },
    {
      flag: "--to-version",
      field: "toVersion",
      type: "string",
      required: true,
      description: "Head version",
    },
    {
      flag: "--risk-threshold",
      field: "riskThreshold",
      type: "number",
      description: "Risk threshold (0-100)",
    },
  ],
  examples: [
    "sdl-mcp tool pr.risk.analyze --repo-id my-repo --from-version v1 --to-version v2",
  ],
};

// ---------------------------------------------------------------------------
// Code actions (3)
// ---------------------------------------------------------------------------

const codeNeedWindow: ActionDefinition = {
  action: "code.needWindow",
  namespace: "code",
  description: "Request gated access to raw code window for a symbol",
  args: [
    { ...REPO_ID_ARG },
    { ...SYMBOL_ID_ARG },
    {
      flag: "--reason",
      field: "reason",
      type: "string",
      required: true,
      description: "Reason for requesting code access",
    },
    {
      flag: "--expected-lines",
      field: "expectedLines",
      type: "number",
      required: true,
      description: "Expected number of lines",
    },
    {
      flag: "--identifiers",
      field: "identifiersToFind",
      type: "string[]",
      required: true,
      description: "Comma-separated identifiers to find",
    },
    {
      flag: "--granularity",
      field: "granularity",
      type: "string",
      description: "Granularity: symbol|block|fileWindow",
    },
    {
      flag: "--max-tokens",
      field: "maxTokens",
      type: "number",
      description: "Max tokens for the window",
    },
    {
      flag: "--slice-context",
      field: "sliceContext",
      type: "json",
      description: "JSON slice context for auto-slice",
    },
    {
      flag: "--response-mode",
      field: "responseMode",
      type: "string",
      description: "Large-response mode: inline|auto|handle",
    },
    {
      flag: "--delta-mode",
      field: "deltaMode",
      type: "string",
      description: "Same-session delta mode: off|auto",
    },
    {
      flag: "--max-delta-lines",
      field: "maxDeltaLines",
      type: "number",
      description: "Maximum diff lines when delta-mode is auto",
    },
  ],
  examples: [
    'sdl-mcp tool code.needWindow --repo-id my-repo --symbol-id "sym1" --reason "debugging" --expected-lines 50 --identifiers "foo,bar"',
  ],
};

const codeGetSkeleton: ActionDefinition = {
  action: "code.getSkeleton",
  namespace: "code",
  description: "Get skeleton view (signatures + control flow, elided bodies)",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--symbol-id",
      field: "symbolId",
      type: "string",
      description: "Symbol ID (optional if --file is provided)",
    },
    {
      flag: "--file",
      field: "file",
      type: "string",
      description: "File path (optional if --symbol-id is provided)",
    },
    {
      flag: "--exported-only",
      field: "exportedOnly",
      type: "boolean",
      description: "Show only exported symbols",
    },
    {
      flag: "--max-lines",
      field: "maxLines",
      type: "number",
      description: "Max lines in output",
    },
    {
      flag: "--max-tokens",
      field: "maxTokens",
      type: "number",
      description: "Max tokens in output",
    },
    {
      flag: "--identifiers",
      field: "identifiersToFind",
      type: "string[]",
      description: "Comma-separated identifiers to highlight",
    },
    {
      flag: "--if-none-match",
      field: "ifNoneMatch",
      type: "string",
      description: "ETag for conditional fetch",
    },
  ],
  examples: [
    "sdl-mcp tool code.getSkeleton --repo-id my-repo --file src/server.ts",
    'sdl-mcp tool code.getSkeleton --repo-id my-repo --symbol-id "sym1" --exported-only',
  ],
};

const codeGetHotPath: ActionDefinition = {
  action: "code.getHotPath",
  namespace: "code",
  description: "Get hot-path excerpt matching identifiers with context",
  args: [
    { ...REPO_ID_ARG },
    { ...SYMBOL_ID_ARG },
    {
      flag: "--identifiers",
      field: "identifiersToFind",
      type: "string[]",
      required: true,
      description: "Comma-separated identifiers to find",
    },
    {
      flag: "--max-lines",
      field: "maxLines",
      type: "number",
      description: "Max lines in output",
    },
    {
      flag: "--max-tokens",
      field: "maxTokens",
      type: "number",
      description: "Max tokens in output",
    },
    {
      flag: "--context-lines",
      field: "contextLines",
      type: "number",
      description: "Context lines around matches",
    },
    {
      flag: "--if-none-match",
      field: "ifNoneMatch",
      type: "string",
      description: "ETag for conditional fetch",
    },
  ],
  examples: [
    'sdl-mcp tool code.getHotPath --repo-id my-repo --symbol-id "sym1" --identifiers "handleAuth,validateToken"',
  ],
};

// ---------------------------------------------------------------------------
// Repo actions (12)
// ---------------------------------------------------------------------------

const repoRegister: ActionDefinition = {
  action: "repo.register",
  namespace: "repo",
  description: "Register a new repository for indexing",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--root-path",
      field: "rootPath",
      type: "string",
      required: true,
      description: "Absolute path to repository root",
    },
    {
      flag: "--ignore",
      field: "ignore",
      type: "string[]",
      description: "Comma-separated glob patterns to ignore",
    },
    {
      flag: "--languages",
      field: "languages",
      type: "string[]",
      description: "Comma-separated languages to index",
    },
    {
      flag: "--max-file-bytes",
      field: "maxFileBytes",
      type: "number",
      description: "Max file size in bytes",
    },
    {
      flag: "--dry-run",
      field: "dryRun",
      type: "boolean",
      description: "Validate and report registration changes without writing",
    },
    {
      flag: "--update-existing",
      field: "updateExisting",
      type: "boolean",
      description: "Apply config changes to an already registered repo",
    },
  ],
  examples: [
    "sdl-mcp tool repo.register --repo-id my-repo --root-path /path/to/repo",
    "sdl-mcp tool repo.register --repo-id my-repo --root-path . --languages ts,py",
  ],
};

const repoStatus: ActionDefinition = {
  action: "repo.status",
  namespace: "repo",
  description: "Get status information about a repository",
  args: [{ ...REPO_ID_ARG }],
  examples: ["sdl-mcp tool repo.status --repo-id my-repo"],
};

const repoOverview: ActionDefinition = {
  action: "repo.overview",
  namespace: "repo",
  description: "Get token-efficient codebase overview with directory summaries",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--level",
      field: "level",
      type: "string",
      required: true,
      description: "Detail level: stats|directories|full",
    },
    {
      flag: "--include-hotspots",
      field: "includeHotspots",
      type: "boolean",
      description: "Include hotspot analysis",
    },
    {
      flag: "--directories",
      field: "directories",
      type: "string[]",
      description: "Comma-separated directories to focus on",
    },
    {
      flag: "--max-directories",
      field: "maxDirectories",
      type: "number",
      description: "Max directories to include (1-200)",
    },
    {
      flag: "--max-exports-per-directory",
      field: "maxExportsPerDirectory",
      type: "number",
      description: "Max exports per directory (1-50)",
    },
    {
      flag: "--if-none-match",
      field: "ifNoneMatch",
      type: "string",
      description: "ETag for conditional fetch",
    },
  ],
  examples: [
    "sdl-mcp tool repo.overview --repo-id my-repo --level stats",
    "sdl-mcp tool repo.overview --repo-id my-repo --level full --include-hotspots",
  ],
};

const indexRefresh: ActionDefinition = {
  action: "index.refresh",
  namespace: "repo",
  description: "Refresh index for a repository (full or incremental)",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--mode",
      field: "mode",
      type: "string",
      required: true,
      description: "Index mode: full|incremental",
    },
    {
      flag: "--reason",
      field: "reason",
      type: "string",
      description: "Reason for refresh",
    },
  ],
  examples: [
    "sdl-mcp tool index.refresh --repo-id my-repo --mode incremental",
    'sdl-mcp tool index.refresh --repo-id my-repo --mode full --reason "schema change"',
  ],
};

const semanticEnrichmentRefresh: ActionDefinition = {
  action: "semantic.enrichment.refresh",
  namespace: "repo",
  description:
    "Run provider-backed semantic enrichment with SCIP > LSP source selection",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--dry-run",
      field: "dryRun",
      type: "boolean",
      description: "Plan and parse providers without writing to the database",
    },
    {
      flag: "--force",
      field: "force",
      type: "boolean",
      description: "Bypass compatible cache decisions where supported",
    },
    {
      flag: "--install",
      field: "install",
      type: "boolean",
      description:
        "Allow verified provider downloads when semanticEnrichment.installPolicy is verified",
    },
    {
      flag: "--languages",
      field: "languages",
      type: "string[]",
      description: "Comma-separated language IDs to refresh",
    },
  ],
  examples: [
    "sdl-mcp tool semantic.enrichment.refresh --repo-id my-repo --dry-run",
    "sdl-mcp tool semantic.enrichment.refresh --repo-id my-repo --languages typescript,python",
  ],
};

const semanticEnrichmentStatus: ActionDefinition = {
  action: "semantic.enrichment.status",
  namespace: "repo",
  description:
    "Report selected semantic enrichment sources, skipped providers, last runs, and precision scores",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--languages",
      field: "languages",
      type: "string[]",
      description: "Comma-separated language IDs to inspect",
    },
  ],
  examples: [
    "sdl-mcp tool semantic.enrichment.status --repo-id my-repo",
    "sdl-mcp tool semantic.enrichment.status --repo-id my-repo --languages typescript",
  ],
};

const policyGet: ActionDefinition = {
  action: "policy.get",
  namespace: "repo",
  description: "Get policy configuration for a repository",
  args: [{ ...REPO_ID_ARG }],
  examples: ["sdl-mcp tool policy.get --repo-id my-repo"],
};

const policySet: ActionDefinition = {
  action: "policy.set",
  namespace: "repo",
  description: "Update policy configuration for a repository",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--policy-patch",
      field: "policyPatch",
      type: "json",
      required: true,
      description: "JSON policy patch, e.g. '{\"maxWindowLines\":200}'",
    },
  ],
  examples: [
    'sdl-mcp tool policy.set --repo-id my-repo --policy-patch \'{"maxWindowLines":200,"requireIdentifiers":true}\'',
  ],
};

// ---------------------------------------------------------------------------
// Agent actions (11)
// ---------------------------------------------------------------------------

const agentFeedback: ActionDefinition = {
  action: "agent.feedback",
  namespace: "agent",
  description: "Record feedback about useful and missing symbols",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--version-id",
      field: "versionId",
      type: "string",
      required: true,
      description: "Version ID",
    },
    {
      flag: "--slice-handle",
      field: "sliceHandle",
      type: "string",
      required: true,
      description: "Slice handle",
    },
    {
      flag: "--useful-symbols",
      field: "usefulSymbols",
      type: "string[]",
      required: true,
      description: "Comma-separated useful symbol IDs",
    },
    {
      flag: "--missing-symbols",
      field: "missingSymbols",
      type: "string[]",
      description: "Comma-separated missing symbol IDs",
    },
    {
      flag: "--task-tags",
      field: "taskTags",
      type: "string[]",
      description: "Comma-separated task tags",
    },
    {
      flag: "--task-type",
      field: "taskType",
      type: "string",
      description: "Task type: debug|review|implement|explain",
    },
    {
      flag: "--task-text",
      field: "taskText",
      type: "string",
      description: "Task description",
    },
  ],
  examples: [
    'sdl-mcp tool agent.feedback --repo-id my-repo --version-id v1 --slice-handle "h1" --useful-symbols "sym1,sym2"',
  ],
};

const agentFeedbackQuery: ActionDefinition = {
  action: "agent.feedback.query",
  namespace: "agent",
  description: "Query feedback records and aggregated statistics",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--version-id",
      field: "versionId",
      type: "string",
      description: "Filter by version ID",
    },
    {
      flag: "--limit",
      field: "limit",
      type: "number",
      description: "Max records to return (1-1000)",
    },
    {
      flag: "--since",
      field: "since",
      type: "string",
      description: "ISO timestamp to filter from",
    },
  ],
  examples: ["sdl-mcp tool agent.feedback.query --repo-id my-repo --limit 10"],
};

const bufferPush: ActionDefinition = {
  action: "buffer.push",
  namespace: "agent",
  description:
    "Push editor buffer updates (requires active server; limited in CLI mode)",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--event-type",
      field: "eventType",
      type: "string",
      required: true,
      description: "Event type: open|change|save|close|checkpoint",
    },
    {
      flag: "--file-path",
      field: "filePath",
      type: "string",
      required: true,
      description: "File path",
    },
    {
      flag: "--content",
      field: "content",
      type: "string",
      required: true,
      description: "File content (use stdin for large content)",
    },
    {
      flag: "--language",
      field: "language",
      type: "string",
      description: "Language ID",
    },
    {
      flag: "--version",
      field: "version",
      type: "number",
      required: true,
      description: "Buffer version number",
    },
    {
      flag: "--dirty",
      field: "dirty",
      type: "boolean",
      required: true,
      description: "Whether the buffer is dirty",
    },
    {
      flag: "--timestamp",
      field: "timestamp",
      type: "string",
      required: true,
      description: "ISO timestamp",
    },
    {
      flag: "--cursor",
      field: "cursor",
      type: "json",
      description: 'JSON cursor position, e.g. \'{"line":0,"col":0}\'',
    },
    {
      flag: "--selections",
      field: "selections",
      type: "json",
      description: "JSON array of selections",
    },
  ],
  examples: [
    'sdl-mcp tool buffer.push --repo-id my-repo --event-type save --file-path src/main.ts --content "..." --version 1 --dirty --timestamp 2024-01-01T00:00:00Z',
  ],
};

const bufferCheckpoint: ActionDefinition = {
  action: "buffer.checkpoint",
  namespace: "agent",
  description:
    "Request a live draft checkpoint (requires active server; limited in CLI mode)",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--reason",
      field: "reason",
      type: "string",
      description: "Reason for checkpoint",
    },
  ],
  examples: ["sdl-mcp tool buffer.checkpoint --repo-id my-repo"],
};

const bufferStatus: ActionDefinition = {
  action: "buffer.status",
  namespace: "agent",
  description:
    "Get live draft buffer status (requires active server; limited in CLI mode)",
  args: [{ ...REPO_ID_ARG }],
  examples: ["sdl-mcp tool buffer.status --repo-id my-repo"],
};

const runtimeExecute: ActionDefinition = {
  action: "runtime.execute",
  namespace: "agent",
  description: "Execute a command in a repo-scoped subprocess",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--runtime",
      field: "runtime",
      type: "string",
      required: true,
      description: `Runtime: ${RUNTIME_NAMES.join("|")}`,
    },
    {
      flag: "--executable",
      field: "executable",
      type: "string",
      description: "Override executable path",
    },
    {
      flag: "--args",
      field: "args",
      type: "string[]",
      description: "Comma-separated arguments",
    },
    {
      flag: "--code",
      field: "code",
      type: "string",
      description: "Code to execute (written to temp file)",
    },
    {
      flag: "--stdin",
      field: "stdin",
      type: "string",
      description: "UTF-8 stdin text for multiline scripts or command input",
    },
    {
      flag: "--relative-cwd",
      field: "relativeCwd",
      type: "string",
      description: "Working directory relative to repo root",
    },
    {
      flag: "--timeout-ms",
      field: "timeoutMs",
      type: "number",
      description: "Execution timeout in ms",
    },
    {
      flag: "--query-terms",
      field: "queryTerms",
      type: "string[]",
      description: "Comma-separated keywords for excerpt matching",
    },
    {
      flag: "--max-response-lines",
      field: "maxResponseLines",
      type: "number",
      description: "Max lines in output summaries (5-1000, default 100)",
    },
    {
      flag: "--persist-output",
      field: "persistOutput",
      type: "boolean",
      description: "Persist full output as artifact",
    },
    {
      flag: "--output-mode",
      field: "outputMode",
      type: "string",
      description: "Response verbosity: minimal|summary|intent",
    },

  ],
  examples: [
    'sdl-mcp tool runtime.execute --repo-id my-repo --runtime shell --code "ls -la"',
    'sdl-mcp tool runtime.execute --repo-id my-repo --runtime node --code "console.log(1+1)"',
  ],
};

const runtimeQueryOutput: ActionDefinition = {
  action: "runtime.queryOutput",
  namespace: "agent",
  description:
    "Query a persisted runtime artifact for matching output excerpts",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--artifact-handle",
      field: "artifactHandle",
      type: "string",
      required: true,
      description: "Artifact handle returned by runtime.execute",
    },
    {
      flag: "--query-terms",
      field: "queryTerms",
      type: "string[]",
      description: "Comma-separated keywords to search for",
    },
    {
      flag: "--cursor",
      field: "cursor",
      type: "json",
      description:
        "Resume after a prior match cursor, e.g. {\"stream\":\"stdout\",\"afterLine\":120}",
    },
    {
      flag: "--line-range",
      field: "lineRange",
      type: "json",
      description:
        "Read an exact range, e.g. {\"stream\":\"stderr\",\"startLine\":10,\"endLine\":40}",
    },
    {
      flag: "--max-excerpts",
      field: "maxExcerpts",
      type: "number",
      description: "Maximum number of excerpts to return",
    },
    {
      flag: "--context-lines",
      field: "contextLines",
      type: "number",
      description: "Context lines to include around matches",
    },
    {
      flag: "--stream",
      field: "stream",
      type: "string",
      description: "Artifact stream to query: stdout|stderr|both",
    },
  ],
  examples: [
    'sdl-mcp tool runtime.queryOutput --repo-id my-repo --artifact-handle "runtime-myrepo-123-abc" --query-terms "error,failed"',
  ],
};

const responseGet: ActionDefinition = {
  action: "response.get",
  namespace: "query",
  description: "Retrieve a stored large tool response by handle",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--handle",
      field: "handle",
      type: "string",
      required: true,
      description: "Response artifact handle returned by a large-response tool",
    },
    {
      flag: "--full",
      field: "full",
      type: "boolean",
      description:
        "Return the full stored response instead of a bounded excerpt",
    },
    {
      flag: "--max-bytes",
      field: "maxBytes",
      type: "number",
      description: "Maximum bytes to return when --full is not set",
    },
    {
      flag: "--max-tokens",
      field: "maxTokens",
      type: "number",
      description: "Estimated token bound when --full is not set",
    },
    {
      flag: "--offset-bytes",
      field: "offsetBytes",
      type: "number",
      description: "Byte offset for excerpt retrieval",
    },
    {
      flag: "--json-path",
      field: "jsonPath",
      type: "string",
      description:
        "Dot or bracket path for extracting a JSON response subtree before serialization or array paging",
    },
    {
      flag: "--raw",
      field: "raw",
      type: "boolean",
      description: "Return raw text excerpts when byte-slicing JSON is intentional",
    },
    {
      flag: "--offset",
      field: "offset",
      type: "number",
      description: "Array item offset after --json-path extraction",
    },
    {
      flag: "--limit",
      field: "limit",
      type: "number",
      description: "Maximum array items to return after --json-path extraction",
    },
  ],
  examples: [
    'sdl-mcp tool response.get --repo-id my-repo --handle "response-myrepo-1770000000000-0123456789abcdef" --raw --max-bytes 8192',
    'sdl-mcp tool response.get --repo-id my-repo --handle "response-myrepo-1770000000000-0123456789abcdef" --json-path finalEvidence[0]',
    'sdl-mcp tool response.get --repo-id my-repo --handle "response-myrepo-1770000000000-0123456789abcdef" --json-path finalEvidence --offset 0 --limit 5',
  ],
};

const usageStats: ActionDefinition = {
  action: "usage.stats",
  namespace: "repo",
  description: "Get token usage statistics for the current session or history",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--scope",
      field: "scope",
      type: "string",
      description: "Usage scope: session|history|both",
    },
    {
      flag: "--detail",
      field: "detail",
      type: "string",
      description: "Response detail level: compact|full",
    },
    {
      flag: "--since",
      field: "since",
      type: "string",
      description: "Only include usage since the given ISO timestamp",
    },
    {
      flag: "--limit",
      field: "limit",
      type: "number",
      description: "Maximum number of history entries to return",
    },
    {
      flag: "--persist",
      field: "persist",
      type: "boolean",
      description: "Persist the current usage snapshot",
    },
  ],
  examples: ["sdl-mcp tool usage.stats --repo-id my-repo --scope session"],
};

const fileRead: ActionDefinition = {
  action: "file.read",
  namespace: "repo",
  description: "Read non-indexed file content from a registered repository",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--file-path",
      field: "filePath",
      type: "string",
      description:
        "File path relative to repo root (non-indexed file types only)",
      required: true,
    },
    {
      flag: "--max-bytes",
      field: "maxBytes",
      type: "number",
      description: "Max bytes to read (default 512KB)",
    },
    {
      flag: "--offset",
      field: "offset",
      type: "number",
      description: "Start reading from this line number (0-based)",
    },
    {
      flag: "--limit",
      field: "limit",
      type: "number",
      description: "Max lines to return",
    },
    {
      flag: "--search",
      field: "search",
      type: "string",
      description:
        "Return only lines matching this regex pattern (case-insensitive)",
    },
    {
      flag: "--search-context",
      field: "searchContext",
      type: "number",
      description: "Lines of context around each search match (default 2)",
    },
    {
      flag: "--json-path",
      field: "jsonPath",
      type: "string",
      description: "For JSON/YAML files: dot-separated key path to extract",
    },
    {
      flag: "--response-mode",
      field: "responseMode",
      type: "string",
      description: "Large-response mode: inline|auto|handle",
    },
    {
      flag: "--delta-mode",
      field: "deltaMode",
      type: "string",
      description: "Same-session delta mode: off|auto",
    },
    {
      flag: "--max-delta-lines",
      field: "maxDeltaLines",
      type: "number",
      description: "Maximum diff lines when delta-mode is auto",
    },
  ],
  examples: [
    'sdl-mcp tool file.read --repo-id my-repo --file-path "config/settings.json"',
  ],
};

const fileWrite: ActionDefinition = {
  action: "file.write",
  namespace: "repo",
  description: "Write a single file with targeted update modes",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--file-path",
      field: "filePath",
      type: "string",
      required: true,
      description: "Path relative to the repository root",
    },
    {
      flag: "--content",
      field: "content",
      type: "string",
      description: "Full file content for create or overwrite mode",
    },
    {
      flag: "--replace-lines",
      field: "replaceLines",
      type: "json",
      description:
        'JSON line replacement object, e.g. {"start":0,"end":2,"content":"new"}',
    },
    {
      flag: "--replace-pattern",
      field: "replacePattern",
      type: "json",
      description:
        'JSON regex replacement object, e.g. {"pattern":"old","replacement":"new","global":true}',
    },
    {
      flag: "--json-path",
      field: "jsonPath",
      type: "string",
      description: "Dot-separated JSON path to update",
    },
    {
      flag: "--json-value",
      field: "jsonValue",
      type: "json",
      description: "JSON value to write when --json-path is set",
    },
    {
      flag: "--insert-at",
      field: "insertAt",
      type: "json",
      description: 'JSON insertion object, e.g. {"line":5,"content":"new"}',
    },
    {
      flag: "--append",
      field: "append",
      type: "string",
      description: "Content to append to the end of the file",
    },
    {
      flag: "--no-backup",
      field: "createBackup",
      type: "boolean",
      description: "Disable the default .bak backup for existing files",
      invertBoolean: true,
    },
    {
      flag: "--create-if-missing",
      field: "createIfMissing",
      type: "boolean",
      description: "Create the file if it does not exist",
    },
  ],
  examples: [
    'sdl-mcp tool file.write --repo-id my-repo --file-path "config/app.json" --json-path "server.port" --json-value 8080',
    'sdl-mcp tool file.write --repo-id my-repo --file-path "docs/note.md" --append "\\nMore detail" --create-if-missing',
    'echo \'{"repoId":"my-repo","filePath":"config/app.json","jsonPath":"server.port","jsonValue":8080}\' | sdl-mcp tool file.write',
  ],
};

const searchEdit: ActionDefinition = {
  action: "search.edit",
  namespace: "repo",
  description: "Preview and apply cross-file search/edit plans",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--mode",
      field: "mode",
      type: "string",
      required: true,
      description: "Phase to run: preview|apply",
    },
    {
      flag: "--targeting",
      field: "targeting",
      type: "string",
      description: "Preview targeting mode: text|symbol|identifier|structural",
    },
    {
      flag: "--query",
      field: "query",
      type: "json",
      description:
        'Preview query JSON, e.g. \'{"literal":"old","replacement":"new","global":true}\'',
    },
    {
      flag: "--edit-mode",
      field: "editMode",
      type: "string",
      description:
        "Preview edit mode: replacePattern|replaceLines|insertAt|append|overwrite",
    },
    {
      flag: "--operations",
      field: "operations",
      type: "json",
      description:
        "Batch preview operations JSON array; mutually exclusive with top-level targeting/query/edit-mode",
    },
    {
      flag: "--filters",
      field: "filters",
      type: "json",
      description:
        'Preview filters JSON, e.g. \'{"include":["src/**/*.ts"],"exclude":["dist/**"]}\'',
    },
    {
      flag: "--preview-context-lines",
      field: "previewContextLines",
      type: "number",
      description: "Context lines to include around preview matches",
    },
    {
      flag: "--max-files",
      field: "maxFiles",
      type: "number",
      description: "Maximum candidate files to edit",
    },
    {
      flag: "--max-matches-per-file",
      field: "maxMatchesPerFile",
      type: "number",
      description: "Maximum matches per file",
    },
    {
      flag: "--max-total-matches",
      field: "maxTotalMatches",
      type: "number",
      description: "Maximum total matches across all files",
    },
    {
      flag: "--plan-handle",
      field: "planHandle",
      type: "string",
      description: "Plan handle returned by preview, required for apply",
    },
    {
      flag: "--create-backup",
      field: "createBackup",
      type: "boolean",
      description: "Create per-file backups during apply",
    },
    {
      flag: "--response-mode",
      field: "responseMode",
      type: "string",
      description: "Large-preview mode: inline|auto|handle",
    },
  ],
  examples: [
    'sdl-mcp tool search.edit --repo-id my-repo --mode preview --targeting text --query \'{"literal":"oldName","replacement":"newName","global":true}\' --edit-mode replacePattern --filters \'{"include":["src/**/*.ts"]}\'',
    'sdl-mcp tool search.edit --repo-id my-repo --mode preview --targeting identifier --query \'{"literal":"old_name","replacement":"new_name","global":true}\' --edit-mode replacePattern --filters \'{"include":["src/**/*.py"]}\'',
    'sdl-mcp tool search.edit --repo-id my-repo --mode preview --targeting structural --query \'{"structural":{"language":"python","treeSitterQuery":"(identifier) @target","requiredCaptures":{"target":"old_name"}},"replacement":"new_name","global":true}\' --edit-mode replacePattern --filters \'{"include":["src/**/*.py"]}\'',
    'sdl-mcp tool search.edit --repo-id my-repo --mode preview --operations \'[{"id":"rename","targeting":"text","query":{"literal":"oldName","replacement":"newName","global":true},"editMode":"replacePattern"}]\'',
    'sdl-mcp tool search.edit --repo-id my-repo --mode apply --plan-handle "search-edit-my-repo-1770000000000-abc123"',
  ],
};

const memoryStore: ActionDefinition = {
  action: "memory.store",
  namespace: "agent",
  description: "Store or update a development memory",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--type",
      field: "type",
      type: "string",
      required: true,
      description: "Memory type: decision|bugfix|task_context",
    },
    {
      flag: "--title",
      field: "title",
      type: "string",
      required: true,
      description: "Memory title",
    },
    {
      flag: "--content",
      field: "content",
      type: "string",
      required: true,
      description: "Memory content",
    },
    {
      flag: "--tags",
      field: "tags",
      type: "string[]",
      description: "Comma-separated tags",
    },
    {
      flag: "--confidence",
      field: "confidence",
      type: "number",
      description: "Confidence score between 0 and 1",
    },
    {
      flag: "--symbol-ids",
      field: "symbolIds",
      type: "string[]",
      description: "Comma-separated symbol IDs",
    },
    {
      flag: "--file-rel-paths",
      field: "fileRelPaths",
      type: "string[]",
      description: "Comma-separated relative file paths",
    },
    {
      flag: "--memory-id",
      field: "memoryId",
      type: "string",
      description: "Optional existing memory ID",
    },
  ],
  examples: [
    'sdl-mcp tool memory.store --repo-id my-repo --type decision --title "Use slices" --content "Prefer slice.build for task context."',
  ],
};

const memoryQuery: ActionDefinition = {
  action: "memory.query",
  namespace: "agent",
  description: "Search stored development memories",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--query",
      field: "query",
      type: "string",
      description: "Search text",
    },
    {
      flag: "--types",
      field: "types",
      type: "string[]",
      description: "Comma-separated memory types",
    },
    {
      flag: "--tags",
      field: "tags",
      type: "string[]",
      description: "Comma-separated tags",
    },
    {
      flag: "--symbol-ids",
      field: "symbolIds",
      type: "string[]",
      description: "Comma-separated symbol IDs",
    },
    {
      flag: "--stale-only",
      field: "staleOnly",
      type: "boolean",
      description: "Only return stale memories",
    },
    {
      flag: "--limit",
      field: "limit",
      type: "number",
      description: "Maximum number of memories to return",
    },
    {
      flag: "--sort-by",
      field: "sortBy",
      type: "string",
      description: "Sort order: recency|confidence",
    },
  ],
  examples: [
    "sdl-mcp tool memory.query --repo-id my-repo --query slice --limit 10",
  ],
};

const memoryRemove: ActionDefinition = {
  action: "memory.remove",
  namespace: "agent",
  description: "Remove a stored development memory",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--memory-id",
      field: "memoryId",
      type: "string",
      required: true,
      description: "Memory ID to remove",
    },
    {
      flag: "--delete-file",
      field: "deleteFile",
      type: "boolean",
      description: "Also delete the backing memory file",
    },
  ],
  examples: [
    "sdl-mcp tool memory.remove --repo-id my-repo --memory-id mem-123",
  ],
};

const memorySurface: ActionDefinition = {
  action: "memory.surface",
  namespace: "agent",
  description: "Surface the most relevant development memories for a task",
  args: [
    { ...REPO_ID_ARG },
    {
      flag: "--symbol-ids",
      field: "symbolIds",
      type: "string[]",
      description: "Comma-separated symbol IDs",
    },
    {
      flag: "--task-type",
      field: "taskType",
      type: "string",
      description: "Task type: debug|review|implement|explain",
    },
    {
      flag: "--limit",
      field: "limit",
      type: "number",
      description: "Maximum number of memories to return",
    },
  ],
  examples: [
    "sdl-mcp tool memory.surface --repo-id my-repo --task-type debug --limit 5",
  ],
};

// ---------------------------------------------------------------------------
// All action definitions, grouped by namespace
// ---------------------------------------------------------------------------

export const ACTION_DEFINITIONS: ActionDefinition[] = [
  // Meta
  actionSearch,
  manual,
  // Query
  symbolSearch,
  symbolGetCard,
  symbolEdit,
  sliceBuild,
  sliceRefresh,
  sliceSpilloverGet,
  deltaGet,
  prRiskAnalyze,
  responseGet,
  // Code
  codeNeedWindow,
  codeGetSkeleton,
  codeGetHotPath,
  // Repo
  repoRegister,
  repoStatus,
  repoOverview,
  indexRefresh,
  semanticEnrichmentRefresh,
  semanticEnrichmentStatus,
  policyGet,
  policySet,
  usageStats,
  fileRead,
  fileWrite,
  searchEdit,
  // Agent
  agentFeedback,
  agentFeedbackQuery,
  bufferPush,
  bufferCheckpoint,
  bufferStatus,
  runtimeExecute,
  runtimeQueryOutput,
  memoryStore,
  memoryQuery,
  memoryRemove,
  memorySurface,
];

/** Lookup by action name */
export const ACTION_MAP = new Map<string, ActionDefinition>(
  ACTION_DEFINITIONS.map((def) => [def.action, def]),
);

/** All valid action names */
export const ALL_ACTION_NAMES = ACTION_DEFINITIONS.map((d) => d.action);
