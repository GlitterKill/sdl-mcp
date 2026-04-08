use tree_sitter::Node;

use crate::types::NativeParsedSymbol;

use super::common::{find_child_by_kind, find_child_node, make_symbol, node_text, ParamInfo};

pub fn extract_symbols_csharp(
    root: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Vec<NativeParsedSymbol> {
    let mut symbols = Vec::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        match node.kind() {
            "namespace_declaration" => {
                if let Some(symbol) = process_namespace_declaration(node, source, repo_id, rel_path)
                {
                    symbols.push(symbol);
                }
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
            "struct_declaration" | "record_declaration" => {
                if let Some(symbol) = process_type_like(node, source, repo_id, rel_path, "class") {
                    symbols.push(symbol);
                }
            }
            "enum_declaration" => {
                if let Some(symbol) = process_type_like(node, source, repo_id, rel_path, "type") {
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
            "property_declaration" => {
                if let Some(symbol) = process_variable_like(node, source, repo_id, rel_path) {
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

fn process_namespace_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name_node = node
        .child_by_field_name("name")
        .or_else(|| find_child_node(node, "qualified_name"))
        .or_else(|| find_child_node(node, "identifier"))?;

    let name = node_text(name_node, source).to_string();
    if name.is_empty() {
        return None;
    }

    // TS csharp.ts does NOT set visibility on namespace/module symbols.
    // Pass empty string which serializes as omitted (visibility is skipped
    // when empty by the NativeParsedSymbol serializer).
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
        "",
        &extract_decorators(node, source),
    );
    symbol.exported = true;
    Some(symbol)
}

fn process_type_like(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    kind: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_identifier(node, source)?;
    let generics = extract_type_parameters(node, source);
    let visibility = extract_visibility(node, source);
    let decorators = extract_decorators(node, source);

    // TS csharp.ts emits signature for class/interface/struct/record but NOT
    // for enum (which maps to kind "type" here). Force signature only for
    // the class-like kinds.
    let mut symbol = if kind == "type" {
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
            &decorators,
        )
    } else {
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
            &decorators,
        )
    };
    symbol.exported = visibility == "public";
    Some(symbol)
}

fn process_method_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_identifier(node, source)?;
    let visibility = extract_visibility(node, source);
    let modifiers = extract_modifiers(node, source);
    let params = extract_parameters(node, source);
    let mut returns = extract_return_type(node, source);

    if returns.is_none() {
        returns = if modifiers.iter().any(|m| m == "async") {
            Some("Task".to_string())
        } else {
            Some("void".to_string())
        };
    }

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
    symbol.exported = visibility == "public";
    Some(symbol)
}

fn process_constructor_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let visibility = extract_visibility(node, source);
    let params = extract_parameters(node, source);

    // TS always emits signature for constructor; force it here.
    let mut symbol = super::common::make_symbol_with_forced_signature(
        "constructor",
        "constructor",
        node,
        source,
        repo_id,
        rel_path,
        &params,
        None,
        &[],
        &visibility,
        &extract_decorators(node, source),
    );
    symbol.exported = visibility == "public";
    Some(symbol)
}

fn process_variable_like(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_identifier(node, source)?;
    let visibility = extract_visibility(node, source);

    let mut symbol = make_symbol(
        &name,
        "variable",
        node,
        source,
        repo_id,
        rel_path,
        &[],
        None,
        &[],
        &visibility,
        &extract_decorators(node, source),
    );
    symbol.exported = visibility == "public";
    Some(symbol)
}

fn extract_identifier(node: Node<'_>, source: &[u8]) -> Option<String> {
    if node.kind() == "identifier" {
        let text = node_text(node, source).to_string();
        if !text.is_empty() {
            return Some(text);
        }
    }

    let mut stack = vec![node];
    while let Some(current) = stack.pop() {
        if current.kind() == "identifier" {
            let text = node_text(current, source).to_string();
            if !text.is_empty() {
                return Some(text);
            }
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

fn extract_visibility(node: Node<'_>, source: &[u8]) -> String {
    let Some(modifiers) = find_child_node(node, "modifiers") else {
        return String::new();
    };

    let mut cursor = modifiers.walk();
    for child in modifiers.children(&mut cursor) {
        if child.kind() == "accessibility_modifier" {
            let text = node_text(child, source);
            if matches!(text, "public" | "private" | "protected" | "internal") {
                return text.to_string();
            }
        }
    }

    String::new()
}

fn extract_modifiers(node: Node<'_>, source: &[u8]) -> Vec<String> {
    let Some(modifiers) = find_child_node(node, "modifiers") else {
        return Vec::new();
    };

    let mut out = Vec::new();
    let mut cursor = modifiers.walk();
    for child in modifiers.children(&mut cursor) {
        let text = node_text(child, source);
        if !text.is_empty() {
            out.push(text.to_string());
        }
    }
    out
}

fn extract_type_parameters(node: Node<'_>, source: &[u8]) -> Vec<String> {
    let Some(type_params) = find_child_node(node, "type_parameter_list") else {
        return Vec::new();
    };

    let mut generics = Vec::new();
    let mut cursor = type_params.walk();
    for child in type_params.children(&mut cursor) {
        if child.kind() == "type_parameter" {
            let text = node_text(child, source).to_string();
            if !text.is_empty() {
                generics.push(text);
            }
        }
    }
    generics
}

fn extract_parameters(node: Node<'_>, source: &[u8]) -> Vec<ParamInfo> {
    let Some(param_list) = find_child_node(node, "parameter_list") else {
        return Vec::new();
    };

    let mut params = Vec::new();
    let mut cursor = param_list.walk();
    for child in param_list.children(&mut cursor) {
        if child.kind() != "parameter" {
            continue;
        }

        let name = extract_identifier(child, source);
        if let Some(name) = name {
            let type_annotation = find_child_by_kind(child, "type", source).and_then(|t| {
                if t.is_empty() {
                    None
                } else {
                    Some(t)
                }
            });

            params.push(ParamInfo {
                name,
                type_annotation,
            });
        }
    }

    params
}

fn extract_return_type(node: Node<'_>, source: &[u8]) -> Option<String> {
    find_child_by_kind(node, "type", source)
        .and_then(|ret| if ret.is_empty() { None } else { Some(ret) })
}

fn extract_decorators(node: Node<'_>, source: &[u8]) -> Vec<String> {
    let mut decorators = Vec::new();
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "attribute_list" {
            decorators.push(node_text(child, source).to_string());
        }
    }
    decorators
}
