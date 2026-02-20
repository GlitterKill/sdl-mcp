use ignore::WalkBuilder;
use std::path::Path;

use crate::lang::extension_to_language;
use crate::types::NativeFileInput;

/// Scan a directory for source files, respecting .gitignore and ignore patterns.
///
/// Returns NativeFileInput entries ready for parse_files_parallel.
pub fn scan_directory(
    root_path: &str,
    repo_id: &str,
    ignore_patterns: &[String],
    languages: &[String],
    max_file_bytes: u64,
) -> Vec<NativeFileInput> {
    let root = Path::new(root_path);
    let mut files = Vec::new();

    let mut builder = WalkBuilder::new(root);
    builder.hidden(false).git_ignore(true).git_global(false);

    // Add custom ignore patterns
    for pattern in ignore_patterns {
        let mut override_builder = ignore::overrides::OverrideBuilder::new(root);
        if let Ok(_) = override_builder.add(&format!("!{pattern}")) {
            if let Ok(overrides) = override_builder.build() {
                builder.overrides(overrides);
            }
        }
    }

    let walker = builder.build();

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        // Skip directories
        if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(true) {
            continue;
        }

        let path = entry.path();

        // Check file size
        if let Ok(metadata) = path.metadata() {
            if metadata.len() > max_file_bytes {
                continue;
            }
        }

        // Check file extension and language
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        let lang = match extension_to_language(ext) {
            Some(l) => l,
            None => continue,
        };

        // Filter by configured languages
        if !languages.is_empty() && !languages.iter().any(|l| l == lang) {
            continue;
        }

        // Compute relative path
        let rel_path = match path.strip_prefix(root) {
            Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        let absolute_path = path.to_string_lossy().to_string();

        files.push(NativeFileInput {
            rel_path,
            absolute_path,
            repo_id: repo_id.to_string(),
            language: lang.to_string(),
        });
    }

    files
}
