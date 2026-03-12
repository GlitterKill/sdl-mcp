use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

use crate::types::NativeParsedSymbol;

/// Detect side effects in a symbol's code.
///
/// Mirrors TypeScript `extractSideEffects` in `summaries.ts`.
///
/// Categories:
/// - Network I/O (fetch, axios, http.request, etc.)
/// - Filesystem I/O (fs.readFile, fs.writeFile, etc.)
/// - Database query (db.query, pool.execute, etc.)
/// - Global state mutation (globalThis, window, document, localStorage)
/// - Environment access (process.env, process.cwd, import.meta.env)
pub fn extract_side_effects(symbol: &NativeParsedSymbol, file_content: &str) -> Vec<String> {
    let mut effects = Vec::new();
    let lines = get_symbol_lines(symbol, file_content);

    static NETWORK_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        vec![
            Regex::new(r"fetch\s*\(").unwrap(),
            Regex::new(r"axios\.").unwrap(),
            Regex::new(r"http\.request\s*\(").unwrap(),
            Regex::new(r"http\.get\s*\(").unwrap(),
            Regex::new(r"http\.post\s*\(").unwrap(),
            Regex::new(r"XMLHttpRequest").unwrap(),
            Regex::new(r"requests\.(?:get|post|put|delete|patch)\s*\(").unwrap(),
            Regex::new(r"http\.(?:Get|Post|NewRequest)\s*\(").unwrap(),
            Regex::new(r"reqwest::(?:get|Client)").unwrap(),
            Regex::new(r"HttpClient|HttpURLConnection|URL\s*\(").unwrap(),
        ]
    });

    static FS_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        vec![
            Regex::new(r"fs\.readFile").unwrap(),
            Regex::new(r"fs\.writeFile").unwrap(),
            Regex::new(r"fs\.appendFile").unwrap(),
            Regex::new(r"fs\.unlink").unwrap(),
            Regex::new(r"fs\.mkdir").unwrap(),
            Regex::new(r"fs\.rmdir").unwrap(),
            Regex::new(r"fs\.existsSync").unwrap(),
            Regex::new(r"fs\.readFileSync").unwrap(),
            Regex::new(r"fs\.writeFileSync").unwrap(),
            Regex::new(r"readFileSync").unwrap(),
            Regex::new(r"writeFileSync").unwrap(),
            Regex::new(r"open\s*\(").unwrap(),
            Regex::new(r"os\.(?:path|listdir|makedirs|remove)").unwrap(),
            Regex::new(r"os\.(?:Open|Create|ReadFile)\s*\(").unwrap(),
            Regex::new(r"std::fs::(?:read|write|create|remove|rename)").unwrap(),
            Regex::new(r"new\s+File(?:Input|Output)Stream\s*\(").unwrap(),
            Regex::new(r"Files\.(?:read|write)").unwrap(),
        ]
    });

    static DB_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        vec![
            Regex::new(r"db\.query\s*\(").unwrap(),
            Regex::new(r"db\.execute\s*\(").unwrap(),
            Regex::new(r"pool\.query\s*\(").unwrap(),
            Regex::new(r"pool\.execute\s*\(").unwrap(),
            Regex::new(r"connection\.query").unwrap(),
            Regex::new(r"connection\.execute").unwrap(),
            Regex::new(r"client\.query").unwrap(),
            Regex::new(r"\.query\s*\(").unwrap(),
            Regex::new(r"sqlite3\.connect\s*\(").unwrap(),
            Regex::new(r"sql\.Open\s*\(").unwrap(),
            Regex::new(r"DriverManager\.getConnection\s*\(").unwrap(),
        ]
    });

    static GLOBAL_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        vec![
            Regex::new(r"globalThis\.").unwrap(),
            Regex::new(r"window\.").unwrap(),
            Regex::new(r"document\.").unwrap(),
            Regex::new(r"localStorage\.").unwrap(),
            Regex::new(r"sessionStorage\.").unwrap(),
            Regex::new(r"process\.").unwrap(),
        ]
    });

    static ENV_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        vec![
            Regex::new(r"process\.env").unwrap(),
            Regex::new(r"process\.cwd").unwrap(),
            Regex::new(r"import\.meta\.env").unwrap(),
            Regex::new(r"os\.environ").unwrap(),
            Regex::new(r"os\.Getenv\s*\(").unwrap(),
            Regex::new(r"std::env::(?:var|vars|args)").unwrap(),
            Regex::new(r"System\.getenv\s*\(").unwrap(),
        ]
    });

    static PROCESS_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        vec![
            Regex::new(r"subprocess\.(?:run|call|Popen)\s*\(").unwrap(),
            Regex::new(r"exec\.Command\s*\(").unwrap(),
            Regex::new(r"std::process::Command").unwrap(),
            Regex::new(r"Runtime\.getRuntime\(\)\.exec\s*\(").unwrap(),
        ]
    });

    for line in &lines {
        // Network I/O
        for pattern in NETWORK_PATTERNS.iter() {
            if pattern.is_match(line) {
                effects.push("Network I/O".to_string());
                break;
            }
        }

        // Filesystem I/O
        for pattern in FS_PATTERNS.iter() {
            if pattern.is_match(line) {
                effects.push("Filesystem I/O".to_string());
                break;
            }
        }

        // Database query
        for pattern in DB_PATTERNS.iter() {
            if pattern.is_match(line) {
                effects.push("Database query".to_string());
                break;
            }
        }

        // Global state mutation
        for pattern in GLOBAL_PATTERNS.iter() {
            if pattern.is_match(line) && !line.contains("//") && !line.contains("/*") {
                if line.contains("window.") && !line.contains("window.addEventListener") {
                    effects.push("Global state mutation (window)".to_string());
                } else if line.contains("document.") && line.contains('=') {
                    effects.push("DOM mutation".to_string());
                } else if line.contains("globalThis.")
                    || line.contains("localStorage.")
                    || line.contains("sessionStorage.")
                {
                    effects.push("Global state mutation".to_string());
                }
                break;
            }
        }

        // Environment access
        for pattern in ENV_PATTERNS.iter() {
            if pattern.is_match(line) {
                effects.push("Environment access".to_string());
                break;
            }
        }

        // Process spawning
        for pattern in PROCESS_PATTERNS.iter() {
            if pattern.is_match(line) {
                effects.push("Process spawning".to_string());
                break;
            }
        }
    }

    // Deduplicate
    let mut seen = HashSet::new();
    effects.retain(|item| seen.insert(item.clone()));
    effects
}

fn get_symbol_lines<'a>(symbol: &NativeParsedSymbol, file_content: &'a str) -> Vec<&'a str> {
    let lines: Vec<&str> = file_content.lines().collect();
    let start = (symbol.range.start_line as usize).saturating_sub(1);
    let end = (symbol.range.end_line as usize).min(lines.len());
    lines[start..end].to_vec()
}
