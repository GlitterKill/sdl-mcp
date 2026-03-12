use tree_sitter::Node;

use crate::types::{NativeParsedSymbol, NativeRange};

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

    best.map(|s| s.name.clone())
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
