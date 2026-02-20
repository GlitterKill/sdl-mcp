use crate::parse::content_hash::hash_content;

/// Generate a stable unique identifier for a symbol.
///
/// Exact parity with TypeScript `generateSymbolId` in `hashing.ts:16-25`.
///
/// Algorithm: `sha256("{repoId}:{relPath}:{kind}:{name}:{astFingerprint}")`
pub fn generate_symbol_id(
    repo_id: &str,
    rel_path: &str,
    kind: &str,
    name: &str,
    ast_fingerprint: &str,
) -> String {
    let combined = format!("{repo_id}:{rel_path}:{kind}:{name}:{ast_fingerprint}");
    hash_content(&combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deterministic() {
        let id1 = generate_symbol_id("repo", "src/main.ts", "function", "hello", "abc123");
        let id2 = generate_symbol_id("repo", "src/main.ts", "function", "hello", "abc123");
        assert_eq!(id1, id2);
    }

    #[test]
    fn test_different_inputs_different_ids() {
        let id1 = generate_symbol_id("repo", "src/main.ts", "function", "hello", "abc123");
        let id2 = generate_symbol_id("repo", "src/main.ts", "function", "world", "abc123");
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_format() {
        let id = generate_symbol_id("repo", "src/main.ts", "function", "hello", "abc123");
        // SHA-256 hex is always 64 chars
        assert_eq!(id.len(), 64);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
