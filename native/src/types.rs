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

/// Extracted symbol from AST analysis.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeParsedSymbol {
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
    /// JSON-encoded signature object.
    pub signature_json: String,
    /// One-line summary from JSDoc or auto-generated.
    pub summary: String,
    /// JSON-encoded invariants array.
    pub invariants_json: String,
    /// JSON-encoded side-effects array.
    pub side_effects_json: String,
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
    /// Source range.
    pub range: NativeRange,
}

/// Extracted call site.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeParsedCall {
    /// Node ID of the caller (enclosing symbol).
    pub caller_name: String,
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
    /// Extracted symbols.
    pub symbols: Vec<NativeParsedSymbol>,
    /// Extracted imports.
    pub imports: Vec<NativeParsedImport>,
    /// Extracted calls.
    pub calls: Vec<NativeParsedCall>,
    /// Parse error message, if any.
    pub parse_error: Option<String>,
}
