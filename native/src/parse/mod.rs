pub mod content_hash;
pub mod file_reader;

use rayon::prelude::*;

use crate::extract;
use crate::lang;
use crate::types::{NativeFileInput, NativeParsedFile};

/// Parse and extract symbols/imports/calls from a batch of files in parallel.
///
/// Uses Rayon's work-stealing thread pool. Each thread gets its own
/// thread-local tree-sitter parser instance.
pub fn parse_files_parallel(
    files: &[NativeFileInput],
    thread_count: usize,
) -> Vec<NativeParsedFile> {
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(thread_count)
        .build()
        .unwrap_or_else(|_| {
            // Fallback to global pool
            rayon::ThreadPoolBuilder::new().build().unwrap()
        });

    pool.install(|| {
        files
            .par_iter()
            .map(|file| parse_single_file(file))
            .collect()
    })
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
            parse_error: Some(format!(
                "Unsupported language: {}",
                input.language
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
    let symbols = extract::symbols::extract_symbols(
        root,
        content.as_bytes(),
        &input.repo_id,
        &input.rel_path,
        &input.language,
    );

    // Extract imports
    let imports = extract::imports::extract_imports(
        root,
        content.as_bytes(),
        &input.language,
    );

    // Extract calls
    let calls = extract::calls::extract_calls(
        root,
        content.as_bytes(),
        &symbols,
        &input.language,
    );

    NativeParsedFile {
        rel_path: input.rel_path.clone(),
        content_hash,
        symbols,
        imports,
        calls,
        parse_error: None,
    }
}
