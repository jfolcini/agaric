//! Actor identity + per-request context for the MCP server.
//!
//! The frontend invokes command handlers directly via Tauri IPC and runs as
//! the implicit [`Actor::User`]. MCP requests, by contrast, originate from an
//! external agent identified by `clientInfo.name` in the `initialize`
//! handshake. The dispatcher wraps each `tools/call` in
//! `ACTOR.scope(ctx,...)` so downstream code (activity feeds in,
//! op-log `origin` population in v2 via) can discover who requested
//! the operation via [`current_actor`] without threading the context through
//! every function signature.
//!
//! # PII hygiene
//!
//! Agent names are self-reported and land in the activity feed.
//! The [`Actor`] type therefore uses a **manual** `Debug` impl that logs the
//! discriminant only (`"User"` / `"Agent"`) and suppresses the `name` field.
//! Structured logging callsites that want the name must read it explicitly,
//! not via `{:?}`. `ActorContext` is NOT exported over Tauri IPC and
//! deliberately omits `Serialize` / `Deserialize` / specta derives.

// #2621: the actor machinery moved down into `crate::task_locals` (its neutral
// home — a core producer `op_log` reads it, an integration `mcp` writes it, so
// it must not live inside `mcp`). Re-exported here so `crate::mcp::actor::…`
// call sites across the mcp layer resolve unchanged.
pub use crate::task_locals::{ACTOR, Actor, ActorContext, current_actor};
