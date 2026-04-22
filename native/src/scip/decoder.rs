use std::sync::Mutex;
use napi::Result as NapiResult;
use prost::Message;

// Include the prost-generated code from build.rs output.
// build.rs writes to CARGO_MANIFEST_DIR/src/scip/ so the generated file
// is a sibling of this file at native/src/scip/scip.rs.
#[path = "scip.rs"]
mod scip_proto;

use scip_proto::*;
use super::types::*;

struct DocumentIterState {
    docs: Vec<Document>,
    cursor: usize,
}

/// Holds the decoded SCIP index with progressive memory release.
///
/// Documents are taken (std::mem::take) from the vec as they're consumed,
/// freeing each document's occurrences/symbols immediately after napi
/// conversion instead of holding the entire decoded index in memory.
pub struct ScipDecodeState {
    metadata: Option<Metadata>,
    external_symbols: Vec<SymbolInformation>,
    doc_state: Mutex<DocumentIterState>,
}

impl ScipDecodeState {
    /// Parse a SCIP index file from disk into an in-memory protobuf structure.
    pub fn new(file_path: &str) -> NapiResult<Self> {
        const MAX_SCIP_INDEX_BYTES: u64 = 256 * 1024 * 1024;
        let metadata = std::fs::metadata(file_path).map_err(|e| {
            napi::Error::from_reason(format!("Failed to stat SCIP file: {}", e))
        })?;
        if metadata.len() > MAX_SCIP_INDEX_BYTES {
            return Err(napi::Error::from_reason(format!(
                "SCIP index file too large: {} bytes (max {} bytes)",
                metadata.len(),
                MAX_SCIP_INDEX_BYTES
            )));
        }
        let bytes = std::fs::read(file_path)
            .map_err(|e| napi::Error::from_reason(format!("Failed to read SCIP file: {}", e)))?;
        let index = Index::decode(&bytes[..])
            .map_err(|e| napi::Error::from_reason(format!("Failed to decode SCIP index: {}", e)))?;
        Ok(Self {
            metadata: index.metadata,
            external_symbols: index.external_symbols,
            doc_state: Mutex::new(DocumentIterState {
                docs: index.documents,
                cursor: 0,
            }),
        })
    }

    /// Extract metadata from the parsed SCIP index.
    pub fn metadata(&self) -> NapiResult<NapiScipMetadata> {
        let meta = self.metadata.as_ref();
        let tool_info = meta.and_then(|m| m.tool_info.as_ref());
        Ok(NapiScipMetadata {
            version: meta.map(|m| m.version).unwrap_or(0),
            tool_name: tool_info.map(|t| t.name.clone()).unwrap_or_default(),
            tool_version: tool_info.map(|t| t.version.clone()).unwrap_or_default(),
            tool_arguments: tool_info.map(|t| t.arguments.clone()).unwrap_or_default(),
            project_root: meta.map(|m| m.project_root.clone()).unwrap_or_default(),
            text_document_encoding: meta.map(|m| {
                match m.text_document_encoding {
                    0 => "UnspecifiedTextEncoding".to_string(),
                    1 => "UTF8".to_string(),
                    2 => "UTF16".to_string(),
                    _ => format!("Unknown({})", m.text_document_encoding),
                }
            }).unwrap_or_else(|| "UnspecifiedTextEncoding".to_string()),
        })
    }

    /// Return the next document from the index, advancing the internal cursor.
    /// Returns None when all documents have been consumed.
    ///
    /// Each consumed document is replaced with `Default::default()` via
    /// `std::mem::take`, releasing its occurrences and symbol data immediately
    /// rather than keeping the full decoded index resident until drop.
    pub fn next_document(&self) -> NapiResult<Option<NapiScipDocument>> {
        let mut state = self.doc_state.lock()
            .map_err(|e| napi::Error::from_reason(format!("Lock poisoned: {}", e)))?;
        let idx = state.cursor;
        if idx >= state.docs.len() {
            return Ok(None);
        }
        let doc = std::mem::take(&mut state.docs[idx]);
        state.cursor += 1;
        Ok(Some(convert_document(&doc)))
    }

    /// Return all external symbols from the SCIP index.
    pub fn external_symbols(&self) -> NapiResult<Vec<NapiScipExternalSymbol>> {
        Ok(self.external_symbols.iter().map(convert_external_symbol).collect())
    }
}

// --- Conversion functions ---

fn convert_document(doc: &Document) -> NapiScipDocument {
    NapiScipDocument {
        language: doc.language.clone(),
        relative_path: doc.relative_path.clone(),
        occurrences: doc.occurrences.iter().map(convert_occurrence).collect(),
        symbols: doc.symbols.iter().map(convert_symbol_info).collect(),
    }
}

fn convert_occurrence(occ: &Occurrence) -> NapiScipOccurrence {
    NapiScipOccurrence {
        range: convert_range(&occ.range),
        symbol: occ.symbol.clone(),
        symbol_roles: occ.symbol_roles,
        override_documentation: occ.override_documentation.clone(),
        syntax_kind: occ.syntax_kind,
        diagnostics: occ.diagnostics.iter().map(convert_diagnostic).collect(),
    }
}

fn convert_symbol_info(sym: &SymbolInformation) -> NapiScipSymbolInfo {
    NapiScipSymbolInfo {
        symbol: sym.symbol.clone(),
        documentation: sym.documentation.clone(),
        relationships: sym.relationships.iter().map(convert_relationship).collect(),
        kind: sym.kind,
        display_name: sym.display_name.clone(),
        signature_documentation: sym.signature_documentation.as_ref().map(|d| d.text.clone()),
        enclosing_symbol: if sym.enclosing_symbol.is_empty() {
            None
        } else {
            Some(sym.enclosing_symbol.clone())
        },
    }
}

fn convert_external_symbol(sym: &SymbolInformation) -> NapiScipExternalSymbol {
    NapiScipExternalSymbol {
        symbol: sym.symbol.clone(),
        documentation: sym.documentation.clone(),
        relationships: sym.relationships.iter().map(convert_relationship).collect(),
        kind: sym.kind,
        display_name: sym.display_name.clone(),
        signature_documentation: sym.signature_documentation.as_ref().map(|d| d.text.clone()),
    }
}

fn convert_relationship(rel: &Relationship) -> NapiScipRelationship {
    NapiScipRelationship {
        symbol: rel.symbol.clone(),
        is_reference: rel.is_reference,
        is_implementation: rel.is_implementation,
        is_type_definition: rel.is_type_definition,
        is_definition: rel.is_definition,
    }
}

/// Convert a SCIP packed range (3 or 4 elements) to an explicit range struct.
///
/// SCIP range encoding:
/// - 3 elements: [line, startCol, endCol] (single-line span)
/// - 4 elements: [startLine, startCol, endLine, endCol] (multi-line span)
fn convert_range(range: &[i32]) -> NapiScipRange {
    match range.len() {
        3 => NapiScipRange {
            start_line: range[0],
            start_col: range[1],
            end_line: range[0], // same line
            end_col: range[2],
        },
        4 => NapiScipRange {
            start_line: range[0],
            start_col: range[1],
            end_line: range[2],
            end_col: range[3],
        },
        _ => NapiScipRange {
            start_line: 0,
            start_col: 0,
            end_line: 0,
            end_col: 0,
        },
    }
}

fn convert_diagnostic(diag: &Diagnostic) -> NapiScipDiagnostic {
    NapiScipDiagnostic {
        severity: diag.severity,
        code: diag.code.clone(),
        message: diag.message.clone(),
        source: diag.source.clone(),
        // Diagnostic in SCIP proto does not have a range field;
        // the range comes from the enclosing Occurrence.
        range: None,
    }
}
