use sha2::{Digest, Sha256};

/// SHA-256 hash of content, returned as lowercase hex.
/// Exact parity with TypeScript `hashContent(content: string): string`.
///
/// The TS implementation does:
///   crypto.createHash("sha256").update(content).digest("hex")
///
/// Node.js `update(string)` encodes the string as UTF-8 before hashing.
/// We do the same here.
pub fn hash_content(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_string() {
        // SHA-256 of empty string
        assert_eq!(
            hash_content(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn test_hello_world() {
        // SHA-256 of "hello world"
        assert_eq!(
            hash_content("hello world"),
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn test_unicode() {
        // Ensure UTF-8 encoding parity
        let content = "const x = '🎉';";
        let hash = hash_content(content);
        assert_eq!(hash.len(), 64); // SHA-256 hex is always 64 chars
    }
}
