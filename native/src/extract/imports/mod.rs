use tree_sitter::Node;

use crate::types::NativeParsedImport;

mod c_lang;
pub mod common;
mod cpp;
mod csharp;
mod go;
mod java;
mod php;
mod python;
mod rust_lang;
mod shell;
mod typescript;

pub fn extract_imports(root: Node<'_>, source: &[u8], language: &str) -> Vec<NativeParsedImport> {
    match language {
        "c" => c_lang::extract_imports_c(root, source),
        "cpp" => cpp::extract_imports_cpp(root, source),
        "go" => go::extract_imports_go(root, source),
        "java" => java::extract_imports_java(root, source),
        "php" => php::extract_imports_php(root, source),
        "py" => python::extract_imports_python(root, source),
        "rs" => rust_lang::extract_imports_rust(root, source),
        "sh" => shell::extract_imports_shell(root, source),
        "cs" => csharp::extract_imports_csharp(root, source),
        "ts" | "tsx" | "js" | "jsx" => typescript::extract_imports_ts(root, source),
        _ => vec![],
    }
}
