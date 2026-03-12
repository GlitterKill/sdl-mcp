use tree_sitter::Node;

use crate::types::NativeParsedImport;

pub mod common;
mod python;
mod typescript;

pub fn extract_imports(root: Node<'_>, source: &[u8], language: &str) -> Vec<NativeParsedImport> {
    match language {
        "py" => python::extract_imports_python(root, source),
        "ts" | "tsx" | "js" | "jsx" => typescript::extract_imports_ts(root, source),
        _ => vec![],
    }
}
