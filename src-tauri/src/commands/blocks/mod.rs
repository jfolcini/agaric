//! Blocks command handlers.

pub(crate) mod crud;
pub mod move_ops;
pub(crate) mod queries;
pub mod space_move;

pub use crud::*;
pub use move_ops::*;
pub use queries::*;
pub use space_move::*;

// pub(crate) helpers used by other crate modules (e.g. recurrence.rs)
// #882: `set_property_in_tx` now lives in `agaric_engine::block_ops`;
// re-export it here so the fully-qualified `commands::blocks::set_property_in_tx`
// path (properties.rs) still resolves.
pub(crate) use agaric_engine::block_ops::set_property_in_tx;
pub(crate) use crud::delete_property_in_tx;
