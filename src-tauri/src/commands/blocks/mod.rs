//! Blocks command handlers.

pub(crate) mod crud;
pub(crate) mod move_ops;
pub(crate) mod queries;

pub use crud::*;
pub use move_ops::*;
pub use queries::*;

// pub(crate) helpers used by other crate modules (e.g. recurrence.rs)
// #882: `set_property_in_tx` now lives in `crate::domain::block_ops`;
// re-export it here so the fully-qualified `commands::blocks::set_property_in_tx`
// path (properties.rs) still resolves.
pub(crate) use crate::domain::block_ops::set_property_in_tx;
pub(crate) use crud::{delete_property_in_tx, find_prev_edit_in_tx};
