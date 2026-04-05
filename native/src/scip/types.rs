use napi_derive::napi;

#[napi(object)]
pub struct NapiScipMetadata {
    pub version: i32,
    pub tool_name: String,
    pub tool_version: String,
    pub tool_arguments: Vec<String>,
    pub project_root: String,
    pub text_document_encoding: String,
}

#[napi(object)]
pub struct NapiScipRange {
    pub start_line: i32,
    pub start_col: i32,
    pub end_line: i32,
    pub end_col: i32,
}

#[napi(object)]
pub struct NapiScipRelationship {
    pub symbol: String,
    pub is_reference: bool,
    pub is_implementation: bool,
    pub is_type_definition: bool,
    pub is_definition: bool,
}

#[napi(object)]
pub struct NapiScipDiagnostic {
    pub severity: i32,
    pub code: String,
    pub message: String,
    pub source: String,
    pub range: Option<NapiScipRange>,
}

#[napi(object)]
pub struct NapiScipOccurrence {
    pub range: NapiScipRange,
    pub symbol: String,
    pub symbol_roles: i32,
    pub override_documentation: Vec<String>,
    pub syntax_kind: i32,
    pub diagnostics: Vec<NapiScipDiagnostic>,
}

#[napi(object)]
pub struct NapiScipSymbolInfo {
    pub symbol: String,
    pub documentation: Vec<String>,
    pub relationships: Vec<NapiScipRelationship>,
    pub kind: i32,
    pub display_name: String,
    pub signature_documentation: Option<String>,
    pub enclosing_symbol: Option<String>,
}

#[napi(object)]
pub struct NapiScipDocument {
    pub language: String,
    pub relative_path: String,
    pub occurrences: Vec<NapiScipOccurrence>,
    pub symbols: Vec<NapiScipSymbolInfo>,
}

#[napi(object)]
pub struct NapiScipExternalSymbol {
    pub symbol: String,
    pub documentation: Vec<String>,
    pub relationships: Vec<NapiScipRelationship>,
    pub kind: i32,
    pub display_name: String,
    pub signature_documentation: Option<String>,
}
