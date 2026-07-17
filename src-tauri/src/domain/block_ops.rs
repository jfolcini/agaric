//! Neutral block-write core.
//!
//! #2621 (THE INVERSION): the pure block-write helpers, content caps, and the
//! three in-transaction writers (`create_block_in_tx`, `set_property_in_tx`,
//! `set_property_in_tx_with_declaration`) moved DOWN into `agaric-engine`
//! (`agaric_engine::block_ops`) — they drive the moved apply kernel
//! (`apply_op_projected`) and the store's `cross_space_validation`, neither of
//! which the app layer owns any longer. This re-export shim keeps every existing
//! `crate::domain::block_ops::…` call site (the `recurrence` sibling-projection
//! path, `spaces::bootstrap`, and the `create_block_inner` / `set_property_inner`
//! `#[tauri::command]` wrappers) compiling unchanged.
pub use agaric_engine::block_ops::*;
