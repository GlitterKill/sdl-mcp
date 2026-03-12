use tree_sitter::Node;

use crate::types::NativeParsedImport;

mod c_lang;
pub mod common;
mod go;
mod java;
mod python;
mod shell;
mod typescript;

pub fn extract_imports(root: Node<'_>, source: &[u8], language: &str) -> Vec<NativeParsedImport> {
    match language {
        "c" => c_lang::extract_imports_c(root, source),
        "go" => go::extract_imports_go(root, source),
        "java" => java::extract_imports_java(root, source),
        "py" => python::extract_imports_python(root, source),
        "sh" => shell::extract_imports_shell(root, source),
        "ts" | "tsx" | "js" | "jsx" => typescript::extract_imports_ts(root, source),
        _ => vec![],
    }
}
