//! Op log writer — appends local operations to the `op_log` table.
//!
//! Phase 1 implementation: single-device, linear chain. Each new op references
//! the immediately preceding op from the same device as its sole parent.

mod append;
mod bypass;
mod payload;
mod query;
mod record;

pub use append::*;
pub use bypass::*;
pub(crate) use payload::*;
pub use query::*;
pub use record::*;

#[cfg(test)]
mod tests;
