pub mod content_hash;
pub mod file_reader;

use std::panic;

use rayon::prelude::*;

use crate::extract;
use crate::lang;
use crate::types::{NativeFileInput, NativeParsedFile};

/// Stack size per Rayon worker thread (64 MiB). Tree-sitter's C-based parser
/// can recurse deeply on complex/generated files (e.g. LLVM's deeply-nested
/// C++ templates); the default stack may not suffice and cause a hard crash
/// (STATUS_STACK_BUFFER_OVERRUN on Windows). 64 MiB provides headroom for
/// both tree-sitter C recursion and the Rust AST walkers.
const RAYON_STACK_SIZE: usize = 64 * 1024 * 1024;

/// Maximum file size in bytes that the native parser will attempt to parse.
/// Files larger than this are skipped with a parse error. This prevents
/// pathological cases (e.g. 16 MB generated test files in LLVM) from
/// consuming excessive memory or triggering stack overflows in tree-sitter.
const MAX_PARSE_FILE_BYTES: usize = 1_500_000; // 1.5 MB

/// Parse and extract symbols/imports/calls from a batch of files in parallel.
///
/// Uses Rayon's work-stealing thread pool. Each thread gets its own
/// thread-local tree-sitter parser instance.
///
/// Individual file panics (e.g. tree-sitter C-level crashes) are caught via
/// `catch_unwind` so they produce a per-file `parse_error` instead of
/// bringing down the entire Node.js process.
pub fn parse_files_parallel(
    files: &[NativeFileInput],
    thread_count: usize,
) -> Vec<NativeParsedFile> {
    // Build a custom thread pool with large stacks. If both the custom pool
    // and global pool fail to build (e.g. OOM under heavy load), we fall back
    // to single-threaded sequential parsing rather than panicking.
    let pool = match rayon::ThreadPoolBuilder::new()
        .num_threads(thread_count)
        .stack_size(RAYON_STACK_SIZE)
        .build()
    {
        Ok(pool) => pool,
        Err(e1) => match rayon::ThreadPoolBuilder::new().build() {
            Ok(pool) => {
                eprintln!("sdl-mcp-native: custom Rayon pool failed ({e1}), using global pool");
                pool
            }
            Err(e2) => {
                eprintln!(
                    "sdl-mcp-native: all Rayon pools failed ({e1}, {e2}), parsing sequentially"
                );
                // Sequential fallback — no parallelism but no crash
                return files.iter().map(|f| parse_single_file_safe(f)).collect();
            }
        },
    };

    pool.install(|| {
        files
            .par_iter()
            .map(|file| parse_single_file_safe(file))
            .collect()
    })
}

/// Wrapper around `parse_single_file` that catches panics from tree-sitter's
/// C code (or any other unexpected panic) and converts them to a parse error.
fn parse_single_file_safe(input: &NativeFileInput) -> NativeParsedFile {
    let rel_path = input.rel_path.clone();
    match panic::catch_unwind(panic::AssertUnwindSafe(|| parse_single_file(input))) {
        Ok(result) => result,
        Err(payload) => {
            let msg = if let Some(s) = payload.downcast_ref::<&str>() {
                format!("panic during parse: {s}")
            } else if let Some(s) = payload.downcast_ref::<String>() {
                format!("panic during parse: {s}")
            } else {
                "panic during parse: unknown payload".to_string()
            };
            NativeParsedFile {
                rel_path,
                content_hash: String::new(),
                symbols: vec![],
                imports: vec![],
                calls: vec![],
                parse_error: Some(msg),
            }
        }
    }
}

/// Parse a single file: read content, compute hash, parse AST, extract all.
fn parse_single_file(input: &NativeFileInput) -> NativeParsedFile {
    let content = match file_reader::read_file(&input.absolute_path) {
        Ok(c) => c,
        Err(e) => {
            return NativeParsedFile {
                rel_path: input.rel_path.clone(),
                content_hash: String::new(),
                symbols: vec![],
                imports: vec![],
                calls: vec![],
                parse_error: Some(format!("{e}")),
            };
        }
    };

    let content_hash = content_hash::hash_content(&content);

    if lang::get_language(&input.language).is_none() {
        return NativeParsedFile {
            rel_path: input.rel_path.clone(),
            content_hash,
            symbols: vec![],
            imports: vec![],
            calls: vec![],
            parse_error: Some(format!("Unsupported language: {}", input.language)),
        };
    }

    // Skip files that are too large — they cause excessive memory usage and
    // risk stack overflows in tree-sitter's C parser on deeply-nested ASTs.
    if content.len() > MAX_PARSE_FILE_BYTES {
        return NativeParsedFile {
            rel_path: input.rel_path.clone(),
            content_hash,
            symbols: vec![],
            imports: vec![],
            calls: vec![],
            parse_error: Some(format!(
                "File too large for native parser ({} bytes, limit {})",
                content.len(),
                MAX_PARSE_FILE_BYTES
            )),
        };
    }

    let mut parser = lang::create_parser(&input.language);
    let tree = match parser.as_mut().and_then(|p| p.parse(&content, None)) {
        Some(t) => t,
        None => {
            return NativeParsedFile {
                rel_path: input.rel_path.clone(),
                content_hash,
                symbols: vec![],
                imports: vec![],
                calls: vec![],
                parse_error: Some("tree-sitter parse returned None".into()),
            };
        }
    };

    let root = tree.root_node();

    // Extract symbols
    let mut symbols = extract::symbols::extract_symbols(
        root,
        content.as_bytes(),
        &input.repo_id,
        &input.rel_path,
        &input.language,
    );

    for symbol in &mut symbols {
        symbol.summary = extract::summary::generate_summary(symbol, &content, &input.language);

        let invariants = extract::invariants::extract_invariants(symbol, &content);
        symbol.invariants = invariants;

        let side_effects = extract::side_effects::extract_side_effects(symbol, &content);
        symbol.side_effects = side_effects;

        let role_tags = extract::roles::extract_role_tags(symbol, &input.rel_path);
        symbol.role_tags = role_tags.clone();
        symbol.search_text =
            extract::search_text::build_search_text(symbol, &input.rel_path, &role_tags);
    }

    // Extract imports
    let imports = extract::imports::extract_imports(root, content.as_bytes(), &input.language);

    // Extract calls
    let calls = extract::calls::extract_calls(root, content.as_bytes(), &symbols, &input.language);

    NativeParsedFile {
        rel_path: input.rel_path.clone(),
        content_hash,
        symbols,
        imports,
        calls,
        parse_error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn oversized_unsupported_language_reports_unsupported_language() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before UNIX_EPOCH")
            .as_nanos();
        let file_path = std::env::temp_dir().join(format!("sdl_mcp_parse_{unique}.txt"));
        let large_content = vec![b'x'; MAX_PARSE_FILE_BYTES + 1];

        fs::write(&file_path, large_content).expect("failed to write temporary file");

        let input = NativeFileInput {
            rel_path: "tmp/oversized.unsupported".to_string(),
            absolute_path: file_path.to_string_lossy().into_owned(),
            repo_id: "test-repo".to_string(),
            language: "unsupported-language".to_string(),
        };

        let parsed = parse_single_file(&input);
        let _ = fs::remove_file(file_path);

        assert_eq!(
            parsed.parse_error.as_deref(),
            Some("Unsupported language: unsupported-language")
        );
    }
}
