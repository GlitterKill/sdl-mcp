use regex::Regex;
use std::sync::LazyLock;

use crate::types::NativeParsedSymbol;

const ROLE_SUFFIXES: &[(&str, &str)] = &[
    ("Provider", "provider"),
    ("Factory", "factory"),
    ("Builder", "builder"),
    ("Handler", "handler"),
    ("Service", "service"),
    ("Repository", "repository"),
    ("Adapter", "adapter"),
    ("Controller", "controller"),
    ("Manager", "manager"),
    ("Middleware", "middleware"),
    ("Resolver", "resolver"),
    ("Validator", "validator"),
    ("Serializer", "serializer"),
    ("Transformer", "transformer"),
];

const SUFFIX_PATTERNS: &[(&str, &str)] = &[
    ("Props", "Props definition"),
    ("Options", "Options definition"),
    ("Config", "Configuration"),
    ("Settings", "Settings definition"),
    ("Params", "Parameters definition"),
    ("Result", "Result type"),
    ("Response", "Response type"),
    ("Output", "Output type"),
    ("Input", "Input type"),
    ("Request", "Request type"),
    ("Args", "Arguments type"),
];


/// Generate a one-line summary for a symbol.
///
/// Mirrors TypeScript `generateSummary` in `summaries.ts`.
///
/// Priority:
/// 1. JSDoc @description (first 1-2 sentences)
/// 2. Auto-generated from camelCase name + param context + return type
pub fn generate_summary(symbol: &NativeParsedSymbol, file_content: &str, language: &str) -> String {
    let jsdoc = extract_doc_comment(symbol, file_content, language);

    if !jsdoc.description.is_empty() {
        let sentences: Vec<&str> = jsdoc
            .description
            .split(|c| c == '.' || c == '!' || c == '?')
            .filter(|s| !s.trim().is_empty())
            .collect();
        if !sentences.is_empty() {
            return sentences
                .iter()
                .take(2)
                .copied()
                .collect::<Vec<_>>()
                .join(". ")
                .trim()
                .to_string();
        }
    }

    // Dispatch to per-kind generators for non-function/method symbols.
    match symbol.kind.as_str() {
        "function" | "method" => {
            // Fall through to existing typed function summary logic below
        }
        "class" => {
            if let Some(s) = generate_class_summary(symbol) { return s; }
            return String::new();
        }
        "interface" => {
            if let Some(s) = generate_interface_summary(symbol) { return s; }
            return String::new();
        }
        "type" | "type_alias" => {
            if let Some(s) = generate_type_summary(symbol) { return s; }
            return String::new();
        }
        "enum" => {
            if let Some(s) = generate_enum_summary(symbol) { return s; }
            return String::new();
        }
        "variable" => {
            if let Some(s) = generate_variable_summary(symbol) { return s; }
            return String::new();
        }
        "constructor" => {
            if let Some(s) = generate_constructor_summary(symbol) { return s; }
            return String::new();
        }
        _ => return String::new(),
    }

    let has_typed_params = symbol
        .signature
        .as_ref()
        .and_then(|s| s.params.as_ref())
        .map_or(false, |params| params.iter().any(|p| p.type_name.is_some()));

    let has_return = symbol.kind == "function"
        && symbol
            .signature
            .as_ref()
            .and_then(|s| s.returns.as_ref())
            .map_or(false, |r| {
                let simple = extract_simple_type(r);
                !simple.is_empty() && simple != "void" && simple != "unknown" && simple != "any"
            });

    if !has_typed_params && !has_return {
        return String::new();
    }

    let name_words = split_camel_case(&symbol.name).join(" ");
    let capitalized = capitalize_first(&name_words);
    let mut summary = capitalized;

    // Add typed param context (use type annotations, not param names)
    if let Some(ref sig) = symbol.signature {
        if let Some(ref params) = sig.params {
            let mut unique: Vec<String> = Vec::new();
            for p in params {
                if let Some(ref tn) = p.type_name {
                    let simple = extract_simple_type(tn);
                    if !simple.is_empty()
                        && simple != "unknown"
                        && simple != "any"
                        && simple != "object"
                        && simple != "Object"
                        && !unique.contains(&simple)
                    {
                        unique.push(simple);
                    }
                }
            }
            if !unique.is_empty() {
                summary.push_str(" from ");
                summary.push_str(&unique.join(" and "));
            }
        }

        // Add return type
        if symbol.kind == "function" {
            if let Some(ref returns) = sig.returns {
                let simple_type = extract_simple_type(returns);
                if !simple_type.is_empty() && simple_type != "void" && simple_type != "unknown" && simple_type != "any" {
                    summary.push_str(" returning ");
                    summary.push_str(&simple_type);
                }
            }
        }
    }

    summary
}

/// Check whether a symbol has a doc comment (without generating the summary).
pub fn has_doc_comment(symbol: &NativeParsedSymbol, file_content: &str, language: &str) -> bool {
    let jsdoc = extract_doc_comment(symbol, file_content, language);
    !jsdoc.description.is_empty()
}

struct JSDoc {
    description: String,
    params: Vec<JSDocParam>,
    throws: Vec<String>,
}

#[allow(dead_code)]
struct JSDocParam {
    name: String,
    description: String,
}

fn extract_jsdoc(symbol: &NativeParsedSymbol, file_content: &str) -> JSDoc {
    let lines: Vec<&str> = file_content.lines().collect();
    let start_line = symbol.range.start_line as usize;
    let jsdoc_lines = extract_preceding_block_comment(&lines, start_line, "/**");
    parse_doc_comment(&jsdoc_lines.join("\n"))
}

fn extract_doc_comment(symbol: &NativeParsedSymbol, file_content: &str, language: &str) -> JSDoc {
    let lines: Vec<&str> = file_content.lines().collect();
    let start_line = symbol.range.start_line as usize;

    match language {
        "py" => {
            if let Some(docstring) = extract_python_docstring(&lines, start_line) {
                return parse_doc_comment(&docstring);
            }

            let comment_lines = extract_preceding_line_comments(&lines, start_line, &["#"]);
            parse_doc_comment(&comment_lines.join("\n"))
        }
        "go" => {
            let comment_lines = extract_preceding_line_comments(&lines, start_line, &["//"]);
            parse_doc_comment(&comment_lines.join("\n"))
        }
        "rs" => {
            let comment_lines =
                extract_preceding_line_comments(&lines, start_line, &["///", "//!"]);
            parse_doc_comment(&comment_lines.join("\n"))
        }
        "cs" => {
            let comment_lines = extract_preceding_line_comments(&lines, start_line, &["///"]);
            parse_doc_comment(&comment_lines.join("\n"))
        }
        "c" | "cpp" => {
            let block = extract_preceding_block_comment(&lines, start_line, "/**");
            if !block.is_empty() {
                parse_doc_comment(&block.join("\n"))
            } else {
                let line_comments = extract_preceding_line_comments(&lines, start_line, &["///"]);
                parse_doc_comment(&line_comments.join("\n"))
            }
        }
        "sh" => {
            let comment_lines = extract_preceding_line_comments(&lines, start_line, &["#"]);
            parse_doc_comment(&comment_lines.join("\n"))
        }
        "ts" | "tsx" | "js" | "jsx" | "java" | "php" => extract_jsdoc(symbol, file_content),
        _ => extract_jsdoc(symbol, file_content),
    }
}

fn extract_python_docstring(lines: &[&str], start_line: usize) -> Option<String> {
    let mut i = start_line.min(lines.len());

    while i < lines.len() {
        let trimmed = lines[i].trim();
        if trimmed.is_empty() {
            i += 1;
            continue;
        }

        let quote = if trimmed.starts_with("\"\"\"") {
            "\"\"\""
        } else if trimmed.starts_with("'''") {
            "'''"
        } else {
            return None;
        };

        let mut content = String::new();
        let remainder = trimmed[quote.len()..].to_string();
        if let Some(end) = remainder.find(quote) {
            content.push_str(remainder[..end].trim());
            return Some(content);
        }

        if !remainder.trim().is_empty() {
            content.push_str(remainder.trim());
        }

        i += 1;
        while i < lines.len() {
            let current = lines[i];
            if let Some(end) = current.find(quote) {
                if !content.is_empty() {
                    content.push('\n');
                }
                content.push_str(current[..end].trim());
                return Some(content);
            }

            if !content.is_empty() {
                content.push('\n');
            }
            content.push_str(current.trim());
            i += 1;
        }

        return None;
    }

    None
}

fn extract_preceding_line_comments(
    lines: &[&str],
    start_line: usize,
    prefixes: &[&str],
) -> Vec<String> {
    if start_line == 0 {
        return Vec::new();
    }

    let mut cursor = start_line.min(lines.len());
    while cursor > 0 && lines[cursor - 1].trim().is_empty() {
        cursor -= 1;
    }

    let mut collected = Vec::new();

    while cursor > 0 {
        let line = lines[cursor - 1].trim();
        if let Some(prefix) = prefixes.iter().find(|prefix| line.starts_with(**prefix)) {
            let mut content = line.trim_start_matches(*prefix).trim().to_string();
            if content.starts_with("<summary>") {
                content = content.trim_start_matches("<summary>").trim().to_string();
            }
            if content.ends_with("</summary>") {
                content = content.trim_end_matches("</summary>").trim().to_string();
            }
            collected.push(content);
            cursor -= 1;
            continue;
        }

        break;
    }

    collected.reverse();
    collected
}

fn extract_preceding_block_comment(
    lines: &[&str],
    start_line: usize,
    block_start: &str,
) -> Vec<String> {
    if start_line == 0 {
        return Vec::new();
    }

    let mut cursor = start_line.min(lines.len());
    while cursor > 0 && lines[cursor - 1].trim().is_empty() {
        cursor -= 1;
    }

    if cursor == 0 {
        return Vec::new();
    }

    let last = lines[cursor - 1].trim();
    if !last.contains("*/") {
        return Vec::new();
    }

    let mut collected = vec![last.to_string()];
    cursor -= 1;

    while cursor > 0 {
        let line = lines[cursor - 1].trim();
        collected.push(line.to_string());
        cursor -= 1;

        if line.contains(block_start) {
            collected.reverse();
            return collected;
        }

        if line.contains("/*") {
            break;
        }
    }

    Vec::new()
}

fn parse_doc_comment(doc_comment: &str) -> JSDoc {
    static RE_JSDOC_START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*/\*\*?").unwrap());
    static RE_JSDOC_END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*\*/$").unwrap());
    static RE_JSDOC_MID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\*\s?").unwrap());
    static RE_XML_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());

    let jsdoc_text: String = doc_comment
        .lines()
        .map(|line| {
            let s = RE_JSDOC_START.replace(line, "");
            let s = RE_JSDOC_END.replace(&s, "");
            let s = RE_JSDOC_MID.replace(&s, "");
            let s = RE_XML_TAG.replace_all(&s, "");
            s.trim().to_string()
        })
        .collect::<Vec<_>>()
        .join("\n");

    let mut jsdoc = JSDoc {
        description: String::new(),
        params: Vec::new(),
        throws: Vec::new(),
    };

    static RE_PARAM: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"@param\s+(\{[^}]+\})?\s*(\w+)\s+(.+)").unwrap());
    #[allow(dead_code)]
    static RE_RETURNS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"@(?:returns?)\s+(.+)").unwrap());
    static RE_THROWS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"@throws\s+(.+)").unwrap());

    let mut current_section = "description";

    for line in jsdoc_text.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with("@param") {
            current_section = "param";
            if let Some(caps) = RE_PARAM.captures(trimmed) {
                jsdoc.params.push(JSDocParam {
                    name: caps
                        .get(2)
                        .map(|m| m.as_str().to_string())
                        .unwrap_or_default(),
                    description: caps
                        .get(3)
                        .map(|m| m.as_str().trim().to_string())
                        .unwrap_or_default(),
                });
            }
        } else if trimmed.starts_with("@returns") || trimmed.starts_with("@return") {
            current_section = "returns";
        } else if trimmed.starts_with("@throws") {
            current_section = "throws";
            if let Some(caps) = RE_THROWS.captures(trimmed) {
                jsdoc.throws.push(
                    caps.get(1)
                        .map(|m| m.as_str().trim().to_string())
                        .unwrap_or_default(),
                );
            }
        } else if trimmed.starts_with('@') {
            current_section = "description";
        } else if current_section == "description" && !trimmed.is_empty() {
            if !jsdoc.description.is_empty() {
                jsdoc.description.push(' ');
            }
            jsdoc.description.push_str(trimmed);
        }
    }

    jsdoc
}

fn split_camel_case(s: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current_word = String::new();
    let chars: Vec<char> = s.chars().collect();

    for i in 0..chars.len() {
        let c = chars[i];

        if c == '_' || c == '-' || c == '.' {
            if !current_word.is_empty() {
                result.push(current_word.clone());
                current_word.clear();
            }
        } else if i > 0 && c.is_uppercase() && !chars[i - 1].is_uppercase() {
            if !current_word.is_empty() {
                result.push(current_word.clone());
                current_word = c.to_string();
            } else {
                current_word.push(c);
            }
        } else if i > 0 && c.is_uppercase() && i < chars.len() - 1 && chars[i + 1].is_lowercase() {
            if !current_word.is_empty() {
                result.push(current_word.clone());
                current_word = c.to_string();
            } else {
                current_word.push(c);
            }
        } else {
            current_word.push(c);
        }
    }

    if !current_word.is_empty() {
        result.push(current_word);
    }

    result
}

fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => {
            let upper: String = first.to_uppercase().collect();
            upper + chars.as_str()
        }
    }
}
fn extract_simple_type(type_annotation: &str) -> String {
    let cleaned = type_annotation.trim_start_matches(':').trim_start();

    // Handle Array<T> -> T[] before generic removal
    if cleaned.contains("Array<") {
        static RE_ARRAY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Array<([^>]+)>").unwrap());
        if let Some(caps) = RE_ARRAY.captures(cleaned) {
            if let Some(inner) = caps.get(1) {
                return format!("{}[]", inner.as_str().trim());
            }
        }
    }
    // Handle T[] syntax
    if cleaned.ends_with("[]") {
        return cleaned.to_string();
    }

    // Remove generics
    static RE_GENERICS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
    let cleaned = RE_GENERICS.replace_all(cleaned, "").trim().to_string();

    if cleaned.contains(" | ") {
        let types: Vec<&str> = cleaned.split(" | ").map(|t| t.trim()).collect();
        return types.first().unwrap_or(&"").to_string();
    }

    if cleaned.contains('&') {
        let types: Vec<&str> = cleaned.split('&').map(|t| t.trim()).collect();
        return types.first().unwrap_or(&"").to_string();
    }

    if cleaned.contains("Record<") {
        return "Object".to_string();
    }

    if cleaned.contains("Map<") {
        return "Map".to_string();
    }

    if cleaned.contains("Set<") {
        return "Set".to_string();
    }

    cleaned
}

fn split_snake_case(name: &str) -> String {
    name.to_lowercase()
        .split('_')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn generate_class_summary(symbol: &NativeParsedSymbol) -> Option<String> {
    let name = &symbol.name;
    for (suffix, role) in ROLE_SUFFIXES {
        if name.ends_with(suffix) && name.len() > suffix.len() {
            let base_name = &name[..name.len() - suffix.len()];
            let base = split_camel_case(base_name).join(" ").to_lowercase();
            return Some(format!("Implements the {} pattern for {}", role, base));
        }
    }
    if let Some(ref sig) = symbol.signature {
        if let Some(ref generics) = sig.generics {
            if !generics.is_empty() {
                let type_params = generics.join(", ");
                let base = split_camel_case(name).join(" ").to_lowercase();
                return Some(format!("Generic {} class parameterized by {}", base, type_params));
            }
        }
    }
    let words = split_camel_case(name).join(" ").to_lowercase();
    Some(format!("Class encapsulating {} behavior", words))
}

fn generate_interface_summary(symbol: &NativeParsedSymbol) -> Option<String> {
    let name = &symbol.name;
    let chars: Vec<char> = name.chars().collect();
    if chars.len() > 1 && chars[0] == 'I' && chars[1].is_uppercase() {
        let base = split_camel_case(&name[1..]).join(" ").to_lowercase();
        return Some(format!("Contract for {}", base));
    }
    for (suffix, desc) in SUFFIX_PATTERNS {
        if name.ends_with(suffix) && name.len() > suffix.len() {
            let base_name = &name[..name.len() - suffix.len()];
            let base = split_camel_case(base_name).join(" ").to_lowercase();
            return Some(format!("{} for {}", desc, base));
        }
    }
    if let Some(ref sig) = symbol.signature {
        if let Some(ref generics) = sig.generics {
            if !generics.is_empty() {
                let type_params = generics.join(", ");
                let base = split_camel_case(name).join(" ").to_lowercase();
                return Some(format!("Generic interface defining {} contract for {}", base, type_params));
            }
        }
    }
    let words = split_camel_case(name).join(" ").to_lowercase();
    Some(format!("Interface defining {} contract", words))
}

fn generate_type_summary(symbol: &NativeParsedSymbol) -> Option<String> {
    let name = &symbol.name;
    for (suffix, desc) in SUFFIX_PATTERNS {
        if name.ends_with(suffix) && name.len() > suffix.len() {
            let base_name = &name[..name.len() - suffix.len()];
            let base = split_camel_case(base_name).join(" ").to_lowercase();
            return Some(format!("{} for {}", desc, base));
        }
    }
    if let Some(ref sig) = symbol.signature {
        if let Some(ref generics) = sig.generics {
            if !generics.is_empty() {
                let type_params = generics.join(", ");
                let base = split_camel_case(name).join(" ").to_lowercase();
                return Some(format!("Generic type alias for {} over {}", base, type_params));
            }
        }
    }
    let words = split_camel_case(name).join(" ").to_lowercase();
    Some(format!("Type alias for {}", words))
}

fn generate_enum_summary(symbol: &NativeParsedSymbol) -> Option<String> {
    let words = split_camel_case(&symbol.name).join(" ").to_lowercase();
    Some(format!("Enumeration of {} values", words))
}

fn generate_variable_summary(symbol: &NativeParsedSymbol) -> Option<String> {
    let name = &symbol.name;
    let is_screaming = name.len() > 1
        && name.chars().next().map_or(false, |c| c.is_ascii_uppercase())
        && name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if is_screaming {
        return Some(format!("Constant defining {}", split_snake_case(name)));
    }
    if name.ends_with("Schema") && name.len() > 6 {
        let base = split_camel_case(&name[..name.len() - 6]).join(" ").to_lowercase();
        return Some(format!("Validation schema for {}", base));
    }
    if name.ends_with("Validator") && name.len() > 9 {
        let base = split_camel_case(&name[..name.len() - 9]).join(" ").to_lowercase();
        return Some(format!("Validator for {}", base));
    }
    // Default/default prefix
    if name.starts_with("default") || name.starts_with("Default") {
        let rest = name.trim_start_matches("default").trim_start_matches("Default").trim_start_matches('_');
        if !rest.is_empty() {
            let words = split_camel_case(rest).join(" ").to_lowercase();
            return Some(format!("Default {} value", words));
        }
    }
    None
}

fn generate_constructor_summary(symbol: &NativeParsedSymbol) -> Option<String> {
    if let Some(ref sig) = symbol.signature {
        if let Some(ref params) = sig.params {
            let typed: Vec<&str> = params.iter()
                .filter_map(|p| p.type_name.as_deref())
                .filter(|t| *t != "any" && *t != "unknown")
                .collect();
            if typed.is_empty() { return None; }
            let type_context = typed.join(" and ");
            return Some(format!("Constructs from {}", type_context));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{NativeParsedSymbol, NativeSymbolSignature, NativeSymbolSignatureParam, NativeRange};

    fn make_symbol(name: &str, kind: &str) -> NativeParsedSymbol {
        NativeParsedSymbol {
            symbol_id: String::new(),
            ast_fingerprint: String::new(),
            kind: kind.to_string(),
            name: name.to_string(),
            exported: false,
            visibility: String::new(),
            range: NativeRange {
                start_line: 0,
                start_col: 0,
                end_line: 0,
                end_col: 0,
            },
            signature: Some(NativeSymbolSignature {
                params: None,
                returns: None,
                generics: None,
            }),
            summary: String::new(),
            invariants: vec![],
            side_effects: vec![],
            role_tags: vec![],
            search_text: String::new(),
            summary_quality: None,
        }
    }

    #[test]
    fn test_class_with_provider_suffix() {
        let s = make_symbol("AuthProvider", "class");
        let result = generate_class_summary(&s);
        assert_eq!(result, Some("Implements the provider pattern for auth".to_string()));
    }

    #[test]
    fn test_class_with_generics() {
        let mut s = make_symbol("Repository", "class");
        s.signature.as_mut().unwrap().generics = Some(vec!["T".to_string()]);
        let result = generate_class_summary(&s);
        assert_eq!(result, Some("Generic repository class parameterized by T".to_string()));
    }

    #[test]
    fn test_interface_with_i_prefix() {
        let s = make_symbol("IUserService", "interface");
        let result = generate_interface_summary(&s);
        assert_eq!(result, Some("Contract for user service".to_string()));
    }

    #[test]
    fn test_interface_with_props_suffix() {
        let s = make_symbol("ButtonProps", "interface");
        let result = generate_interface_summary(&s);
        assert_eq!(result, Some("Props definition for button".to_string()));
    }

    #[test]
    fn test_type_with_result_suffix() {
        let s = make_symbol("QueryResult", "type");
        let result = generate_type_summary(&s);
        assert_eq!(result, Some("Result type for query".to_string()));
    }

    #[test]
    fn test_enum_summary() {
        let s = make_symbol("LogLevel", "enum");
        let result = generate_enum_summary(&s);
        assert_eq!(result, Some("Enumeration of log level values".to_string()));
    }

    #[test]
    fn test_variable_screaming_snake() {
        let s = make_symbol("MAX_RETRIES", "variable");
        let result = generate_variable_summary(&s);
        assert_eq!(result, Some("Constant defining max retries".to_string()));
    }

    #[test]
    fn test_variable_schema_suffix() {
        let s = make_symbol("userSchema", "variable");
        let result = generate_variable_summary(&s);
        assert_eq!(result, Some("Validation schema for user".to_string()));
    }

    #[test]
    fn test_constructor_with_typed_params() {
        let mut s = make_symbol("constructor", "constructor");
        s.signature.as_mut().unwrap().params = Some(vec![
            NativeSymbolSignatureParam { name: "name".to_string(), type_name: Some("string".to_string()) },
            NativeSymbolSignatureParam { name: "age".to_string(), type_name: Some("number".to_string()) },
        ]);
        let result = generate_constructor_summary(&s);
        assert_eq!(result, Some("Constructs from string and number".to_string()));
    }

    #[test]
    fn test_variable_no_summary() {
        let s = make_symbol("count", "variable");
        let result = generate_variable_summary(&s);
        assert_eq!(result, None);
    }
}
