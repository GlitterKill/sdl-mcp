use tree_sitter::Node;

use crate::types::NativeParsedSymbol;

pub mod common;
mod go;
mod java;
mod python;
mod typescript;

pub fn extract_symbols(
    root: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    language: &str,
) -> Vec<NativeParsedSymbol> {
    match language {
        "go" => go::extract_symbols_go(root, source, repo_id, rel_path),
        "java" => java::extract_symbols_java(root, source, repo_id, rel_path),
        "py" => python::extract_symbols_python(root, source, repo_id, rel_path),
        "ts" | "tsx" | "js" | "jsx" => {
            typescript::extract_symbols_ts(root, source, repo_id, rel_path)
        }
        _ => vec![],
    }
}
