use tree_sitter::{Language, Parser};

/// Get the tree-sitter Language for a given language identifier.
///
/// Language identifiers match the config schema: "ts", "tsx", "js", "jsx",
/// "py", "go", "java", "cs", "c", "cpp", "php", "rs", "kt", "sh".
pub fn get_language(lang_id: &str) -> Option<Language> {
    match lang_id {
        "ts" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "tsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        "js" | "jsx" => Some(tree_sitter_javascript::LANGUAGE.into()),
        "py" => Some(tree_sitter_python::LANGUAGE.into()),
        "go" => Some(tree_sitter_go::LANGUAGE.into()),
        "java" => Some(tree_sitter_java::LANGUAGE.into()),
        "cs" => Some(tree_sitter_c_sharp::LANGUAGE.into()),
        "c" => Some(tree_sitter_c::LANGUAGE.into()),
        "cpp" => Some(tree_sitter_cpp::LANGUAGE.into()),
        "php" => Some(tree_sitter_php::LANGUAGE_PHP.into()),
        "rs" => Some(tree_sitter_rust::LANGUAGE.into()),
        "sh" => Some(tree_sitter_bash::LANGUAGE.into()),
        // Kotlin doesn't have an official tree-sitter-kotlin Rust crate yet
        "kt" => None,
        _ => None,
    }
}

/// Create a tree-sitter Parser configured for the given language.
/// Returns None if the language is not supported.
pub fn create_parser(lang_id: &str) -> Option<Parser> {
    let language = get_language(lang_id)?;
    let mut parser = Parser::new();
    parser
        .set_language(&language)
        .expect("Failed to set parser language");
    Some(parser)
}

/// Map file extension to language identifier.
pub fn extension_to_language(ext: &str) -> Option<&'static str> {
    match ext {
        "ts" => Some("ts"),
        "tsx" => Some("tsx"),
        "js" | "mjs" | "cjs" => Some("js"),
        "jsx" => Some("jsx"),
        "py" | "pyw" => Some("py"),
        "go" => Some("go"),
        "java" => Some("java"),
        "cs" => Some("cs"),
        "c" | "h" => Some("c"),
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" => Some("cpp"),
        "php" => Some("php"),
        "rs" => Some("rs"),
        "kt" | "kts" => Some("kt"),
        "sh" | "bash" | "zsh" => Some("sh"),
        _ => None,
    }
}
