//! Neutral domain layer (#642).
//!
//! Houses shared domain types and tx-scoped helpers that are consumed by
//! BOTH the IPC/command layer (`crate::commands`) AND lower data-layer
//! modules (`crate::fts`, `crate::recurrence`). Before this module existed
//! those definitions lived inside `crate::commands`, so `fts` and
//! `recurrence` had to reach *up* into the IPC layer for them — and
//! `commands` reaches *down* into `fts` — forming a `commands ⇄ fts`
//! module cycle plus `recurrence/fts → commands` upward edges.
//!
//! `domain` is declared in `lib.rs` **before** `commands` and `fts` to make
//! the intended layering explicit: it is a true lower layer that depends on
//! nothing in either. The acceptable dependency direction is now
//! `commands → fts → domain` and `commands → domain` (one-way).
//!
//! Re-exports from the old `crate::commands::queries` path keep the many
//! existing command-internal callers and the `tauri-specta` bindings
//! churn-free; `fts` and `recurrence` import from `crate::domain::…`
//! directly so the cycle is genuinely broken (not merely re-routed through
//! a re-export living in `commands`).

pub mod block_ops;
pub mod search_types;
