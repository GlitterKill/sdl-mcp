use tree_sitter::Node;

use crate::types::{NativeParsedCall, NativeParsedSymbol};

pub mod common;
mod typescript;

pub fn extract_calls(
    root: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
    language: &str,
) -> Vec<NativeParsedCall> {
    match language {
        "ts" | "tsx" | "js" | "jsx" => typescript::extract_calls_ts(root, source, symbols),
        _ => vec![],
    }
}
