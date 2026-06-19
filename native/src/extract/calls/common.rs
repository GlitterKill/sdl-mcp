use tree_sitter::Node;

use crate::types::{NativeParsedSymbol, NativeRange};

/// Build a stable per-file nodeId for a symbol, format
/// `${name}:${startLine}:${startCol}`.
///
/// This is the canonical Rust-side format consumed by
/// `rust-process-file.ts` → `buildSymbolIndexMaps`. It must stay in sync with
/// the `caller_node_id` produced by every per-language call extractor via
/// `find_enclosing_symbol` below.
/// Canonical set of `ExtractedCall.callType` output literals.
///
/// Must match the TypeScript source-of-truth set in
/// `src/indexer/treesitter/extractCalls.ts` (function, method, constructor,
/// dynamic, computed, tagged-template). Rust extractors must emit only these
/// kebab-case/lowercase strings — `"direct"` and `"tagged_template"` are
/// legacy aliases that were removed in Task 1.5.
pub const CALL_TYPES: &[&str] = &[
    "function",
    "method",
    "constructor",
    "dynamic",
    "computed",
    "tagged-template",
];

pub fn make_node_id(name: &str, range: &NativeRange) -> String {
    format!("{}:{}:{}", name, range.start_line, range.start_col)
}

/// Walk `symbols` and return the nodeId (see `make_node_id`) of the smallest
/// enclosing symbol for `node`, or `"<module>"` when the node is not inside
/// any extracted symbol.
///
/// Returns the stable nodeId rather than bare `name` so that two symbols with
/// the same name inside a single file (overloaded functions, methods on
/// different classes) remain distinguishable in the caller→callee edge map.
pub fn find_enclosing_symbol(node: Node<'_>, symbols: &[NativeParsedSymbol]) -> String {
    let node_start = node.start_position();
    let node_end = node.end_position();
    let node_start_line = (node_start.row + 1) as u32;
    let node_start_col = node_start.column as u32;
    let node_end_line = (node_end.row + 1) as u32;
    let node_end_col = node_end.column as u32;

    let mut best_non_variable: Option<&NativeParsedSymbol> = None;
    let mut best_non_variable_size = u64::MAX;
    let mut best_any: Option<&NativeParsedSymbol> = None;
    let mut best_any_size = u64::MAX;

    for sym in symbols {
        if symbol_contains_range(
            sym,
            node_start_line,
            node_start_col,
            node_end_line,
            node_end_col,
        ) {
            let size = symbol_range_size(sym);
            if size < best_any_size {
                best_any = Some(sym);
                best_any_size = size;
            }
            if sym.kind != "variable" && size < best_non_variable_size {
                best_non_variable = Some(sym);
                best_non_variable_size = size;
            }
        }
    }

    best_non_variable
        .or(best_any)
        .map(|s| s.node_id.clone())
        .unwrap_or_else(|| "<module>".to_string())
}

fn symbol_contains_range(
    sym: &NativeParsedSymbol,
    start_line: u32,
    start_col: u32,
    end_line: u32,
    end_col: u32,
) -> bool {
    if start_line < sym.range.start_line || end_line > sym.range.end_line {
        return false;
    }
    if start_line == sym.range.start_line && start_col < sym.range.start_col {
        return false;
    }
    if end_line == sym.range.end_line && end_col > sym.range.end_col {
        return false;
    }
    true
}

fn symbol_range_size(sym: &NativeParsedSymbol) -> u64 {
    let line_span = sym.range.end_line.saturating_sub(sym.range.start_line) as u64;
    let col_span = sym.range.end_col.saturating_sub(sym.range.start_col) as u64;
    (line_span * 1_000_000) + col_span
}

pub fn node_text<'a>(node: Node<'a>, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

pub fn extract_range(node: Node<'_>) -> NativeRange {
    let start = node.start_position();
    let end = node.end_position();
    NativeRange {
        start_line: (start.row + 1) as u32,
        start_col: start.column as u32,
        end_line: (end.row + 1) as u32,
        end_col: end.column as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{NativeParsedSymbol, NativeRange};

    fn sym(node_id: &str, name: &str, start_line: u32, end_line: u32) -> NativeParsedSymbol {
        sym_with_cols(node_id, name, start_line, 0, end_line, 0)
    }

    fn sym_with_cols(
        node_id: &str,
        name: &str,
        start_line: u32,
        start_col: u32,
        end_line: u32,
        end_col: u32,
    ) -> NativeParsedSymbol {
        NativeParsedSymbol {
            node_id: node_id.to_string(),
            symbol_id: format!("test:{}", name),
            ast_fingerprint: String::new(),
            kind: "function".to_string(),
            name: name.to_string(),
            exported: false,
            visibility: String::new(),
            range: NativeRange {
                start_line,
                start_col,
                end_line,
                end_col,
            },
            signature: None,
            summary: String::new(),
            invariants: vec![],
            side_effects: vec![],
            role_tags: vec![],
            decorators: vec![],
            search_text: String::new(),
            summary_quality: None,
        }
    }

    #[test]
    fn make_node_id_uses_name_and_position() {
        let range = NativeRange {
            start_line: 42,
            start_col: 4,
            end_line: 50,
            end_col: 1,
        };
        assert_eq!(make_node_id("foo", &range), "foo:42:4");
    }

    #[test]
    fn make_node_id_disambiguates_same_name_at_different_positions() {
        let r1 = NativeRange {
            start_line: 10,
            start_col: 0,
            end_line: 12,
            end_col: 1,
        };
        let r2 = NativeRange {
            start_line: 20,
            start_col: 2,
            end_line: 25,
            end_col: 1,
        };
        // Two `handle` methods on two different classes in the same file get
        // distinct nodeIds — this is exactly the overload case that the
        // old caller_name-based approach silently corrupted.
        assert_ne!(make_node_id("handle", &r1), make_node_id("handle", &r2));
    }

    #[test]
    fn symbol_contains_range_respects_same_line_columns() {
        let owner = sym_with_cols("owner", "owner", 10, 5, 10, 20);

        assert!(symbol_contains_range(&owner, 10, 5, 10, 20));
        assert!(symbol_contains_range(&owner, 10, 8, 10, 12));
        assert!(!symbol_contains_range(&owner, 10, 4, 10, 12));
        assert!(!symbol_contains_range(&owner, 10, 8, 10, 21));
    }
}
