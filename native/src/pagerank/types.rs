//! Napi-rs payload types for the personalized PageRank export.
//!
//! Kept separate from the algorithm itself so the JS surface can evolve
//! independently of the push implementation.

use napi_derive::napi;

/// A single (neighbor index, weight) entry in the directional adjacency the
/// TypeScript layer hands to the native walker.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativePprAdjEntry {
    pub neighbor: u32,
    pub weight: f64,
}

/// A single seed contribution to the personalization vector.
///
/// `node` is an index into the adjacency `Vec<Vec<...>>`. `weight` should
/// already be normalized so the seed vector sums to 1.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativePprSeed {
    pub node: u32,
    pub weight: f64,
}

/// A node that received a non-zero PPR score.
///
/// Returned as a sparse list to keep payload size proportional to touched
/// nodes rather than the full graph.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativePprScore {
    pub node: u32,
    pub score: f64,
}
