use napi_derive::napi;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeClusterSymbol {
    pub symbol_id: String,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeClusterEdge {
    pub from_symbol_id: String,
    pub to_symbol_id: String,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeClusterAssignment {
    pub symbol_id: String,
    pub cluster_id: String,
    pub membership_score: f64,
}

