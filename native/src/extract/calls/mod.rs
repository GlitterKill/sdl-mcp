use tree_sitter::Node;

use crate::types::{NativeParsedCall, NativeParsedSymbol};

pub mod common;
mod go;
mod python;
mod typescript;

pub fn extract_calls(
    root: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
    language: &str,
) -> Vec<NativeParsedCall> {
    match language {
        "go" => go::extract_calls_go(root, source, symbols),
        "py" => python::extract_calls_python(root, source, symbols),
        "ts" | "tsx" | "js" | "jsx" => typescript::extract_calls_ts(root, source, symbols),
        _ => vec![],
    }
}
