use tree_sitter::Node;

use crate::types::NativeParsedSymbol;

use super::common::{find_child_by_kind, find_child_node, make_symbol, node_text, ParamInfo};

pub fn extract_symbols_php(
    root: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Vec<NativeParsedSymbol> {
    let mut symbols = Vec::new();
    let mut stack = vec![root];
    let mut current_namespace: Option<String> = None;

    while let Some(node) = stack.pop() {
        match node.kind() {
            "namespace_definition" => {
                process_namespace_definition(
                    node,
                    source,
                    repo_id,
                    rel_path,
                    &mut current_namespace,
                    &mut symbols,
                );
            }
            "class_declaration" => {
                if let Some(symbol) = process_type_like(
                    node,
                    source,
                    repo_id,
                    rel_path,
                    "class",
                    current_namespace.as_deref(),
                    false,
                ) {
                    symbols.push(symbol);
                }
            }
            "interface_declaration" => {
                if let Some(symbol) = process_type_like(
                    node,
                    source,
                    repo_id,
                    rel_path,
                    "interface",
                    current_namespace.as_deref(),
                    false,
                ) {
                    symbols.push(symbol);
                }
            }
            "trait_declaration" => {
                if let Some(symbol) = process_type_like(
                    node,
                    source,
                    repo_id,
                    rel_path,
                    "class",
                    current_namespace.as_deref(),
                    true,
                ) {
                    symbols.push(symbol);
                }
            }
            "method_declaration" => {
                if let Some(symbol) = process_method_declaration(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "function_definition" => {
                if let Some(symbol) = process_function_definition(
                    node,
                    source,
                    repo_id,
                    rel_path,
                    current_namespace.as_deref(),
                ) {
                    symbols.push(symbol);
                }
            }
            "property_declaration" => {
                process_property_declaration(node, source, repo_id, rel_path, &mut symbols);
            }
            "const_declaration" => {
                process_const_declaration(node, source, repo_id, rel_path, &mut symbols);
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

fn process_namespace_definition(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    current_namespace: &mut Option<String>,
    symbols: &mut Vec<NativeParsedSymbol>,
) {
    let namespace_node = node
        .child_by_field_name("name")
        .or_else(|| find_child_node(node, "namespace_name"))
        .or_else(|| find_child_node(node, "qualified_name"))
        .or_else(|| find_child_node(node, "name"));

    let Some(namespace_node) = namespace_node else {
        return;
    };

    let namespace = node_text(namespace_node, source).trim().to_string();
    if namespace.is_empty() {
        return;
    }

    *current_namespace = Some(namespace.clone());

    let mut symbol = make_symbol(
        &namespace,
        "module",
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
    symbols.push(symbol);
}

fn process_type_like(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    kind: &str,
    current_namespace: Option<&str>,
    is_trait: bool,
) -> Option<NativeParsedSymbol> {
    let name = extract_name(node, source)?;
    let fq_name = if let Some(namespace) = current_namespace {
        format!(r"{namespace}\{name}")
    } else {
        name.clone()
    };

    let visibility = if name.starts_with('_') {
        "private".to_string()
    } else {
        "public".to_string()
    };

    let mut symbol = make_symbol(
        &fq_name,
        kind,
        node,
        source,
        repo_id,
        rel_path,
        &[],
        None,
        &[],
        &visibility,
        &[],
    );
    symbol.exported = true;

    if is_trait {
        symbol.role_tags.push("trait".to_string());
    }

    Some(symbol)
}

fn process_method_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = extract_name(node, source)?;
    let params = extract_parameters(node, source);
    let returns = extract_return_type(node, source);
    let visibility = extract_visibility(node, source).unwrap_or_else(|| "public".to_string());

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
        &[],
    );
    symbol.exported = visibility != "private";
    Some(symbol)
}

fn process_function_definition(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    current_namespace: Option<&str>,
) -> Option<NativeParsedSymbol> {
    let name = extract_name(node, source)?;
    let fq_name = if let Some(namespace) = current_namespace {
        format!(r"{namespace}\{name}")
    } else {
        name.clone()
    };

    let params = extract_parameters(node, source);
    let returns = extract_return_type(node, source);
    let visibility = if name.starts_with('_') {
        "private".to_string()
    } else {
        "public".to_string()
    };

    let mut symbol = make_symbol(
        &fq_name,
        "function",
        node,
        source,
        repo_id,
        rel_path,
        &params,
        returns.as_deref(),
        &[],
        &visibility,
        &[],
    );
    symbol.exported = !name.starts_with('_');
    Some(symbol)
}

fn process_property_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    symbols: &mut Vec<NativeParsedSymbol>,
) {
    let properties = extract_property_names(node, source);
    let visibility = extract_visibility(node, source).unwrap_or_else(|| "public".to_string());

    for property in properties {
        let normalized = property.trim_start_matches('$');
        let property_visibility = if normalized.starts_with('_') {
            "private".to_string()
        } else {
            visibility.clone()
        };

        let mut symbol = make_symbol(
            &property,
            "variable",
            node,
            source,
            repo_id,
            rel_path,
            &[],
            None,
            &[],
            &property_visibility,
            &[],
        );
        symbol.exported = property_visibility != "private";
        symbols.push(symbol);
    }
}

fn process_const_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    symbols: &mut Vec<NativeParsedSymbol>,
) {
    let constants = extract_constant_names(node, source);
    let visibility = extract_visibility(node, source).unwrap_or_else(|| "public".to_string());

    for constant in constants {
        let mut symbol = make_symbol(
            &constant,
            "variable",
            node,
            source,
            repo_id,
            rel_path,
            &[],
            None,
            &[],
            &visibility,
            &[],
        );
        symbol.exported = visibility != "private";
        symbols.push(symbol);
    }
}

fn extract_name(node: Node<'_>, source: &[u8]) -> Option<String> {
    let name_node = node
        .child_by_field_name("name")
        .or_else(|| find_child_node(node, "name"));
    let name = name_node
        .map(|n| node_text(n, source).to_string())
        .unwrap_or_default();
    (!name.is_empty()).then_some(name)
}

fn extract_parameters(node: Node<'_>, source: &[u8]) -> Vec<ParamInfo> {
    let parameters_node = node
        .child_by_field_name("formal_parameters")
        .or_else(|| find_child_node(node, "formal_parameters"));
    let Some(parameters_node) = parameters_node else {
        return Vec::new();
    };

    let mut params = Vec::new();
    let mut cursor = parameters_node.walk();
    for child in parameters_node.children(&mut cursor) {
        if child.kind() != "simple_parameter" {
            continue;
        }

        let name = child
            .child_by_field_name("name")
            .and_then(|n| extract_variable_name(n, source));
        let Some(name) = name else {
            continue;
        };

        let type_annotation = extract_parameter_type(child, source);
        params.push(ParamInfo {
            name,
            type_annotation,
        });
    }

    params
}

fn extract_variable_name(node: Node<'_>, source: &[u8]) -> Option<String> {
    if node.kind() == "variable_name" {
        if let Some(inner_name) = find_child_by_kind(node, "name", source) {
            return (!inner_name.is_empty()).then_some(inner_name);
        }
        let raw = node_text(node, source).to_string();
        let trimmed = raw.trim_start_matches('$').to_string();
        return (!trimmed.is_empty()).then_some(trimmed);
    }

    if node.kind() == "name" {
        let text = node_text(node, source).to_string();
        return (!text.is_empty()).then_some(text);
    }

    None
}

fn extract_parameter_type(node: Node<'_>, source: &[u8]) -> Option<String> {
    if let Some(type_node) = node.child_by_field_name("type") {
        let text = node_text(type_node, source).to_string();
        if !text.is_empty() {
            return Some(text);
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if matches!(
            child.kind(),
            "primitive_type" | "named_type" | "union_type" | "optional_type"
        ) {
            let text = node_text(child, source).to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }

    None
}

fn extract_return_type(node: Node<'_>, source: &[u8]) -> Option<String> {
    let return_type = node
        .child_by_field_name("return_type")
        .or_else(|| find_child_node(node, "return_type"));
    let text = return_type
        .map(|n| node_text(n, source).to_string())
        .unwrap_or_default();
    (!text.is_empty()).then_some(text)
}

fn extract_visibility(node: Node<'_>, source: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() != "visibility_modifier" {
            continue;
        }

        let text = node_text(child, source);
        if text == "public" || text == "private" || text == "protected" {
            return Some(text.to_string());
        }
        return Some("public".to_string());
    }

    None
}

fn extract_property_names(node: Node<'_>, source: &[u8]) -> Vec<String> {
    let mut names = Vec::new();
    let mut cursor = node.walk();

    for child in node.children(&mut cursor) {
        if child.kind() != "property_element" {
            continue;
        }

        let Some(variable_node) = find_child_node(child, "variable_name") else {
            continue;
        };

        let Some(name) = extract_variable_name(variable_node, source) else {
            continue;
        };

        names.push(format!("${name}"));
    }

    names
}

fn extract_constant_names(node: Node<'_>, source: &[u8]) -> Vec<String> {
    let mut names = Vec::new();
    let mut cursor = node.walk();

    for child in node.children(&mut cursor) {
        if child.kind() != "const_element" {
            continue;
        }

        if let Some(name) = find_child_by_kind(child, "name", source) {
            if !name.is_empty() {
                names.push(name);
            }
        }
    }

    names
}
