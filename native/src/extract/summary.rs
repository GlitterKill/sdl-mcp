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
pub fn generate_summary(
    symbol: &NativeParsedSymbol,
    file_content: &str,
) -> String {
    let jsdoc = extract_jsdoc(symbol, file_content);

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

    // Auto-generate from name
    let name_words = split_camel_case(&symbol.name).join(" ");
    let capitalized = capitalize_first(&name_words);

    let mut summary = capitalized;

    // Add param context
    if let Ok(sig) = serde_json::from_str::<serde_json::Value>(&symbol.signature_json) {
        if let Some(params) = sig.get("params").and_then(|p| p.as_array()) {
            let param_infos: Vec<String> = params
                .iter()
                .filter_map(|p| p.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                .collect();
            let context = generate_param_context(&param_infos);
            if !context.is_empty() {
                summary.push(' ');
                summary.push_str(&context);
            }
        }

        // Add return type
        if symbol.kind == "function" {
            if let Some(returns) = sig.get("returns").and_then(|r| r.as_str()) {
                let simple_type = extract_simple_type(returns);
                if !simple_type.is_empty()
                    && simple_type != "void"
                    && simple_type != "unknown"
                {
                    summary.push_str(" and returns ");
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

    let mut jsdoc_lines: Vec<String> = Vec::new();
    let mut i = if start_line > 0 { start_line - 1 } else { 0 };

    // Walk backwards from symbol start to find JSDoc block
    while i < lines.len() {
        let line = lines[i].trim();

        if line.starts_with("/**") {
            jsdoc_lines.insert(0, line.to_string());
            break;
        }

        if line.starts_with('*') || line.starts_with("*/") {
            jsdoc_lines.insert(0, line.to_string());
            if i == 0 {
                break;
            }
            i -= 1;
            continue;
        }

        if line.is_empty() {
            if i == 0 {
                break;
            }
            i -= 1;
            continue;
        }

        break;
    }

    static RE_JSDOC_START: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\s*/\*\*?").unwrap());
    static RE_JSDOC_END: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\s*\*/$").unwrap());
    static RE_JSDOC_MID: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\s*\*\s?").unwrap());

    let jsdoc_text: String = jsdoc_lines
        .iter()
        .map(|l| {
            let s = RE_JSDOC_START.replace(l, "");
            let s = RE_JSDOC_END.replace(&s, "");
            let s = RE_JSDOC_MID.replace(&s, "");
            s.to_string()
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
    static RE_THROWS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"@throws\s+(.+)").unwrap());

    let mut current_section = "description";

    for line in jsdoc_text.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with("@param") {
            current_section = "param";
            if let Some(caps) = RE_PARAM.captures(trimmed) {
                jsdoc.params.push(JSDocParam {
                    name: caps.get(2).map(|m| m.as_str().to_string()).unwrap_or_default(),
                    description: caps.get(3).map(|m| m.as_str().trim().to_string()).unwrap_or_default(),
                });
            }
        } else if trimmed.starts_with("@returns") || trimmed.starts_with("@return") {
            current_section = "returns";
        } else if trimmed.starts_with("@throws") {
            current_section = "throws";
            if let Some(caps) = RE_THROWS.captures(trimmed) {
                jsdoc
                    .throws
                    .push(caps.get(1).map(|m| m.as_str().trim().to_string()).unwrap_or_default());
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
        } else if i > 0
            && c.is_uppercase()
            && !chars[i - 1].is_uppercase()
        {
            if !current_word.is_empty() {
                result.push(current_word.clone());
                current_word = c.to_string();
            } else {
                current_word.push(c);
            }
        } else if i > 0
            && c.is_uppercase()
            && i < chars.len() - 1
            && chars[i + 1].is_lowercase()
        {
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

fn generate_param_context(param_names: &[String]) -> String {
    let mut parts = Vec::new();

    for name in param_names {
        if name.starts_with("...") {
            continue;
        }

        if name.contains("Id") || name.contains("ID") {
            parts.push(format!("by {}", name.to_lowercase()));
        } else if name.contains("Config") || name.contains("Options") {
            parts.push(format!("with {}", name.to_lowercase()));
        } else if name.contains("Data") || name.contains("Input") {
            parts.push(format!("from {}", name.to_lowercase()));
        } else if name.contains("Path") || name.contains("File") {
            parts.push(format!("at {}", name.to_lowercase()));
        }
    }

    parts.join(" ")
}

fn extract_simple_type(type_annotation: &str) -> String {
    let cleaned = type_annotation
        .trim_start_matches(':')
        .trim_start();

    // Remove generics
    static RE_GENERICS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
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
