use tree_sitter::Node;

use crate::types::NativeParsedSymbol;

use super::common::{find_child_node, make_symbol, node_text, ParamInfo};

pub fn extract_symbols_go(
    root: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Vec<NativeParsedSymbol> {
    let mut symbols = Vec::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        match node.kind() {
            "source_file" => process_source_file(node, source, repo_id, rel_path, &mut symbols),
            "function_declaration" => {
                if let Some(symbol) = process_function_declaration(node, source, repo_id, rel_path)
                {
                    symbols.push(symbol);
                }
            }
            "method_declaration" => {
                if let Some(symbol) = process_method_declaration(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "type_declaration" => {
                if let Some(symbol) = process_type_declaration(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "const_declaration" => {
                process_const_or_var_declaration(
                    node,
                    source,
                    repo_id,
                    rel_path,
                    "const_spec",
                    &mut symbols,
                );
            }
            "var_declaration" => {
                process_const_or_var_declaration(
                    node,
                    source,
                    repo_id,
                    rel_path,
                    "var_spec",
                    &mut symbols,
                );
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

fn process_source_file(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    symbols: &mut Vec<NativeParsedSymbol>,
) {
    let Some(package_clause) = find_child_node(node, "package_clause") else {
        return;
    };
    let Some(package_name) = find_child_node(package_clause, "package_identifier") else {
        return;
    };

    let name = node_text(package_name, source).to_string();
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
        "",
        &[],
    );
    symbol.exported = true;
    symbols.push(symbol);
}

fn process_function_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name_node = find_child_node(node, "identifier")?;
    let name = node_text(name_node, source).to_string();

    let params = extract_params_for_function(node, source);
    let returns = extract_results(node, source);

    // TS go.ts always emits signature for function_declaration (even when
    // params is empty). Force signature to match.
    let mut symbol = super::common::make_symbol_with_forced_signature(
        &name,
        "function",
        node,
        source,
        repo_id,
        rel_path,
        &params,
        returns.as_deref(),
        &[],
        "",
        &[],
    );
    symbol.exported = is_exported_name(&name);
    Some(symbol)
}

fn process_method_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name_node = find_child_node(node, "field_identifier")?;
    let name = node_text(name_node, source).to_string();

    let mut params = extract_params_for_method(node, source);
    let returns = extract_results(node, source);

    // TS go.ts extractParameters for methods inserts TWO synthetic params
    // for the receiver: first the receiver type as name+type, then the
    // receiver name with the receiver type as type. Replicate that.
    if let Some((receiver_type, receiver_name)) =
        extract_receiver_info(node, source)
    {
        params.insert(
            0,
            ParamInfo {
                name: receiver_type.clone(),
                type_annotation: Some(receiver_type.clone()),
            },
        );
        if let Some(recv_name) = receiver_name {
            params.insert(
                1,
                ParamInfo {
                    name: recv_name,
                    type_annotation: Some(receiver_type),
                },
            );
        }
    }

    let mut symbol = super::common::make_symbol_with_forced_signature(
        &name,
        "method",
        node,
        source,
        repo_id,
        rel_path,
        &params,
        returns.as_deref(),
        &[],
        "",
        &[],
    );
    symbol.exported = is_exported_name(&name);
    Some(symbol)
}

fn process_type_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let type_spec = find_child_node(node, "type_spec")?;
    let name_node = find_child_node(type_spec, "type_identifier")?;
    let name = node_text(name_node, source).to_string();

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
        "",
        &[],
    );
    symbol.exported = is_exported_name(&name);
    Some(symbol)
}

fn process_const_or_var_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    spec_kind: &str,
    symbols: &mut Vec<NativeParsedSymbol>,
) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() != spec_kind {
            continue;
        }

        let mut names = Vec::new();
        if let Some(name_node) = find_child_node(child, "identifier") {
            names.push(node_text(name_node, source).to_string());
        }

        if let Some(identifier_list) = find_child_node(child, "identifier_list") {
            let mut list_cursor = identifier_list.walk();
            for identifier in identifier_list.children(&mut list_cursor) {
                if identifier.kind() == "identifier" {
                    names.push(node_text(identifier, source).to_string());
                }
            }
        }

        for name in names {
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
                "",
                &[],
            );
            symbol.exported = is_exported_name(&name);
            symbols.push(symbol);
        }
    }
}

fn extract_params_for_function(node: Node<'_>, source: &[u8]) -> Vec<ParamInfo> {
    let mut param_lists = collect_parameter_lists(node);
    if param_lists.is_empty() {
        return vec![];
    }

    extract_param_infos(param_lists.remove(0), source)
}

fn extract_params_for_method(node: Node<'_>, source: &[u8]) -> Vec<ParamInfo> {
    let param_lists = collect_parameter_lists(node);
    if param_lists.len() < 2 {
        return vec![];
    }

    extract_param_infos(param_lists[1], source)
}

#[allow(dead_code)]
fn extract_receiver_type(node: Node<'_>, source: &[u8]) -> Option<String> {
    extract_receiver_info(node, source).map(|(ty, _)| ty)
}

fn extract_receiver_info(
    node: Node<'_>,
    source: &[u8],
) -> Option<(String, Option<String>)> {
    let param_lists = collect_parameter_lists(node);
    let receiver_list = param_lists.first().copied()?;

    let mut cursor = receiver_list.walk();
    for child in receiver_list.children(&mut cursor) {
        if child.kind() != "parameter_declaration" {
            continue;
        }

        let mut receiver_name: Option<String> = None;
        let mut receiver_type: Option<String> = None;
        let mut decl_cursor = child.walk();
        for decl_child in child.children(&mut decl_cursor) {
            if decl_child.kind() == "identifier" {
                if receiver_name.is_none() {
                    let t = node_text(decl_child, source).to_string();
                    if !t.is_empty() {
                        receiver_name = Some(t);
                    }
                }
            } else if receiver_type.is_none() {
                let t = node_text(decl_child, source).to_string();
                if !t.is_empty() {
                    receiver_type = Some(t);
                }
            }
        }

        if let Some(ty) = receiver_type {
            return Some((ty, receiver_name));
        }
    }

    None
}

fn collect_parameter_lists(node: Node<'_>) -> Vec<Node<'_>> {
    let mut parameter_lists = Vec::new();
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "parameter_list" {
            parameter_lists.push(child);
        }
    }
    parameter_lists
}

fn extract_param_infos(parameter_list: Node<'_>, source: &[u8]) -> Vec<ParamInfo> {
    let mut params = Vec::new();
    let mut cursor = parameter_list.walk();

    for child in parameter_list.children(&mut cursor) {
        match child.kind() {
            "parameter_declaration" => {
                let names = extract_parameter_names(child, source, false);
                let type_annotation = extract_parameter_type(child, source);

                for name in names {
                    params.push(ParamInfo {
                        name,
                        type_annotation: type_annotation.clone(),
                    });
                }
            }
            "variadic_parameter_declaration" => {
                let names = extract_parameter_names(child, source, true);
                let type_annotation = extract_parameter_type(child, source);

                for name in names {
                    params.push(ParamInfo {
                        name,
                        type_annotation: type_annotation.clone(),
                    });
                }
            }
            _ => {}
        }
    }

    params
}

fn extract_parameter_names(node: Node<'_>, source: &[u8], variadic: bool) -> Vec<String> {
    let mut names = Vec::new();

    if let Some(identifier_list) = find_child_node(node, "identifier_list") {
        let mut list_cursor = identifier_list.walk();
        for child in identifier_list.children(&mut list_cursor) {
            if child.kind() == "identifier" {
                let base = node_text(child, source);
                if !base.is_empty() {
                    names.push(if variadic {
                        format!("...{base}")
                    } else {
                        base.to_string()
                    });
                }
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "identifier" {
            let base = node_text(child, source);
            if !base.is_empty() {
                names.push(if variadic {
                    format!("...{base}")
                } else {
                    base.to_string()
                });
            }
        }
    }

    names
}

fn extract_parameter_type(node: Node<'_>, source: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() != "identifier" && child.kind() != "identifier_list" {
            let type_text = node_text(child, source).to_string();
            if !type_text.is_empty() {
                return Some(type_text);
            }
        }
    }
    None
}

fn extract_results(node: Node<'_>, source: &[u8]) -> Option<String> {
    let parameter_lists = collect_parameter_lists(node);
    if parameter_lists.len() >= 2 {
        let mut result_types = Vec::new();
        let mut cursor = parameter_lists[1].walk();
        for child in parameter_lists[1].children(&mut cursor) {
            if child.kind() == "parameter_declaration" {
                if let Some(result_type) = extract_parameter_type(child, source) {
                    result_types.push(result_type);
                }
            }
        }

        if !result_types.is_empty() {
            return Some(result_types.join(", "));
        }
    }

    let mut cursor = node.walk();
    let children: Vec<Node<'_>> = node.children(&mut cursor).collect();
    for i in 0..children.len() {
        if children[i].kind() == "type_identifier"
            && children.get(i + 1).map(|n| n.kind()) == Some("block")
        {
            let result = node_text(children[i], source).to_string();
            if !result.is_empty() {
                return Some(result);
            }
        }
    }

    None
}

fn is_exported_name(name: &str) -> bool {
    name.chars()
        .next()
        .map(|c| c.is_uppercase())
        .unwrap_or(false)
}
