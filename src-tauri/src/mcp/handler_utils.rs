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
///
/// L-123: the user-facing message is a short structured category derived
/// from [`serde_json::error::Category`] (e.g. "data shape mismatch") rather
/// than the verbatim `serde_json::Error::Display`. The latter embeds
/// line/column hints that point into the MCP wire JSON — meaningless to
/// the agent / human reading the activity feed. The verbose serde output
/// is still preserved on a `tracing::debug!` line for daily-log debugging.
pub(crate) fn parse_args<T: serde::de::DeserializeOwned>(
    tool: &str,
    args: Value,
) -> Result<T, AppError> {
    serde_json::from_value::<T>(args).map_err(|e| {
        // `serde_json::error::Category` has exactly four variants in
        // serde_json 1.0 — the match below is exhaustive without a
        // fallback arm so any future variant is a compile error.
        let category = match e.classify() {
            serde_json::error::Category::Data => "data shape mismatch",
            serde_json::error::Category::Syntax => "json syntax",
            serde_json::error::Category::Eof => "json truncated",
            serde_json::error::Category::Io => "json io",
        };
        tracing::debug!(tool, error = %e, "MCP parse_args failed");
        AppError::Validation(format!("tool `{tool}`: invalid arguments ({category})"))
    })
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

#[cfg(test)]
mod tests {
    //! L-123: pin the user-facing `parse_args` error message format so
    //! the activity feed stays short and structured. The verbose
    //! `serde_json::Error::Display` (with line/column hints into the MCP
    //! wire JSON) must NOT leak into `AppError::Validation`.
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Debug, Deserialize)]
    struct Probe {
        required: String,
    }

    #[test]
    fn parse_args_missing_required_field_emits_data_shape_message() {
        let err = parse_args::<Probe>("test_tool", json!({})).unwrap_err();
        match err {
            AppError::Validation(msg) => {
                assert!(
                    msg.contains("test_tool"),
                    "message must include tool name: {msg}"
                );
                assert!(
                    msg.contains("data shape mismatch"),
                    "missing-field is Category::Data: {msg}"
                );
                assert!(
                    !msg.contains("line"),
                    "L-123: must NOT include serde_json line/column: {msg}"
                );
                assert!(
                    !msg.contains("column"),
                    "L-123: must NOT include serde_json line/column: {msg}"
                );
            }
            _ => panic!("expected Validation, got {err:?}"),
        }
    }

    #[test]
    fn parse_args_type_mismatch_emits_data_shape_message() {
        // `42` is a number, but `Probe.required` is `String` —
        // serde_json classifies this as `Category::Data`.
        let err = parse_args::<Probe>("test_tool", json!({"required": 42})).unwrap_err();
        match err {
            AppError::Validation(msg) => {
                assert!(msg.contains("test_tool"));
                assert!(msg.contains("data shape mismatch"));
            }
            _ => panic!("expected Validation, got {err:?}"),
        }
    }

    #[test]
    fn parse_args_happy_path_returns_value() {
        let probe: Probe = parse_args::<Probe>("test_tool", json!({"required": "hello"})).unwrap();
        assert_eq!(probe.required, "hello");
    }
}
