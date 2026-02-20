use std::fmt;

#[derive(Debug)]
pub enum IndexerError {
    Io(std::io::Error),
    Parse(String),
    UnsupportedLanguage(String),
}

impl fmt::Display for IndexerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IndexerError::Io(e) => write!(f, "IO error: {e}"),
            IndexerError::Parse(msg) => write!(f, "Parse error: {msg}"),
            IndexerError::UnsupportedLanguage(lang) => {
                write!(f, "Unsupported language: {lang}")
            }
        }
    }
}

impl std::error::Error for IndexerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            IndexerError::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for IndexerError {
    fn from(e: std::io::Error) -> Self {
        IndexerError::Io(e)
    }
}
