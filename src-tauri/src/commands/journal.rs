//! Journal command handlers — daily page navigation.

use chrono::NaiveDate;
use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use crate::db::WritePool;
use crate::device::DeviceId;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::pagination::BlockRow;

use super::sanitize_internal_error;
use super::*;

/// Open today's journal page, creating it if it does not exist.
///
/// Returns the [`BlockRow`] for a `page` block whose content is today's date
/// in `YYYY-MM-DD` format.  The lookup is idempotent: calling this multiple
/// times on the same day always returns the same page.
pub async fn today_journal_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) -> Result<BlockRow, AppError> {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    navigate_journal_inner(pool, device_id, materializer, today).await
}

/// Open the journal page for a specific date, creating it if it does not exist.
///
/// `date` must be in `YYYY-MM-DD` format.  If a `page` block with that exact
/// content already exists (and is not deleted), its [`BlockRow`] is returned.
/// Otherwise a new page block is created.
///
/// Thin delegator to [`resolve_or_create_journal_page`] — kept as a named
/// public symbol so existing call sites (Tauri command wrapper,
/// [`today_journal_inner`], the command-integration tests) continue to
/// compile unchanged. New code (MCP `journal_for_date` tool, FEAT-4c) should
/// prefer [`journal_for_date_inner`].
///
/// # Errors
///
/// - [`AppError::Validation`] — `date` is not a valid `YYYY-MM-DD` string
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn navigate_journal_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    date: String,
) -> Result<BlockRow, AppError> {
    resolve_or_create_journal_page(pool, device_id, materializer, &date).await
}

/// Typed-date variant of the journal-for-date lookup used by the FEAT-4c
/// MCP `journal_for_date` tool.
///
/// Takes a parsed [`NaiveDate`] rather than a string so MCP callers can
/// surface the parse error with a tool-specific message. Delegates to the
/// same [`resolve_or_create_journal_page`] helper as
/// [`navigate_journal_inner`] and [`today_journal_inner`] — all three call
/// sites share one implementation so behaviour cannot drift between the
/// frontend and the MCP surface.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn journal_for_date_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    date: NaiveDate,
) -> Result<BlockRow, AppError> {
    let formatted = date.format("%Y-%m-%d").to_string();
    resolve_or_create_journal_page(pool, device_id, materializer, &formatted).await
}

/// Shared date → journal-page lookup used by every `*_journal_inner`
/// variant. Centralises the existing-page probe + missing-page create
/// so future bug fixes / behaviour changes apply uniformly.
///
/// Validates the date format, then queries `blocks` for an existing
/// non-deleted `page` whose `content` exactly matches `date`. Creates a
/// new page block on miss via [`create_block_in_tx`] so op-log + cache
/// invariants are preserved.
///
/// # M-22 — TOCTOU race fix
///
/// The lookup-then-create sequence runs inside a single
/// `BEGIN IMMEDIATE` transaction so concurrent IPC calls serialise on
/// the SQLite writer lock. Without this, two near-simultaneous calls
/// could both observe "missing" via SELECT and both INSERT a duplicate
/// journal page for the same date. With `BEGIN IMMEDIATE`, the second
/// caller blocks until the first commits; its SELECT then sees the
/// newly-created page and returns it instead of creating a duplicate.
///
/// # Errors
///
/// - [`AppError::Validation`] — `date` is not `YYYY-MM-DD`.
async fn resolve_or_create_journal_page(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    date: &str,
) -> Result<BlockRow, AppError> {
    validate_date_format(date)?;

    // M-22: BEGIN IMMEDIATE eagerly acquires the writer lock, serialising
    // concurrent calls for the same date so the SELECT and the eventual
    // INSERT are atomic with respect to each other.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Look for an existing page whose content matches the date exactly.
    let existing: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                  is_conflict as "is_conflict: bool", conflict_type,
                  todo_state, priority, due_date, scheduled_date, page_id
           FROM blocks
           WHERE block_type = 'page' AND content = ? AND deleted_at IS NULL
           LIMIT 1"#,
        date
    )
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(row) = existing {
        // Found it — release the writer lock and return without creating.
        tx.commit().await?;
        return Ok(row);
    }

    // No existing page — create one inside the SAME transaction so the
    // SELECT + INSERT pair is atomic. Concurrent callers that lost the
    // race will block on `BEGIN IMMEDIATE` above; once we commit, their
    // SELECT will observe this new page and they will fall through the
    // `if let Some(row)` branch above instead of inserting a duplicate.
    let (block, op_record) = create_block_in_tx(
        &mut tx,
        device_id,
        "page".into(),
        date.to_string(),
        None,
        None,
    )
    .await?;

    tx.commit().await?;

    // Fire-and-forget background cache dispatch (mirrors the
    // post-commit dispatch in `create_block_inner`).
    materializer.dispatch_background_or_warn(&op_record);

    Ok(block)
}

/// FEAT-12 — Quick-capture a single content block onto today's journal page.
///
/// Resolves today's journal page (creating it if it doesn't exist via
/// [`today_journal_inner`]) and then appends a new `content` block as a
/// child of that page. Used by the global-shortcut quick-capture flow:
/// the user fires the OS hotkey from anywhere, types into a small modal,
/// and the captured line lands at the bottom of today's journal — no
/// navigation, no clicks.
///
/// Calling this twice on the same day appends two distinct blocks (matches
/// the existing `create_block` semantic). The function is idempotent at
/// the journal-page level — only the first call on a given day creates
/// the page; subsequent calls reuse it.
///
/// # Errors
///
/// - [`AppError::Validation`] — `content` exceeds the per-block size cap
///   enforced by [`create_block_inner`].
/// - Other [`AppError`] variants propagated from
///   [`today_journal_inner`] / [`create_block_inner`] (e.g. DB I/O).
#[instrument(skip(pool, device_id, materializer, content), err)]
pub async fn quick_capture_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    content: String,
) -> Result<BlockRow, AppError> {
    let page = today_journal_inner(pool, device_id, materializer).await?;
    create_block_inner(
        pool,
        device_id,
        materializer,
        "content".into(),
        content,
        Some(page.id),
        None,
    )
    .await
}

/// Tauri command: quick-capture a single content block onto today's
/// journal page. Delegates to [`quick_capture_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn quick_capture_block(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    content: String,
) -> Result<BlockRow, AppError> {
    quick_capture_block_inner(&pool.0, device_id.as_str(), &materializer, content)
        .await
        .map_err(sanitize_internal_error)
}

#[cfg(test)]
mod tests {
    //! Unit tests for the journal command surface — focused on the M-22
    //! TOCTOU fix in [`resolve_or_create_journal_page`]. The broader
    //! contract (today_journal/navigate_journal idempotency, quick-capture
    //! happy path) is covered by the `command_integration_tests/page_integration`
    //! module; the tests here exercise the private resolver directly so
    //! the regression guard for the duplicate-page race lives next to the
    //! code it protects.
    use super::*;
    use crate::db::init_pool;
    use crate::materializer::Materializer;
    use std::path::PathBuf;
    use std::sync::Arc;
    use tempfile::TempDir;
    use tokio::task::JoinSet;

    const DEV: &str = "journal-test-device-001";
    const TEST_DATE: &str = "2025-04-15";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Count non-deleted journal pages whose content matches `date`.
    /// Used by the M-22 regression test to assert exactly one page was
    /// created across N concurrent callers.
    async fn count_journal_pages_for_date(pool: &SqlitePool, date: &str) -> i64 {
        sqlx::query_scalar!(
            r#"SELECT COUNT(*) as "count: i64" FROM blocks
               WHERE block_type = 'page' AND content = ? AND deleted_at IS NULL"#,
            date
        )
        .fetch_one(pool)
        .await
        .unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn journal_page_resolve_returns_existing_when_present() {
        // Pre-seed a journal page for TEST_DATE (via the same resolver so
        // the page is created through the normal op-log path), then call
        // the resolver again and assert it returns the same page id
        // without creating a duplicate.
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let first = resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let second = resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(
            first.id, second.id,
            "second resolve must return the existing journal page id"
        );
        assert_eq!(
            count_journal_pages_for_date(&pool, TEST_DATE).await,
            1,
            "exactly one journal page must exist for {TEST_DATE} after two resolves"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn journal_page_resolve_creates_when_missing() {
        // Empty DB: first call creates the page; second call returns the
        // same id without inserting a duplicate.
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Sanity: no journal page yet.
        assert_eq!(
            count_journal_pages_for_date(&pool, TEST_DATE).await,
            0,
            "empty DB must have zero journal pages for {TEST_DATE}"
        );

        let first = resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(first.block_type, "page");
        assert_eq!(first.content.as_deref(), Some(TEST_DATE));
        assert!(first.deleted_at.is_none());

        let second = resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(
            first.id, second.id,
            "calling resolve_or_create twice on the same date must be idempotent"
        );
        assert_eq!(
            count_journal_pages_for_date(&pool, TEST_DATE).await,
            1,
            "idempotent resolve must leave exactly one journal page in the DB"
        );

        mat.shutdown();
    }

    /// M-22 regression guard.
    ///
    /// Spawns three concurrent `resolve_or_create_journal_page` calls for
    /// the same date and asserts:
    ///   1. all three return the same page id, and
    ///   2. exactly one journal page exists in the DB.
    ///
    /// Pre-fix this would race in the SELECT→INSERT window and produce
    /// two or three distinct pages with identical title. Post-fix the
    /// `BEGIN IMMEDIATE` writer-lock serialisation ensures the second/third
    /// caller's SELECT sees the page committed by the first and skips
    /// the create branch.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn journal_page_resolve_concurrent_calls_create_one_page() {
        let (pool, _dir) = test_pool().await;
        let mat = Arc::new(Materializer::new(pool.clone()));

        let mut set: JoinSet<Result<BlockRow, AppError>> = JoinSet::new();
        for _ in 0..3 {
            let pool = pool.clone();
            let mat = Arc::clone(&mat);
            set.spawn(
                async move { resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE).await },
            );
        }

        let mut ids: Vec<String> = Vec::with_capacity(3);
        while let Some(joined) = set.join_next().await {
            let row = joined
                .expect("task panicked")
                .expect("resolver returned error");
            assert_eq!(row.content.as_deref(), Some(TEST_DATE));
            ids.push(row.id);
        }
        assert_eq!(
            ids.len(),
            3,
            "all three concurrent tasks must have completed"
        );

        // Drain background materializer work before counting so any
        // pending derived-state writes settle deterministically.
        mat.flush_background().await.unwrap();

        let first_id = ids[0].clone();
        for id in &ids {
            assert_eq!(
                id, &first_id,
                "M-22: all concurrent resolves must return the same page id, got {ids:?}"
            );
        }

        let count = count_journal_pages_for_date(&pool, TEST_DATE).await;
        assert_eq!(
            count, 1,
            "M-22 regression: exactly ONE journal page must exist for {TEST_DATE} after \
             three concurrent resolves, got {count} (ids = {ids:?})"
        );

        // Belt-and-braces: there must also be exactly one CreateBlock op
        // for a page block whose payload content equals TEST_DATE. If the
        // TOCTOU race re-emerged we would see 2 or 3 ops here even if
        // some unique constraint masked the duplicate row.
        let op_count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) as \"c: i64\" FROM op_log \
             WHERE op_type = 'create_block' \
             AND json_extract(payload, '$.block_type') = 'page' \
             AND json_extract(payload, '$.content') = ?",
            TEST_DATE
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            op_count, 1,
            "M-22 regression: exactly ONE create_block op for the journal page must \
             be in the op_log, got {op_count}"
        );

        // Drop the Arc<Materializer> so we own the inner value to call
        // shutdown(). `Arc::try_unwrap` is fine here — all spawned tasks
        // have already completed by this point.
        match Arc::try_unwrap(mat) {
            Ok(mat) => mat.shutdown(),
            Err(_) => panic!("materializer Arc still has outstanding refs after JoinSet drained"),
        }
    }
}
