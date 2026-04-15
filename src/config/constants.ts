/**
 * Constants for SDL-MCP
 *
 * This file defines all named constants used throughout the codebase.
 * Magic numbers have been extracted to improve maintainability and
 * provide clear documentation for configuration values.
 */

// ============================================================================
// Database & Query Constants
// ============================================================================

/**
 * Timeout for database busy state in milliseconds.
 * LadybugDB may block if the database is locked; this sets how long
 * to wait before giving up.
 */
export const DB_BUSY_TIMEOUT_MS = 5000;

/**
 * Maximum number of prepared statements to cache.
 * Caching improves performance by avoiding statement recompilation.
 */
export const MAX_STATEMENT_CACHE_SIZE = 500;

/**
 * Number of rows to insert in a single batch transaction.
 * Batched inserts balance memory usage with transaction efficiency.
 */
export const DB_CHUNK_SIZE = 500;

/**
 * Default limit for database query results.
 */
export const DB_QUERY_LIMIT_DEFAULT = 50;

/**
 * Maximum limit for database query results.
 */
export const DB_QUERY_LIMIT_MAX = 100;

// ============================================================================
// Code Display & Window Constants
// ============================================================================

/**
 * Default maximum number of lines to return in hot path excerpts.
 */
export const DEFAULT_MAX_LINES_HOTPATH = 50;

/**
 * Default maximum token budget for hot path excerpts.
 */
export const DEFAULT_MAX_TOKENS_HOTPATH = 1000;

/**
 * Default maximum number of lines to return in code skeletons.
 */
export const DEFAULT_MAX_LINES_SKELETON = 100;

/**
 * Default maximum token budget for code skeletons.
 */
export const DEFAULT_MAX_TOKENS_SKELETON = 2000;

/**
 * Maximum lines for detailed code skeletons.
 */
export const DEFAULT_MAX_LINES_SKELETON_DETAILED = 200;

/**
 * Maximum token budget for detailed code skeletons.
 */
export const DEFAULT_MAX_TOKENS_SKELETON_DETAILED = 5000;

/**
 * Default number of context lines to include around matched identifiers.
 */
export const DEFAULT_CONTEXT_LINES = 3;

/**
 * Default maximum number of lines to return in code window requests.
 */
export const DEFAULT_MAX_WINDOW_LINES = 180;

/**
 * Default maximum token budget for code window requests.
 */
export const DEFAULT_MAX_WINDOW_TOKENS = 1400;

// ============================================================================
// Graph & Slice Constants
// ============================================================================

/**
 * Default maximum number of symbol cards to include in a graph slice.
 * Tightened from 300 to 60 to reduce token cost per slice response.
 */
export const DEFAULT_MAX_CARDS = 60;

/**
 * Default maximum estimated token budget for graph slices.
 */
export const DEFAULT_MAX_TOKENS_SLICE = 12000;

/**
 * Maximum size of the frontier during beam search.
 */
export const MAX_FRONTIER = 1000;

/**
 * Maximum number of start nodes sourced from free-form task text.
 */
export const TASK_TEXT_START_NODE_MAX = 40;

/**
 * Maximum number of distinct task-text tokens considered for start-node seeding.
 */
export const TASK_TEXT_TOKEN_MAX = 24;

/**
 * Maximum number of symbol matches to pull per task-text token.
 */
export const TASK_TEXT_TOKEN_QUERY_LIMIT = 6;

/**
 * Minimum token length required for task-text seeding.
 */
export const TASK_TEXT_MIN_TOKEN_LENGTH = 3;

/**
 * Maximum character length for stack-trace text used as a hybrid retrieval query.
 * Prevents excessively long queries that would degrade FTS/vector search performance.
 */
export const STACK_TRACE_QUERY_MAX_LENGTH = 500;

/**
 * Max promoted first-hop dependencies (call/import) per explicit entry symbol.
 */
export const ENTRY_FIRST_HOP_MAX_PER_SYMBOL = 4;

/**
 * Max same-file sibling symbols to promote per explicit entry symbol.
 */
export const ENTRY_SIBLING_MAX_PER_SYMBOL = 3;

/**
 * Minimum shared prefix length for sibling promotion based on name similarity.
 */
export const ENTRY_SIBLING_MIN_SHARED_PREFIX = 6;

/**
 * Minimum score threshold for including nodes in slice results.
 */
export const SLICE_SCORE_THRESHOLD = 0.2;

/**
 * Beam-search scoring boost for symbols in the same cluster as entry symbols.
 */
export const CLUSTER_COHESION_SAME_BOOST = 0.15;

/**
 * Beam-search scoring boost for symbols in clusters related to entry clusters.
 */
export const CLUSTER_COHESION_RELATED_BOOST = 0.05;

/**
 * Number of frontier candidates to include as suggestions when slice is truncated.
 */
export const SLICE_FRONTIER_SUGGESTIONS = 10;

/**
 * Base token cost for including a symbol in a slice estimate.
 */
export const SYMBOL_TOKEN_BASE = 50;

/**
 * Maximum additional tokens to add for symbol summary in slice estimates.
 */
export const SYMBOL_TOKEN_ADDITIONAL_MAX = 150;

/**
 * Maximum token cost for a single symbol card in slice estimates.
 */
export const SYMBOL_TOKEN_MAX = 200;

/**
 * Estimated number of characters per token for rough token counting.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

// ============================================================================
// File & Content Limits
// ============================================================================

/**
 * Maximum file size in bytes to index (2MB).
 * Large files are skipped to prevent memory issues and slow indexing.
 */
export const MAX_FILE_BYTES = 2000000;

/**
 * Maximum file size in bytes for tree-sitter parsing (1 MB).
 * Tree-sitter native addon can crash or OOM on very large files.
 * This is stricter than MAX_FILE_BYTES to protect the live server
 * during skeleton/hotpath generation.
 */
export const MAX_TREESITTER_PARSE_BYTES = 1024 * 1024;

/**
 * Maximum length of query strings to show in error messages.
 */
export const QUERY_PREVIEW_LENGTH = 50;

/**
 * Maximum length for tree-sitter query strings.
 */
export const GRAMMAR_QUERY_LENGTH = 100;

// ============================================================================
// Timeout & Interval Constants
// ============================================================================

/**
 * Interval in milliseconds for cleaning up expired slice handles (1 hour).
 */
export const CLEANUP_INTERVAL_MS = 3600000;

/**
 * Time-to-live for slice handles in milliseconds (1 hour).
 */
export const SLICE_LEASE_TTL_MS = 3600000;

/**
 * Debounce delay in milliseconds for file watch events.
 */
export const WATCH_DEBOUNCE_MS = 200;

/**
 * Stability threshold in milliseconds for file watch events.
 */
export const WATCH_STABILITY_THRESHOLD_MS = 200;

/**
 * Poll interval in milliseconds for file watchers.
 */
export const WATCH_POLL_INTERVAL_MS = 100;

// ============================================================================
// Indexer & Diagnostics Constants
// ============================================================================

/**
 * Maximum number of TypeScript errors to report before truncating.
 */
export const TS_DIAGNOSTICS_MAX_ERRORS = 50;

/**
 * Maximum number of cached TypeScript LanguageService instances.
 * Each instance holds a full AST in memory; cap prevents unbounded growth.
 */
export const TS_DIAGNOSTICS_MAX_CACHE = 5;

/**
 * Maximum number of watcher errors to accumulate before truncating.
 */
export const WATCHER_ERROR_MAX_COUNT = 100;

/**
 * Threshold for detecting stale watcher state when pending changes exist.
 */
export const WATCHER_STALE_THRESHOLD_MS = 60_000;

/**
 * Base retry delay for failed incremental watcher re-index operations.
 */
export const WATCHER_REINDEX_RETRY_BASE_MS = 250;

/**
 * Maximum retry delay for watcher re-index backoff.
 */
export const WATCHER_REINDEX_RETRY_MAX_MS = 4000;

/**
 * Maximum attempts for watcher-triggered re-index retries.
 */
export const WATCHER_REINDEX_MAX_ATTEMPTS = 4;

/**
 * Default upper bound on candidate source files in watcher mode.
 */
export const WATCHER_DEFAULT_MAX_WATCHED_FILES = 25_000;

// ============================================================================
// API & Tool Constants
// ============================================================================

/**
 * Maximum number of results to return from symbol search.
 */
export const SYMBOL_SEARCH_MAX_RESULTS = 1000;

/**
 * Maximum page size for paginated results.
 */
export const PAGE_SIZE_MAX = 100;

/**
 * Default number of symbols to return from search operations.
 */
export const SYMBOL_SEARCH_DEFAULT_LIMIT = 50;

/**
 * Maximum number of query tokens to fan out when symbol search receives natural-language text.
 */
export const SYMBOL_SEARCH_MAX_QUERY_TOKENS = 8;

/**
 * Minimum token length used for natural-language symbol search tokenization.
 */
export const SYMBOL_SEARCH_MIN_QUERY_TOKEN_LENGTH = 3;

/**
 * Maximum dependency names to include per dependency kind in symbol cards.
 * Trims high-degree symbols so card payloads remain practical.
 */
export const SYMBOL_CARD_MAX_DEPS_PER_KIND = 24;

/**
 * Max deps per kind for lightweight slice cards (non-entry symbols).
 */
export const SYMBOL_CARD_MAX_DEPS_PER_KIND_LIGHT = 6;

/**
 * Maximum number of test references stored in card metrics payload.
 */
export const SYMBOL_CARD_MAX_TEST_REFS = 8;

/**
 * Maximum number of processes included in a symbol card.
 */
export const SYMBOL_CARD_MAX_PROCESSES = 3;

/**
 * Maximum number of invariants kept in card payload.
 */
export const SYMBOL_CARD_MAX_INVARIANTS = 8;

/**
 * Maximum invariants for lightweight (non-entry) slice cards.
 */
export const SYMBOL_CARD_MAX_INVARIANTS_LIGHT = 2;

/**
 * Maximum number of side effects kept in card payload.
 */
export const SYMBOL_CARD_MAX_SIDE_EFFECTS = 8;

/**
 * Maximum side effects for lightweight (non-entry) slice cards.
 */
export const SYMBOL_CARD_MAX_SIDE_EFFECTS_LIGHT = 2;

/**
 * Maximum summary length stored in symbol card payload.
 */
export const SYMBOL_CARD_SUMMARY_MAX_CHARS = 240;

/**
 * Max summary length for lightweight slice cards.
 */
export const SYMBOL_CARD_SUMMARY_MAX_CHARS_LIGHT = 90;

/**
 * Maximum length for dependency labels in slice cards.
 * Truncates long names to save tokens in wire format.
 */
export const DEP_LABEL_MAX_LENGTH = 80;

/**
 * Default page size for spillover symbol retrieval.
 * Reduced from 50 to 20 to limit per-page token cost.
 */
export const SPILLOVER_DEFAULT_PAGE_SIZE = 20;

/**
 * Length to truncate astFingerprint in standard wire format.
 */
export const AST_FINGERPRINT_WIRE_LENGTH = 16;

/**
 * Length to truncate astFingerprint in compact v2 wire format.
 */
export const AST_FINGERPRINT_COMPACT_WIRE_LENGTH = 8;

/**
 * Length to truncate symbol IDs in compact v2 wire format.
 * 16 hex chars = 64 bits. Collision probability among 1000 symbols is ~10^-14.
 */
export const SYMBOL_ID_COMPACT_WIRE_LENGTH = 16;

// ============================================================================
// Policy & Weights Constants
// ============================================================================

/**
 * Priority weight for window size limit policy (highest).
 */
export const POLICY_PRIORITY_WINDOW_SIZE_LIMIT = 100;

/**
 * Priority weight for identifier requirement policy.
 */
export const POLICY_PRIORITY_IDENTIFIERS_REQUIRED = 90;

/**
 * Priority weight for budget enforcement policy.
 */
export const POLICY_PRIORITY_BUDGET_CAPS = 80;

/**
 * Priority weight for break-glass override policy (highest).
 * Break-glass must be evaluated first so it can short-circuit
 * other rules rather than retroactively clearing their denials.
 */
export const POLICY_PRIORITY_BREAK_GLASS = 110;

/**
 * Priority weight for default deny raw code policy.
 */
export const POLICY_PRIORITY_DEFAULT_DENY_RAW = 5;

/**
 * Minimum Node.js major version required.
 */
export const NODE_MIN_MAJOR_VERSION = 24;

// ============================================================================
// CLI & Server Constants
// ============================================================================

/**
 * Default HTTP port for the MCP server.
 */
export const DEFAULT_HTTP_PORT = 3000;

/**
 * Name of the PID file written alongside the graph database.
 * Used for process discovery and stale-process cleanup.
 */
export const PIDFILE_NAME = "sdl-mcp.pid";

/**
 * Maximum time in milliseconds to wait for graceful shutdown before
 * forcing process exit. Prevents the server from hanging indefinitely
 * if a cleanup step (e.g. LadybugDB close) blocks.
 */
export const SHUTDOWN_FORCE_EXIT_TIMEOUT_MS = 5000;

/**
 * SDL-MCP package version. Keep in sync with package.json.
 */
export const SDL_MCP_VERSION = "0.8.0";

// ============================================================================
// Configuration Defaults
// ============================================================================

/**
 * Default number of memories to surface in repo status and slice builds.
 */
export const DEFAULT_MEMORY_SURFACE_LIMIT = 5;

/**
 * Default concurrency level for indexing operations.
 * Set to 8 for modern SSD systems; parsing and graph DB writes are the actual bottlenecks.
 */
export const DEFAULT_INDEXING_CONCURRENCY = 8;

/**
 * Maximum concurrency level for indexing operations.
 */
export const MAX_INDEXING_CONCURRENCY = 10;

/**
 * Default concurrency for Pass 2 cross-file call resolution.
 * Conservative default (1 = sequential) until tier presets exist.
 */
export const DEFAULT_PASS2_CONCURRENCY = 1;

/**
 * Maximum concurrency for Pass 2 resolvers.
 */
export const MAX_PASS2_CONCURRENCY = 16;

/**
 * Default timeout for operations in milliseconds.
 */
export const DEFAULT_OPERATION_TIMEOUT_MS = 2000;

/**
 * Minimum operation timeout in milliseconds.
 */
export const MIN_OPERATION_TIMEOUT_MS = 100;

// ============================================================================
// Regex Pattern Constants
// ============================================================================

/**
 * Minimum length for AWS Access Key ID in regex pattern.
 */
export const AWS_KEY_MIN_LENGTH = 16;

/**
 * Maximum length for AWS Access Key ID in regex pattern.
 */
export const AWS_KEY_MAX_LENGTH = 32;

/**
 * Length of GitHub personal access token in regex pattern.
 */
export const GITHUB_TOKEN_LENGTH = 36;

// ============================================================================
// Blast Radius Constants
// ============================================================================

/**
 * Growth rate threshold above which a symbol is considered a fan-in amplifier.
 * A growthRate > 0.20 means the symbol's dependency count grew by more than 20%.
 * Amplifiers are sorted to the top of the blast radius list within the same distance tier.
 */
export const FAN_IN_AMPLIFIER_THRESHOLD = 0.2;

// ============================================================================
// Stability & Diff Constants
// ============================================================================

/**
 * Stability score contribution for stable interface.
 */
export const STABILITY_SCORE_INTERFACE = 33;

/**
 * Stability score contribution for stable behavior.
 */
export const STABILITY_SCORE_BEHAVIOR = 33;

/**
 * Stability score contribution for stable side effects.
 */
export const STABILITY_SCORE_SIDE_EFFECTS = 34;

// ============================================================================
// Cache Constants
// ============================================================================

/**
 * Default maximum number of symbol card entries in cache.
 */
export const DEFAULT_SYMBOL_CARD_CACHE_MAX_ENTRIES = 2000;

/**
 * Default maximum size of symbol card cache in bytes (100MB).
 */
export const DEFAULT_SYMBOL_CARD_CACHE_MAX_SIZE_BYTES = 100 * 1024 * 1024;

/**
 * Default maximum number of graph slice entries in cache.
 */
export const DEFAULT_GRAPH_SLICE_CACHE_MAX_ENTRIES = 1000;

/**
 * Default maximum size of graph slice cache in bytes (50MB).
 */
export const DEFAULT_GRAPH_SLICE_CACHE_MAX_SIZE_BYTES = 50 * 1024 * 1024;

// ============================================================================
// ID Validation Constants
// ============================================================================

/**
 * Maximum allowed length for repository IDs.
 * Repository IDs must be <= 128 characters.
 */
export const MAX_REPO_ID_LENGTH = 128;

/**
 * Maximum allowed length for symbol IDs.
 * Symbol IDs must be <= 512 characters.
 */
export const MAX_SYMBOL_ID_LENGTH = 512;

// ============================================================================
// Query Limit Constants
// ============================================================================

/**
 * Default limit for database queries returning multiple rows.
 * Used in listRepos and similar functions.
 */
export const DEFAULT_QUERY_LIMIT = 1000;

/**
 * Default limit for batch database queries.
 * Used in getVersionsByRepo and similar functions.
 */
export const DEFAULT_BATCH_QUERY_LIMIT = 100;

// ============================================================================
// Regex Cache Constants
// ============================================================================

/**
 * Maximum number of compiled regex patterns to cache.
 * When the cache exceeds this size, old entries are evicted.
 */
export const REGEX_CACHE_MAX_SIZE = 500;

/**
 * Number of entries to evict when regex cache is full.
 * Evicts the oldest entries to make room for new patterns.
 */
export const REGEX_CACHE_EVICT_COUNT = 100;

// ============================================================================
// Runtime Execution Constants
// ============================================================================

/**
 * Default maximum execution duration in milliseconds (30 seconds).
 */
export const RUNTIME_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Minimum allowed execution timeout in milliseconds.
 */
export const RUNTIME_MIN_TIMEOUT_MS = 100;

/**
 * Maximum allowed execution timeout in milliseconds (5 minutes).
 */
export const RUNTIME_MAX_TIMEOUT_MS = 600_000;

/**
 * Default maximum stdout bytes captured (1 MB).
 */
export const RUNTIME_DEFAULT_MAX_STDOUT_BYTES = 1_048_576;

/**
 * Default maximum stderr bytes captured (256 KB).
 */
export const RUNTIME_DEFAULT_MAX_STDERR_BYTES = 262_144;

/**
 * Default maximum artifact size on disk (10 MB).
 */
export const RUNTIME_DEFAULT_MAX_ARTIFACT_BYTES = 10_485_760;

/**
 * Default artifact time-to-live in hours.
 */
export const RUNTIME_DEFAULT_ARTIFACT_TTL_HOURS = 24;

/**
 * Default maximum concurrent runtime jobs.
 */
export const RUNTIME_DEFAULT_MAX_CONCURRENT_JOBS = 2;

/**
 * Maximum allowed concurrent runtime jobs.
 */
export const RUNTIME_MAX_CONCURRENT_JOBS = 8;

/**
 * Maximum number of arguments allowed per execution.
 */
export const RUNTIME_MAX_ARG_COUNT = 100;

/**
 * Maximum code string length for code-mode execution (1 MB).
 */
export const RUNTIME_MAX_CODE_LENGTH = 1_048_576;

/**
 * Maximum number of query terms for keyword excerpt matching.
 */
export const RUNTIME_MAX_QUERY_TERMS = 10;

/**
 * Default number of head lines in stdout summary.
 */
export const RUNTIME_EXCERPT_HEAD_LINES = 20;

/**
 * Default number of tail lines in stdout summary.
 */
export const RUNTIME_EXCERPT_TAIL_LINES = 20;

/**
 * Default number of stderr tail lines in summary.
 */
export const RUNTIME_EXCERPT_STDERR_TAIL_LINES = 20;

/**
 * Maximum keyword-matched excerpt windows returned.
 */
export const RUNTIME_MAX_KEYWORD_EXCERPTS = 10;

/**
 * Context lines around each keyword match.
 */
export const RUNTIME_KEYWORD_CONTEXT_LINES = 3;

/**
 * Grace period in milliseconds before escalating SIGTERM to SIGKILL on Unix.
 */
export const RUNTIME_SIGKILL_GRACE_MS = 5000;

/**
 * Default maximum response lines for runtime output.
 */
export const RUNTIME_DEFAULT_MAX_RESPONSE_LINES = 100;

/**
 * Maximum characters per output line before truncation.
 * Prevents single long lines (minified JSON, base64) from dominating token budget.
 */
export const RUNTIME_MAX_LINE_LENGTH = 500;

/**
 * Default output mode for runtime.execute responses.
 * "minimal" returns only status/exitCode/handle (~50 tokens).
 * "summary" returns head+tail excerpts (legacy behavior).
 * "intent" returns only queryTerms-matched excerpts.
 */
export const RUNTIME_DEFAULT_OUTPUT_MODE = "minimal";

/**
 * Minimum bytes for runtime config byte limits.
 */
export const RUNTIME_MIN_BYTES = 1024;

/**
 * Priority for runtime-enabled policy rule.
 */
export const POLICY_PRIORITY_RUNTIME_ENABLED = 100;

/**
 * Priority for runtime-allowed policy rule.
 */
export const POLICY_PRIORITY_RUNTIME_ALLOWED = 95;

/**
 * Priority for runtime cwd-scope policy rule.
 */
export const POLICY_PRIORITY_RUNTIME_CWD_SCOPE = 90;

/**
 * Priority for runtime env-allowlist policy rule.
 */
export const POLICY_PRIORITY_RUNTIME_ENV_ALLOWLIST = 85;

/**
 * Priority for runtime timeout-cap policy rule.
 */
export const POLICY_PRIORITY_RUNTIME_TIMEOUT_CAP = 80;

/**
 * Priority for runtime concurrency-cap policy rule.
 */
export const POLICY_PRIORITY_RUNTIME_CONCURRENCY_CAP = 70;

/**
 * When true, legacy ANN index and semantic reranking are available.
 * When false (default), hybrid retrieval is the only active path.
 *
 * @deprecated Stage 4: Legacy ANN/rerank code is deprecated.
 * Set this to true only for rollback scenarios during the hybrid
 * retrieval transition. Will be removed after two consecutive
 * benchmark runs confirm hybrid stability.
 */
export const LEGACY_ANN_MAINTENANCE_MODE = false;
