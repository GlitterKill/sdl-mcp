use tree_sitter::Node;

use crate::types::NativeParsedSymbol;

use super::common::{
    find_child_node, make_symbol, make_symbol_with_forced_signature, node_text, ParamInfo,
};

pub fn extract_symbols_python(
    root: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Vec<NativeParsedSymbol> {
    let mut symbols = Vec::new();
    traverse_symbols(root, source, repo_id, rel_path, None, &mut symbols);

    symbols
}

fn traverse_symbols(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    parent_class: Option<&str>,
    symbols: &mut Vec<NativeParsedSymbol>,
) {
    match node.kind() {
        "function_definition" => {
            if let Some(symbol) =
                process_function_definition(node, source, repo_id, rel_path, parent_class)
            {
                symbols.push(symbol);
            }
        }
        "class_definition" => {
            let class_name = node
                .child_by_field_name("name")
                .map(|name_node| node_text(name_node, source).to_string());
            if let Some(symbol) = process_class_definition(node, source, repo_id, rel_path) {
                symbols.push(symbol);
            }

            // Match the TypeScript Python adapter: class bodies are traversed
            // with the current class name so contained function_definition
            // nodes become method symbols with owner-qualified names.
            traverse_child_symbols(
                node,
                source,
                repo_id,
                rel_path,
                class_name.as_deref().or(parent_class),
                symbols,
            );
            return;
        }
        "assignment" => {
            if let Some(symbol) = process_assignment(node, source, repo_id, rel_path) {
                symbols.push(symbol);
            }
        }
        _ => {}
    }

    traverse_child_symbols(node, source, repo_id, rel_path, parent_class, symbols);
}

fn traverse_child_symbols(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    parent_class: Option<&str>,
    symbols: &mut Vec<NativeParsedSymbol>,
) {
    let child_count = node.child_count();
    for i in 0..child_count {
        if let Some(child) = node.child(i) {
            traverse_symbols(child, source, repo_id, rel_path, parent_class, symbols);
        }
    }
}

fn process_function_definition(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    parent_class: Option<&str>,
) -> Option<NativeParsedSymbol> {
    let name_node = node.child_by_field_name("name")?;
    let name = node_text(name_node, source).to_string();
    let qualified_name = parent_class
        .map(|class_name| format!("{class_name}.{name}"))
        .unwrap_or_else(|| name.clone());
    let kind = if parent_class.is_some() {
        "method"
    } else {
        "function"
    };

    let params = extract_parameters(node, source);
    let returns = node
        .child_by_field_name("return_type")
        .map(|n| node_text(n, source).to_string());
    let decorators = extract_decorators(node, source);
    let visibility = extract_visibility(&name);

    let mut symbol = make_symbol_with_forced_signature(
        &qualified_name,
        kind,
        node,
        source,
        repo_id,
        rel_path,
        &params,
        returns.as_deref(),
        &[],
        &visibility,
        &decorators,
    );
    symbol.exported = !name.starts_with('_');
    Some(symbol)
}

fn process_class_definition(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name_node = node.child_by_field_name("name")?;
    let name = node_text(name_node, source).to_string();
    let visibility = extract_visibility(&name);
    let decorators = extract_decorators(node, source);

    let mut symbol = make_symbol_with_forced_signature(
        &name,
        "class",
        node,
        source,
        repo_id,
        rel_path,
        &[],
        None,
        &[],
        &visibility,
        &decorators,
    );
    symbol.exported = !name.starts_with('_');
    Some(symbol)
}

fn process_assignment(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let left = node.child_by_field_name("left")?;
    if left.kind() != "identifier" {
        return None;
    }

    let name = node_text(left, source).to_string();
    let visibility = extract_visibility(&name);

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
    symbol.exported = !name.starts_with('_');
    Some(symbol)
}

fn extract_parameters(node: Node<'_>, source: &[u8]) -> Vec<ParamInfo> {
    let mut params = Vec::new();
    let Some(parameters_node) = node.child_by_field_name("parameters") else {
        return params;
    };

    let mut cursor = parameters_node.walk();
    for child in parameters_node.children(&mut cursor) {
        match child.kind() {
            "identifier" => {
                params.push(ParamInfo {
                    name: node_text(child, source).to_string(),
                    type_annotation: None,
                });
            }
            "list_splat_pattern" => {
                if let Some(identifier) = find_child_node(child, "identifier") {
                    params.push(ParamInfo {
                        name: format!("*{}", node_text(identifier, source)),
                        type_annotation: None,
                    });
                }
            }
            "dictionary_splat_pattern" => {
                if let Some(identifier) = find_child_node(child, "identifier") {
                    params.push(ParamInfo {
                        name: format!("**{}", node_text(identifier, source)),
                        type_annotation: None,
                    });
                }
            }
            _ => {
                let identifier = find_child_node(child, "identifier");
                if let Some(identifier) = identifier {
                    let type_annotation = find_child_node(child, "type")
                        .map(|type_node| node_text(type_node, source).to_string());
                    params.push(ParamInfo {
                        name: node_text(identifier, source).to_string(),
                        type_annotation,
                    });
                }
            }
        }
    }

    params
}

fn extract_decorators(node: Node<'_>, source: &[u8]) -> Vec<String> {
    let mut decorators = Vec::new();
    let Some(decorators_node) = node.child_by_field_name("decorators") else {
        return decorators;
    };

    let mut cursor = decorators_node.walk();
    for child in decorators_node.children(&mut cursor) {
        if child.kind() == "decorator" {
            decorators.push(node_text(child, source).to_string());
        }
    }

    decorators
}

fn extract_visibility(name: &str) -> String {
    if name.starts_with('_') {
        "private".to_string()
    } else {
        "public".to_string()
    }
}
