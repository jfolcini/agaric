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
        };

        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

/// Serializable error DTO for Tauri command responses.
/// Retained as an explicit DTO for contexts where a plain struct is preferred
/// over serializing the enum directly (e.g., logging, tests).
#[derive(Debug, Serialize)]
pub struct CommandError {
    pub message: String,
    pub kind: String,
}

impl From<AppError> for CommandError {
    fn from(err: AppError) -> Self {
        let kind = match &err {
            AppError::Database(_) => "database",
            AppError::Migration(_) => "migration",
            AppError::Io(_) => "io",
            AppError::Json(_) => "json",
            AppError::Ulid(_) => "ulid",
            AppError::NotFound(_) => "not_found",
            AppError::InvalidOperation(_) => "invalid_operation",
            AppError::Channel(_) => "channel",
        };
        CommandError {
            message: err.to_string(),
            kind: kind.to_string(),
        }
    }
}

// Make CommandError usable as a Tauri command error
impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}
