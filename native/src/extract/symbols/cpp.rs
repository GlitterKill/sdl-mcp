use tree_sitter::Node;

use crate::types::NativeParsedSymbol;

use super::common::{
    build_signature, find_child_by_kind, find_child_node, make_symbol, node_text, ParamInfo,
};

pub fn extract_symbols_cpp(
    root: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Vec<NativeParsedSymbol> {
    let mut symbols = Vec::new();
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        match node.kind() {
            "namespace_definition" => {
                if let Some(symbol) = process_namespace(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "class_specifier" | "struct_specifier" => {
                if let Some(symbol) = process_class_like(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "enum_specifier" => {
                if let Some(symbol) = process_enum(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "type_definition" | "alias_declaration" => {
                if let Some(symbol) = process_type_alias(node, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "template_declaration" => {
                process_template_declaration(node, source, repo_id, rel_path, &mut symbols);
            }
            "function_definition" => {
                if !is_under_template_declaration(node) {
                    if let Some(symbol) = process_function_like(node, source, repo_id, rel_path) {
                        symbols.push(symbol);
                    }
                }
            }
            "declaration" => {
                if !is_under_template_declaration(node) {
                    process_declaration(node, source, repo_id, rel_path, &mut symbols);
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

fn process_namespace(
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

    let fqn = build_fqn(node.parent().unwrap_or(node), &name, source);
    let mut symbol = make_symbol(
        &fqn,
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
    Some(symbol)
}

fn process_class_like(
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

    let fqn = build_fqn(node, &name, source);
    let generics = extract_template_parameters(node, source);

    let mut symbol = make_symbol(
        &fqn,
        "class",
        node,
        source,
        repo_id,
        rel_path,
        &[],
        None,
        &generics,
        "public",
        &[],
    );
    symbol.exported = true;
    symbol.signature = build_signature(&[], None, &generics);
    Some(symbol)
}

fn process_enum(
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

    let fqn = build_fqn(node, &name, source);
    let mut symbol = make_symbol(
        &fqn,
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

fn process_type_alias(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let name = if let Some(name_node) = node.child_by_field_name("name") {
        node_text(name_node, source).to_string()
    } else {
        find_child_by_kind(node, "type_identifier", source)
            .or_else(|| {
                node.child_by_field_name("declarator")
                    .and_then(find_identifier_in_declarator)
                    .map(|n| node_text(n, source).to_string())
            })
            .unwrap_or_default()
    };

    if name.is_empty() {
        return None;
    }

    let fqn = build_fqn(node, &name, source);
    let mut symbol = make_symbol(
        &fqn,
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

fn process_template_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    symbols: &mut Vec<NativeParsedSymbol>,
) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "class_specifier" | "struct_specifier" => {
                if let Some(symbol) = process_class_like(child, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "enum_specifier" => {
                if let Some(symbol) = process_enum(child, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "function_definition" => {
                if let Some(symbol) = process_function_like(child, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            "declaration" => {
                process_declaration(child, source, repo_id, rel_path, symbols);
            }
            "type_definition" | "alias_declaration" => {
                if let Some(symbol) = process_type_alias(child, source, repo_id, rel_path) {
                    symbols.push(symbol);
                }
            }
            _ => {}
        }
    }
}

fn process_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    symbols: &mut Vec<NativeParsedSymbol>,
) {
    if let Some(function_symbol) = process_function_like(node, source, repo_id, rel_path) {
        symbols.push(function_symbol);
        return;
    }

    if !is_global_or_namespace_scope(node) {
        return;
    }

    process_variable_declaration(node, source, repo_id, rel_path, symbols);
}

fn process_function_like(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
) -> Option<NativeParsedSymbol> {
    let declarator = node.child_by_field_name("declarator")?;
    let function_declarator = find_function_declarator(declarator)?;
    let name_node = function_declarator.child_by_field_name("declarator")?;

    let raw_name = node_text(name_node, source).trim().to_string();
    if raw_name.is_empty() {
        return None;
    }

    let short_name = extract_terminal_name(&raw_name);
    if short_name.is_empty() {
        return None;
    }

    let class_name = find_enclosing_class_name(node, source);
    let visibility = extract_visibility(node, source);
    let params = extract_parameters(function_declarator, source);
    let returns = extract_return_type(node, source);
    let generics = extract_template_parameters(node, source);

    let fqn = build_fqn(node, &raw_name, source);
    let is_destructor = raw_name.starts_with('~') || short_name.starts_with('~');
    let is_constructor = class_name
        .as_ref()
        .is_some_and(|cls| !is_destructor && short_name == *cls);

    let (kind, exported) = if is_destructor {
        ("constructor", visibility == "public")
    } else if is_constructor {
        ("constructor", visibility == "public")
    } else if class_name.is_some() {
        ("method", visibility == "public")
    } else {
        ("function", true)
    };

    let mut symbol = make_symbol(
        &fqn,
        kind,
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
    symbol.exported = exported;
    Some(symbol)
}

fn process_variable_declaration(
    node: Node<'_>,
    source: &[u8],
    repo_id: &str,
    rel_path: &str,
    symbols: &mut Vec<NativeParsedSymbol>,
) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() != "init_declarator" {
            continue;
        }

        let declarator = child
            .child_by_field_name("declarator")
            .or_else(|| find_child_node(child, "declarator"));
        let Some(declarator) = declarator else {
            continue;
        };
        let Some(name_node) = find_identifier_in_declarator(declarator) else {
            continue;
        };

        let name = node_text(name_node, source).to_string();
        if name.is_empty() {
            continue;
        }

        let fqn = build_fqn(node, &name, source);
        let mut symbol = make_symbol(
            &fqn,
            "variable",
            child,
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

fn find_identifier_in_declarator(node: Node<'_>) -> Option<Node<'_>> {
    if matches!(
        node.kind(),
        "identifier"
            | "type_identifier"
            | "field_identifier"
            | "destructor_name"
            | "operator_name"
            | "qualified_identifier"
    ) {
        return Some(node);
    }

    let mut stack = vec![node];
    while let Some(current) = stack.pop() {
        if matches!(
            current.kind(),
            "identifier"
                | "type_identifier"
                | "field_identifier"
                | "destructor_name"
                | "operator_name"
                | "qualified_identifier"
        ) {
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

fn extract_parameters(function_declarator: Node<'_>, source: &[u8]) -> Vec<ParamInfo> {
    let mut params = Vec::new();
    let parameter_list = function_declarator
        .child_by_field_name("parameters")
        .or_else(|| find_child_node(function_declarator, "parameter_list"));
    let Some(parameter_list) = parameter_list else {
        return params;
    };

    let mut cursor = parameter_list.walk();
    for child in parameter_list.children(&mut cursor) {
        if child.kind() != "parameter_declaration" {
            continue;
        }

        let Some(declarator) = child.child_by_field_name("declarator") else {
            continue;
        };
        let Some(identifier) = find_identifier_in_declarator(declarator) else {
            continue;
        };

        let name = extract_terminal_name(node_text(identifier, source));
        if name.is_empty() {
            continue;
        }

        let mut type_annotation = None;
        let mut type_cursor = child.walk();
        for decl_child in child.children(&mut type_cursor) {
            if decl_child.kind() != "declarator" && decl_child.kind() != "," {
                let text = node_text(decl_child, source).trim().to_string();
                if !text.is_empty() {
                    type_annotation = Some(text);
                    break;
                }
            }
        }

        params.push(ParamInfo {
            name,
            type_annotation,
        });
    }

    params
}

fn extract_return_type(node: Node<'_>, source: &[u8]) -> Option<String> {
    let mut current = node;
    while current.kind() != "declaration" {
        let Some(parent) = current.parent() else {
            return None;
        };
        current = parent;
    }

    let mut cursor = current.walk();
    for child in current.children(&mut cursor) {
        if matches!(
            child.kind(),
            "declarator" | "virtual" | "static" | "inline" | "const" | "volatile"
        ) {
            continue;
        }

        let text = node_text(child, source).trim().to_string();
        if !text.is_empty() {
            return Some(text);
        }
    }

    None
}

fn extract_template_parameters(node: Node<'_>, source: &[u8]) -> Vec<String> {
    let mut current = Some(node);
    while let Some(candidate) = current {
        if candidate.kind() == "template_declaration" {
            return parse_template_parameter_list(candidate, source);
        }
        current = candidate.parent();
    }

    Vec::new()
}

fn parse_template_parameter_list(template_node: Node<'_>, source: &[u8]) -> Vec<String> {
    let params_node = template_node
        .child_by_field_name("parameters")
        .or_else(|| find_child_node(template_node, "template_parameter_list"));
    let Some(params_node) = params_node else {
        return Vec::new();
    };

    let mut generics = Vec::new();
    let mut stack = vec![params_node];
    while let Some(current) = stack.pop() {
        if current.kind() == "type_parameter_declaration" {
            if let Some(name_node) = current.child_by_field_name("name") {
                let name = node_text(name_node, source).to_string();
                if !name.is_empty() {
                    generics.push(name);
                }
            }
        }

        let child_count = current.child_count();
        for i in (0..child_count).rev() {
            if let Some(child) = current.child(i) {
                stack.push(child);
            }
        }
    }

    generics
}

fn build_fqn(node: Node<'_>, name: &str, source: &[u8]) -> String {
    let mut parts = Vec::new();
    let mut current = Some(node);

    while let Some(candidate) = current {
        match candidate.kind() {
            "namespace_definition" => {
                if let Some(name_node) = candidate.child_by_field_name("name") {
                    let segment = node_text(name_node, source).to_string();
                    if !segment.is_empty() {
                        parts.push(segment);
                    }
                }
            }
            "class_specifier" | "struct_specifier" | "enum_specifier" => {
                if let Some(name_node) = candidate.child_by_field_name("name") {
                    let segment = node_text(name_node, source).to_string();
                    if !segment.is_empty() {
                        parts.push(segment);
                    }
                }
            }
            _ => {}
        }

        current = candidate.parent();
    }

    parts.reverse();

    if parts.is_empty() {
        return name.to_string();
    }

    if name.contains("::") {
        let scope_prefix = format!("{}::", parts.join("::"));
        if name.starts_with(&scope_prefix) {
            return name.to_string();
        }
        return format!("{scope_prefix}{name}");
    }

    format!("{}::{name}", parts.join("::"))
}

fn find_enclosing_class_name(node: Node<'_>, source: &[u8]) -> Option<String> {
    let mut current = node.parent();
    while let Some(candidate) = current {
        if matches!(candidate.kind(), "class_specifier" | "struct_specifier") {
            let name = candidate
                .child_by_field_name("name")
                .map(|n| node_text(n, source).to_string())
                .unwrap_or_default();
            if !name.is_empty() {
                return Some(name);
            }
        }
        current = candidate.parent();
    }
    None
}

fn extract_visibility(node: Node<'_>, source: &[u8]) -> String {
    let Some((class_node, body_node)) = find_enclosing_class_and_body(node) else {
        return "public".to_string();
    };

    let default_visibility = if class_node.kind() == "struct_specifier" {
        "public"
    } else {
        "private"
    };

    let mut active_visibility = default_visibility.to_string();
    let mut cursor = body_node.walk();
    for child in body_node.children(&mut cursor) {
        if child.kind() == "access_specifier" {
            let text = node_text(child, source);
            if text.contains("public") {
                active_visibility = "public".to_string();
            } else if text.contains("private") {
                active_visibility = "private".to_string();
            } else if text.contains("protected") {
                active_visibility = "protected".to_string();
            }
            continue;
        }

        if is_ancestor_or_same(child, node) {
            return active_visibility;
        }
    }

    active_visibility
}

fn find_enclosing_class_and_body(node: Node<'_>) -> Option<(Node<'_>, Node<'_>)> {
    let mut current = node.parent();
    while let Some(candidate) = current {
        if matches!(candidate.kind(), "class_specifier" | "struct_specifier") {
            let body = candidate.child_by_field_name("body")?;
            return Some((candidate, body));
        }
        current = candidate.parent();
    }
    None
}

fn is_ancestor_or_same(ancestor: Node<'_>, descendant: Node<'_>) -> bool {
    if ancestor.id() == descendant.id() {
        return true;
    }

    let mut current = descendant.parent();
    while let Some(node) = current {
        if node.id() == ancestor.id() {
            return true;
        }
        current = node.parent();
    }

    false
}

fn is_global_or_namespace_scope(node: Node<'_>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };

    if parent.kind() == "translation_unit" {
        return true;
    }

    if parent.kind() == "declaration_list" {
        return parent
            .parent()
            .is_some_and(|grandparent| grandparent.kind() == "namespace_definition");
    }

    false
}

fn extract_terminal_name(name: &str) -> String {
    name.rsplit("::").next().unwrap_or(name).trim().to_string()
}

fn is_under_template_declaration(node: Node<'_>) -> bool {
    let mut current = node.parent();
    while let Some(candidate) = current {
        if candidate.kind() == "template_declaration" {
            return true;
        }
        current = candidate.parent();
    }

    false
}
