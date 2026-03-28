use serde::Serialize;
use thiserror::Error;

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

    #[error("Validation error: {0}")]
    Validation(String),
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
            AppError::Validation(_) => "validation",
        };

        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_not_found_error() {
        let err = AppError::NotFound("test".into());
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "not_found");
        assert_eq!(json["message"], "Not found: test");
    }

    #[test]
    fn serialize_all_constructible_variants() {
        let cases: Vec<(AppError, &str)> = vec![
            (AppError::Ulid("bad".into()), "ulid"),
            (AppError::NotFound("x".into()), "not_found"),
            (AppError::InvalidOperation("y".into()), "invalid_operation"),
            (AppError::Channel("z".into()), "channel"),
            (AppError::Validation("v".into()), "validation"),
            (AppError::Io(std::io::Error::other("io")), "io"),
            (
                AppError::Json(serde_json::from_str::<()>("bad").unwrap_err()),
                "json",
            ),
        ];
        for (err, expected_kind) in cases {
            let json = serde_json::to_value(&err).unwrap();
            assert_eq!(json["kind"], expected_kind, "kind mismatch for {}", err);
            assert!(!json["message"].as_str().unwrap().is_empty());
        }
    }

    #[test]
    fn display_format() {
        let err = AppError::NotFound("block 'abc'".into());
        assert_eq!(err.to_string(), "Not found: block 'abc'");
    }

    #[test]
    fn display_format_all_variants() {
        assert_eq!(
            AppError::Ulid("bad ulid".into()).to_string(),
            "ULID error: bad ulid"
        );
        assert_eq!(
            AppError::InvalidOperation("nope".into()).to_string(),
            "Invalid operation: nope"
        );
        assert_eq!(
            AppError::Channel("closed".into()).to_string(),
            "Channel error: closed"
        );
        assert_eq!(
            AppError::Validation("missing field".into()).to_string(),
            "Validation error: missing field"
        );
        let io_err = AppError::Io(std::io::Error::other("disk full"));
        assert!(io_err.to_string().contains("disk full"));
        let json_err = AppError::Json(serde_json::from_str::<()>("bad").unwrap_err());
        assert!(json_err.to_string().contains("JSON error"));
    }

    #[test]
    fn from_io_error() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file missing");
        let app_err: AppError = io_err.into();
        assert!(matches!(app_err, AppError::Io(_)));
    }

    #[test]
    fn from_serde_json_error() {
        let json_err = serde_json::from_str::<()>("invalid json").unwrap_err();
        let app_err: AppError = json_err.into();
        assert!(matches!(app_err, AppError::Json(_)));
    }
}
