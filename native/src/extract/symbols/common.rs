use tree_sitter::Node;

use crate::extract::fingerprint::generate_ast_fingerprint;
use crate::extract::symbol_id::generate_symbol_id;
use crate::types::{
    NativeParsedSymbol, NativeRange, NativeSymbolSignature, NativeSymbolSignatureParam,
};

pub struct ParamInfo {
    pub name: String,
    pub type_annotation: Option<String>,
}

pub fn node_text<'a>(node: Node<'a>, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

pub fn extract_range(node: Node<'_>) -> NativeRange {
    let start = node.start_position();
    let end = node.end_position();
    NativeRange {
        start_line: (start.row + 1) as u32,
        start_col: start.column as u32,
        end_line: (end.row + 1) as u32,
        end_col: end.column as u32,
    }
}

pub fn find_child_by_kind(parent: Node<'_>, kind: &str, source: &[u8]) -> Option<String> {
    let mut cursor = parent.walk();
    for child in parent.children(&mut cursor) {
        if child.kind() == kind {
            return Some(node_text(child, source).to_string());
        }
    }
    None
}

pub fn find_child_node<'a>(parent: Node<'a>, kind: &str) -> Option<Node<'a>> {
    let mut cursor = parent.walk();
    for child in parent.children(&mut cursor) {
        if child.kind() == kind {
            return Some(child);
        }
    }
    None
}

pub fn make_symbol(
    name: &str,
    kind: &str,
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    params: &[ParamInfo],
    returns: Option<&str>,
    generics: &[String],
    visibility: &str,
    decorators: &[String],
) -> NativeParsedSymbol {
    let fingerprint = generate_ast_fingerprint(node, source);
    let symbol_id = generate_symbol_id(repo_id, rel_path, kind, name, &fingerprint);

    let signature = build_signature(params, returns, generics);
    let range = extract_range(node);

    // Phase 1 Task 1.2: stable per-file nodeId, format `name:startLine:startCol`.
    // Must match the caller_node_id format produced by
    // `crate::extract::calls::common::make_node_id` so downstream
    // `buildSymbolIndexMaps` can join call sites to their enclosing symbols.
    let node_id = format!("{}:{}:{}", name, range.start_line, range.start_col);

    NativeParsedSymbol {
        node_id,
        symbol_id,
        ast_fingerprint: fingerprint,
        kind: kind.to_string(),
        name: name.to_string(),
        exported: false,
        visibility: visibility.to_string(),
        range,
        signature,
        summary: String::new(),
        invariants: vec![],
        side_effects: vec![],
        role_tags: vec![],
        decorators: decorators.to_vec(),
        search_text: String::new(),
        summary_quality: None,
    }
}

pub fn build_signature(
    params: &[ParamInfo],
    returns: Option<&str>,
    generics: &[String],
) -> Option<NativeSymbolSignature> {
    if params.is_empty() && returns.is_none() && generics.is_empty() {
        return None;
    }

    Some(build_signature_inner(params, returns, generics))
}

/// Like `build_signature` but always returns `Some(...)` even when the
/// signature is entirely empty. Used by callers (e.g. the TypeScript symbol
/// extractor) that need to match the TS source-of-truth exactly: TS's
/// `processFunctionDeclaration` / `processClassDeclaration` / etc. always
/// emit a `signature` object (with `params: []`) for function, method,
/// class, interface, and type declarations, even when the declaration has
/// no params, no return type, and no generics.
pub fn build_signature_forced(
    params: &[ParamInfo],
    returns: Option<&str>,
    generics: &[String],
) -> Option<NativeSymbolSignature> {
    Some(build_signature_inner(params, returns, generics))
}

fn build_signature_inner(
    params: &[ParamInfo],
    returns: Option<&str>,
    generics: &[String],
) -> NativeSymbolSignature {
    let native_params: Vec<NativeSymbolSignatureParam> = params
        .iter()
        .map(|p| NativeSymbolSignatureParam {
            name: p.name.clone(),
            type_name: p.type_annotation.clone(),
        })
        .collect();

    NativeSymbolSignature {
        params: if native_params.is_empty() {
            None
        } else {
            Some(native_params)
        },
        returns: returns.map(|s| s.to_string()),
        generics: if generics.is_empty() {
            None
        } else {
            Some(generics.to_vec())
        },
    }
}

/// Like `make_symbol` but forces an always-present signature object.
/// Matches the TS source-of-truth behaviour for function / method /
/// class / interface / type declarations: those emit a `signature`
/// object even when the declaration has no params / no return type /
/// no generics.
pub fn make_symbol_with_forced_signature(
    name: &str,
    kind: &str,
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    params: &[ParamInfo],
    returns: Option<&str>,
    generics: &[String],
    visibility: &str,
    decorators: &[String],
) -> NativeParsedSymbol {
    let mut symbol = make_symbol(
        name, kind, node, source, repo_id, rel_path, params, returns, generics, visibility,
        decorators,
    );
    symbol.signature = build_signature_forced(params, returns, generics);
    symbol
}
