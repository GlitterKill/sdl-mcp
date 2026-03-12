use tree_sitter::Node;

use crate::types::{NativeParsedCall, NativeParsedSymbol};

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

pub fn extract_calls(
    root: Node<'_>,
    source: &[u8],
    symbols: &[NativeParsedSymbol],
    language: &str,
) -> Vec<NativeParsedCall> {
    match language {
        "c" => c_lang::extract_calls_c(root, source, symbols),
        "cpp" => cpp::extract_calls_cpp(root, source, symbols),
        "go" => go::extract_calls_go(root, source, symbols),
        "java" => java::extract_calls_java(root, source, symbols),
        "php" => php::extract_calls_php(root, source, symbols),
        "py" => python::extract_calls_python(root, source, symbols),
        "rs" => rust_lang::extract_calls_rust(root, source, symbols),
        "sh" => shell::extract_calls_shell(root, source, symbols),
        "cs" => csharp::extract_calls_csharp(root, source, symbols),
        "ts" | "tsx" | "js" | "jsx" => typescript::extract_calls_ts(root, source, symbols),
        _ => vec![],
    }
}
