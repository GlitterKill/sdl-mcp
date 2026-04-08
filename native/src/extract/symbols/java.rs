use tree_sitter::Node;

use crate::types::NativeParsedSymbol;

use super::common::{find_child_node, make_symbol, node_text, ParamInfo};

pub fn extract_symbols_java(
    root: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Vec<NativeParsedSymbol> {
    let mut symbols = Vec::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        match node.kind() {
            "package_declaration" => {
                process_package_declaration(node, source, repo_id, rel_path, &mut symbols)
            }
            "class_declaration" => {
                if let Some(symbol) = process_type_like(node, source, repo_id, rel_path, "class") {
                    symbols.push(symbol);
                }
            }
            "interface_declaration" => {
                if let Some(symbol) =
                    process_type_like(node, source, repo_id, rel_path, "interface")
                {
                    symbols.push(symbol);
                }
            }
            "enum_declaration" | "record_declaration" => {
                if let Some(symbol) = process_type_like(node, source, repo_id, rel_path, "class") {
                    symbols.push(symbol);
                }
            }
            "annotation_type_declaration" => {
                if let Some(symbol) =
                    process_type_like(node, source, repo_id, rel_path, "interface")
                {
                    symbols.push(symbol);
                }
            }
            "method_declaration" => {
                if let Some(symbol) = process_method_declaration(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "constructor_declaration" => {
                if let Some(symbol) =
                    process_constructor_declaration(node, source, repo_id, rel_path)
                {
                    symbols.push(symbol);
                }
            }
            "field_declaration" => {
                process_field_declaration(node, source, repo_id, rel_path, &mut symbols);
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

fn process_package_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    symbols: &mut Vec<NativeParsedSymbol>,
) {
    let package_node =
        find_child_node(node, "scoped_identifier").or_else(|| find_child_node(node, "identifier"));
    let Some(package_node) = package_node else {
        return;
    };

    let name = node_text(package_node, source).to_string();
    if name.is_empty() {
        return;
    }

    let mut symbol = make_symbol(
        &name,
        "module",
        node,
        source,
        repo_id,
        rel_path,
        &[],
        None,
        &[],
        "public",
        &extract_decorators(node, source),
    );
    symbol.exported = true;
    symbols.push(symbol);
}

fn process_type_like(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    kind: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_identifier(node, source)?;
    let generics = extract_generics(node, source);
    let visibility = extract_visibility(node, source);

    // TS java.ts emits signature for class_declaration and
    // interface_declaration but NOT for enum_declaration /
    // record_declaration / annotation_type_declaration.
    let should_force_signature = matches!(
        node.kind(),
        "class_declaration" | "interface_declaration"
    );

    let mut symbol = if should_force_signature {
        super::common::make_symbol_with_forced_signature(
            &name,
            kind,
            node,
            source,
            repo_id,
            rel_path,
            &[],
            None,
            &generics,
            &visibility,
            &[],
        )
    } else {
        make_symbol(
            &name,
            kind,
            node,
            source,
            repo_id,
            rel_path,
            &[],
            None,
            &generics,
            &visibility,
            &[],
        )
    };
    symbol.exported = is_public(node);
    Some(symbol)
}

fn process_method_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_identifier(node, source)?;
    let params = extract_parameters(node, source);
    let returns = extract_return_type(node, source);
    let visibility = extract_visibility(node, source);

    let mut symbol = make_symbol(
        &name,
        "method",
        node,
        source,
        repo_id,
        rel_path,
        &params,
        returns.as_deref(),
        &[],
        &visibility,
        &extract_decorators(node, source),
    );
    symbol.exported = is_public(node);
    Some(symbol)
}

fn process_constructor_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_identifier(node, source)?;
    let params = extract_parameters(node, source);
    let visibility = extract_visibility(node, source);

    let mut symbol = make_symbol(
        &name,
        "constructor",
        node,
        source,
        repo_id,
        rel_path,
        &params,
        Some(&name),
        &[],
        &visibility,
        &extract_decorators(node, source),
    );
    symbol.exported = is_public(node);
    Some(symbol)
}

fn process_field_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    symbols: &mut Vec<NativeParsedSymbol>,
) {
    let visibility = extract_visibility(node, source);

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() != "variable_declarator" {
            continue;
        }

        let Some(name_node) = find_child_node(child, "identifier") else {
            continue;
        };
        let name = node_text(name_node, source).to_string();
        if name.is_empty() {
            continue;
        }

        let mut symbol = make_symbol(
            &name,
            "variable",
            child,
            source,
            repo_id,
            rel_path,
            &[],
            None,
            &[],
            &visibility,
            &extract_decorators(child, source),
        );
        symbol.exported = false;
        symbols.push(symbol);
    }
}

fn extract_identifier(node: Node<'_>, source: &[u8]) -> Option<String> {
    if node.kind() == "identifier" {
        let text = node_text(node, source).to_string();
        return (!text.is_empty()).then_some(text);
    }

    find_child_node(node, "identifier")
        .map(|identifier| node_text(identifier, source).to_string())
        .filter(|text| !text.is_empty())
}

fn extract_visibility(node: Node<'_>, source: &[u8]) -> String {
    // TS java.ts treats the absence of a modifier (Java package-private) as
    // "public" for parity with other language adapters.
    let Some(modifiers) = find_child_node(node, "modifiers") else {
        return "public".to_string();
    };

    let mut cursor = modifiers.walk();
    for child in modifiers.children(&mut cursor) {
        match child.kind() {
            "public" | "private" | "protected" => {
                return node_text(child, source).to_string();
            }
            _ => {}
        }
    }

    // No explicit modifier among the modifiers node (only annotations etc.).
    // Default to public to match TS source-of-truth.
    "public".to_string()
}

fn is_public(node: Node<'_>) -> bool {
    // TS java.ts treats absence of explicit visibility as exported (public).
    let Some(modifiers) = find_child_node(node, "modifiers") else {
        return true;
    };

    let mut cursor = modifiers.walk();
    let found_public = modifiers
        .children(&mut cursor)
        .any(|child| child.kind() == "public");
    found_public
}

fn extract_generics(node: Node<'_>, source: &[u8]) -> Vec<String> {
    let Some(type_params) = find_child_node(node, "type_parameters") else {
        return Vec::new();
    };

    let mut generics = Vec::new();
    let mut cursor = type_params.walk();
    for child in type_params.children(&mut cursor) {
        if child.kind() == "type_identifier" {
            generics.push(node_text(child, source).to_string());
        }
    }

    generics
}

fn extract_parameters(node: Node<'_>, source: &[u8]) -> Vec<ParamInfo> {
    let Some(formal_params) = find_child_node(node, "formal_parameters") else {
        return Vec::new();
    };

    let mut params = Vec::new();
    let mut cursor = formal_params.walk();

    for child in formal_params.children(&mut cursor) {
        if child.kind() != "formal_parameter" {
            continue;
        }

        let Some(identifier) = find_child_node(child, "identifier") else {
            continue;
        };

        // TS java.ts extracts type only for non-primitive reference types
        // (type_identifier / scoped_type_identifier). Primitive types
        // (integral_type, floating_point_type, etc.) are not extracted.
        let type_annotation = extract_reference_parameter_type(child, source);
        params.push(ParamInfo {
            name: node_text(identifier, source).to_string(),
            type_annotation,
        });
    }

    params
}

fn extract_reference_parameter_type(node: Node<'_>, source: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "type_identifier"
            | "scoped_type_identifier"
            | "generic_type"
            | "array_type" => {
                let text = node_text(child, source).to_string();
                if !text.is_empty() {
                    return Some(text);
                }
            }
            _ => {}
        }
    }
    None
}

#[allow(dead_code)]
fn extract_parameter_type(node: Node<'_>, source: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "identifier" {
            continue;
        }
        if is_java_type_node(child.kind()) {
            let text = node_text(child, source).to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }

    None
}

fn extract_return_type(node: Node<'_>, source: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if is_java_type_node(child.kind()) {
            let text = node_text(child, source).to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }

    None
}

fn is_java_type_node(kind: &str) -> bool {
    matches!(
        kind,
        "type_identifier"
            | "generic_type"
            | "void_type"
            | "integral_type"
            | "floating_point_type"
            | "boolean_type"
            | "scoped_type_identifier"
            | "array_type"
    )
}

fn extract_decorators(_node: Node<'_>, _source: &[u8]) -> Vec<String> {
    // TS java.ts does NOT emit decorators for Java declarations.
    Vec::new()
}
