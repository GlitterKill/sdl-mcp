use napi_derive::napi;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeProcessSymbol {
    pub symbol_id: String,
    pub name: String,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeProcessCallEdge {
    pub caller_id: String,
    pub callee_id: String,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeProcessStep {
    pub symbol_id: String,
    pub step_order: u32,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeProcess {
    pub process_id: String,
    pub entry_symbol_id: String,
    pub steps: Vec<NativeProcessStep>,
    pub depth: u32,
}

