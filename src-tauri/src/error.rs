use serde::Serialize;
use thiserror::Error;

/// Helper struct matching the `{ kind, message }` JSON shape that [`AppError`]
/// serialises to.  Used solely so specta can derive the TypeScript type for
/// `AppError` — the real serialisation is still handled by the manual
/// `Serialize` impl below.
#[derive(Serialize, specta::Type)]
#[serde(rename = "AppError")]
#[allow(dead_code)] // Fields are read by specta's Type derive macro, not directly
struct AppErrorSchema {
    kind: String,
    message: String,
}

/// HTTP-layer error taxonomy for Google Calendar API calls (FEAT-5c).
///
/// Returned from the stateless API client in `gcal_push::api`.  Callers
/// (FEAT-5e connector) decide per-variant whether to retry, surface a
/// `gcal:reauth_required` event, disable push, drop a map row, etc.
///
/// # Redaction
///
/// `Display` / `Debug` impls MUST NOT embed the OAuth access token.
/// None of the variants carry a `Token`, so the `thiserror`-derived
/// impls satisfy this by construction.  The `api.rs` public functions
/// use `#[tracing::instrument(skip(token), err)]` for belt-and-braces
/// span-level non-leakage (the `Token` type's `Debug` impl already
/// redacts via `secrecy::SecretString`).
///
/// # Wire format
///
/// Travels over Tauri IPC nested inside [`AppError::Gcal`], which
/// serialises as `{ kind: "gcal", message: "<display string>" }`.  The
/// frontend does not currently discriminate between sub-kinds over IPC
/// (the display string is sufficient for the Settings toast / banner).
/// If future UX needs distinct frontend behaviour per sub-kind, extend
/// the manual `Serialize` impl on `AppError` to emit a structured
/// `gcal_kind` field without relaxing the serialization contract.
#[derive(Debug, Error, Serialize, specta::Type, Clone, PartialEq, Eq)]
#[serde(tag = "kind", content = "message")]
pub enum GcalErrorKind {
    /// HTTP 401 — access token expired or revoked.  Callers refresh
    /// via [`crate::gcal_push::oauth::fetch_with_auto_refresh`] and,
    /// on a second 401, emit `gcal:reauth_required`.
    #[error("unauthorized (token expired or revoked)")]
    Unauthorized,

    /// HTTP 403 — scope mismatch or calendar ACL rejection.
    /// Callers typically disable push and surface a settings error.
    #[error("forbidden: {0}")]
    Forbidden(String),

    /// HTTP 429 — Google's per-user / per-project quota hit.  The
    /// `retry_after_ms` is parsed from the `Retry-After` header when
    /// present; when absent, defaults to 1000 ms.  Callers sleep then
    /// retry (FEAT-5e's retry taxonomy).
    #[error("rate limited; retry after {retry_after_ms}ms")]
    RateLimited { retry_after_ms: u64 },

    /// HTTP 5xx — upstream failure.  Callers retry with backoff.
    #[error("server error: HTTP {status}")]
    ServerError { status: u16 },

    /// HTTP 404 on a `calendars/{calendar_id}` path.  Distinct from
    /// [`GcalErrorKind::EventGone`] because the recovery is different:
    /// the dedicated "Agaric Agenda" calendar was deleted externally
    /// by the user → clear all `gcal_agenda_event_map` rows and
    /// re-create the calendar on next push cycle.
    #[error("dedicated calendar was deleted by the user externally")]
    CalendarGone,

    /// HTTP 404 on an event path.  Returned by `delete_event` /
    /// `patch_event` when the event row was deleted in the GCal UI.
    /// Callers drop the map row and re-create on next push.
    #[error("event was deleted externally")]
    EventGone,

    /// HTTP 400 (malformed body) or HTTP 409 (conflict — duplicate id,
    /// concurrent edit).  Callers fix the request and retry; not
    /// transient.
    #[error("invalid request: {0}")]
    InvalidRequest(String),
}

/// Application-level error type covering all expected failure modes.
///
/// Implements `Serialize` so it can be used directly as the error type in
/// `#[tauri::command]` handlers — the idiomatic Tauri 2 pattern.
/// The frontend receives `{ kind: string, message: string }`.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Migration error: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("ULID error: {0}")]
    Ulid(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Invalid operation: {0}")]
    InvalidOperation(String),

    #[error("Channel error: {0}")]
    Channel(String),

    #[error("Snapshot error: {0}")]
    Snapshot(String),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("Non-reversible operation: {op_type} cannot be undone")]
    NonReversible { op_type: String },

    /// Google Calendar API HTTP-layer error (FEAT-5c).  See
    /// [`GcalErrorKind`] for the full taxonomy.  The `#[from]` impl
    /// lets `api.rs` bubble `Err(GcalErrorKind::…)` through `?`.
    #[error(transparent)]
    Gcal(#[from] GcalErrorKind),
}

/// Tauri 2 requires command error types to implement `Serialize`.
/// We serialize as `{ kind, message }` so the frontend can match on `kind`.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        use serde::ser::SerializeStruct;

        let kind = match self {
            AppError::Database(_) => "database",
            AppError::Migration(_) => "migration",
            AppError::Io(_) => "io",
            AppError::Json(_) => "json",
            AppError::Ulid(_) => "ulid",
            AppError::NotFound(_) => "not_found",
            AppError::InvalidOperation(_) => "invalid_operation",
            AppError::Channel(_) => "channel",
            AppError::Snapshot(_) => "snapshot",
            AppError::Validation(_) => "validation",
            AppError::NonReversible { .. } => "non_reversible",
            AppError::Gcal(_) => "gcal",
        };

        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

/// Forward specta's type introspection to [`AppErrorSchema`] so that the
/// generated TypeScript type matches the `{ kind, message }` JSON shape
/// produced by the manual `Serialize` impl above.
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
        let err = AppError::Validation(MSG_VALIDATION.into());
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
                AppError::Validation(MSG_VALIDATION.into()),
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
        let err = AppError::Validation(MSG_VALIDATION.into());
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
            AppError::Validation(MSG_VALIDATION.into()),
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

    // --- GcalErrorKind (FEAT-5c) ---

    #[test]
    fn gcal_error_kind_display_unauthorized() {
        let err = GcalErrorKind::Unauthorized;
        assert_eq!(
            err.to_string(),
            "unauthorized (token expired or revoked)",
            "Unauthorized Display should not embed any token material"
        );
    }

    #[test]
    fn gcal_error_kind_display_forbidden_includes_reason() {
        let err = GcalErrorKind::Forbidden("scope mismatch".into());
        assert_eq!(err.to_string(), "forbidden: scope mismatch");
    }

    #[test]
    fn gcal_error_kind_display_rate_limited_includes_retry_after_ms() {
        let err = GcalErrorKind::RateLimited {
            retry_after_ms: 5_000,
        };
        assert_eq!(err.to_string(), "rate limited; retry after 5000ms");
    }

    #[test]
    fn gcal_error_kind_display_server_error_includes_status() {
        let err = GcalErrorKind::ServerError { status: 503 };
        assert_eq!(err.to_string(), "server error: HTTP 503");
    }

    #[test]
    fn gcal_error_kind_display_calendar_gone() {
        let err = GcalErrorKind::CalendarGone;
        assert_eq!(
            err.to_string(),
            "dedicated calendar was deleted by the user externally"
        );
    }

    #[test]
    fn gcal_error_kind_display_event_gone() {
        let err = GcalErrorKind::EventGone;
        assert_eq!(err.to_string(), "event was deleted externally");
    }

    #[test]
    fn gcal_error_kind_display_invalid_request() {
        let err = GcalErrorKind::InvalidRequest("missing field 'summary'".into());
        assert_eq!(err.to_string(), "invalid request: missing field 'summary'");
    }

    #[test]
    fn gcal_error_kind_debug_does_not_leak_imaginary_token() {
        // Defence-in-depth: no variant carries a token, so Debug cannot
        // leak one.  This pins that invariant — if a future refactor
        // adds a token-bearing variant, the test must be extended.
        let err = GcalErrorKind::Forbidden("anything".into());
        let debug = format!("{err:?}");
        assert!(
            !debug.to_lowercase().contains("bearer"),
            "GcalErrorKind Debug must not embed anything bearer-like, got: {debug}"
        );
    }

    #[test]
    fn from_gcal_error_kind_produces_gcal_variant() {
        let err: AppError = GcalErrorKind::Unauthorized.into();
        assert!(
            matches!(err, AppError::Gcal(GcalErrorKind::Unauthorized)),
            "GcalErrorKind should convert to AppError::Gcal via #[from]"
        );
    }

    #[test]
    fn serialize_gcal_variant_has_gcal_kind() {
        let err = AppError::Gcal(GcalErrorKind::Unauthorized);
        let json = serde_json::to_value(&err).expect("Gcal error should serialize");
        assert_eq!(json["kind"], "gcal", "Gcal variant kind should be 'gcal'");
        assert_eq!(
            json["message"], "unauthorized (token expired or revoked)",
            "Gcal message should mirror inner Display"
        );
    }

    #[test]
    fn serialize_gcal_rate_limited_propagates_retry_after_in_message() {
        let err = AppError::Gcal(GcalErrorKind::RateLimited {
            retry_after_ms: 1_500,
        });
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "gcal");
        assert_eq!(json["message"], "rate limited; retry after 1500ms");
    }

    #[test]
    fn display_gcal_variant_is_transparent_over_inner_kind() {
        // `#[error(transparent)]` means Gcal's Display output is the
        // inner GcalErrorKind Display unchanged.  This keeps frontend
        // strings stable regardless of whether a call site returns a
        // bare GcalErrorKind or wraps it in AppError::Gcal.
        let inner = GcalErrorKind::CalendarGone;
        let wrapped = AppError::Gcal(inner.clone());
        assert_eq!(wrapped.to_string(), inner.to_string());
    }
}
