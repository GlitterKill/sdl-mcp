use std::fs;
use std::path::Path;

use crate::error::IndexerError;

/// Read file content as UTF-8 string, handling BOM if present.
pub fn read_file(path: &str) -> Result<String, IndexerError> {
    let path = Path::new(path);
    let bytes = fs::read(path)?;

    // Strip UTF-8 BOM if present (0xEF 0xBB 0xBF)
    let content = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&bytes[3..]).into_owned()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };

    Ok(content)
}
