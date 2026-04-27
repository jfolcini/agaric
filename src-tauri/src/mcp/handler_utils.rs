//! Shared MCP tool-handler ceremony.
//!
//! Both [`crate::mcp::tools_ro`] and [`crate::mcp::tools_rw`] open every
//! handler with the same two-step pattern:
//!
//! 1. Decode the JSON-RPC `params` blob into a typed `*Args` struct,
//!    converting `serde_json` decode failures into a JSON-RPC
//!    `-32602 invalid params` (i.e., [`AppError::Validation`] with the
//!    tool name embedded).
//! 2. After the inner business logic returns, re-encode the typed
//!    response struct into a [`serde_json::Value`] for the wire.
//!
//! Centralising both helpers here keeps the RO and RW surfaces in
//! lock-step — there is no risk of drift between two byte-identical
//! `parse_args` copies (the previous setup), and every handler ends
//! with a uniform `to_tool_result(&resp)` call instead of an ad-hoc
//! `Ok(serde_json::to_value(resp)?)` line.
//!
//! Both helpers are `pub(crate)` so only the MCP module tree can import
//! them — they have no meaning outside the JSON-RPC dispatch path.
//!
//! Resolves REVIEW-LATER MAINT-135.

use serde_json::Value;

use crate::error::AppError;

/// Convert a serde-json deserialization error into an
/// [`AppError::Validation`] with the tool name embedded. Used for every
/// handler's arg parse so bad input maps to `-32602 invalid params` at
/// the JSON-RPC layer.
pub(crate) fn parse_args<T: serde::de::DeserializeOwned>(
    tool: &str,
    args: Value,
) -> Result<T, AppError> {
    serde_json::from_value::<T>(args)
        .map_err(|e| AppError::Validation(format!("tool `{tool}`: invalid arguments — {e}")))
}

/// Serialise a typed handler response into the [`serde_json::Value`] that
/// the JSON-RPC dispatcher expects on the wire.
///
/// Preserves the original `?`-on-`serde_json::Error` semantics from the
/// pre-MAINT-135 handlers: a serialisation failure converts to
/// [`AppError::Json`] via the `#[from] serde_json::Error` impl, which the
/// dispatcher in `server.rs` then maps to a JSON-RPC internal error. In
/// practice this branch is unreachable for the typed `*Resp` structs the
/// handlers return — every field is a primitive, `String`, `Vec`, or a
/// nested `Serialize` struct with no custom `Serialize` impl that could
/// fail — but the conversion is kept honest so future response shapes
/// cannot regress silently.
pub(crate) fn to_tool_result<T: serde::Serialize>(value: &T) -> Result<Value, AppError> {
    Ok(serde_json::to_value(value)?)
}
