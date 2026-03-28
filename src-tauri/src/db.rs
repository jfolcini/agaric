use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;
use std::path::Path;

/// Initialize the SQLite database with WAL mode and appropriate pool settings.
/// Single write connection, read pool for concurrent readers.
///
/// Enables `PRAGMA foreign_keys = ON` on every connection — SQLite does NOT
/// enforce FK constraints by default, so this is mandatory.
pub async fn init_pool(db_path: &Path) -> Result<SqlitePool, crate::error::AppError> {
    let connect_options = SqliteConnectOptions::new()
        .filename(db_path)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .create_if_missing(true)
        .pragma("foreign_keys", "ON");

    let pool = SqlitePoolOptions::new()
        .max_connections(5) // 1 writer + 4 readers under WAL
        .connect_with(connect_options)
        .await?;

    // Run migrations
    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(pool)
}
