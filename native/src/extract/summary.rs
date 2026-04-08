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



/// Maximum lines to scan in a function body for behavioral signals.
const MAX_BODY_SCAN_LINES: usize = 200;

/// Behavioral signals detected by scanning a function body.
#[derive(Debug, Default)]
struct BodySignals {
    throws: bool,
    validates: bool,
    delegates: Option<String>,
    iterates: bool,
    is_async: bool,
    has_network_io: bool,
    has_file_io: bool,
    has_db_io: bool,
    transforms: bool,
    aggregates: bool,
    caches: bool,
    sorts: bool,
    merges: bool,
    early_returns: usize,
    switch_or_chain: bool,
    recursion: bool,
    emits_events: bool,
    registers_listeners: bool,
}

/// Analyze a function body for behavioral patterns using regex/string matching.
/// Skips comment lines. Caps scan at MAX_BODY_SCAN_LINES.
fn analyze_body_patterns(symbol: &NativeParsedSymbol, file_content: &str) -> BodySignals {
    let mut signals = BodySignals::default();

    let all_lines: Vec<&str> = file_content.lines().collect();
    let start = symbol.range.start_line as usize;
    let end = symbol.range.end_line as usize;
    if start >= all_lines.len() || end > all_lines.len() || start >= end {
        return signals;
    }

    // Skip the first line (function signature) and cap at MAX_BODY_SCAN_LINES
    let body_lines: Vec<&str> = all_lines[start..end.min(all_lines.len())]
        .iter()
        .skip(1)
        .take(MAX_BODY_SCAN_LINES)
        .copied()
        .collect();
    if body_lines.is_empty() {
        return signals;
    }

    let mut in_block_comment = false;
    let mut else_if_count = 0;
    let mut call_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    let name_pattern = format!(r"\b{}\s*\(", regex::escape(&symbol.name));
    let name_regex = Regex::new(&name_pattern).ok();

    for raw_line in &body_lines {
        let line = raw_line.trim();

        // Skip comment lines
        if in_block_comment {
            if line.contains("*/") { in_block_comment = false; }
            continue;
        }
        if line.starts_with("/*") {
            in_block_comment = true;
            if line.contains("*/") { in_block_comment = false; }
            continue;
        }
        if line.starts_with("//") { continue; }
        if line.is_empty() { continue; }

        // Throws
        static RE_THROW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bthrow\s+").unwrap());
        if RE_THROW.is_match(line) { signals.throws = true; }

        // Validates: guard clause with throw or early return
        static RE_IF_BANG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"if\s*\(!").unwrap());
        static RE_THROW_KW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bthrow\b").unwrap());
        static RE_RETURN_KW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\breturn\b").unwrap());
        if RE_IF_BANG.is_match(line) && (RE_THROW_KW.is_match(line) || RE_RETURN_KW.is_match(line)) {
            signals.validates = true;
        }
        static RE_IF_THROW_NEW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"if\s*\(").unwrap());
        static RE_THROW_NEW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"throw\s+new\b").unwrap());
        if RE_IF_THROW_NEW.is_match(line) && RE_THROW_NEW.is_match(line) {
            signals.validates = true;
        }

        // Async
        static RE_AWAIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bawait\s").unwrap());
        if RE_AWAIT.is_match(line) { signals.is_async = true; }

        // Iteration
        static RE_ITER: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(\.forEach\s*\(|\.map\s*\(|\.filter\s*\(|\.reduce\s*\(|\bfor\s*\(|\bwhile\s*\(|\bfor\s+of\b|\bfor\s+in\b)").unwrap()
        });
        if RE_ITER.is_match(line) { signals.iterates = true; }

        // Transform
        static RE_TRANSFORM: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(\.map\s*\(|\.flatMap\s*\(|Object\.assign\s*\(|\{\.\.\.|Array\.from\s*\()").unwrap()
        });
        if RE_TRANSFORM.is_match(line) { signals.transforms = true; }

        // Aggregation
        static RE_AGG: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(\.reduce\s*\(|Math\.(min|max|abs)\s*\()").unwrap()
        });
        if RE_AGG.is_match(line) { signals.aggregates = true; }

        // Sort
        static RE_SORT: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(\.sort\s*\(|\.toSorted\s*\()").unwrap()
        });
        if RE_SORT.is_match(line) { signals.sorts = true; }

        // Merge
        static RE_MERGE: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(Object\.assign\s*\(|(?i:deepMerge)\s*\(|\{\.\.\.[^,]*,\s*\.\.\.)" ).unwrap()
        });
        if RE_MERGE.is_match(line) { signals.merges = true; }

        // Cache
        static RE_CACHE: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(?i)(cache\.(get|set|has)\s*\(|\.memoize\s*\(|new\s+WeakMap|new\s+WeakRef)").unwrap()
        });
        if RE_CACHE.is_match(line) { signals.caches = true; }

        // Network I/O
        static RE_NET: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(\bfetch\s*\(|axios\.|http\.request\s*\(|http\.get\s*\(|http\.post\s*\()").unwrap()
        });
        if RE_NET.is_match(line) { signals.has_network_io = true; }

        // File I/O
        static RE_FILE: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(fs\.(readFile|writeFile|appendFile|unlink|mkdir|rmdir|existsSync|readFileSync|writeFileSync)|\b(readFileSync|writeFileSync)\s*\()").unwrap()
        });
        if RE_FILE.is_match(line) { signals.has_file_io = true; }

        // DB I/O
        static RE_DB: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(\b(db|pool|connection|client|conn)\.(query|execute)\s*\()").unwrap()
        });
        static RE_SQL: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(?i)\b(SELECT|INSERT|UPDATE|DELETE|MERGE|MATCH|CREATE)\b").unwrap()
        });
        if RE_DB.is_match(line) || (line.contains(".query(") && RE_SQL.is_match(line)) {
            signals.has_db_io = true;
        }

        // Events emit
        static RE_EMIT: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(\.emit\s*\(|\.dispatch\s*\(|\.trigger\s*\(|\.publish\s*\()").unwrap()
        });
        if RE_EMIT.is_match(line) { signals.emits_events = true; }

        // Event listeners
        static RE_LISTEN: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r#"(\.on\s*\(\s*['"`]|\.addEventListener\s*\(|\.subscribe\s*\()"#).unwrap()
        });
        if RE_LISTEN.is_match(line) { signals.registers_listeners = true; }

        // Early returns
        static RE_EARLY_RETURN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*return\b").unwrap());
        if RE_EARLY_RETURN.is_match(raw_line) { signals.early_returns += 1; }

        // Switch
        static RE_SWITCH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bswitch\s*\(").unwrap());
        if RE_SWITCH.is_match(line) { signals.switch_or_chain = true; }

        // Else-if chain
        static RE_ELSE_IF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\belse\s+if\b").unwrap());
        if RE_ELSE_IF.is_match(line) { else_if_count += 1; }

        // Recursion
        if let Some(ref re) = name_regex {
            if re.is_match(line) { signals.recursion = true; }
        }

        // Track call targets for delegation detection
        static RE_CALL: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(?:this\.)?([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*)\s*\(").unwrap()
        });
        static RE_SKIP_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"^(function |const |if |while |for |switch )").unwrap()
        });
        if !RE_SKIP_PREFIX.is_match(line) {
            if let Some(cap) = RE_CALL.captures(line) {
                let target = cap.get(1).unwrap().as_str().to_string();
                static SKIP_CALLS: LazyLock<std::collections::HashSet<&str>> = LazyLock::new(|| {
                    [
                        "console.log", "console.warn", "console.error",
                        "Math.min", "Math.max", "Math.abs", "Math.floor", "Math.ceil", "Math.round",
                        "Array.isArray", "Object.keys", "Object.values", "Object.entries",
                        "JSON.stringify", "JSON.parse", "String", "Number", "Boolean",
                        "parseInt", "parseFloat", "Promise.all", "Promise.resolve",
                    ].into_iter().collect()
                });
                if !SKIP_CALLS.contains(target.as_str()) {
                    *call_counts.entry(target).or_insert(0) += 1;
                }
            }
        }
    }

    // Switch/chain: flag if >2 else-if branches
    if else_if_count > 2 { signals.switch_or_chain = true; }

    // Delegation: if one call dominates a short body AND no more-specific
    // behavioral signal was detected
    let has_specific_signal =
        signals.iterates || signals.transforms || signals.aggregates ||
        signals.sorts || signals.merges || signals.caches ||
        signals.has_network_io || signals.has_file_io || signals.has_db_io ||
        signals.emits_events || signals.registers_listeners ||
        signals.recursion || signals.validates;
    if !call_counts.is_empty() && body_lines.len() <= 10 && !has_specific_signal {
        let total_calls: usize = call_counts.values().sum();
        if let Some((top_target, &top_count)) = call_counts.iter().max_by_key(|(_, v)| *v) {
            if top_count >= 1 && total_calls <= 3 && top_target != &symbol.name {
                signals.delegates = Some(top_target.clone());
            }
        }
    }

    signals
}

/// Build a behavioral summary for a function/method.
/// Returns None if no behavioral signal is detected (better than a tautology).
/// Count how many behavioral signals are set on a BodySignals struct.
/// Mirrors countActiveSignals in summaries.ts.
fn count_active_signals(signals: &BodySignals) -> usize {
    let mut count = 0;
    if signals.throws { count += 1; }
    if signals.validates { count += 1; }
    if signals.delegates.is_some() { count += 1; }
    if signals.iterates { count += 1; }
    if signals.has_network_io { count += 1; }
    if signals.has_file_io { count += 1; }
    if signals.has_db_io { count += 1; }
    if signals.transforms { count += 1; }
    if signals.aggregates { count += 1; }
    if signals.caches { count += 1; }
    if signals.sorts { count += 1; }
    if signals.merges { count += 1; }
    if signals.switch_or_chain { count += 1; }
    if signals.recursion { count += 1; }
    if signals.emits_events { count += 1; }
    if signals.registers_listeners { count += 1; }
    count
}

/// Verb prefixes that convey a clear intent and should take priority over
/// generic body-pattern templates. Mirrors STRONG_VERB_PREFIXES in summaries.ts.
const STRONG_VERB_PREFIXES: &[&str] = &[
    "build", "compose", "create", "make", "construct",
    "compute", "calculate", "calc",
    "load", "fetch", "read",
    "save", "write", "store", "persist",
    "parse", "decode",
    "format", "render", "stringify",
    "normalize", "clean",
    "init", "initialize", "setup",
    "register", "subscribe",
    "remove", "delete", "destroy", "unregister",
    "update", "patch",
    "validate", "sanitize",
    "extract", "derive",
    "apply", "execute", "run", "invoke",
    "reset", "clear", "flush", "purge",
    "compare", "diff",
    "count", "measure", "estimate",
    "clone", "copy", "duplicate",
];

/// Build a summary from a verb-prefixed function name. Returns None when the
/// first word is not a recognized action verb. Mirrors generatePrefixSummary
/// in summaries.ts (minimal subset — just the most common verbs).
fn generate_prefix_summary(first_word: &str, subject: &str, signals: &BodySignals) -> Option<String> {
    let io_detail_get = if signals.has_db_io { " from database" }
        else if signals.has_network_io { " from network" }
        else if signals.has_file_io { " from filesystem" }
        else if signals.caches { " (cached)" }
        else { "" };
    match first_word {
        "get" => Some(format!("Retrieves {}{}", subject, io_detail_get)),
        "set" => Some(format!("Sets {}", subject)),
        "find" => Some(format!("Finds {}", subject)),
        "create" => Some(format!("Creates a new {}", subject)),
        "make" | "construct" => Some(format!("Constructs {}", subject)),
        "build" | "compose" => Some(format!(
            "Builds {}{}",
            subject,
            if signals.iterates { " from components" } else { "" }
        )),
        "compute" | "calculate" | "calc" => Some(format!(
            "Computes {}{}",
            subject,
            if signals.aggregates { " by aggregating values" } else { "" }
        )),
        "check" | "verify" | "assert" => Some(format!(
            "Checks {}{}",
            subject,
            if signals.throws { ", throws on failure" } else { "" }
        )),
        "ensure" | "require" => Some(format!(
            "Ensures {} is valid{}",
            subject,
            if signals.throws { " or throws" } else { "" }
        )),
        "parse" | "decode" => Some(format!(
            "Parses {}{}",
            subject,
            if signals.validates { " with validation" } else { "" }
        )),
        "format" | "render" | "stringify" => Some(format!("Formats {} for output", subject)),
        "normalize" | "clean" => Some(format!("Normalizes {} to canonical form", subject)),
        "init" | "initialize" | "setup" => Some(format!("Initializes {}", subject)),
        "register" | "subscribe" => Some(format!(
            "Registers {}{}",
            subject,
            if signals.registers_listeners { " as event listener" } else { "" }
        )),
        "remove" | "delete" | "destroy" | "unregister" => Some(format!("Removes {}", subject)),
        "update" | "patch" => Some(format!(
            "Updates {}{}",
            subject,
            if signals.has_db_io { " in database" } else { "" }
        )),
        "load" | "fetch" | "read" => {
            let io = if signals.has_db_io { " from database" }
                else if signals.has_network_io { " from network" }
                else if signals.has_file_io { " from disk" }
                else { "" };
            Some(format!("Loads {}{}", subject, io))
        }
        "save" | "write" | "store" | "persist" => {
            let io = if signals.has_db_io { " to database" }
                else if signals.has_file_io { " to disk" }
                else { "" };
            Some(format!("Saves {}{}", subject, io))
        }
        "validate" | "sanitize" => Some(format!(
            "Validates {}{}",
            subject,
            if signals.throws { ", throws on invalid input" } else { "" }
        )),
        "extract" | "derive" => Some(format!("Extracts {}", subject)),
        "apply" | "execute" | "run" | "invoke" => Some(format!(
            "Executes {}{}",
            subject,
            if signals.is_async { " asynchronously" } else { "" }
        )),
        "reset" => Some(format!("Resets {} to initial state", subject)),
        "clear" | "flush" | "purge" => Some(format!("Clears {}", subject)),
        "compare" | "diff" => Some(format!("Compares {}", subject)),
        "count" | "measure" | "estimate" => Some(format!("Counts {}", subject)),
        "clone" | "copy" | "duplicate" => Some(format!("Creates a copy of {}", subject)),
        _ => None,
    }
}

fn generate_behavioral_function_summary(symbol: &NativeParsedSymbol, file_content: &str) -> Option<String> {
    let signals = analyze_body_patterns(symbol, file_content);

    // Derive subject from name: split camelCase, drop the first word (verb)
    let words = split_camel_case(&symbol.name);
    let first_word = words.first().map(|w| w.to_lowercase()).unwrap_or_default();
    let rest_words = if words.len() > 1 {
        words[1..].iter().map(|w| w.to_lowercase()).collect::<Vec<_>>().join(" ")
    } else {
        String::new()
    };
    let subject = if rest_words.is_empty() { None } else { Some(rest_words.clone()) };

    // Prefix-based action verbs (build/get/load/save/...) describe what the
    // function does at a higher level than the generic transform/iterate
    // templates below. Run the prefix matcher early so a function named
    // buildSlice does not get summarized as "Transforms each slice" just
    // because it contains a single .map() call.
    if STRONG_VERB_PREFIXES.contains(&first_word.as_str()) && !rest_words.is_empty() {
        if let Some(s) = generate_prefix_summary(&first_word, &rest_words, &signals) {
            return Some(s);
        }
    }

    // Length gate: long functions with only weak generic signals should
    // return None — the name alone is more honest than a vague summary.
    let active_count = count_active_signals(&signals);
    let body_length = symbol.range.end_line.saturating_sub(symbol.range.start_line);
    if body_length > 60 && active_count <= 2 {
        return None;
    }

    // Template priority (first match wins)

    // 1. Delegation
    if let Some(ref target) = signals.delegates {
        return Some(match &subject {
            Some(s) => format!("Delegates to {} for {}", target, s),
            None => format!("Delegates to {}", target),
        });
    }

    // 2. Validation (but not if recursion/iteration/transform detected)
    if signals.validates && !signals.iterates && !signals.transforms && !signals.recursion {
        let throw_clause = if signals.throws { ", throws on failure" } else { "" };
        return Some(match &subject {
            Some(s) => format!("Validates {}{}", s, throw_clause),
            None => format!("Validates input{}", throw_clause),
        });
    }

    // 3. Network I/O
    if signals.has_network_io {
        return Some(match &subject {
            Some(s) => format!("Fetches {} via network", s),
            None => "Performs network request".to_string(),
        });
    }

    // 4. File I/O
    if signals.has_file_io {
        return Some(match &subject {
            Some(s) => format!("Reads/writes {} on disk", s),
            None => "Performs filesystem I/O".to_string(),
        });
    }

    // 5. DB I/O
    if signals.has_db_io {
        return Some(match &subject {
            Some(s) => format!("Queries {} from database", s),
            None => "Performs database query".to_string(),
        });
    }

    // 6. Caching
    if signals.caches {
        return Some(match &subject {
            Some(s) => format!("Caches {}", s),
            None => "Memoizes result".to_string(),
        });
    }

    // 7. Event emission
    if signals.emits_events {
        return Some(match &subject {
            Some(s) => format!("Emits {} event", s),
            None => "Emits event".to_string(),
        });
    }

    // 8. Event subscription
    if signals.registers_listeners {
        return Some(match &subject {
            Some(s) => format!("Subscribes to {}", s),
            None => "Registers event listener".to_string(),
        });
    }

    // 9. Aggregation (without transform)
    if signals.aggregates && !signals.transforms {
        return Some(match &subject {
            Some(s) => format!("Aggregates {}", s),
            None => "Aggregates data".to_string(),
        });
    }

    // 10. Transform + iterate
    if signals.transforms && signals.iterates {
        return Some(match &subject {
            Some(s) => format!("Transforms each {}", s),
            None => "Transforms collection elements".to_string(),
        });
    }

    // 11. Transform only
    if signals.transforms && !signals.iterates {
        return Some(match &subject {
            Some(s) => format!("Transforms {}", s),
            None => "Transforms data".to_string(),
        });
    }

    // 12. Sort
    if signals.sorts {
        return Some(match &subject {
            Some(s) => format!("Sorts {}", s),
            None => "Sorts elements".to_string(),
        });
    }

    // 13. Merge
    if signals.merges {
        return Some(match &subject {
            Some(s) => format!("Merges {}", s),
            None => "Merges data".to_string(),
        });
    }

    // 14. Dispatch (switch/chain with many early returns)
    if signals.switch_or_chain && signals.early_returns > 3 {
        return Some(match &subject {
            Some(s) => format!("Dispatches {} across branches", s),
            None => "Routes by condition".to_string(),
        });
    }

    // 15. Recursion
    if signals.recursion {
        return Some(match &subject {
            Some(s) => format!("Recursively processes {}", s),
            None => "Recursive computation".to_string(),
        });
    }

    // 16. Iterate only
    if signals.iterates && !signals.transforms {
        return Some(match &subject {
            Some(s) => format!("Iterates over {}", s),
            None => "Iterates over elements".to_string(),
        });
    }

    // 17. Throws (standalone)
    if signals.throws {
        if let Some(ref s) = subject {
            return Some(format!("Validates {}, throws on failure", s));
        }
    }

    // No behavioral signal detected
    None
}

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
            return generate_behavioral_function_summary(symbol, file_content)
                .unwrap_or_default();
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

fn generate_constructor_summary(_symbol: &NativeParsedSymbol) -> Option<String> {
    // "Constructs from TypeA and TypeB" is pure type restating — return None.
    // The types are already on the card's signature.
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{NativeParsedSymbol, NativeSymbolSignature, NativeSymbolSignatureParam, NativeRange};

    fn make_symbol(name: &str, kind: &str) -> NativeParsedSymbol {
        NativeParsedSymbol {
            node_id: name.to_string(),
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
            decorators: vec![],
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
        assert_eq!(result, None);
    }

    #[test]
    fn test_variable_no_summary() {
        let s = make_symbol("count", "variable");
        let result = generate_variable_summary(&s);
        assert_eq!(result, None);
    }
}
