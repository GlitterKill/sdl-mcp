use std::collections::HashSet;

use crate::types::NativeParsedSymbol;

pub fn extract_role_tags(symbol: &NativeParsedSymbol, rel_path: &str) -> Vec<String> {
    let name = symbol.name.to_lowercase();
    let path = rel_path.replace('\\', "/").to_lowercase();
    let file_name = path.rsplit('/').next().unwrap_or("");
    let name_tokens = split_identifier_like_text(&symbol.name)
        .into_iter()
        .map(|part| part.to_lowercase())
        .collect::<Vec<_>>();
    let path_tokens = split_path_tokens(rel_path)
        .into_iter()
        .map(|part| part.to_lowercase())
        .collect::<Vec<_>>();
    let mut tags = Vec::new();

    if name.contains("handler") || path.contains("/handler") || path.contains("/api/") {
        tags.push("handler".to_string());
    }

    if name.contains("controller") || path.contains("/controller") {
        tags.push("controller".to_string());
    }

    if name.ends_with("service") || path.contains("/service") {
        tags.push("service".to_string());
    }

    if name_tokens
        .iter()
        .any(|token| token == "repo" || token == "repository")
        || path_tokens
            .iter()
            .any(|token| token == "repo" || token == "repository")
    {
        tags.push("repo".to_string());
    }

    if name.contains("model") || path.contains("/model") {
        tags.push("model".to_string());
    }

    if name.contains("middleware") || path.contains("/middleware/") {
        tags.push("middleware".to_string());
    }

    if path.starts_with("tests/")
        || path.contains("/tests/")
        || path.contains(".test.")
        || path.contains(".spec.")
        || (file_name.starts_with("test_") && file_name.ends_with(".py"))
        || file_name.ends_with("_test.py")
    {
        tags.push("test".to_string());
    }

    if path_tokens
        .iter()
        .any(|token| token == "config" || token == "settings")
        || has_tagged_file_suffix(&path, "config")
        || has_tagged_file_suffix(&path, "settings")
        || name_tokens
            .iter()
            .any(|token| token == "config" || token == "settings")
    {
        tags.push("config".to_string());
    }

    if symbol.kind == "function"
        && (name == "main"
            || name == "start"
            || name == "bootstrap"
            || name == "boot"
            || name.starts_with("handle")
            || name.starts_with("on"))
    {
        tags.push("entrypoint".to_string());
    }

    if has_tagged_file_suffix(&path, "main")
        || has_tagged_file_suffix(&path, "index")
        || has_tagged_file_suffix(&path, "app")
        || has_tagged_file_suffix(&path, "manage")
        || has_tagged_file_suffix(&path, "application")
        || has_tagged_file_suffix(&path, "lib")
        || path.ends_with("/__main__.py")
        || path.contains("/bin/")
        || path.contains("/cli/")
    {
        tags.push("entrypoint".to_string());
    }

    let mut seen = HashSet::new();
    tags.retain(|tag| seen.insert(tag.clone()));
    tags
}

fn split_identifier_like_text(input: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = input.chars().collect();

    for (idx, ch) in chars.iter().enumerate() {
        if ch.is_alphanumeric() {
            let boundary = idx > 0
                && ch.is_uppercase()
                && (!chars[idx - 1].is_uppercase()
                    || (idx + 1 < chars.len() && chars[idx + 1].is_lowercase()));
            if boundary && !current.is_empty() {
                result.push(current.clone());
                current.clear();
            }
            current.push(*ch);
        } else if !current.is_empty() {
            result.push(current.clone());
            current.clear();
        }
    }

    if !current.is_empty() {
        result.push(current);
    }

    result
}

fn split_path_tokens(rel_path: &str) -> Vec<String> {
    rel_path
        .replace('\\', "/")
        .split(['/', '.', '-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| part.to_string())
        .collect()
}

fn has_tagged_file_suffix(path: &str, basename: &str) -> bool {
    [
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".rs", ".py", ".go", ".java",
        ".cs", ".cpp", ".cc", ".c", ".h", ".php", ".kt", ".kts", ".sh", ".bash",
    ]
    .iter()
    .any(|extension| path.ends_with(&format!("/{basename}{extension}")))
}

#[cfg(test)]
mod tests {
    use crate::types::{NativeParsedSymbol, NativeRange};

    use super::extract_role_tags;

    fn stub_symbol(name: &str, kind: &str) -> NativeParsedSymbol {
        NativeParsedSymbol {
            symbol_id: "sym".to_string(),
            ast_fingerprint: "fp".to_string(),
            kind: kind.to_string(),
            name: name.to_string(),
            exported: true,
            visibility: "public".to_string(),
            range: NativeRange {
                start_line: 1,
                start_col: 0,
                end_line: 2,
                end_col: 0,
            },
            signature: None,
            summary: String::new(),
            invariants: vec![],
            side_effects: vec![],
            role_tags: vec![],
            search_text: String::new(),
        }
    }

    #[test]
    fn infers_handler_and_entrypoint_tags() {
        let symbol = stub_symbol("handleLogin", "function");
        let tags = extract_role_tags(&symbol, "src/api/auth-handler.ts");
        assert!(tags.iter().any(|tag| tag == "handler"));
        assert!(tags.iter().any(|tag| tag == "entrypoint"));
    }

    #[test]
    fn infers_test_and_config_tags_from_path() {
        let symbol = stub_symbol("loadConfig", "function");
        let tags = extract_role_tags(&symbol, "tests/config/load-config.test.ts");
        assert!(tags.iter().any(|tag| tag == "test"));
        assert!(tags.iter().any(|tag| tag == "config"));
    }

    #[test]
    fn avoids_false_repo_matches_for_report_helpers() {
        let symbol = stub_symbol("reportMetrics", "function");
        let tags = extract_role_tags(&symbol, "src/utils/report.ts");
        assert!(!tags.iter().any(|tag| tag == "repo"));
    }

    #[test]
    fn infers_entrypoint_and_config_for_js_family_files() {
        let main_symbol = stub_symbol("renderApp", "function");
        let main_tags = extract_role_tags(&main_symbol, "src/main.tsx");
        assert!(main_tags.iter().any(|tag| tag == "entrypoint"));

        let config_symbol = stub_symbol("loadSettings", "function");
        let config_tags = extract_role_tags(&config_symbol, "src/config.js");
        assert!(config_tags.iter().any(|tag| tag == "config"));
    }
}
