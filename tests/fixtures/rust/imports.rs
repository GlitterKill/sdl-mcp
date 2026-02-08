// Use statement with simple path
use std::collections::HashMap;

// Use statement with wildcard
use std::io::*;

// Use statement with scoped list
use std::collections::{HashMap, HashSet};

// Use statement with aliases
use std::io::Result as IoResult;

// Use statement with nested paths
use std::sync::Arc;

// Use statement with self and super
use self::my_module::MyStruct;
use super::parent_module::ParentStruct;
use crate::root_module::RootStruct;

// Use statement with mixed
use std::collections::HashMap;
use std::io::{self, Read, Write};

// External crate use
use serde::{Serialize, Deserialize};
use tokio::runtime::Runtime;

// Module declarations (mod foo; - creates edge to module file)
mod my_module;
mod internal;
mod utils;

// Re-export
pub use crate::my_module::PublicStruct;

// Function to test imports
fn main() {
    let map: HashMap<String, i32> = HashMap::new();
    let _ = std::fs::read_to_string("test.txt");
}
