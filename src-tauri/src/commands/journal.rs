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

/// Open today's journal page in `space_id`, creating it if it does not exist.
///
/// Returns the [`BlockRow`] for a `page` block whose content is today's date
/// in `YYYY-MM-DD` format AND whose `space` ref property points at
/// `space_id`. The lookup is idempotent per-space: calling this multiple
/// times on the same day with the same space always returns the same page.
///
/// FEAT-3p5 — daily journal pages are scoped per-space (J1). Two devices
/// in different spaces both create today's journal page without colliding
/// because the `(content, space)` pair is the unique key, not just
/// `content`.
pub async fn today_journal_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
) -> Result<BlockRow, AppError> {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    navigate_journal_inner(pool, device_id, materializer, today, space_id).await
}

/// Open the journal page for a specific date in `space_id`, creating it
/// if it does not exist.
///
/// `date` must be in `YYYY-MM-DD` format. If a `page` block with that
/// exact content already exists in `space_id` (and is not deleted, not a
/// conflict copy), its [`BlockRow`] is returned. Otherwise a new page
/// block is created with its `space` property atomically set in the
/// same `BEGIN IMMEDIATE` transaction.
///
/// Thin delegator to [`resolve_or_create_journal_page`] — kept as a named
/// public symbol so existing call sites (Tauri command wrapper,
/// [`today_journal_inner`], the command-integration tests) continue to
/// compile unchanged. New code (MCP `journal_for_date` tool, FEAT-4c) should
/// prefer [`journal_for_date_inner`].
///
/// # Errors
///
/// - [`AppError::Validation`] — `date` is not a valid `YYYY-MM-DD` string,
///   or `space_id` does not refer to a live space block.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn navigate_journal_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    date: String,
    space_id: &str,
) -> Result<BlockRow, AppError> {
    resolve_or_create_journal_page(pool, device_id, materializer, &date, space_id).await
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
///
/// FEAT-3p5 — `space_id` is required to scope the journal lookup.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn journal_for_date_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    date: NaiveDate,
    space_id: &str,
) -> Result<BlockRow, AppError> {
    let formatted = date.format("%Y-%m-%d").to_string();
    resolve_or_create_journal_page(pool, device_id, materializer, &formatted, space_id).await
}

/// Shared date → journal-page lookup used by every `*_journal_inner`
/// variant. Centralises the existing-page probe + missing-page create
/// so future bug fixes / behaviour changes apply uniformly.
///
/// Validates the date format and `space_id`, then queries `blocks` for
/// an existing non-deleted, non-conflict `page` whose `content` exactly
/// matches `date` AND whose `space` ref property points at `space_id`.
/// Creates a new page block on miss using the same atomic
/// `CreateBlock` + `SetProperty(space)` pattern as
/// [`crate::commands::create_page_in_space_inner`] so the new page
/// never exists in the op log without its `space` property — the
/// FEAT-3 invariant "nothing outside of spaces".
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
/// # FEAT-3p5 — per-space lookup
///
/// The lookup query joins `blocks` against `block_properties` filtering
/// `key = 'space' AND value_ref = <space_id>`. The same date can therefore
/// have a distinct journal page in every space — switching space takes
/// the user to that space's daily note, not a shared global note.
///
/// # Errors
///
/// - [`AppError::Validation`] — `date` is not `YYYY-MM-DD`, or `space_id`
///   does not refer to a live space block (`is_space = 'true'`).
async fn resolve_or_create_journal_page(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    date: &str,
    space_id: &str,
) -> Result<BlockRow, AppError> {
    validate_date_format(date)?;

    // M-22: BEGIN IMMEDIATE eagerly acquires the writer lock, serialising
    // concurrent calls for the same date so the SELECT and the eventual
    // INSERT are atomic with respect to each other.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // FEAT-3p5: look for an existing page whose content matches the date
    // exactly AND whose `space` ref property points at the requested
    // space. Two spaces with the same date keep distinct daily notes.
    let existing: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position, b.deleted_at,
                  b.is_conflict as "is_conflict: bool", b.conflict_type,
                  b.todo_state, b.priority, b.due_date, b.scheduled_date, b.page_id
           FROM blocks b
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.is_conflict = 0
             AND b.content = ?
             AND EXISTS (
                 SELECT 1 FROM block_properties bp
                 WHERE bp.block_id = b.id
                   AND bp.key = 'space'
                   AND bp.value_ref = ?
             )
           LIMIT 1"#,
        date,
        space_id,
    )
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(row) = existing {
        // Found it — release the writer lock and return without creating.
        tx.commit().await?;
        return Ok(row);
    }

    // FEAT-3p5: validate `space_id` upfront inside the tx (TOCTOU-safe
    // against a concurrent space delete). The target must exist as a
    // live, non-conflict block AND carry `is_space = 'true'`. Mirrors
    // the check in `create_page_in_space_inner`.
    let space_ok = sqlx::query_scalar!(
        r#"SELECT 1 as "ok: i32" FROM blocks b
           WHERE b.id = ?
             AND b.deleted_at IS NULL
             AND b.is_conflict = 0
             AND EXISTS (
                 SELECT 1 FROM block_properties p
                 WHERE p.block_id = b.id
                   AND p.key = 'is_space'
                   AND p.value_text = 'true'
             )"#,
        space_id,
    )
    .fetch_optional(&mut *tx)
    .await?;
    if space_ok.is_none() {
        return Err(AppError::Validation(format!(
            "space_id '{space_id}' does not refer to a live space block (is_space = 'true')"
        )));
    }

    // No existing page — create one inside the SAME transaction so the
    // SELECT + INSERT pair is atomic. Concurrent callers that lost the
    // race will block on `BEGIN IMMEDIATE` above; once we commit, their
    // SELECT will observe this new page and they will fall through the
    // `if let Some(row)` branch above instead of inserting a duplicate.
    //
    // FEAT-3p5: emit the same `CreateBlock` + `SetProperty(space=<sid>)`
    // op pair as `create_page_in_space_inner` so a sync peer materializes
    // the new daily page with its space property in one step. We inline
    // the two helpers (rather than calling `create_page_in_space_inner`)
    // because that helper opens its own `BEGIN IMMEDIATE` and we must
    // keep the SELECT + INSERT pair atomic in *this* transaction.
    let (block, page_op_record) = create_block_in_tx(
        &mut tx,
        device_id,
        "page".into(),
        date.to_string(),
        None,
        None,
    )
    .await?;

    let (_block_after_prop, space_op_record) = set_property_in_tx(
        &mut tx,
        device_id,
        block.id.clone(),
        "space",
        None,
        None,
        None,
        Some(space_id.to_string()),
    )
    .await?;

    tx.commit().await?;

    // Fire-and-forget background cache dispatch for both ops (mirrors the
    // post-commit dispatch in `create_page_in_space`).
    materializer.dispatch_background_or_warn(&page_op_record);
    materializer.dispatch_background_or_warn(&space_op_record);

    Ok(block)
}

/// FEAT-12 — Quick-capture a single content block onto today's journal page.
///
/// Resolves today's journal page in `space_id` (creating it if it doesn't
/// exist via [`today_journal_inner`]) and then appends a new `content`
/// block as a child of that page. Used by the global-shortcut quick-
/// capture flow: the user fires the OS hotkey from anywhere, types into a
/// small modal, and the captured line lands at the bottom of today's
/// journal in the active space — no navigation, no clicks.
///
/// Calling this twice on the same day appends two distinct blocks (matches
/// the existing `create_block` semantic). The function is idempotent at
/// the journal-page level — only the first call on a given day creates
/// the page; subsequent calls reuse it.
///
/// FEAT-3p5 — `space_id` is required to scope the capture to a single
/// space. Two devices sharing the same OS hotkey but bound to different
/// spaces will append into their own daily notes without colliding.
///
/// # Errors
///
/// - [`AppError::Validation`] — `content` exceeds the per-block size cap
///   enforced by [`create_block_inner`], or `space_id` does not refer to
///   a live space block.
/// - Other [`AppError`] variants propagated from
///   [`today_journal_inner`] / [`create_block_inner`] (e.g. DB I/O).
#[instrument(skip(pool, device_id, materializer, content), err)]
pub async fn quick_capture_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    content: String,
    space_id: &str,
) -> Result<BlockRow, AppError> {
    let page = today_journal_inner(pool, device_id, materializer, space_id).await?;
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
/// journal page in `space_id`. Delegates to [`quick_capture_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn quick_capture_block(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    content: String,
    space_id: String,
) -> Result<BlockRow, AppError> {
    quick_capture_block_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        content,
        &space_id,
    )
    .await
    .map_err(sanitize_internal_error)
}

#[cfg(test)]
mod tests {
    //! Unit tests for the journal command surface — focused on the M-22
    //! TOCTOU fix and the FEAT-3p5 per-space lookup in
    //! [`resolve_or_create_journal_page`]. The broader contract
    //! (today_journal/navigate_journal idempotency, quick-capture
    //! happy path) is covered by the
    //! `command_integration_tests/page_integration` module; the tests
    //! here exercise the private resolver directly so the regression
    //! guards for the duplicate-page race and per-space scoping live
    //! next to the code they protect.
    use super::*;
    use crate::commands::create_space_inner;
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

    /// FEAT-3p5: create a single test space and return its ULID. Used by
    /// every test in this module so the resolver always has a valid
    /// space to scope under.
    async fn mk_space(pool: &SqlitePool, name: &str) -> String {
        create_space_inner(pool, DEV, name.into(), None)
            .await
            .expect("create_space must succeed")
            .into_string()
    }

    /// Count non-deleted, non-conflict journal pages whose content
    /// matches `date` AND whose `space` ref points at `space_id`. Used
    /// by both the M-22 regression test and the FEAT-3p5 per-space
    /// scoping tests.
    async fn count_journal_pages_for_date_in_space(
        pool: &SqlitePool,
        date: &str,
        space_id: &str,
    ) -> i64 {
        sqlx::query_scalar!(
            r#"SELECT COUNT(*) as "count: i64" FROM blocks b
               WHERE b.block_type = 'page'
                 AND b.content = ?
                 AND b.deleted_at IS NULL
                 AND b.is_conflict = 0
                 AND EXISTS (
                     SELECT 1 FROM block_properties bp
                     WHERE bp.block_id = b.id
                       AND bp.key = 'space'
                       AND bp.value_ref = ?
                 )"#,
            date,
            space_id,
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
        let space = mk_space(&pool, "Personal").await;

        let first = resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE, &space)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let second = resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE, &space)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(
            first.id, second.id,
            "second resolve must return the existing journal page id"
        );
        assert_eq!(
            count_journal_pages_for_date_in_space(&pool, TEST_DATE, &space).await,
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
        let space = mk_space(&pool, "Personal").await;

        // Sanity: no journal page yet.
        assert_eq!(
            count_journal_pages_for_date_in_space(&pool, TEST_DATE, &space).await,
            0,
            "empty DB must have zero journal pages for {TEST_DATE}"
        );

        let first = resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE, &space)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(first.block_type, "page");
        assert_eq!(first.content.as_deref(), Some(TEST_DATE));
        assert!(first.deleted_at.is_none());

        let second = resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE, &space)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(
            first.id, second.id,
            "calling resolve_or_create twice on the same date must be idempotent"
        );
        assert_eq!(
            count_journal_pages_for_date_in_space(&pool, TEST_DATE, &space).await,
            1,
            "idempotent resolve must leave exactly one journal page in the DB"
        );

        // FEAT-3p5: the new page must carry a `space` ref property
        // pointing at the requested space.
        let space_prop = sqlx::query_scalar!(
            r#"SELECT value_ref FROM block_properties
               WHERE block_id = ? AND key = 'space'"#,
            first.id,
        )
        .fetch_optional(&pool)
        .await
        .unwrap()
        .flatten();
        assert_eq!(
            space_prop.as_deref(),
            Some(space.as_str()),
            "new journal page must carry space = {space}"
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
        let space = mk_space(&pool, "Personal").await;

        let mut set: JoinSet<Result<BlockRow, AppError>> = JoinSet::new();
        for _ in 0..3 {
            let pool = pool.clone();
            let mat = Arc::clone(&mat);
            let space = space.clone();
            set.spawn(async move {
                resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE, &space).await
            });
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

        let count = count_journal_pages_for_date_in_space(&pool, TEST_DATE, &space).await;
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

    // ------------------------------------------------------------------
    // FEAT-3p5 — per-space lookup tests
    // ------------------------------------------------------------------

    /// Two spaces, both with a journal page for the same date. The
    /// resolver must return the matching space's page in each case.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn today_journal_per_space_lookup_finds_only_current_space_page() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space_a = mk_space(&pool, "Personal").await;
        let space_b = mk_space(&pool, "Work").await;

        let page_a = resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE, &space_a)
            .await
            .unwrap();
        let page_b = resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE, &space_b)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_ne!(
            page_a.id, page_b.id,
            "FEAT-3p5: same date in two spaces must produce two distinct pages"
        );

        // Re-lookup each — must return the same page (idempotent per-space).
        let again_a = resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE, &space_a)
            .await
            .unwrap();
        let again_b = resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE, &space_b)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(
            again_a.id, page_a.id,
            "lookup with space_a must return space_a's page"
        );
        assert_eq!(
            again_b.id, page_b.id,
            "lookup with space_b must return space_b's page"
        );

        // Each space carries exactly one page for the date.
        assert_eq!(
            count_journal_pages_for_date_in_space(&pool, TEST_DATE, &space_a).await,
            1,
        );
        assert_eq!(
            count_journal_pages_for_date_in_space(&pool, TEST_DATE, &space_b).await,
            1,
        );

        mat.shutdown();
    }

    /// Only space_a has the page; calling with space_b must create a NEW
    /// page scoped to space_b rather than returning space_a's page.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn today_journal_creates_in_current_space_when_missing() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space_a = mk_space(&pool, "Personal").await;
        let space_b = mk_space(&pool, "Work").await;

        let page_a = resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE, &space_a)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Sanity: space_b has no page yet.
        assert_eq!(
            count_journal_pages_for_date_in_space(&pool, TEST_DATE, &space_b).await,
            0,
            "space_b must start with zero journal pages for {TEST_DATE}"
        );

        let page_b = resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE, &space_b)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_ne!(
            page_a.id, page_b.id,
            "FEAT-3p5: missing-in-space-b must create a NEW page, not return space_a's"
        );
        assert_eq!(page_b.content.as_deref(), Some(TEST_DATE));

        // The new page's space property points at space_b.
        let space_prop = sqlx::query_scalar!(
            r#"SELECT value_ref FROM block_properties
               WHERE block_id = ? AND key = 'space'"#,
            page_b.id,
        )
        .fetch_optional(&pool)
        .await
        .unwrap()
        .flatten();
        assert_eq!(
            space_prop.as_deref(),
            Some(space_b.as_str()),
            "new page must carry space = space_b"
        );

        // Both spaces carry exactly one journal page for the date.
        assert_eq!(
            count_journal_pages_for_date_in_space(&pool, TEST_DATE, &space_a).await,
            1,
        );
        assert_eq!(
            count_journal_pages_for_date_in_space(&pool, TEST_DATE, &space_b).await,
            1,
        );

        mat.shutdown();
    }

    /// FEAT-3p5: validation guard. Calling the resolver with a non-space
    /// `space_id` (e.g. a content block, or a missing id) must fail with
    /// `AppError::Validation` rather than silently creating an unscoped
    /// page.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn today_journal_rejects_invalid_space_id() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let err = resolve_or_create_journal_page(
            &pool,
            DEV,
            &mat,
            TEST_DATE,
            "01ABCDEFGHJKMNPQRSTVWXYZ00", // syntactically valid but does not exist
        )
        .await
        .expect_err("must reject unknown space_id");

        assert!(
            matches!(err, AppError::Validation(_)),
            "expected Validation error for unknown space_id, got {err:?}"
        );

        mat.shutdown();
    }
}
