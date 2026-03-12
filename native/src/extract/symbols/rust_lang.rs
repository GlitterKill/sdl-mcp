use tree_sitter::Node;

use crate::types::NativeParsedSymbol;

use super::common::{find_child_node, make_symbol, node_text, ParamInfo};

pub fn extract_symbols_rust(
    root: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Vec<NativeParsedSymbol> {
    let mut symbols = Vec::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        let mut skip_children = false;

        match node.kind() {
            "function_item" => {
                if let Some(symbol) = process_function_item(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "struct_item" => {
                if let Some(symbol) = process_struct_item(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "enum_item" => {
                if let Some(symbol) = process_enum_item(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "trait_item" => {
                if let Some(symbol) = process_trait_item(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "type_item" => {
                if let Some(symbol) = process_type_item(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "const_item" => {
                if let Some(symbol) = process_variable_item(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "static_item" => {
                if let Some(symbol) = process_variable_item(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "mod_item" => {
                if let Some(symbol) = process_module_item(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "impl_item" => {
                process_impl_item(node, source, repo_id, rel_path, &mut symbols);
                skip_children = true;
            }
            _ => {}
        }

        if skip_children {
            continue;
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

fn process_function_item(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name_node = node.child_by_field_name("name")?;
    let name = node_text(name_node, source).to_string();
    if name.is_empty() {
        return None;
    }

    let params = extract_function_parameters(node, source);
    let returns = extract_function_return_type(node, source);
    let generics = extract_generics(node, source);
    let visibility = extract_visibility(node, source);

    let mut symbol = make_symbol(
        &name,
        "function",
        node,
        source,
        repo_id,
        rel_path,
        &params,
        returns.as_deref(),
        &generics,
        &visibility,
        &[],
    );
    symbol.exported = visibility == "public";
    Some(symbol)
}

fn process_struct_item(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name_node = node.child_by_field_name("name")?;
    let name = node_text(name_node, source).to_string();
    if name.is_empty() {
        return None;
    }

    let fields = extract_struct_fields(node, source);
    let generics = extract_generics(node, source);
    let visibility = extract_visibility(node, source);

    let mut symbol = make_symbol(
        &name,
        "class",
        node,
        source,
        repo_id,
        rel_path,
        &fields,
        None,
        &generics,
        &visibility,
        &[],
    );
    symbol.exported = visibility == "public";
    Some(symbol)
}

fn process_enum_item(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name_node = node.child_by_field_name("name")?;
    let name = node_text(name_node, source).to_string();
    if name.is_empty() {
        return None;
    }

    let variants = extract_enum_variants(node, source);
    let generics = extract_generics(node, source);
    let visibility = extract_visibility(node, source);

    let mut symbol = make_symbol(
        &name,
        "type",
        node,
        source,
        repo_id,
        rel_path,
        &variants,
        None,
        &generics,
        &visibility,
        &[],
    );
    symbol.exported = visibility == "public";
    Some(symbol)
}

fn process_trait_item(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name_node = node.child_by_field_name("name")?;
    let name = node_text(name_node, source).to_string();
    if name.is_empty() {
        return None;
    }

    let generics = extract_generics(node, source);
    let visibility = extract_visibility(node, source);

    let mut symbol = make_symbol(
        &name,
        "interface",
        node,
        source,
        repo_id,
        rel_path,
        &[],
        None,
        &generics,
        &visibility,
        &[],
    );
    symbol.exported = visibility == "public";
    Some(symbol)
}

fn process_type_item(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let has_type_keyword = {
        let mut cursor = node.walk();
        let found = node
            .children(&mut cursor)
            .any(|child| child.kind() == "type");
        found
    };
    if !has_type_keyword {
        return None;
    }

    let name_node = node.child_by_field_name("name")?;
    let name = node_text(name_node, source).to_string();
    if name.is_empty() {
        return None;
    }

    let generics = extract_generics(node, source);
    let visibility = extract_visibility(node, source);

    let mut symbol = make_symbol(
        &name,
        "type",
        node,
        source,
        repo_id,
        rel_path,
        &[],
        None,
        &generics,
        &visibility,
        &[],
    );
    symbol.exported = visibility == "public";
    Some(symbol)
}

fn process_variable_item(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name_node = node.child_by_field_name("name")?;
    let name = node_text(name_node, source).to_string();
    if name.is_empty() {
        return None;
    }

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
        &[],
    );
    symbol.exported = visibility == "public";
    Some(symbol)
}

fn process_module_item(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name_node = node.child_by_field_name("name")?;
    let name = node_text(name_node, source).to_string();
    if name.is_empty() {
        return None;
    }

    let visibility = extract_visibility(node, source);

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
        &visibility,
        &[],
    );
    symbol.exported = visibility == "public";
    Some(symbol)
}

fn process_impl_item(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    symbols: &mut Vec<NativeParsedSymbol>,
) {
    let Some(type_node) = node.child_by_field_name("type") else {
        return;
    };

    let type_name = extract_impl_type_name(type_node, source);
    if type_name.is_empty() {
        return;
    }

    let Some(body_node) = node.child_by_field_name("body") else {
        return;
    };

    let mut cursor = body_node.walk();
    for child in body_node.children(&mut cursor) {
        if child.kind() != "function_item" {
            continue;
        }

        let Some(name_node) = child.child_by_field_name("name") else {
            continue;
        };
        let method_name = node_text(name_node, source).to_string();
        if method_name.is_empty() {
            continue;
        }

        let symbol_name = format!("{type_name}::{method_name}");
        let params = extract_function_parameters(child, source);
        let returns = extract_function_return_type(child, source);
        let generics = extract_generics(child, source);
        let visibility = extract_visibility(child, source);

        let mut symbol = make_symbol(
            &symbol_name,
            "method",
            child,
            source,
            repo_id,
            rel_path,
            &params,
            returns.as_deref(),
            &generics,
            &visibility,
            &[],
        );
        symbol.exported = visibility == "public";
        symbols.push(symbol);
    }
}

fn extract_impl_type_name(type_node: Node<'_>, source: &[u8]) -> String {
    if type_node.kind() == "generic_type" {
        if let Some(inner_type) = type_node.child_by_field_name("type") {
            let value = node_text(inner_type, source).to_string();
            if !value.is_empty() {
                return value;
            }
        }
    }

    node_text(type_node, source).to_string()
}

fn extract_function_parameters(node: Node<'_>, source: &[u8]) -> Vec<ParamInfo> {
    let mut params = Vec::new();
    let Some(parameters_node) = node.child_by_field_name("parameters") else {
        return params;
    };

    let mut cursor = parameters_node.walk();
    for child in parameters_node.children(&mut cursor) {
        if child.kind() != "parameter" {
            continue;
        }

        let pattern = child.child_by_field_name("pattern");
        let param_type = child.child_by_field_name("type");
        let Some(pattern) = pattern else {
            continue;
        };

        let name = node_text(pattern, source).to_string();
        if name.is_empty() {
            continue;
        }

        let type_annotation = param_type
            .map(|node| node_text(node, source).to_string())
            .filter(|text| !text.is_empty());

        params.push(ParamInfo {
            name,
            type_annotation,
        });
    }

    params
}

fn extract_function_return_type(node: Node<'_>, source: &[u8]) -> Option<String> {
    node.child_by_field_name("return_type")
        .map(|return_node| node_text(return_node, source).trim().to_string())
        .filter(|text| !text.is_empty())
}

fn extract_struct_fields(node: Node<'_>, source: &[u8]) -> Vec<ParamInfo> {
    let mut fields = Vec::new();
    let Some(body_node) = node.child_by_field_name("body") else {
        return fields;
    };

    let mut cursor = body_node.walk();
    for child in body_node.children(&mut cursor) {
        if child.kind() != "field_declaration" {
            continue;
        }

        let Some(name_node) = child.child_by_field_name("name") else {
            continue;
        };

        let name = node_text(name_node, source).to_string();
        if name.is_empty() {
            continue;
        }

        let type_annotation = child
            .child_by_field_name("type")
            .map(|type_node| node_text(type_node, source).to_string())
            .filter(|text| !text.is_empty());

        fields.push(ParamInfo {
            name,
            type_annotation,
        });
    }

    fields
}

fn extract_enum_variants(node: Node<'_>, source: &[u8]) -> Vec<ParamInfo> {
    let mut variants = Vec::new();
    let Some(body_node) = node.child_by_field_name("body") else {
        return variants;
    };

    let mut cursor = body_node.walk();
    for child in body_node.children(&mut cursor) {
        if child.kind() != "enum_variant" {
            continue;
        }

        let Some(name_node) = child.child_by_field_name("name") else {
            continue;
        };

        let name = node_text(name_node, source).to_string();
        if name.is_empty() {
            continue;
        }

        let type_annotation = child
            .child_by_field_name("type")
            .map(|type_node| node_text(type_node, source).to_string())
            .filter(|text| !text.is_empty());

        variants.push(ParamInfo {
            name,
            type_annotation,
        });
    }

    variants
}

fn extract_generics(node: Node<'_>, source: &[u8]) -> Vec<String> {
    let Some(type_parameters) = node.child_by_field_name("type_parameters") else {
        return Vec::new();
    };

    let mut generics = Vec::new();
    let mut cursor = type_parameters.walk();
    for child in type_parameters.children(&mut cursor) {
        if child.kind() == "type_identifier" || child.kind() == "type_parameter" {
            let value = node_text(child, source).to_string();
            if !value.is_empty() {
                generics.push(value);
            }
        }
    }

    generics
}

fn extract_visibility(node: Node<'_>, source: &[u8]) -> String {
    let visibility_node = find_child_node(node, "visibility_modifier");
    let Some(visibility_node) = visibility_node else {
        return "private".to_string();
    };

    let text = node_text(visibility_node, source);
    if text == "pub" {
        return "public".to_string();
    }
    if text.contains("pub(crate)") {
        return "internal".to_string();
    }
    if text.contains("pub(super)") {
        return "protected".to_string();
    }

    "private".to_string()
}
