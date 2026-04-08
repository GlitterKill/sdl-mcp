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
    let node_start_line = node.start_position().row + 1;
    let node_end_line = node.end_position().row + 1;

    let mut best: Option<&NativeParsedSymbol> = None;
    let mut best_size = u32::MAX;

    for sym in symbols {
        let sym_start = sym.range.start_line;
        let sym_end = sym.range.end_line;

        if sym_start <= node_start_line as u32 && sym_end >= node_end_line as u32 {
            let size = sym_end - sym_start;
            if size < best_size {
                best = Some(sym);
                best_size = size;
            }
        }
    }

    best.map(|s| s.node_id.clone())
        .unwrap_or_else(|| "<module>".to_string())
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
                start_col: 0,
                end_line,
                end_col: 0,
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
}
