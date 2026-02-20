#[macro_use]
extern crate napi_derive;

pub mod error;
pub mod extract;
pub mod lang;
pub mod parse;
pub mod scanner;
pub mod types;

use types::{NativeFileInput, NativeParsedFile};

/// Parse and extract symbols/imports/calls from a batch of files.
///
/// This is the primary entry point called from TypeScript.
/// Uses Rayon for parallel processing across files.
///
/// Returns NativeParsedFile[] with per-file results.
#[napi]
pub fn parse_files(
    files: Vec<NativeFileInput>,
    thread_count: u32,
) -> Vec<NativeParsedFile> {
    let count = if thread_count == 0 {
        num_cpus()
    } else {
        thread_count as usize
    };

    parse::parse_files_parallel(&files, count)
}

/// SHA-256 hash of a string, returned as lowercase hex.
///
/// Exact parity with TypeScript `hashContent()` in `util/hashing.ts`.
/// Exported for cross-validation in parity tests.
#[napi]
pub fn hash_content_native(content: String) -> String {
    parse::content_hash::hash_content(&content)
}

/// Generate a stable symbol ID.
///
/// Exact parity with TypeScript `generateSymbolId()` in `util/hashing.ts`.
/// Exported for cross-validation in parity tests.
#[napi]
pub fn generate_symbol_id_native(
    repo_id: String,
    rel_path: String,
    kind: String,
    name: String,
    fingerprint: String,
) -> String {
    extract::symbol_id::generate_symbol_id(&repo_id, &rel_path, &kind, &name, &fingerprint)
}

/// Get the number of available CPU cores (minus 1, minimum 1).
fn num_cpus() -> usize {
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    cpus.saturating_sub(1).max(1)
}
