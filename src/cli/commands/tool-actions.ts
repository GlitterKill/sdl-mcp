/**
 * CLI action definitions for all 25 gateway tool actions.
 *
 * Each definition maps CLI flags (kebab-case) to handler field names (camelCase),
 * specifying types, required/optional, and descriptions for help rendering.
 */

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
}

export interface ActionDefinition {
  /** Action name matching gateway action map, e.g. "symbol.search" */
  action: string;
  /** Namespace grouping for --list display */
  namespace: "query" | "code" | "repo" | "agent";
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
// Query actions (9)
// ---------------------------------------------------------------------------

const symbolSearch: ActionDefinition = {
  action: "symbol.search",
  namespace: "query",
  description: "Search for symbols by name or summary",
  args: [
    { ...REPO_ID_ARG },
    { flag: "--query", field: "query", type: "string", required: true, description: "Search query", short: "-q" },
    { flag: "--limit", field: "limit", type: "number", description: "Max results (default: 20)" },
    { flag: "--semantic", field: "semantic", type: "boolean", description: "Enable semantic reranking" },
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
    { flag: "--if-none-match", field: "ifNoneMatch", type: "string", description: "ETag for conditional fetch" },
    { ...MIN_CALL_CONFIDENCE_ARG },
    { ...INCLUDE_RESOLUTION_METADATA_ARG },
  ],
  examples: [
    'sdl-mcp tool symbol.getCard --repo-id my-repo --symbol-id "file:src/server.ts::MCPServer"',
  ],
};

const symbolGetCards: ActionDefinition = {
  action: "symbol.getCards",
  namespace: "query",
  description: "Batch fetch symbol cards for multiple IDs",
  args: [
    { ...REPO_ID_ARG },
    { flag: "--symbol-ids", field: "symbolIds", type: "string[]", required: true, description: "Comma-separated symbol IDs" },
    { ...MIN_CALL_CONFIDENCE_ARG },
    { ...INCLUDE_RESOLUTION_METADATA_ARG },
    { flag: "--known-etags", field: "knownEtags", type: "json", description: 'JSON map of symbolId→ETag, e.g. \'{"sym1":"etag1"}\'' },
  ],
  examples: [
    'sdl-mcp tool symbol.getCards --repo-id my-repo --symbol-ids "sym1,sym2,sym3"',
  ],
};

const sliceBuild: ActionDefinition = {
  action: "slice.build",
  namespace: "query",
  description: "Build a graph slice for a task context",
  args: [
    { ...REPO_ID_ARG },
    { flag: "--task-text", field: "taskText", type: "string", description: "Natural language task description" },
    { flag: "--entry-symbols", field: "entrySymbols", type: "string[]", description: "Comma-separated entry symbol IDs" },
    { flag: "--edited-files", field: "editedFiles", type: "string[]", description: "Comma-separated edited file paths" },
    { flag: "--stack-trace", field: "stackTrace", type: "string", description: "Stack trace for debugging" },
    { flag: "--failing-test-path", field: "failingTestPath", type: "string", description: "Path to failing test" },
    { flag: "--card-detail", field: "cardDetail", type: "string", description: "Card detail level: minimal|signature|deps|compact|full" },
    { flag: "--adaptive-detail", field: "adaptiveDetail", type: "boolean", description: "Enable adaptive detail level" },
    { flag: "--wire-format", field: "wireFormat", type: "string", description: "Wire format: standard|compact" },
    { flag: "--wire-format-version", field: "wireFormatVersion", type: "number", description: "Wire format version: 1|2|3" },
    { flag: "--max-cards", field: "_budgetMaxCards", type: "number", description: "Budget: max cards (1-500)" },
    { flag: "--max-tokens", field: "_budgetMaxTokens", type: "number", description: "Budget: max estimated tokens (1-200000)" },
    { flag: "--min-confidence", field: "minConfidence", type: "number", description: "Minimum confidence threshold (0-1)" },
    { ...MIN_CALL_CONFIDENCE_ARG },
    { ...INCLUDE_RESOLUTION_METADATA_ARG },
    { flag: "--known-card-etags", field: "knownCardEtags", type: "json", description: "JSON map of symbolId→ETag for incremental fetch" },
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
    { flag: "--slice-handle", field: "sliceHandle", type: "string", required: true, description: "Slice handle from a previous slice.build" },
    { flag: "--known-version", field: "knownVersion", type: "string", required: true, description: "Known version for incremental refresh" },
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
    { flag: "--spillover-handle", field: "spilloverHandle", type: "string", required: true, description: "Spillover handle from a truncated slice" },
    { flag: "--cursor", field: "cursor", type: "string", description: "Pagination cursor" },
    { flag: "--page-size", field: "pageSize", type: "number", description: "Page size (1-100)" },
  ],
  examples: [
    'sdl-mcp tool slice.spillover.get --spillover-handle "spill-abc"',
  ],
};

const deltaGet: ActionDefinition = {
  action: "delta.get",
  namespace: "query",
  description: "Get delta pack between two versions with blast radius",
  args: [
    { ...REPO_ID_ARG },
    { flag: "--from-version", field: "fromVersion", type: "string", required: true, description: "Source version ID" },
    { flag: "--to-version", field: "toVersion", type: "string", required: true, description: "Target version ID" },
    { flag: "--max-cards", field: "_budgetMaxCards", type: "number", description: "Budget: max cards (1-500)" },
    { flag: "--max-tokens", field: "_budgetMaxTokens", type: "number", description: "Budget: max estimated tokens" },
  ],
  examples: [
    'sdl-mcp tool delta.get --repo-id my-repo --from-version v1 --to-version v2',
  ],
};

const contextSummary: ActionDefinition = {
  action: "context.summary",
  namespace: "query",
  description: "Generate token-bounded context summary",
  args: [
    { ...REPO_ID_ARG },
    { flag: "--query", field: "query", type: "string", required: true, description: "Summary query", short: "-q" },
    { flag: "--budget", field: "budget", type: "number", description: "Token budget" },
    { flag: "--format", field: "format", type: "string", description: "Output format: markdown|json|clipboard" },
    { flag: "--scope", field: "scope", type: "string", description: "Scope: symbol|file|task" },
  ],
  examples: [
    'sdl-mcp tool context.summary --repo-id my-repo --query "auth module"',
  ],
};

const prRiskAnalyze: ActionDefinition = {
  action: "pr.risk.analyze",
  namespace: "query",
  description: "Analyze PR risk with blast radius and test recommendations",
  args: [
    { ...REPO_ID_ARG },
    { flag: "--from-version", field: "fromVersion", type: "string", required: true, description: "Base version" },
    { flag: "--to-version", field: "toVersion", type: "string", required: true, description: "Head version" },
    { flag: "--risk-threshold", field: "riskThreshold", type: "number", description: "Risk threshold (0-100)" },
  ],
  examples: [
    'sdl-mcp tool pr.risk.analyze --repo-id my-repo --from-version v1 --to-version v2',
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
    { flag: "--reason", field: "reason", type: "string", required: true, description: "Reason for requesting code access" },
    { flag: "--expected-lines", field: "expectedLines", type: "number", required: true, description: "Expected number of lines" },
    { flag: "--identifiers", field: "identifiersToFind", type: "string[]", required: true, description: "Comma-separated identifiers to find" },
    { flag: "--granularity", field: "granularity", type: "string", description: "Granularity: symbol|block|fileWindow" },
    { flag: "--max-tokens", field: "maxTokens", type: "number", description: "Max tokens for the window" },
    { flag: "--slice-context", field: "sliceContext", type: "json", description: "JSON slice context for auto-slice" },
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
    { flag: "--symbol-id", field: "symbolId", type: "string", description: "Symbol ID (optional if --file is provided)" },
    { flag: "--file", field: "file", type: "string", description: "File path (optional if --symbol-id is provided)" },
    { flag: "--exported-only", field: "exportedOnly", type: "boolean", description: "Show only exported symbols" },
    { flag: "--max-lines", field: "maxLines", type: "number", description: "Max lines in output" },
    { flag: "--max-tokens", field: "maxTokens", type: "number", description: "Max tokens in output" },
    { flag: "--identifiers", field: "identifiersToFind", type: "string[]", description: "Comma-separated identifiers to highlight" },
  ],
  examples: [
    'sdl-mcp tool code.getSkeleton --repo-id my-repo --file src/server.ts',
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
    { flag: "--identifiers", field: "identifiersToFind", type: "string[]", required: true, description: "Comma-separated identifiers to find" },
    { flag: "--max-lines", field: "maxLines", type: "number", description: "Max lines in output" },
    { flag: "--max-tokens", field: "maxTokens", type: "number", description: "Max tokens in output" },
    { flag: "--context-lines", field: "contextLines", type: "number", description: "Context lines around matches" },
  ],
  examples: [
    'sdl-mcp tool code.getHotPath --repo-id my-repo --symbol-id "sym1" --identifiers "handleAuth,validateToken"',
  ],
};

// ---------------------------------------------------------------------------
// Repo actions (6)
// ---------------------------------------------------------------------------

const repoRegister: ActionDefinition = {
  action: "repo.register",
  namespace: "repo",
  description: "Register a new repository for indexing",
  args: [
    { ...REPO_ID_ARG },
    { flag: "--root-path", field: "rootPath", type: "string", required: true, description: "Absolute path to repository root" },
    { flag: "--ignore", field: "ignore", type: "string[]", description: "Comma-separated glob patterns to ignore" },
    { flag: "--languages", field: "languages", type: "string[]", description: "Comma-separated languages to index" },
    { flag: "--max-file-bytes", field: "maxFileBytes", type: "number", description: "Max file size in bytes" },
  ],
  examples: [
    'sdl-mcp tool repo.register --repo-id my-repo --root-path /path/to/repo',
    'sdl-mcp tool repo.register --repo-id my-repo --root-path . --languages ts,py',
  ],
};

const repoStatus: ActionDefinition = {
  action: "repo.status",
  namespace: "repo",
  description: "Get status information about a repository",
  args: [
    { ...REPO_ID_ARG },
  ],
  examples: [
    'sdl-mcp tool repo.status --repo-id my-repo',
  ],
};

const repoOverview: ActionDefinition = {
  action: "repo.overview",
  namespace: "repo",
  description: "Get token-efficient codebase overview with directory summaries",
  args: [
    { ...REPO_ID_ARG },
    { flag: "--level", field: "level", type: "string", required: true, description: "Detail level: stats|directories|full" },
    { flag: "--include-hotspots", field: "includeHotspots", type: "boolean", description: "Include hotspot analysis" },
    { flag: "--directories", field: "directories", type: "string[]", description: "Comma-separated directories to focus on" },
    { flag: "--max-directories", field: "maxDirectories", type: "number", description: "Max directories to include (1-200)" },
    { flag: "--max-exports-per-directory", field: "maxExportsPerDirectory", type: "number", description: "Max exports per directory (1-50)" },
  ],
  examples: [
    'sdl-mcp tool repo.overview --repo-id my-repo --level stats',
    'sdl-mcp tool repo.overview --repo-id my-repo --level full --include-hotspots',
  ],
};

const indexRefresh: ActionDefinition = {
  action: "index.refresh",
  namespace: "repo",
  description: "Refresh index for a repository (full or incremental)",
  args: [
    { ...REPO_ID_ARG },
    { flag: "--mode", field: "mode", type: "string", required: true, description: "Index mode: full|incremental" },
    { flag: "--reason", field: "reason", type: "string", description: "Reason for refresh" },
  ],
  examples: [
    'sdl-mcp tool index.refresh --repo-id my-repo --mode incremental',
    'sdl-mcp tool index.refresh --repo-id my-repo --mode full --reason "schema change"',
  ],
};

const policyGet: ActionDefinition = {
  action: "policy.get",
  namespace: "repo",
  description: "Get policy configuration for a repository",
  args: [
    { ...REPO_ID_ARG },
  ],
  examples: [
    'sdl-mcp tool policy.get --repo-id my-repo',
  ],
};

const policySet: ActionDefinition = {
  action: "policy.set",
  namespace: "repo",
  description: "Update policy configuration for a repository",
  args: [
    { ...REPO_ID_ARG },
    { flag: "--policy-patch", field: "policyPatch", type: "json", required: true, description: 'JSON policy patch, e.g. \'{"maxWindowLines":200}\'' },
  ],
  examples: [
    'sdl-mcp tool policy.set --repo-id my-repo --policy-patch \'{"maxWindowLines":200,"requireIdentifiers":true}\'',
  ],
};

// ---------------------------------------------------------------------------
// Agent actions (7)
// ---------------------------------------------------------------------------

const agentContext: ActionDefinition = {
  action: "agent.context",
  namespace: "agent",
  description: "Retrieve multi-rung task context for explain, debug, review, or implement work",
  args: [
    { ...REPO_ID_ARG },
    { flag: "--task-type", field: "taskType", type: "string", required: true, description: "Task type: debug|review|implement|explain" },
    { flag: "--task-text", field: "taskText", type: "string", required: true, description: "Task description" },
    { flag: "--budget", field: "budget", type: "json", description: 'JSON budget, e.g. \'{"maxTokens":5000}\'' },
    { flag: "--options", field: "options", type: "json", description: 'JSON options, e.g. \'{"contextMode":"precise","includeTests":true}\'' },
  ],
  examples: [
    'sdl-mcp tool agent.context --repo-id my-repo --task-type debug --task-text "fix auth bug"',
  ],
};

const agentFeedback: ActionDefinition = {
  action: "agent.feedback",
  namespace: "agent",
  description: "Record feedback about useful and missing symbols",
  args: [
    { ...REPO_ID_ARG },
    { flag: "--version-id", field: "versionId", type: "string", required: true, description: "Version ID" },
    { flag: "--slice-handle", field: "sliceHandle", type: "string", required: true, description: "Slice handle" },
    { flag: "--useful-symbols", field: "usefulSymbols", type: "string[]", required: true, description: "Comma-separated useful symbol IDs" },
    { flag: "--missing-symbols", field: "missingSymbols", type: "string[]", description: "Comma-separated missing symbol IDs" },
    { flag: "--task-tags", field: "taskTags", type: "string[]", description: "Comma-separated task tags" },
    { flag: "--task-type", field: "taskType", type: "string", description: "Task type: debug|review|implement|explain" },
    { flag: "--task-text", field: "taskText", type: "string", description: "Task description" },
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
    { flag: "--version-id", field: "versionId", type: "string", description: "Filter by version ID" },
    { flag: "--limit", field: "limit", type: "number", description: "Max records to return (1-1000)" },
    { flag: "--since", field: "since", type: "string", description: "ISO timestamp to filter from" },
  ],
  examples: [
    'sdl-mcp tool agent.feedback.query --repo-id my-repo --limit 10',
  ],
};

const bufferPush: ActionDefinition = {
  action: "buffer.push",
  namespace: "agent",
  description: "Push editor buffer updates (requires active server; limited in CLI mode)",
  args: [
    { ...REPO_ID_ARG },
    { flag: "--event-type", field: "eventType", type: "string", required: true, description: "Event type: open|change|save|close|checkpoint" },
    { flag: "--file-path", field: "filePath", type: "string", required: true, description: "File path" },
    { flag: "--content", field: "content", type: "string", required: true, description: "File content (use stdin for large content)" },
    { flag: "--language", field: "language", type: "string", description: "Language ID" },
    { flag: "--version", field: "version", type: "number", required: true, description: "Buffer version number" },
    { flag: "--dirty", field: "dirty", type: "boolean", required: true, description: "Whether the buffer is dirty" },
    { flag: "--timestamp", field: "timestamp", type: "string", required: true, description: "ISO timestamp" },
    { flag: "--cursor", field: "cursor", type: "json", description: 'JSON cursor position, e.g. \'{"line":0,"col":0}\'' },
    { flag: "--selections", field: "selections", type: "json", description: "JSON array of selections" },
  ],
  examples: [
    'sdl-mcp tool buffer.push --repo-id my-repo --event-type save --file-path src/main.ts --content "..." --version 1 --dirty --timestamp 2024-01-01T00:00:00Z',
  ],
};

const bufferCheckpoint: ActionDefinition = {
  action: "buffer.checkpoint",
  namespace: "agent",
  description: "Request a live draft checkpoint (requires active server; limited in CLI mode)",
  args: [
    { ...REPO_ID_ARG },
    { flag: "--reason", field: "reason", type: "string", description: "Reason for checkpoint" },
  ],
  examples: [
    'sdl-mcp tool buffer.checkpoint --repo-id my-repo',
  ],
};

const bufferStatus: ActionDefinition = {
  action: "buffer.status",
  namespace: "agent",
  description: "Get live draft buffer status (requires active server; limited in CLI mode)",
  args: [
    { ...REPO_ID_ARG },
  ],
  examples: [
    'sdl-mcp tool buffer.status --repo-id my-repo',
  ],
};

const runtimeExecute: ActionDefinition = {
  action: "runtime.execute",
  namespace: "agent",
  description: "Execute a command in a repo-scoped subprocess",
  args: [
    { ...REPO_ID_ARG },
    { flag: "--runtime", field: "runtime", type: "string", required: true, description: "Runtime: node|python|shell" },
    { flag: "--executable", field: "executable", type: "string", description: "Override executable path" },
    { flag: "--args", field: "args", type: "string[]", description: "Comma-separated arguments" },
    { flag: "--code", field: "code", type: "string", description: "Code to execute (written to temp file)" },
    { flag: "--relative-cwd", field: "relativeCwd", type: "string", description: "Working directory relative to repo root" },
    { flag: "--timeout-ms", field: "timeoutMs", type: "number", description: "Execution timeout in ms" },
    { flag: "--query-terms", field: "queryTerms", type: "string[]", description: "Comma-separated keywords for excerpt matching" },
    { flag: "--max-response-lines", field: "maxResponseLines", type: "number", description: "Max lines in output summaries" },
    { flag: "--persist-output", field: "persistOutput", type: "boolean", description: "Persist full output as artifact" },
  ],
  examples: [
    'sdl-mcp tool runtime.execute --repo-id my-repo --runtime shell --code "ls -la"',
    'sdl-mcp tool runtime.execute --repo-id my-repo --runtime node --code "console.log(1+1)"',
  ],
};

const runtimeQueryOutput: ActionDefinition = {
  action: "runtime.queryOutput",
  namespace: "agent",
  description: "Query a persisted runtime artifact for matching output excerpts",
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
  examples: [
    "sdl-mcp tool usage.stats --repo-id my-repo --scope session",
  ],
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
      description: "File path relative to repo root (non-indexed file types only)",
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
      description: "Return only lines matching this regex pattern (case-insensitive)",
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
  ],
  examples: [
    'sdl-mcp tool file.read --repo-id my-repo --file-path "config/settings.json"',
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
    { flag: "--title", field: "title", type: "string", required: true, description: "Memory title" },
    { flag: "--content", field: "content", type: "string", required: true, description: "Memory content" },
    { flag: "--tags", field: "tags", type: "string[]", description: "Comma-separated tags" },
    { flag: "--confidence", field: "confidence", type: "number", description: "Confidence score between 0 and 1" },
    { flag: "--symbol-ids", field: "symbolIds", type: "string[]", description: "Comma-separated symbol IDs" },
    { flag: "--file-rel-paths", field: "fileRelPaths", type: "string[]", description: "Comma-separated relative file paths" },
    { flag: "--memory-id", field: "memoryId", type: "string", description: "Optional existing memory ID" },
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
    { flag: "--query", field: "query", type: "string", description: "Search text" },
    { flag: "--types", field: "types", type: "string[]", description: "Comma-separated memory types" },
    { flag: "--tags", field: "tags", type: "string[]", description: "Comma-separated tags" },
    { flag: "--symbol-ids", field: "symbolIds", type: "string[]", description: "Comma-separated symbol IDs" },
    { flag: "--stale-only", field: "staleOnly", type: "boolean", description: "Only return stale memories" },
    { flag: "--limit", field: "limit", type: "number", description: "Maximum number of memories to return" },
    { flag: "--sort-by", field: "sortBy", type: "string", description: "Sort order: recency|confidence" },
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
    { flag: "--memory-id", field: "memoryId", type: "string", required: true, description: "Memory ID to remove" },
    { flag: "--delete-file", field: "deleteFile", type: "boolean", description: "Also delete the backing memory file" },
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
    { flag: "--symbol-ids", field: "symbolIds", type: "string[]", description: "Comma-separated symbol IDs" },
    { flag: "--task-type", field: "taskType", type: "string", description: "Task type: debug|review|implement|explain" },
    { flag: "--limit", field: "limit", type: "number", description: "Maximum number of memories to return" },
  ],
  examples: [
    "sdl-mcp tool memory.surface --repo-id my-repo --task-type debug --limit 5",
  ],
};

// ---------------------------------------------------------------------------
// All action definitions, grouped by namespace
// ---------------------------------------------------------------------------

export const ACTION_DEFINITIONS: ActionDefinition[] = [
  // Query
  symbolSearch, symbolGetCard, symbolGetCards,
  sliceBuild, sliceRefresh, sliceSpilloverGet,
  deltaGet, contextSummary, prRiskAnalyze,
  // Code
  codeNeedWindow, codeGetSkeleton, codeGetHotPath,
  // Repo
  repoRegister, repoStatus, repoOverview,
  indexRefresh, policyGet, policySet, usageStats, fileRead,
  // Agent
  agentContext, agentFeedback, agentFeedbackQuery,
  bufferPush, bufferCheckpoint, bufferStatus, runtimeExecute, runtimeQueryOutput,
  memoryStore, memoryQuery, memoryRemove, memorySurface,
];

/** Lookup by action name */
export const ACTION_MAP = new Map<string, ActionDefinition>(
  ACTION_DEFINITIONS.map((def) => [def.action, def]),
);

/** All valid action names */
export const ALL_ACTION_NAMES = ACTION_DEFINITIONS.map((d) => d.action);
