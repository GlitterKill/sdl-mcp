extern crate napi_build;

fn main() {
    napi_build::setup();

    // Compile SCIP protobuf schema for Rust decoder
    let out_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("src")
        .join("scip");
    std::fs::create_dir_all(&out_dir).expect("Failed to create src/scip directory");

    prost_build::Config::new()
        .out_dir(&out_dir)
        .compile_protos(&["proto/scip.proto"], &["proto/"])
        .expect("Failed to compile SCIP protobuf");
}
