use tree_sitter::Node;

use crate::types::NativeParsedSymbol;

use super::common::{find_child_node, make_symbol, node_text, ParamInfo};

pub fn extract_symbols_c(
    root: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Vec<NativeParsedSymbol> {
    let mut symbols = Vec::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        match node.kind() {
            "function_definition" => {
                if let Some(symbol) = process_function_definition(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "struct_specifier" => {
                if let Some(symbol) = process_struct_specifier(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "enum_specifier" => {
                if let Some(symbol) = process_enum_specifier(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "type_definition" => {
                if let Some(symbol) = process_type_definition(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            _ => {}
        }

        let child_count = node.child_count();
        for i in (0..child_count).rev() {
            if let Some(child) = node.child(i) {
                stack.push(child);
            }
        }
    }

    symbols
}

fn process_function_definition(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let declarator = node.child_by_field_name("declarator")?;
    let name_node = find_identifier_in_declarator(declarator)?;
    let name = node_text(name_node, source).to_string();
    if name.is_empty() {
        return None;
    }

    let params = extract_function_params(declarator, source);
    let returns = extract_return_type(node, source);

    let mut symbol = make_symbol(
        &name,
        "function",
        node,
        source,
        repo_id,
        rel_path,
        &params,
        returns.as_deref(),
        &[],
        "public",
        &[],
    );
    symbol.exported = true;
    Some(symbol)
}

fn process_struct_specifier(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    // TS source-of-truth (src/indexer/adapter/c.ts) does NOT require body;
    // it only reads the 'name' field. Match that so forward-declared
    // struct references in typedefs still emit a class symbol.
    let name_node = node.child_by_field_name("name")?;
    if name_node.kind() != "type_identifier" {
        return None;
    }

    let name = node_text(name_node, source).to_string();
    if name.is_empty() {
        return None;
    }

    // TS always emits signature with params: members (possibly empty).
    // Force signature emission to match TS shape.
    let mut symbol = super::common::make_symbol_with_forced_signature(
        &name,
        "class",
        node,
        source,
        repo_id,
        rel_path,
        &[],
        None,
        &[],
        "public",
        &[],
    );
    symbol.exported = true;
    Some(symbol)
}

fn process_enum_specifier(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name_node = node.child_by_field_name("name")?;
    if name_node.kind() != "type_identifier" {
        return None;
    }

    let name = node_text(name_node, source).to_string();
    if name.is_empty() {
        return None;
    }

    // TS always emits signature with params: enumValues (possibly empty).
    let mut symbol = super::common::make_symbol_with_forced_signature(
        &name,
        "class",
        node,
        source,
        repo_id,
        rel_path,
        &[],
        None,
        &[],
        "public",
        &[],
    );
    symbol.exported = true;
    Some(symbol)
}

fn process_type_definition(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name_node = find_child_node(node, "type_identifier")
        .or_else(|| find_identifier_in_declarator(node))
        .or_else(|| {
            node.child_by_field_name("declarator")
                .and_then(find_identifier_in_declarator)
        })?;

    let name = node_text(name_node, source).to_string();
    if name.is_empty() {
        return None;
    }

    let mut symbol = make_symbol(
        &name,
        "type",
        node,
        source,
        repo_id,
        rel_path,
        &[],
        None,
        &[],
        "public",
        &[],
    );
    symbol.exported = true;
    Some(symbol)
}


fn find_identifier_in_declarator(node: Node<'_>) -> Option<Node<'_>> {
    if matches!(node.kind(), "identifier" | "type_identifier") {
        return Some(node);
    }

    let mut stack = vec![node];
    while let Some(current) = stack.pop() {
        if matches!(current.kind(), "identifier" | "type_identifier") {
            return Some(current);
        }

        let child_count = current.child_count();
        for i in (0..child_count).rev() {
            if let Some(child) = current.child(i) {
                if child.kind() != "parameter_list" {
                    stack.push(child);
                }
            }
        }
    }

    None
}

fn find_function_declarator(node: Node<'_>) -> Option<Node<'_>> {
    if node.kind() == "function_declarator" {
        return Some(node);
    }

    let mut stack = vec![node];
    while let Some(current) = stack.pop() {
        if current.kind() == "function_declarator" {
            return Some(current);
        }

        let child_count = current.child_count();
        for i in (0..child_count).rev() {
            if let Some(child) = current.child(i) {
                stack.push(child);
            }
        }
    }

    None
}

fn extract_function_params(declarator: Node<'_>, source: &[u8]) -> Vec<ParamInfo> {
    let mut params = Vec::new();
    // Match TS extractParameters: declarator.childForFieldName("parameters")
    // directly, with no recursion through pointer_declarator. Functions that
    // return pointers (e.g. void *f(size_t)) therefore yield no params to
    // mirror the TS source-of-truth output.
    let Some(parameter_list) = declarator.child_by_field_name("parameters") else {
        return params;
    };

    let mut cursor = parameter_list.walk();
    for child in parameter_list.children(&mut cursor) {
        if child.kind() != "parameter_declaration" {
            continue;
        }

        let Some(decl) = child.child_by_field_name("declarator") else {
            continue;
        };
        let Some(identifier) = find_identifier_in_declarator(decl) else {
            continue;
        };

        let name = node_text(identifier, source).to_string();
        if name.is_empty() {
            continue;
        }

        let mut type_text = None;
        let mut decl_cursor = child.walk();
        for decl_child in child.children(&mut decl_cursor) {
            if decl_child.kind() != "declarator" {
                let text = node_text(decl_child, source).trim().to_string();
                if !text.is_empty() {
                    type_text = Some(text);
                    break;
                }
            }
        }

        params.push(ParamInfo {
            name,
            type_annotation: type_text,
        });
    }

    params
}

fn extract_return_type(node: Node<'_>, source: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if is_type_like_child(child.kind()) {
            let text = node_text(child, source).trim().to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }

    None
}

fn is_type_like_child(kind: &str) -> bool {
    matches!(
        kind,
        "primitive_type"
            | "type_identifier"
            | "sized_type_specifier"
            | "struct_specifier"
            | "union_specifier"
            | "enum_specifier"
            | "macro_type_specifier"
            | "type_qualifier"
    )
}
