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
 * SQLite returns SQLITE_BUSY if the database is locked; this sets how long
 * to wait before giving up.
 */
export const DB_BUSY_TIMEOUT_MS = 5000;

/**
 * Maximum number of prepared SQL statements to cache.
 * Caching improves performance by avoiding statement recompilation.
 */
export const MAX_STATEMENT_CACHE_SIZE = 500;

/**
 * Number of rows to insert in a single batch transaction.
 * SQLite performs better with batched inserts; this size balances
 * memory usage with transaction efficiency.
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
export const TOKENS_PER_CHAR_ESTIMATE = 4;

// ============================================================================
// File & Content Limits
// ============================================================================

/**
 * Maximum file size in bytes to index (2MB).
 * Large files are skipped to prevent memory issues and slow indexing.
 */
export const MAX_FILE_BYTES = 2000000;

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
 * Maximum number of watcher errors to accumulate before truncating.
 */
export const WATCHER_ERROR_MAX_COUNT = 100;

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
export const DEP_LABEL_MAX_LENGTH = 40;

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
 * Priority weight for break-glass override policy (lowest).
 */
export const POLICY_PRIORITY_BREAK_GLASS = 10;

/**
 * Priority weight for default deny raw code policy.
 */
export const POLICY_PRIORITY_DEFAULT_DENY_RAW = 5;

/**
 * Minimum Node.js major version required.
 */
export const NODE_MIN_MAJOR_VERSION = 18;

// ============================================================================
// CLI & Server Constants
// ============================================================================

/**
 * Default HTTP port for the MCP server.
 */
export const DEFAULT_HTTP_PORT = 3000;

// ============================================================================
// Configuration Defaults
// ============================================================================

/**
 * Default concurrency level for indexing operations.
 * Set to 8 for modern SSD systems; parsing and SQLite are the actual bottlenecks.
 */
export const DEFAULT_INDEXING_CONCURRENCY = 8;

/**
 * Maximum concurrency level for indexing operations.
 */
export const MAX_INDEXING_CONCURRENCY = 10;

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
