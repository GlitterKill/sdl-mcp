use tree_sitter::Node;

use crate::types::NativeRange;

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

pub fn extract_string_value(string_node: Node<'_>, source: &[u8]) -> Option<String> {
    let mut cursor = string_node.walk();
    for child in string_node.children(&mut cursor) {
        if child.kind() == "string_fragment" {
            let text = node_text(child, source);
            return Some(text.to_string());
        }
    }

    let text = node_text(string_node, source);
    if text.len() >= 2 {
        let first = text.chars().next()?;
        let last = text.chars().last()?;
        if (first == '"' || first == '\'') && first == last {
            return Some(text[1..text.len() - 1].to_string());
        }
    }

    None
}
