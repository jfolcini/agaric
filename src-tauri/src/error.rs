use serde::Serialize;
use thiserror::Error;

/// The stable machine-readable `kind` discriminant [`AppError`] puts on the
/// IPC wire (#2251).
///
/// One unit variant per [`AppError`] variant, serialised (serde
/// `snake_case`) to the **exact** strings the old hand-written
/// `match`-of-`&str` in the manual `Serialize` impl emitted — the
/// `wire_kind_strings_pinned_for_every_variant` test below pins every
/// variant byte-for-byte against that legacy table, so this is a pure
/// type-level promotion with zero wire drift.
///
/// Because this enum derives `specta::Type` and is referenced by
/// [`AppErrorSchema`], the generated `bindings.ts` now carries
/// `kind: AppErrorKind` as a string-literal union instead of the old open
/// `kind: string` — the frontend's error discrimination
/// (`isCancellation` / `isPoolBusy` / …) type-checks against it, and the
/// previous hand-maintained mirror union in `src/lib/app-error.ts` is gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum AppErrorKind {
    Database,
    NotFound,
    /// [`AppError::PoolTimedOut`] — wire string `"pool_busy"` (kept from the
    /// original frontend contract; deliberately NOT `pool_timed_out`).
    PoolBusy,
    Conflict,
    Migration,
    Io,
    Json,
    Ulid,
    InvalidOperation,
    Channel,
    Internal,
    Snapshot,
    Validation,
    NonReversible,
    Cancelled,
}

/// Structured sub-kind for [`AppError::Validation`] (#1061, #2251).
///
/// Historically these codes were packed into the `message` as a
/// `"<Code>: <reason>"` prefix, hand-formatted at every Rust emit site and
/// regex-parsed back out on the frontend
/// (`src/lib/search-query/validation-codes.ts`), with only tests keeping the
/// two ends aligned. They are now a real optional `code` field on the wire
/// envelope (`{ kind: "validation", message, code }`); the frontend
/// discriminates on `err.code` against the specta-generated string-literal
/// union, and the `message` carries only the human-readable reason.
///
/// Variant names serialise as-is (serde default, PascalCase) — the exact
/// strings the old prefixes used, pinned by
/// `validation_code_wire_strings_pinned` below.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
pub enum ValidationCode {
    /// Invalid page-name glob filter (`fts::glob_filter`).
    InvalidGlob,
    /// Invalid user-supplied regex (`fts::toggle_filter::build_regex`).
    InvalidRegex,
    /// Invalid / unparseable date-filter bound (metadata, pages, backlink).
    InvalidDateFilter,
    /// Filter primitive not allowed / not supported on the queried surface
    /// (Pages metadata listing, advanced-query engine).
    InvalidFilter,
    /// Stale pagination cursor (format/sort mismatch) — the client should
    /// retry once without a cursor (see `usePageBrowserData`).
    RequiresRefresh,
}

/// Helper struct matching the `{ kind, message, code? }` JSON shape that
/// [`AppError`] serialises to.  Used solely so specta can derive the
/// TypeScript type for `AppError` — the real serialisation is still handled
/// by the manual `Serialize` impl below (which the
/// `schema_matches_manual_serialize_shape` test pins against this schema).
#[derive(Serialize, specta::Type)]
#[serde(rename = "AppError")]
#[allow(dead_code)] // Fields are read by specta's Type derive macro, not directly
struct AppErrorSchema {
    kind: AppErrorKind,
    message: String,
    /// Structured validation sub-kind (#2251). Present only on
    /// `kind: "validation"` errors that carry one; omitted entirely (never
    /// `null`) otherwise, so every non-coded error keeps the exact legacy
    /// `{ kind, message }` two-field envelope.
    #[specta(optional)]
    code: Option<ValidationCode>,
}

/// Application-level error type covering all expected failure modes.
///
/// Implements `Serialize` so it can be used directly as the error type in
/// `#[tauri::command]` handlers — the idiomatic Tauri 2 pattern.
/// The frontend receives `{ kind: string, message: string }`.
#[derive(Debug, Error)]
pub enum AppError {
    /// Catch-all SQL error.  Constructed only by the manual
    /// `From<sqlx::Error>` impl below, *after* the more specific
    /// `RowNotFound` / `PoolTimedOut` / `Database(unique_violation)`
    /// cases have been peeled off and routed to dedicated variants.
    /// Callers must never `AppError::Database(e)` directly when one
    /// of the discriminated variants would apply — let `?` / `.into()`
    /// do the routing so the IPC `kind` stays stable.
    #[error("Database error: {0}")]
    Database(#[source] sqlx::Error),

    /// Issue #106 — `sqlx::Error::RowNotFound` lifted out of
    /// `Database` so the frontend can discriminate "the row you
    /// asked about does not exist" from a generic SQL failure.
    /// Serializes as `kind: "not_found"`.  Carries a `String`
    /// payload to stay compatible with the pre-existing
    /// `NotFound(String)` call sites that synthesize a contextual
    /// "block <id>" message; `From<sqlx::Error>` populates it with
    /// a generic "row not found" since the driver has no row
    /// context at that layer.
    #[error("Not found: {0}")]
    NotFound(String),

    /// Issue #106 — `sqlx::Error::PoolTimedOut`.  Distinct from
    /// `Database` because the frontend can offer a "try again"
    /// affordance: the writer is genuinely busy, not broken.
    /// Serializes as `kind: "pool_busy"`.
    #[error("Database pool timed out (writer busy)")]
    PoolTimedOut,

    /// Issue #106 — UNIQUE-constraint / primary-key violation.
    /// `From<sqlx::Error>` inspects `db_err.is_unique_violation()`
    /// and routes to this variant when true; the payload is the
    /// driver's display string (which already includes the
    /// constraint name, e.g. "UNIQUE constraint failed:
    /// attachments.fs_path").  Serializes as `kind: "conflict"`.
    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Migration error: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("ULID error: {0}")]
    Ulid(String),

    #[error("Invalid operation: {0}")]
    InvalidOperation(String),

    #[error("Channel error: {0}")]
    Channel(String),

    /// #1664 — internal / unexpected invariant failure (e.g. a spawned
    /// worker task panicked, surfacing as a `tokio::task::JoinError`).
    /// Distinct from [`AppError::Channel`], which means a channel/receiver
    /// was dropped, so log triage keyed on `kind` is not muddied by
    /// overloading `channel` for "a worker thread panicked". Serializes
    /// `kind: "internal"` and is collapsed by `sanitize_internal_error`
    /// to the generic "an internal error occurred" message on the wire
    /// while the real cause is logged via the warn path.
    #[error("Internal error: {0}")]
    Internal(String),

    #[error("Snapshot error: {0}")]
    Snapshot(String),

    /// Business-rule / input rejection. `message` is the human-readable
    /// reason; `code` optionally carries a machine-discriminable
    /// [`ValidationCode`] sub-kind (#2251 — previously packed into the
    /// message as a `"<Code>: <reason>"` prefix). Construct via
    /// [`AppError::validation`] / [`AppError::validation_coded`].
    #[error("Validation error: {message}")]
    Validation {
        code: Option<ValidationCode>,
        message: String,
    },

    #[error("Non-reversible operation: {op_type} cannot be undone")]
    NonReversible { op_type: String },

    /// In-flight Tauri command was cancelled because the
    /// client dropped the response promise (e.g. the palette fired a
    /// fresh search before the previous one completed). The frontend
    /// already discriminates stale results via `generationRef`; this
    /// variant lets it cleanly distinguish "user gave up / stale"
    /// from "the query failed". Never logged as a warning — cancel
    /// is the expected case, not an error.
    #[error("Cancelled: request was aborted by the client")]
    Cancelled,
}

impl AppError {
    /// Plain (uncoded) validation rejection. Takes `String` (not
    /// `impl Into<String>`) so the hundreds of pre-existing
    /// `AppError::validation("…".into())` / `AppError::validation(format!(…))`
    /// call sites keep inferring the conversion target unambiguously.
    #[must_use]
    pub fn validation(message: String) -> Self {
        AppError::Validation {
            code: None,
            message,
        }
    }

    /// Validation rejection carrying a machine-discriminable
    /// [`ValidationCode`] sub-kind. `message` must be the human reason
    /// ONLY — never re-embed the code as a `"<Code>: …"` prefix (#2251
    /// removed that wire convention; the code travels in the `code` field).
    #[must_use]
    pub fn validation_coded(code: ValidationCode, message: impl Into<String>) -> Self {
        AppError::Validation {
            code: Some(code),
            message: message.into(),
        }
    }

    /// The structured validation sub-kind, if this is a coded
    /// [`AppError::Validation`]; `None` for uncoded validation errors and
    /// every other variant. The Rust-side mirror of the frontend's
    /// `validationCode(err)` narrowing helper.
    #[must_use]
    pub fn validation_code(&self) -> Option<ValidationCode> {
        match self {
            AppError::Validation { code, .. } => *code,
            _ => None,
        }
    }

    /// The stable machine-readable wire kind for this error — the single
    /// source of truth the `Serialize` impl (and any log-triage keyed on
    /// `kind`) uses.
    #[must_use]
    pub fn kind(&self) -> AppErrorKind {
        match self {
            AppError::Database(_) => AppErrorKind::Database,
            AppError::NotFound(_) => AppErrorKind::NotFound,
            AppError::PoolTimedOut => AppErrorKind::PoolBusy,
            AppError::Conflict(_) => AppErrorKind::Conflict,
            AppError::Migration(_) => AppErrorKind::Migration,
            AppError::Io(_) => AppErrorKind::Io,
            AppError::Json(_) => AppErrorKind::Json,
            AppError::Ulid(_) => AppErrorKind::Ulid,
            AppError::InvalidOperation(_) => AppErrorKind::InvalidOperation,
            AppError::Channel(_) => AppErrorKind::Channel,
            AppError::Internal(_) => AppErrorKind::Internal,
            AppError::Snapshot(_) => AppErrorKind::Snapshot,
            AppError::Validation { .. } => AppErrorKind::Validation,
            AppError::NonReversible { .. } => AppErrorKind::NonReversible,
            AppError::Cancelled => AppErrorKind::Cancelled,
        }
    }
}

/// Manual `From<sqlx::Error>` (issue #106).
///
/// Replaces the previous `#[from] sqlx::Error` blanket conversion so
/// the IPC layer can discriminate three call-site-recoverable cases
/// (`RowNotFound`, `PoolTimedOut`, unique-constraint conflict) from
/// the generic "something went wrong in SQL" bucket.  Routing happens
/// here — *not* at the call site — so existing `?` propagation gains
/// the discrimination for free and no downstream code has to learn
/// to inspect `sqlx::Error` directly.
impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::RowNotFound => AppError::NotFound("row not found".into()),
            sqlx::Error::PoolTimedOut => AppError::PoolTimedOut,
            sqlx::Error::Database(ref db_err) if db_err.is_unique_violation() => {
                AppError::Conflict(db_err.to_string())
            }
            other => AppError::Database(other),
        }
    }
}

/// Tauri 2 requires command error types to implement `Serialize`.
/// We serialize as `{ kind, message }` — plus an optional `code` field on
/// coded validation errors — so the frontend can match on structured data.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        use serde::ser::SerializeStruct;

        let code = match self {
            AppError::Validation { code, .. } => *code,
            _ => None,
        };

        // Field count: coded validation errors gain a third `code` field;
        // every other error keeps the exact legacy two-field envelope
        // (pinned byte-for-byte by `wire_format_pinned_for_every_variant`).
        let mut state =
            serializer.serialize_struct("AppError", if code.is_some() { 3 } else { 2 })?;
        state.serialize_field("kind", &self.kind())?;
        // `self.to_string()` always allocates the formatted message, but
        // `Serialize` for `AppError` only fires on the IPC error boundary
        // (cold path), and serde lacks a "borrowed Display" adapter that
        // would let us avoid the intermediate `String`. Documented as the
        // boundary cost of the `AppError` pattern.
        //
        // Coded validation errors ship the raw human reason WITHOUT the
        // `"Validation error: "` display decoration: the machine part
        // travels in `code`, and the frontend surfaces `message` verbatim
        // (inline regex alert, invalid-filter toast) instead of stripping
        // prefixes back out of a display string.
        let message = match self {
            AppError::Validation {
                code: Some(_),
                message,
            } => message.clone(),
            other => other.to_string(),
        };
        state.serialize_field("message", &message)?;
        if let Some(code) = code {
            state.serialize_field("code", &code)?;
        }
        state.end()
    }
}

/// Forward specta's type introspection to [`AppErrorSchema`] so that the
/// generated TypeScript type matches the `{ kind, message, code? }` JSON
/// shape produced by the manual `Serialize` impl above.
impl specta::Type for AppError {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
        AppErrorSchema::definition(types)
    }
}

/// Tests for `AppError`: Display output for every variant, Serialize output
/// (`{ kind, message }` shape for Tauri 2 frontend), and `From` impls.
#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic fixture strings for consistent error messages.
    const MSG_NOT_FOUND: &str = "block 01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const MSG_ULID: &str = "invalid ULID format";
    const MSG_VALIDATION: &str = "title must not be empty";
    const MSG_CHANNEL: &str = "receiver dropped";
    const MSG_INVALID_OP: &str = "cannot edit deleted block";
    const MSG_SNAPSHOT: &str = "CBOR encode failed";
    const MSG_INTERNAL: &str = "search task join failed: panicked";

    // --- Display output per variant ---

    #[test]
    fn display_not_found_prefixes_message() {
        let err = AppError::NotFound(MSG_NOT_FOUND.into());
        assert_eq!(
            err.to_string(),
            format!("Not found: {MSG_NOT_FOUND}"),
            "NotFound display should prefix 'Not found: '"
        );
    }

    #[test]
    fn display_ulid_prefixes_message() {
        let err = AppError::Ulid(MSG_ULID.into());
        assert_eq!(err.to_string(), format!("ULID error: {MSG_ULID}"));
    }

    #[test]
    fn display_validation_prefixes_message() {
        let err = AppError::validation(MSG_VALIDATION.into());
        assert_eq!(
            err.to_string(),
            format!("Validation error: {MSG_VALIDATION}")
        );
    }

    #[test]
    fn display_invalid_operation_prefixes_message() {
        let err = AppError::InvalidOperation(MSG_INVALID_OP.into());
        assert_eq!(
            err.to_string(),
            format!("Invalid operation: {MSG_INVALID_OP}")
        );
    }

    #[test]
    fn display_channel_prefixes_message() {
        let err = AppError::Channel(MSG_CHANNEL.into());
        assert_eq!(err.to_string(), format!("Channel error: {MSG_CHANNEL}"));
    }

    #[test]
    fn display_snapshot_prefixes_message() {
        let err = AppError::Snapshot(MSG_SNAPSHOT.into());
        assert_eq!(err.to_string(), format!("Snapshot error: {MSG_SNAPSHOT}"));
    }

    #[test]
    fn display_internal_prefixes_message() {
        let err = AppError::Internal(MSG_INTERNAL.into());
        assert_eq!(err.to_string(), format!("Internal error: {MSG_INTERNAL}"));
    }

    #[test]
    fn serialize_internal_variant_has_internal_kind() {
        // #1664 — a panicked worker must serialize as `kind: "internal"`,
        // NOT `kind: "channel"`, so log triage keyed on `kind` is not
        // muddied by overloading the channel/receiver-error variant.
        let err = AppError::Internal(MSG_INTERNAL.into());
        let json = serde_json::to_value(&err).expect("Internal should serialize");
        assert_eq!(json["kind"], "internal", "Internal variant kind");
    }

    #[test]
    fn display_io_includes_inner_message() {
        let err = AppError::Io(std::io::Error::other("disk full"));
        let msg = err.to_string();
        assert!(
            msg.contains("disk full"),
            "IO display should include inner message, got: {msg}"
        );
    }

    #[test]
    fn display_json_starts_with_prefix() {
        let err = AppError::Json(serde_json::from_str::<()>("{bad").unwrap_err());
        assert!(
            err.to_string().starts_with("JSON error:"),
            "JSON display should start with 'JSON error:'"
        );
    }

    // --- Serialize: { kind, message } shape for Tauri 2 ---

    #[test]
    fn serialize_all_string_variants_produce_kind_and_message() {
        let cases: Vec<(AppError, &str, String)> = vec![
            (
                AppError::Ulid(MSG_ULID.into()),
                "ulid",
                format!("ULID error: {MSG_ULID}"),
            ),
            (
                AppError::NotFound(MSG_NOT_FOUND.into()),
                "not_found",
                format!("Not found: {MSG_NOT_FOUND}"),
            ),
            (
                AppError::InvalidOperation(MSG_INVALID_OP.into()),
                "invalid_operation",
                format!("Invalid operation: {MSG_INVALID_OP}"),
            ),
            (
                AppError::Channel(MSG_CHANNEL.into()),
                "channel",
                format!("Channel error: {MSG_CHANNEL}"),
            ),
            (
                AppError::Snapshot(MSG_SNAPSHOT.into()),
                "snapshot",
                format!("Snapshot error: {MSG_SNAPSHOT}"),
            ),
            (
                AppError::Internal(MSG_INTERNAL.into()),
                "internal",
                format!("Internal error: {MSG_INTERNAL}"),
            ),
            (
                AppError::validation(MSG_VALIDATION.into()),
                "validation",
                format!("Validation error: {MSG_VALIDATION}"),
            ),
        ];
        for (err, expected_kind, expected_message) in cases {
            let json = serde_json::to_value(&err).expect("AppError should serialize");
            assert_eq!(json["kind"], expected_kind, "kind mismatch for {err}");
            assert_eq!(
                json["message"], expected_message,
                "message mismatch for {err}"
            );
        }
    }

    #[test]
    fn serialize_io_variant_has_correct_kind() {
        let err = AppError::Io(std::io::Error::other("disk full"));
        let json = serde_json::to_value(&err).expect("IO error should serialize");
        assert_eq!(json["kind"], "io", "IO variant kind should be 'io'");
        assert!(
            json["message"].as_str().unwrap_or("").contains("disk full"),
            "IO message should include inner error"
        );
    }

    #[test]
    fn serialize_json_variant_has_correct_kind() {
        let err = AppError::Json(serde_json::from_str::<()>("{bad").unwrap_err());
        let json = serde_json::to_value(&err).expect("JSON error should serialize");
        assert_eq!(json["kind"], "json", "JSON variant kind should be 'json'");
        assert!(
            !json["message"].as_str().unwrap_or("").is_empty(),
            "JSON message should not be empty"
        );
    }

    #[test]
    fn serialize_database_variant_has_correct_kind() {
        let db_err = AppError::Database(sqlx::Error::RowNotFound);
        let json = serde_json::to_value(&db_err).expect("Database error should serialize");
        assert_eq!(json["kind"], "database", "Database variant kind");
        assert!(
            json["message"]
                .as_str()
                .unwrap_or("")
                .contains("Database error"),
            "Database message prefix"
        );
    }

    #[test]
    fn serialize_migration_variant_has_correct_kind() {
        let migrate_err = sqlx::migrate::MigrateError::Execute(sqlx::Error::RowNotFound);
        let app_err = AppError::Migration(migrate_err);
        let json = serde_json::to_value(&app_err).expect("Migration error should serialize");
        assert_eq!(json["kind"], "migration", "Migration variant kind");
        assert!(
            json["message"]
                .as_str()
                .unwrap_or("")
                .contains("Migration error"),
            "Migration message prefix"
        );
    }

    #[test]
    fn serialize_non_reversible_variant_has_correct_kind_and_message() {
        let err = AppError::NonReversible {
            op_type: "purge_block".into(),
        };
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "non_reversible");
        assert!(json["message"].as_str().unwrap().contains("purge_block"));
    }

    #[test]
    fn serialize_produces_exactly_two_fields() {
        let err = AppError::NotFound("x".into());
        let json = serde_json::to_value(&err).unwrap();
        let obj = json
            .as_object()
            .expect("serialized error should be a JSON object");
        assert_eq!(
            obj.len(),
            2,
            "serialized AppError should have exactly 'kind' and 'message'"
        );
        assert!(obj.contains_key("kind"), "missing 'kind' field");
        assert!(obj.contains_key("message"), "missing 'message' field");
    }

    #[test]
    fn serialize_uncoded_validation_keeps_two_field_envelope() {
        // #2251 wire-compat: a Validation error WITHOUT a code must keep the
        // exact legacy `{ kind, message }` shape — the `code` field is
        // omitted (not `null`) so pre-existing JSON is byte-identical.
        let err = AppError::validation(MSG_VALIDATION.into());
        let json = serde_json::to_value(&err).unwrap();
        let obj = json.as_object().expect("object");
        assert_eq!(obj.len(), 2, "uncoded validation must not gain a field");
        assert_eq!(json["kind"], "validation");
        assert_eq!(
            json["message"],
            format!("Validation error: {MSG_VALIDATION}"),
            "uncoded validation message must keep the legacy Display decoration"
        );
    }

    #[test]
    fn serialize_coded_validation_carries_code_and_raw_reason() {
        // #2251 — coded validation errors promote the old `"<Code>: …"`
        // message prefix to a structured `code` field. The message carries
        // ONLY the human reason (no `Validation error:` decoration, no
        // machine prefix).
        let err = AppError::validation_coded(ValidationCode::InvalidRegex, "unclosed group");
        assert_eq!(
            serde_json::to_string(&err).expect("serialize"),
            r#"{"kind":"validation","message":"unclosed group","code":"InvalidRegex"}"#,
        );
    }

    // --- #2251: wire-format pins (typed AppErrorKind / ValidationCode) ---
    //
    // The `kind` discriminant used to be a hand-written `&str` match inside
    // the manual `Serialize` impl. It is now the `AppErrorKind` enum (so the
    // specta binding is a string-literal union); these tests pin every
    // variant's wire string byte-for-byte against the legacy table so the
    // type-level promotion can never drift the JSON reaching the webview.

    #[test]
    fn wire_kind_strings_pinned_for_every_variant() {
        // Exhaustive: one arm per AppErrorKind variant. Adding an AppError
        // variant without extending this table fails the match exhaustively.
        let cases: [(AppErrorKind, &str); 15] = [
            (AppErrorKind::Database, "database"),
            (AppErrorKind::NotFound, "not_found"),
            (AppErrorKind::PoolBusy, "pool_busy"),
            (AppErrorKind::Conflict, "conflict"),
            (AppErrorKind::Migration, "migration"),
            (AppErrorKind::Io, "io"),
            (AppErrorKind::Json, "json"),
            (AppErrorKind::Ulid, "ulid"),
            (AppErrorKind::InvalidOperation, "invalid_operation"),
            (AppErrorKind::Channel, "channel"),
            (AppErrorKind::Internal, "internal"),
            (AppErrorKind::Snapshot, "snapshot"),
            (AppErrorKind::Validation, "validation"),
            (AppErrorKind::NonReversible, "non_reversible"),
            (AppErrorKind::Cancelled, "cancelled"),
        ];
        for (kind, expected) in cases {
            assert_eq!(
                serde_json::to_value(kind).expect("kind serializes"),
                serde_json::Value::String(expected.into()),
                "wire string drift for {kind:?}"
            );
        }
    }

    #[test]
    fn wire_format_pinned_for_every_variant() {
        // Full-envelope pin: for every variant, the serialized JSON string
        // must be IDENTICAL to what the pre-#2251 implementation emitted
        // (`{"kind":"<legacy kind>","message":"<Display output>"}` with that
        // exact field order). Coded validation is the ONE deliberate
        // exception, pinned separately above.
        let io_err = AppError::Io(std::io::Error::other("disk full"));
        let json_err = AppError::Json(serde_json::from_str::<()>("{bad").unwrap_err());
        let migrate_err = AppError::Migration(sqlx::migrate::MigrateError::Execute(
            sqlx::Error::RowNotFound,
        ));
        let db_err = AppError::Database(sqlx::Error::PoolClosed);
        let cases: Vec<(AppError, &str)> = vec![
            (db_err, "database"),
            (AppError::NotFound(MSG_NOT_FOUND.into()), "not_found"),
            (AppError::PoolTimedOut, "pool_busy"),
            (
                AppError::Conflict("UNIQUE constraint failed".into()),
                "conflict",
            ),
            (migrate_err, "migration"),
            (io_err, "io"),
            (json_err, "json"),
            (AppError::Ulid(MSG_ULID.into()), "ulid"),
            (
                AppError::InvalidOperation(MSG_INVALID_OP.into()),
                "invalid_operation",
            ),
            (AppError::Channel(MSG_CHANNEL.into()), "channel"),
            (AppError::Internal(MSG_INTERNAL.into()), "internal"),
            (AppError::Snapshot(MSG_SNAPSHOT.into()), "snapshot"),
            (AppError::validation(MSG_VALIDATION.into()), "validation"),
            (
                AppError::NonReversible {
                    op_type: "purge_block".into(),
                },
                "non_reversible",
            ),
            (AppError::Cancelled, "cancelled"),
        ];
        for (err, legacy_kind) in cases {
            let expected = serde_json::to_string(&serde_json::json!({
                "kind": legacy_kind,
                "message": err.to_string(),
            }))
            .expect("legacy envelope serializes");
            assert_eq!(
                serde_json::to_string(&err).expect("AppError serializes"),
                expected,
                "wire envelope drift for {err:?}"
            );
        }
    }

    #[test]
    fn validation_code_wire_strings_pinned() {
        // The exact strings the old `"<Code>: …"` message prefixes spelled —
        // and the strings the TS `ValidationCode` union in bindings.ts (and
        // its runtime mirror in validation-codes.ts) discriminates on.
        let cases: [(ValidationCode, &str); 5] = [
            (ValidationCode::InvalidGlob, "InvalidGlob"),
            (ValidationCode::InvalidRegex, "InvalidRegex"),
            (ValidationCode::InvalidDateFilter, "InvalidDateFilter"),
            (ValidationCode::InvalidFilter, "InvalidFilter"),
            (ValidationCode::RequiresRefresh, "RequiresRefresh"),
        ];
        for (code, expected) in cases {
            assert_eq!(
                serde_json::to_value(code).expect("code serializes"),
                serde_json::Value::String(expected.into()),
                "wire string drift for {code:?}"
            );
        }
    }

    // --- From impls ---

    #[test]
    fn from_io_error_produces_io_variant() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file missing");
        let app_err: AppError = io_err.into();
        assert!(
            matches!(app_err, AppError::Io(_)),
            "io::Error should convert to AppError::Io"
        );
    }

    #[test]
    fn from_serde_json_error_produces_json_variant() {
        let json_err = serde_json::from_str::<()>("not json").unwrap_err();
        let app_err: AppError = json_err.into();
        assert!(
            matches!(app_err, AppError::Json(_)),
            "serde_json::Error should convert to AppError::Json"
        );
    }

    // --- Issue #106: discriminated From<sqlx::Error> mapping ---
    //
    // These tests pin the routing contract that `impl From<sqlx::Error>
    // for AppError` is required to honour.  If the mapping ever
    // regresses (e.g. someone restores `#[from]` on `Database`), the
    // frontend's `kind`-based switch in `src/lib/errors.ts` silently
    // collapses three previously distinct UX states ("nothing found",
    // "writer busy, try again", "unique violation") back into the
    // generic "an internal error occurred" toast.

    #[test]
    fn from_sqlx_row_not_found_routes_to_not_found_variant() {
        let app_err: AppError = sqlx::Error::RowNotFound.into();
        assert!(
            matches!(app_err, AppError::NotFound(_)),
            "sqlx::Error::RowNotFound must route to AppError::NotFound, got: {app_err:?}"
        );
    }

    #[test]
    fn from_sqlx_pool_timed_out_routes_to_pool_timed_out_variant() {
        let app_err: AppError = sqlx::Error::PoolTimedOut.into();
        assert!(
            matches!(app_err, AppError::PoolTimedOut),
            "sqlx::Error::PoolTimedOut must route to AppError::PoolTimedOut, got: {app_err:?}"
        );
    }

    #[tokio::test]
    async fn from_sqlx_unique_violation_routes_to_conflict_variant() {
        // Drive a real UNIQUE-constraint failure through a throwaway
        // SQLite memory DB so the `is_unique_violation()` discriminator
        // is exercised against the actual driver — not a synthetic
        // `DatabaseError` mock that might lie about its error code.
        let pool = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("memory pool");
        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .expect("create table");
        sqlx::query("INSERT INTO t (id) VALUES (1)")
            .execute(&pool)
            .await
            .expect("first insert");
        let err = sqlx::query("INSERT INTO t (id) VALUES (1)")
            .execute(&pool)
            .await
            .expect_err("duplicate PK insert must fail");
        let app_err = AppError::from(err);
        match app_err {
            AppError::Conflict(msg) => assert!(
                msg.to_lowercase().contains("unique") || msg.to_lowercase().contains("primary"),
                "Conflict payload should mention the constraint, got: {msg}"
            ),
            other => panic!("expected AppError::Conflict, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn from_sqlx_non_unique_db_error_falls_through_to_database_variant() {
        // Edge case spelled out in issue #106: a `Database(...)` SQLite
        // error whose `is_unique_violation()` is *false* (here: a
        // CHECK-constraint failure) must NOT be misrouted to
        // `AppError::Conflict`.  If a future refactor weakens the
        // discriminator (e.g. matches on the message string instead of
        // the code), this test fires.
        let pool = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("memory pool");
        sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER CHECK (n > 0))")
            .execute(&pool)
            .await
            .expect("create table");
        let err = sqlx::query("INSERT INTO t (id, n) VALUES (1, -5)")
            .execute(&pool)
            .await
            .expect_err("CHECK violation must fail");
        let app_err = AppError::from(err);
        assert!(
            matches!(app_err, AppError::Database(_)),
            "non-unique DB error must fall through to AppError::Database, got: {app_err:?}"
        );
    }

    #[test]
    fn from_sqlx_pool_closed_falls_through_to_database_variant() {
        // Belt-and-braces: an arbitrary non-routed sqlx variant must
        // still land on `Database`.  `PoolClosed` is used elsewhere in
        // the codebase (rmcp_spike) as a stable stand-in for "generic
        // SQL failure" — keep that contract pinned.
        let app_err: AppError = sqlx::Error::PoolClosed.into();
        assert!(
            matches!(app_err, AppError::Database(_)),
            "sqlx::Error::PoolClosed must fall through to AppError::Database, got: {app_err:?}"
        );
    }

    #[test]
    fn from_sqlx_configuration_routes_to_database_variant() {
        // #655: the read-pool `query_only` boot assertion surfaces a
        // *configuration* failure (read pool not write-protected). It is
        // raised as `sqlx::Error::Configuration` so it routes to the
        // `database` domain instead of being misattributed to `snapshot`.
        // Pin both the variant and the serialized `kind`.
        let app_err: AppError =
            sqlx::Error::Configuration("read pool failed query_only assertion at boot".into())
                .into();
        assert!(
            matches!(app_err, AppError::Database(_)),
            "sqlx::Error::Configuration must route to AppError::Database, got: {app_err:?}"
        );
        let json = serde_json::to_value(&app_err).expect("Database should serialize");
        assert_eq!(
            json["kind"], "database",
            "a read-pool config failure serializes as kind: 'database', not 'snapshot'"
        );
    }

    // --- Issue #106: serialize the new kinds ---

    #[test]
    fn serialize_pool_timed_out_variant_has_pool_busy_kind() {
        let err = AppError::PoolTimedOut;
        let json = serde_json::to_value(&err).expect("PoolTimedOut should serialize");
        assert_eq!(
            json["kind"], "pool_busy",
            "PoolTimedOut serializes as kind: 'pool_busy' (not 'pool_timed_out') to match the frontend contract"
        );
        assert!(
            json["message"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .contains("pool"),
            "PoolTimedOut message should reference the pool"
        );
    }

    #[test]
    fn serialize_conflict_variant_has_conflict_kind() {
        let err = AppError::Conflict("UNIQUE constraint failed: attachments.fs_path".into());
        let json = serde_json::to_value(&err).expect("Conflict should serialize");
        assert_eq!(json["kind"], "conflict", "Conflict kind");
        assert!(
            json["message"]
                .as_str()
                .unwrap_or("")
                .contains("UNIQUE constraint failed"),
            "Conflict message should preserve the driver's constraint description"
        );
    }

    #[test]
    fn serialize_not_found_from_sqlx_has_not_found_kind() {
        // Round-trip: lift a sqlx error through From, then serialize.
        // Confirms the IPC `kind` discrimination survives the full path.
        let app_err: AppError = sqlx::Error::RowNotFound.into();
        let json = serde_json::to_value(&app_err).expect("NotFound should serialize");
        assert_eq!(json["kind"], "not_found");
    }

    // --- Debug ---

    #[test]
    fn debug_output_includes_variant_name() {
        let err = AppError::NotFound(MSG_NOT_FOUND.into());
        let debug = format!("{err:?}");
        assert!(
            debug.contains("NotFound"),
            "Debug output should include variant name, got: {debug}"
        );
    }

    #[test]
    fn debug_output_includes_inner_message() {
        let err = AppError::validation(MSG_VALIDATION.into());
        let debug = format!("{err:?}");
        assert!(
            debug.contains(MSG_VALIDATION),
            "Debug output should include inner message, got: {debug}"
        );
    }

    // --- source() chain (std::error::Error) ---

    #[test]
    fn source_returns_inner_for_database_variant() {
        use std::error::Error;
        let err = AppError::Database(sqlx::Error::RowNotFound);
        assert!(
            err.source().is_some(),
            "Database variant should expose inner sqlx::Error via source()"
        );
    }

    #[test]
    fn source_returns_inner_for_io_variant() {
        use std::error::Error;
        let err = AppError::Io(std::io::Error::other("disk full"));
        assert!(
            err.source().is_some(),
            "Io variant should expose inner io::Error via source()"
        );
    }

    #[test]
    fn source_returns_inner_for_json_variant() {
        use std::error::Error;
        let err = AppError::Json(serde_json::from_str::<()>("{bad").unwrap_err());
        assert!(
            err.source().is_some(),
            "Json variant should expose inner serde_json::Error via source()"
        );
    }

    #[test]
    fn source_returns_none_for_string_variants() {
        use std::error::Error;
        let cases: Vec<AppError> = vec![
            AppError::Ulid(MSG_ULID.into()),
            AppError::NotFound(MSG_NOT_FOUND.into()),
            AppError::InvalidOperation(MSG_INVALID_OP.into()),
            AppError::Channel(MSG_CHANNEL.into()),
            AppError::Snapshot(MSG_SNAPSHOT.into()),
            AppError::validation(MSG_VALIDATION.into()),
            AppError::NonReversible {
                op_type: "purge_block".into(),
            },
        ];
        for err in cases {
            assert!(
                err.source().is_none(),
                "String-only variant {err:?} should return None from source()"
            );
        }
    }
}
