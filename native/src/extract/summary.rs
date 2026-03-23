use regex::Regex;
use std::sync::LazyLock;

use crate::types::NativeParsedSymbol;

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

    // Auto-generate only if type info adds value beyond the name.
    // The TS layer treats empty strings as null (no summary).
    // Only functions/methods benefit from type-based summaries;
    // classes/interfaces/types/variables get kind+name from the card already.
    if symbol.kind != "function" && symbol.kind != "method" {
        return String::new();
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
