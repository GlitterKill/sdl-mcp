use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

use crate::types::NativeParsedSymbol;

/// Extract invariants from a symbol's code and JSDoc.
///
/// Mirrors TypeScript `extractInvariants` in `summaries.ts`.
///
/// Detects:
/// - JSDoc @param with "must", "required", "should be", "cannot be"
/// - JSDoc @throws
/// - `assert()` calls
/// - Guard clauses: `if (!x) throw/return`
/// - Null/undefined checks: `if (x === null || x === undefined) throw`
pub fn extract_invariants(
    symbol: &NativeParsedSymbol,
    file_content: &str,
) -> Vec<String> {
    let mut invariants = Vec::new();

    // Extract JSDoc invariants
    let jsdoc = extract_jsdoc_invariants(symbol, file_content);
    invariants.extend(jsdoc);

    // Extract code-level invariants
    let lines = get_symbol_lines(symbol, file_content);

    static RE_ASSERT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"assert\(([^)]+)\)").unwrap());
    static RE_GUARD: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"if\s*\(!([^)]+)\)\s*(?:\{|throw|return)").unwrap());
    static RE_THROW_GUARD: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"if\s*\(([^)]+)\)\s*(?:\{|throw|return)").unwrap());

    for line in &lines {
        // assert() calls
        if line.contains("assert(") {
            if let Some(caps) = RE_ASSERT.captures(line) {
                invariants.push(format!("Asserts: {}", &caps[1]));
            }
        }

        // Guard clauses: if (!x) throw/return
        if line.contains("if (!") || line.contains("if (! ") {
            if let Some(caps) = RE_GUARD.captures(line) {
                invariants.push(format!("Requires: {}", caps[1].trim()));
            }
        }

        // if (condition) throw new / return false
        if line.contains("if (")
            && (line.contains("throw new") || line.contains("return false"))
        {
            if let Some(caps) = RE_THROW_GUARD.captures(line) {
                let condition = caps[1].trim();
                if condition.contains('!')
                    || condition.contains("undefined")
                    || condition.contains("null")
                {
                    invariants.push(format!("Requires: {condition}"));
                }
            }
        }
    }

    // Deduplicate while preserving order
    let mut seen = HashSet::new();
    invariants.retain(|item| seen.insert(item.clone()));
    invariants
}

fn extract_jsdoc_invariants(
    symbol: &NativeParsedSymbol,
    file_content: &str,
) -> Vec<String> {
    let mut invariants = Vec::new();
    let lines: Vec<&str> = file_content.lines().collect();
    let start_line = symbol.range.start_line as usize;

    // Walk backwards to find JSDoc
    let mut jsdoc_lines: Vec<String> = Vec::new();
    let mut i = if start_line > 0 { start_line - 1 } else { 0 };

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

    let jsdoc_text: String = jsdoc_lines
        .iter()
        .map(|l| {
            l.trim_start_matches(|c: char| c.is_whitespace())
                .trim_start_matches("/**")
                .trim_start_matches("*/")
                .trim_start_matches('*')
                .trim_start()
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n");

    static RE_PARAM: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"@param\s+(\{[^}]+\})?\s*(\w+)\s+(.+)").unwrap());
    static RE_THROWS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"@throws\s+(.+)").unwrap());

    for line in jsdoc_text.lines() {
        let trimmed = line.trim();

        if let Some(caps) = RE_PARAM.captures(trimmed) {
            let param_name = &caps[2];
            let description = caps[3].trim();
            let lower = description.to_lowercase();
            if lower.contains("must")
                || lower.contains("required")
                || lower.contains("should be")
                || lower.contains("cannot be")
            {
                invariants.push(format!("@param {param_name}: {description}"));
            }
        }

        if let Some(caps) = RE_THROWS.captures(trimmed) {
            invariants.push(format!("@throws {}", caps[1].trim()));
        }
    }

    invariants
}

fn get_symbol_lines<'a>(symbol: &NativeParsedSymbol, file_content: &'a str) -> Vec<&'a str> {
    let lines: Vec<&str> = file_content.lines().collect();
    let start = (symbol.range.start_line as usize).saturating_sub(1);
    let end = (symbol.range.end_line as usize).min(lines.len());
    lines[start..end].to_vec()
}
