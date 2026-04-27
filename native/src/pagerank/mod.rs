//! Personalized PageRank (ACL forward-push) for SDL-MCP.
//!
//! Pure-Rust implementation that mirrors `src/retrieval/ppr.ts` byte-for-byte
//! to within numerical noise (≤ 1e-3). The napi-rs entry point lives in
//! `native/src/lib.rs` and dispatches to [`push::run`].
//!
//! The adjacency is owned by the TypeScript layer and passed across the FFI as
//! a `Vec<Vec<NativePprAdjEntry>>`; this keeps the snapshot single-sourced.

pub mod push;
pub mod types;

pub use types::{NativePprAdjEntry, NativePprScore, NativePprSeed};
