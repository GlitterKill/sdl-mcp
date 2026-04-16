use napi_derive::napi;

/// Input file descriptor passed from TypeScript to Rust.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeFileInput {
    /// Relative path from repo root (forward slashes).
    pub rel_path: String,
    /// Absolute path on disk.
    pub absolute_path: String,
    /// Repository identifier.
    pub repo_id: String,
    /// Language identifier (e.g., "ts", "tsx", "js", "py", "go").
    pub language: String,
}

/// Range within a source file (1-indexed lines, 0-indexed columns).
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct NativeRange {
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

/// A single parameter in a function/method signature.
///
/// Typed fields replace the previous JSON-encoded `signature_json: String` so
/// that callers receive structured data rather than opaque text that must be
/// re-parsed on the TypeScript side.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeSymbolSignatureParam {
    /// Parameter name as it appears in source.
    pub name: String,
    /// Declared type annotation, if present (e.g. `"string"`, `"Request | null"`).
    pub type_name: Option<String>,
}

/// Structured representation of a function or method signature.
///
/// `None` fields are omitted rather than serialised as empty arrays/strings,
/// keeping the napi payload compact. The struct is `None` on the parent symbol
/// when there are no params, no return type, and no generics (e.g. plain
/// variables or class declarations).
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeSymbolSignature {
    /// Parameter list. `None` when the symbol has no parameters.
    pub params: Option<Vec<NativeSymbolSignatureParam>>,
    /// Return type annotation, if present (e.g. `"Promise<User>"`).
    pub returns: Option<String>,
    /// Generic type parameters (e.g. `["T", "U extends Serializable"]`).
    pub generics: Option<Vec<String>>,
}

/// Extracted symbol from AST analysis.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeParsedSymbol {
    /// Stable per-file nodeId, format `${name}:${startLine}:${startCol}`.
    /// Distinct from `symbol_id` (a cross-repo SHA-256) — `node_id` is the
    /// key used by same-file edge resolution and call-site joining in
    /// `buildSymbolIndexMaps`. Must match the `caller_node_id` emitted by
    /// `NativeParsedCall` for the enclosing symbol.
    pub node_id: String,
    /// Stable symbol ID: sha256("{repoId}:{relPath}:{kind}:{name}:{astFingerprint}").
    pub symbol_id: String,
    /// AST fingerprint hash.
    pub ast_fingerprint: String,
    /// Symbol kind: "function", "class", "interface", "type_alias", "method",
    /// "constructor", "variable", "module", "enum", "property".
    pub kind: String,
    /// Symbol name.
    pub name: String,
    /// Whether the symbol is exported.
    pub exported: bool,
    /// Visibility: "public", "private", "protected", "internal", or empty.
    pub visibility: String,
    /// Source range.
    pub range: NativeRange,
    /// Parsed signature object.
    pub signature: Option<NativeSymbolSignature>,
    /// One-line summary from JSDoc or auto-generated.
    pub summary: String,
    /// Invariants array.
    pub invariants: Vec<String>,
    /// Side-effects array.
    pub side_effects: Vec<String>,
    /// Role tags inferred from name/path heuristics.
    pub role_tags: Vec<String>,
    /// Raw decorator / annotation / attribute source text attached to this
    /// symbol. Includes the leading sigil (e.g. `@Component(...)`, `@override`,
    /// `#[derive(Debug)]`). Empty for languages without a decorator concept.
    pub decorators: Vec<String>,
    /// Search-oriented text including identifier splits, summary, tags, and path hints.
    pub search_text: String,
    /// Summary quality score: 1.0 = doc comment, 0.4 = typed function, 0.3 = heuristic, 0.0 = none.
    pub summary_quality: Option<f64>,
}

/// Extracted import statement.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeParsedImport {
    /// Module specifier (e.g., "./utils.js", "lodash").
    pub specifier: String,
    /// Whether the import is relative (starts with . or ..).
    pub is_relative: bool,
    /// Whether the import is from an external package.
    pub is_external: bool,
    /// Named imports (e.g., ["foo", "bar"]).
    pub named_imports: Vec<String>,
    /// Default import name, if any.
    pub default_import: Option<String>,
    /// Namespace import name (e.g., "* as ns"), if any.
    pub namespace_import: Option<String>,
    /// Whether this statement re-exports (e.g., `export … from`, `pub use`).
    /// Languages without a re-export concept (Java, C#) always set this to false.
    pub is_re_export: bool,
    /// Source range.
    pub range: NativeRange,
}

/// Extracted call site.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeParsedCall {
    /// Stable nodeId of the caller (enclosing symbol), format
    /// `${name}:${startLine}:${startCol}`. Must match the `node_id` of a
    /// `NativeParsedSymbol` emitted for the same file so downstream
    /// `buildSymbolIndexMaps` can join call sites to their callers.
    pub caller_node_id: String,
    /// Callee identifier (e.g., "foo", "this.bar", "ns.baz").
    pub callee_identifier: String,
    /// Call type: "direct", "method", "constructor", "super", "tagged_template",
    /// "optional_chain", "computed".
    pub call_type: String,
    /// Source range.
    pub range: NativeRange,
}

/// Complete parse result for a single file.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeParsedFile {
    /// Relative path (matches input).
    pub rel_path: String,
    /// SHA-256 hex digest of file content.
    pub content_hash: String,
    /// Raw file content (passed through to avoid double-read on JS side).
    /// `None` for error paths where content was unavailable or irrelevant.
    pub content: Option<String>,
    /// Extracted symbols.
    pub symbols: Vec<NativeParsedSymbol>,
    /// Extracted imports.
    pub imports: Vec<NativeParsedImport>,
    /// Extracted calls.
    pub calls: Vec<NativeParsedCall>,
    /// Parse error message, if any.
    pub parse_error: Option<String>,
}

// Cluster + process analysis types (see native/src/cluster/types.rs, native/src/process/types.rs)
pub use crate::cluster::types::{NativeClusterAssignment, NativeClusterEdge, NativeClusterSymbol};
pub use crate::process::types::{
    NativeProcess, NativeProcessCallEdge, NativeProcessStep, NativeProcessSymbol,
};
