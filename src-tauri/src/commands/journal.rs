//! Journal command handlers — daily page navigation.

use chrono::{NaiveDate, NaiveTime};
use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use crate::db::{CommandTx, ReadPool, WriteCtx};
use crate::materializer::Materializer;
use agaric_core::error::AppError;
use agaric_store::pagination::BlockRow;
use agaric_store::space::{SpaceId, SpaceScope};

use super::sanitize_internal_error;
use super::*;

/// Open today's journal page in `space_id`, creating it if it does not exist.
///
/// Returns the [`BlockRow`] for a `page` block whose content is today's date
/// in `YYYY-MM-DD` format AND whose `space` ref property points at
/// `space_id`. The lookup is idempotent per-space: calling this multiple
/// times on the same day with the same space always returns the same page.
///
/// Daily journal pages are scoped per-space (J1). Two devices
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
/// exact content already exists in `space_id` (and is not deleted),
/// its [`BlockRow`] is returned. Otherwise a new page
/// block is created with its `space` property atomically set in the
/// same `BEGIN IMMEDIATE` transaction.
///
/// Thin delegator to `resolve_or_create_journal_page` — kept as a named
/// public symbol so existing call sites (Tauri command wrapper,
/// [`today_journal_inner`], the command-integration tests) continue to
/// Compile unchanged. New code (MCP `journal_for_date` tool) should
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

/// Typed-date variant of the journal-for-date lookup used by the
/// MCP `journal_for_date` tool.
///
/// Takes a parsed [`NaiveDate`] rather than a string so MCP callers can
/// surface the parse error with a tool-specific message. Delegates to the
/// same `resolve_or_create_journal_page` helper as
/// [`navigate_journal_inner`] and [`today_journal_inner`] — all three call
/// sites share one implementation so behaviour cannot drift between the
/// frontend and the MCP surface.
///
/// `space_id` is required to scope the journal lookup.
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
/// Invariant "nothing outside of spaces" — then copies the space's journal
/// template under it in the same transaction
/// ([`apply_journal_template_in_tx`], #5395).
///
/// # TOCTOU race fix
///
/// The lookup-then-create sequence runs inside a single
/// `BEGIN IMMEDIATE` transaction so concurrent IPC calls serialise on
/// the SQLite writer lock. Without this, two near-simultaneous calls
/// could both observe "missing" via SELECT and both INSERT a duplicate
/// journal page for the same date. With `BEGIN IMMEDIATE`, the second
/// caller blocks until the first commits; its SELECT then sees the
/// newly-created page and returns it instead of creating a duplicate.
///
/// # per-space lookup
///
/// The lookup query filters `blocks` on `b.space_id = <space_id>` (#533,
/// migration 0086 — `space_id` is a first-class column). The same date can
/// therefore
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

    // BEGIN IMMEDIATE eagerly acquires the writer lock, serialising
    // concurrent calls for the same date so the SELECT and the eventual
    // INSERT are atomic with respect to each other. CommandTx
    // couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "resolve_or_create_journal_page").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // Look for an existing page whose content matches the date
    // exactly AND whose `space` ref property points at the requested
    // space. Two spaces with the same date keep distinct daily notes.
    let existing: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT b.id as "id!: agaric_core::ulid::BlockId", b.block_type, b.content, b.parent_id as "parent_id: agaric_core::ulid::BlockId", b.position, b.deleted_at,
                  b.todo_state, b.priority, b.due_date, b.scheduled_date, b.page_id as "page_id: agaric_core::ulid::BlockId"
           FROM blocks b
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.content = ?
             -- Repeats idx_blocks_journal_date's partial-index predicate so the
             -- planner can serve this as an index seek (audit #427). `date` is
             -- format-validated above, so this never changes the result.
             AND b.content LIKE '____-__-__'
             AND b.space_id = ?
           LIMIT 1"#,
        date,
        space_id,
    )
    .fetch_optional(&mut **tx)
    .await?;

    if let Some(row) = existing {
        // Found it — release the writer lock and return without creating.
        // No op_records enqueued, so `commit_without_dispatch` is the
        // semantic match.
        tx.commit_without_dispatch().await?;
        return Ok(row);
    }

    crate::commands::spaces::require_live_space_in_tx(&mut tx, space_id).await?;

    // No existing page — create one inside the SAME transaction so the
    // SELECT + INSERT pair is atomic. Concurrent callers that lost the
    // race will block on `BEGIN IMMEDIATE` above; once we commit, their
    // SELECT will observe this new page and they will fall through the
    // `if let Some(row)` branch above instead of inserting a duplicate.
    //
    // Emit the same `CreateBlock` + `SetProperty(space=<sid>)`
    // op pair as `create_page_in_space_inner` so a sync peer materializes
    // the new daily page with its space property in one step. We inline
    // the two helpers (rather than calling `create_page_in_space_inner`)
    // because that helper opens its own `BEGIN IMMEDIATE` and we must
    // keep the SELECT + INSERT pair atomic in *this* transaction.
    let (block, page_op_record) = create_block_in_tx(
        &mut tx,
        materializer.loro_state(),
        device_id,
        "page".into(),
        date.to_string(),
        None,
        None,
        // #2849 PR2: server-generated id (no optimistic client id).
        None,
    )
    .await?;

    // The space op is not dispatched: a fresh block has nothing to re-scope
    // (#5275, the `space` arm of `push_property_op_invalidations`).
    let (_block_after_prop, _space_op_record) = set_property_in_tx(
        &mut tx,
        materializer.loro_state(),
        device_id,
        block.id.clone().into_string(),
        "space",
        None,
        None,
        None,
        Some(space_id.to_string()),
        None,
    )
    .await?;

    // Commit + fire-and-forget dispatch for the create op (mirrors the
    // post-commit dispatch in `create_page_in_space`).
    tx.enqueue_background(page_op_record);
    apply_journal_template_in_tx(
        &mut tx,
        materializer,
        device_id,
        block.id.as_str(),
        date,
        space_id,
    )
    .await?;
    tx.commit_and_dispatch(materializer).await?;

    Ok(block)
}

/// The journal template of `space_id`, as the journal's *Configure journal
/// template* button finds it: the live page flagged `journal-template = true`
/// with the smallest id. A second live one is logged and ignored; a template
/// in the trash is logged and counts as none, so the day is created either
/// way.
async fn find_journal_template_in_tx(
    tx: &mut CommandTx,
    space_id: &str,
) -> Result<Option<String>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT b.id as "id!: String", b.deleted_at IS NOT NULL as "trashed!: bool"
           FROM blocks b
           JOIN block_properties bp
             ON bp.block_id = b.id
            AND bp.key = 'journal-template'
            AND bp.value_text = 'true'
           WHERE b.block_type = 'page'
             AND b.space_id = ?1
           ORDER BY b.id ASC"#,
        space_id,
    )
    .fetch_all(&mut ***tx)
    .await?;
    let mut live = rows.iter().filter(|row| !row.trashed);
    let Some(first) = live.next() else {
        if let Some(trashed) = rows.first() {
            tracing::warn!(
                target: "journal",
                template_id = %trashed.id,
                space_id,
                "the journal template is in the trash; creating an empty day"
            );
        }
        return Ok(None);
    };
    if live.next().is_some() {
        tracing::warn!(
            target: "journal",
            template_id = %first.id,
            space_id,
            "several pages are flagged journal-template; using the first"
        );
    }
    Ok(Some(first.id.clone()))
}

/// Copy the space's journal template under the day page `page_id` (#5395),
/// in the caller's transaction, so the day and its template land or roll back
/// together and one undo reverts both. No template, or one in the trash,
/// leaves the day empty. Every creator of a day page calls this: the journal
/// view and the date picker through [`crate::commands::create_page_in_space_inner`],
/// Quick Capture and the MCP `journal_for_date` tool through
/// [`resolve_or_create_journal_page`].
///
/// The variables expand against `date`, the day being created, not the
/// clock: `<% today %>` and `<% page title %>` are the day. `<% time %>` is
/// the clock, since a day has no time of its own, and `<% datetime %>` is
/// both. Returns the copied rows, depth-first.
pub(crate) async fn apply_journal_template_in_tx(
    tx: &mut CommandTx,
    materializer: &Materializer,
    device_id: &str,
    page_id: &str,
    date: &str,
    space_id: &str,
) -> Result<Vec<BlockRow>, AppError> {
    let Some(template_id) = find_journal_template_in_tx(tx, space_id).await? else {
        return Ok(Vec::new());
    };
    let day = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| AppError::validation(format!("expected YYYY-MM-DD, got '{date}'")))?;
    let time = chrono::Local::now().time();
    crate::commands::pages::copy_page_blocks_in_tx(
        tx,
        materializer,
        device_id,
        &template_id,
        page_id,
        |content| expand_journal_template_variables(content, day, time),
    )
    .await
}

/// Expand one block's template variables for the day `day` (#5395): `<% today
/// %>`, `<% time %>`, `<% datetime %>` and `<% page title %>`, with the
/// `{{date}}`, `{{time}}` and `{{title}}` spellings of the `/template` grammar,
/// and `{{cursor}}` stripped. A name is case-insensitive and its inner
/// whitespace collapses. A `:FORMAT` suffix is dropped and the token takes its
/// default form: the frontend's date-fns formats have no twin here, and a
/// literal token in every new day is worse than a default date. Any other
/// token stays as written.
fn expand_journal_template_variables(content: &str, day: NaiveDate, time: NaiveTime) -> String {
    let resolve = |body: &str| -> Option<String> {
        let head = body.split(':').next().unwrap_or_default();
        let name = head
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase();
        let date = day.format("%Y-%m-%d");
        let clock = time.format("%H:%M");
        match name.as_str() {
            "today" | "date" => Some(date.to_string()),
            "time" => Some(clock.to_string()),
            "datetime" => Some(format!("{date} {clock}")),
            "page title" | "title" => Some(date.to_string()),
            "cursor" => Some(String::new()),
            _ => None,
        }
    };
    let expanded = expand_tokens(content, "<%", "%>", resolve);
    expand_tokens(&expanded, "{{", "}}", resolve)
}

/// Replace each `open`…`close` token in `content` by what `resolve` makes of
/// its body, leaving a token it declines, and an `open` nothing closes, as
/// written.
fn expand_tokens(
    content: &str,
    open: &str,
    close: &str,
    resolve: impl Fn(&str) -> Option<String> + Copy,
) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find(open) {
        out.push_str(&rest[..start]);
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(close) else {
            out.push_str(open);
            rest = after;
            continue;
        };
        let body = &after[..end];
        if let Some(value) = resolve(body) {
            out.push_str(&value);
        } else {
            out.push_str(open);
            out.push_str(body);
            out.push_str(close);
        }
        rest = &after[end + close.len()..];
    }
    out.push_str(rest);
    out
}

/// Quick-capture a single content block onto today's journal page.
///
/// Resolves today's journal page in `space_id` (creating it, journal
/// template included, if it doesn't exist via [`today_journal_inner`]) and
/// then appends a new `content` block as a child of that page. Used by the
/// global-shortcut quick-capture flow: the user fires the OS hotkey from
/// anywhere, types into a small modal, and the captured line lands at the
/// bottom of today's journal in the active space — no navigation, no clicks.
///
/// Calling this twice on the same day appends two distinct blocks (matches
/// the existing `create_block` semantic). The function is idempotent at
/// the journal-page level — only the first call on a given day creates
/// the page; subsequent calls reuse it.
///
/// `space_id` is required to scope the capture to a single
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
#[tauri::command]
#[specta::specta]
pub async fn quick_capture_block(
    ctx: State<'_, WriteCtx>,
    content: String,
    space_id: SpaceId,
) -> Result<BlockRow, AppError> {
    // b2 (#2248): required-target-space commands take the `SpaceId` newtype at
    // the wire boundary. The lenient `Deserialize` only uppercases, so reject a
    // malformed id here rather than letting a never-matching filter reach the
    // space-existence check with an opaque error.
    space_id.validate_shape()?;
    quick_capture_block_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        content,
        space_id.as_str(),
    )
    .await
    .map_err(sanitize_internal_error)
}

// ---------------------------------------------------------------------------
// Journal page lookup commands — database-native, no pagination
// ---------------------------------------------------------------------------

/// Look up a single journal page by exact date string.
///
/// Returns the [`BlockRow`] for a live, non-conflict `page` block whose
/// `content` exactly matches `date` (in `YYYY-MM-DD` format) and whose
/// `space` ref property points at `space_id`. Returns `None` when no such
/// page exists.
///
/// This replaces the frontend pattern of calling `listBlocks({
/// block_type: 'page', limit: 500 })` and scanning a JS Map — which broke
/// when the backend clamped `limit` to 100 (F06) and newer pages fell
/// off the end of the result set.
///
/// The query is backed by `idx_blocks_journal_date` (migration 0047), a
/// partial index on `blocks(content)` scoped to `block_type = 'page' AND
/// content LIKE '____-__-__'`. SQLite can only use a partial index when the
/// query repeats the index's WHERE predicate, so the query carries the
/// redundant `content LIKE '____-__-__'` term (the `date` arg is already
/// format-validated, so it never changes the result set) — that makes the
/// lookup an index seek, O(log N) regardless of total block count (audit #427).
#[instrument(skip(pool), err)]
pub async fn get_journal_page_by_date_inner(
    pool: &SqlitePool,
    date: &str,
    space_id: &str,
) -> Result<Option<BlockRow>, AppError> {
    validate_date_format(date)?;

    let row = sqlx::query_as!(
        BlockRow,
        r#"SELECT b.id as "id!: agaric_core::ulid::BlockId", b.block_type, b.content, b.parent_id as "parent_id: agaric_core::ulid::BlockId", b.position, b.deleted_at,
                  b.todo_state, b.priority, b.due_date, b.scheduled_date, b.page_id as "page_id: agaric_core::ulid::BlockId"
           FROM blocks b
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.content = ?
             -- Repeats idx_blocks_journal_date's partial-index predicate so the
             -- planner can serve this as an index seek (audit #427). `date` is
             -- format-validated above, so this never changes the result.
             AND b.content LIKE '____-__-__'
             AND b.space_id = ?
           LIMIT 1"#,
        date,
        space_id,
    )
    .fetch_optional(pool)
    .await?;

    Ok(row)
}

/// Tauri command: look up a journal page by date. Delegates to
/// [`get_journal_page_by_date_inner`].
///
/// `scope` is a required-active [`SpaceScope`] (b1 migration): the
/// per-space journal lookup has no cross-space form, so
/// [`SpaceScope::Global`] is rejected by [`SpaceScope::require_active`].
/// The frontend skips the probe (no auto-create) when there is no active
/// space rather than dispatching a `Global` scope.
#[tauri::command]
#[specta::specta]
pub async fn get_journal_page_by_date(
    pool: State<'_, ReadPool>,
    date: String,
    scope: SpaceScope,
) -> Result<Option<BlockRow>, AppError> {
    let space_id = scope.require_active()?;
    get_journal_page_by_date_inner(&pool.0, &date, space_id.as_str())
        .await
        .map_err(sanitize_internal_error)
}

/// List date-formatted journal pages in `space_id` whose `content` falls in
/// the inclusive `[start_date, end_date]` range.
///
/// Returns every live, non-conflict `page` block whose `content` matches the
/// `YYYY-MM-DD` pattern, whose `space` ref property points at `space_id`, and
/// whose date is within the requested range. The result is a flat
/// `Vec<BlockRow>` — bounded by the visible date span (≤ 42 for a six-week
/// calendar grid, fewer for daily/weekly views) so pagination would only add
/// noise.
///
/// Backed by the `idx_blocks_journal_date` partial index plus a range
/// predicate on `content`, so the lookup remains O(visible-days) regardless of
/// total block count or total journal-page count across all time.
///
/// Both endpoints are validated against the `YYYY-MM-DD` shape, and
/// `start_date <= end_date` is enforced — callers passing inverted ranges hit
/// a Validation error rather than a silent empty result.
#[instrument(skip(pool), err)]
pub async fn list_journal_pages_in_range_inner(
    pool: &SqlitePool,
    start_date: &str,
    end_date: &str,
    space_id: &str,
) -> Result<Vec<BlockRow>, AppError> {
    validate_date_format(start_date)?;
    validate_date_format(end_date)?;
    if start_date > end_date {
        return Err(AppError::validation(
            "start_date must be <= end_date".to_string(),
        ));
    }

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT b.id as "id!: agaric_core::ulid::BlockId", b.block_type, b.content, b.parent_id as "parent_id: agaric_core::ulid::BlockId", b.position, b.deleted_at,
                  b.todo_state, b.priority, b.due_date, b.scheduled_date, b.page_id as "page_id: agaric_core::ulid::BlockId"
           FROM blocks b
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             -- C9 (#345): journal-title detection. LIKE drives the index
             -- (case-insensitive, but `_` matches ANY char, so it admits
             -- non-date titles like "abcd-ef-gh"); the GLOB tightens it to
             -- a digit class. Both are kept: LIKE keeps the query sargable
             -- while GLOB rejects non-digit false positives.
             AND b.content LIKE '____-__-__'
             AND b.content GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
             AND b.content >= ?
             AND b.content <= ?
             AND b.space_id = ?
           ORDER BY b.content ASC"#,
        start_date,
        end_date,
        space_id,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

/// Tauri command: list date-formatted journal pages in `[start_date,
/// end_date]`. Delegates to [`list_journal_pages_in_range_inner`].
///
/// `scope` is a required-active [`SpaceScope`] (b1 migration);
/// [`SpaceScope::Global`] is rejected by [`SpaceScope::require_active`].
/// The frontend short-circuits locally to an empty page map when there
/// is no active space rather than dispatching a `Global` scope.
#[tauri::command]
#[specta::specta]
pub async fn list_journal_pages_in_range(
    pool: State<'_, ReadPool>,
    start_date: String,
    end_date: String,
    scope: SpaceScope,
) -> Result<Vec<BlockRow>, AppError> {
    let space_id = scope.require_active()?;
    list_journal_pages_in_range_inner(&pool.0, &start_date, &end_date, space_id.as_str())
        .await
        .map_err(sanitize_internal_error)
}

#[cfg(test)]
mod tests {
    //! Unit tests for the journal command surface — focused on the
    //! TOCTOU fix and the per-space lookup in
    //! [`resolve_or_create_journal_page`]. The broader contract
    //! (today_journal/navigate_journal idempotency, quick-capture
    //! happy path) is covered by the
    //! `tests/command_integration/page_integration` module; the tests
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

    /// Create a single test space and return its ULID. Used by
    /// every test in this module so the resolver always has a valid
    /// space to scope under.
    async fn mk_space(pool: &SqlitePool, name: &str) -> String {
        let materializer = Materializer::new(pool.clone());
        create_space_inner(pool, DEV, &materializer, name.into(), None)
            .await
            .expect("create_space must succeed")
            .into_string()
    }

    /// Count non-deleted, non-conflict journal pages whose content
    /// matches `date` AND whose `space` ref points at `space_id`. Used
    /// By both the regression test and the per-space
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
                 AND b.space_id = ?"#,
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

        // The new page must carry a `space` ref property
        // pointing at the requested space.
        let space_prop =
            sqlx::query_scalar!(r#"SELECT space_id FROM blocks WHERE id = ?"#, first.id,)
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

    /// Regression guard.
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
            ids.push(row.id.to_string());
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
                "all concurrent resolves must return the same page id, got {ids:?}"
            );
        }

        let count = count_journal_pages_for_date_in_space(&pool, TEST_DATE, &space).await;
        assert_eq!(
            count, 1,
            " regression: exactly ONE journal page must exist for {TEST_DATE} after \
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
            " regression: exactly ONE create_block op for the journal page must \
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
    // Per-space lookup tests
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
            "same date in two spaces must produce two distinct pages"
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
            "missing-in-space-b must create a NEW page, not return space_a's"
        );
        assert_eq!(page_b.content.as_deref(), Some(TEST_DATE));

        // The new page's space property points at space_b.
        let space_prop =
            sqlx::query_scalar!(r#"SELECT space_id FROM blocks WHERE id = ?"#, page_b.id,)
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

    /// Validation guard. Calling the resolver with a non-space
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
            matches!(err, AppError::Validation { .. }),
            "expected Validation error for unknown space_id, got {err:?}"
        );

        mat.shutdown();
    }

    // ------------------------------------------------------------------
    // Get_journal_page_by_date / list_journal_pages_in_range
    // ------------------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_journal_page_by_date_finds_existing_page() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space = mk_space(&pool, "Personal").await;

        let created = resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE, &space)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let found = get_journal_page_by_date_inner(&pool, TEST_DATE, &space)
            .await
            .unwrap()
            .expect("page should exist");
        assert_eq!(found.id, created.id);
        assert_eq!(found.content.as_deref(), Some(TEST_DATE));

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_journal_page_by_date_returns_none_for_missing() {
        let (pool, _dir) = test_pool().await;
        let space = mk_space(&pool, "Personal").await;

        let row = get_journal_page_by_date_inner(&pool, TEST_DATE, &space)
            .await
            .unwrap();
        assert!(row.is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_journal_page_by_date_rejects_invalid_format() {
        let (pool, _dir) = test_pool().await;
        let space = mk_space(&pool, "Personal").await;

        let err = get_journal_page_by_date_inner(&pool, "2025/04/15", &space)
            .await
            .expect_err("non-YYYY-MM-DD must be rejected");
        assert!(matches!(err, AppError::Validation { .. }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_journal_page_by_date_is_scoped_to_space() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space_a = mk_space(&pool, "Personal").await;
        let space_b = mk_space(&pool, "Work").await;

        let page_a = resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE, &space_a)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // The page lives in space_a; querying space_b for the same date
        // must not surface it.
        let in_b = get_journal_page_by_date_inner(&pool, TEST_DATE, &space_b)
            .await
            .unwrap();
        assert!(in_b.is_none(), "space_b must not see space_a's page");

        let in_a = get_journal_page_by_date_inner(&pool, TEST_DATE, &space_a)
            .await
            .unwrap()
            .expect("space_a must see its own page");
        assert_eq!(in_a.id, page_a.id);

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_journal_pages_in_range_filters_by_dates() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space = mk_space(&pool, "Personal").await;

        for d in ["2025-03-30", "2025-04-15", "2025-04-20", "2025-05-05"] {
            resolve_or_create_journal_page(&pool, DEV, &mat, d, &space)
                .await
                .unwrap();
        }
        mat.flush_background().await.unwrap();

        let april = list_journal_pages_in_range_inner(&pool, "2025-04-01", "2025-04-30", &space)
            .await
            .unwrap();
        let april_dates: Vec<&str> = april
            .iter()
            .map(|r| r.content.as_deref().unwrap_or(""))
            .collect();
        assert_eq!(april_dates, vec!["2025-04-15", "2025-04-20"]);

        // Empty range (date outside any page) returns empty without error.
        let empty = list_journal_pages_in_range_inner(&pool, "2024-01-01", "2024-12-31", &space)
            .await
            .unwrap();
        assert!(empty.is_empty());

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_journal_pages_in_range_excludes_non_date_pages() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space = mk_space(&pool, "Personal").await;

        // Date-formatted page in range.
        resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE, &space)
            .await
            .unwrap();
        // Non-date-formatted page in the same space — must not surface.
        let non_date = crate::commands::create_page_in_space_inner(
            &pool,
            DEV,
            &mat,
            None,
            "Project Plan".to_string(),
            space.clone(),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let rows = list_journal_pages_in_range_inner(&pool, "2025-04-01", "2025-04-30", &space)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1, "non-date page must not appear");
        assert_eq!(rows[0].content.as_deref(), Some(TEST_DATE));
        assert_ne!(rows[0].id, non_date.into_string());

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_journal_pages_in_range_rejects_like_false_positive() {
        // C9 (#345): the old `LIKE '____-__-__'` admits any character in each
        // `_` slot. A title like "2025-04-1x" is 10 chars in the
        // `____-__-__` shape AND falls inside the `>= '2025-04-01' AND
        // <= '2025-04-30'` lexical range, so the bounded range does NOT
        // mask it — only the new digit-class GLOB rejects it.
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space = mk_space(&pool, "Personal").await;

        // A real journal page in range.
        resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE, &space)
            .await
            .unwrap();
        // A non-date page whose title matches the old LIKE shape and sits
        // inside the date range, but has a non-digit final char.
        let bogus = crate::commands::create_page_in_space_inner(
            &pool,
            DEV,
            &mat,
            None,
            "2025-04-1x".to_string(),
            space.clone(),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let rows = list_journal_pages_in_range_inner(&pool, "2025-04-01", "2025-04-30", &space)
            .await
            .unwrap();
        assert_eq!(
            rows.len(),
            1,
            "GLOB must reject the LIKE false positive '2025-04-1x'"
        );
        assert_eq!(rows[0].content.as_deref(), Some(TEST_DATE));
        assert_ne!(rows[0].id, bogus.into_string());

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_journal_pages_in_range_is_scoped_to_space() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space_a = mk_space(&pool, "Personal").await;
        let space_b = mk_space(&pool, "Work").await;

        resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE, &space_a)
            .await
            .unwrap();
        resolve_or_create_journal_page(&pool, DEV, &mat, TEST_DATE, &space_b)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let a = list_journal_pages_in_range_inner(&pool, "2025-04-01", "2025-04-30", &space_a)
            .await
            .unwrap();
        let b = list_journal_pages_in_range_inner(&pool, "2025-04-01", "2025-04-30", &space_b)
            .await
            .unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(b.len(), 1);
        assert_ne!(a[0].id, b[0].id, "each space sees only its own page");

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_journal_pages_in_range_rejects_inverted_range() {
        let (pool, _dir) = test_pool().await;
        let space = mk_space(&pool, "Personal").await;

        let err = list_journal_pages_in_range_inner(&pool, "2025-05-01", "2025-04-01", &space)
            .await
            .expect_err("inverted range must be rejected");
        assert!(matches!(err, AppError::Validation { .. }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_journal_pages_in_range_rejects_invalid_date_format() {
        let (pool, _dir) = test_pool().await;
        let space = mk_space(&pool, "Personal").await;

        let err = list_journal_pages_in_range_inner(&pool, "2025-04-1", "2025-04-30", &space)
            .await
            .expect_err("non-YYYY-MM-DD start must be rejected");
        assert!(matches!(err, AppError::Validation { .. }));
    }

    // ------------------------------------------------------------------
    // #5395 — the journal template lands with the day, whoever creates it
    // ------------------------------------------------------------------

    use crate::commands::{
        create_block_inner, create_page_in_space_inner, delete_block_inner, set_property_inner,
    };
    use agaric_core::ulid::{ActiveBlockId, BlockId};

    const DAY: &str = "2031-01-02";

    async fn flag(pool: &SqlitePool, mat: &Materializer, page_id: &str, key: &str) {
        set_property_inner(
            pool,
            DEV,
            mat,
            ActiveBlockId::from(page_id.to_owned()),
            key.into(),
            Some("true".into()),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("flag must be set");
    }

    async fn child(pool: &SqlitePool, mat: &Materializer, parent: &str, content: &str) -> String {
        create_block_inner(
            pool,
            DEV,
            mat,
            "content".into(),
            content.into(),
            Some(BlockId::from_trusted(parent)),
            None,
        )
        .await
        .expect("block must be created")
        .id
        .into_string()
    }

    /// A journal template page in `space`: `Notes for <% page title %>` with
    /// `On <% today %> at <% time %>, {{date}}{{cursor}}` nested under it, then
    /// `Second {{title}}`. Returns the template's id.
    async fn seed_template(pool: &SqlitePool, mat: &Materializer, space: &str) -> String {
        let template =
            create_page_in_space_inner(pool, DEV, mat, None, "Daily template".into(), space.into())
                .await
                .expect("template page")
                .into_string();
        flag(pool, mat, &template, "template").await;
        flag(pool, mat, &template, "journal-template").await;
        let notes = child(pool, mat, &template, "Notes for <% page title %>").await;
        child(
            pool,
            mat,
            &notes,
            "On <% today %> at <% time %>, {{date}}{{cursor}}",
        )
        .await;
        child(pool, mat, &template, "Second {{title}}").await;
        template
    }

    /// `(content, parent_id, position)` of every live block on `page_id`, in
    /// `(parent_id, position)` order.
    async fn page_blocks(pool: &SqlitePool, page_id: &str) -> Vec<(String, String, i64)> {
        sqlx::query!(
            r#"SELECT content as "content!: String", parent_id as "parent_id!: String",
                      position as "position!: i64"
               FROM blocks
               WHERE page_id = ?1 AND id != ?1 AND deleted_at IS NULL
               ORDER BY parent_id, position"#,
            page_id,
        )
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r| (r.content, r.parent_id, r.position))
        .collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn journal_for_date_copies_the_template_with_nesting_and_variables() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space = mk_space(&pool, "Personal").await;
        seed_template(&pool, &mat, &space).await;

        let day = NaiveDate::parse_from_str(DAY, "%Y-%m-%d").unwrap();
        let page = journal_for_date_inner(&pool, DEV, &mat, day, &space)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let page_id = page.id.into_string();
        let blocks = page_blocks(&pool, &page_id).await;
        assert_eq!(
            blocks.len(),
            3,
            "two top-level blocks and one nested: {blocks:?}"
        );
        let notes = blocks
            .iter()
            .find(|(content, _, _)| content == "Notes for 2031-01-02")
            .expect("`<% page title %>` is the day");
        assert_eq!(notes.1, page_id);
        assert_eq!(notes.2, 1);
        let second = blocks
            .iter()
            .find(|(content, _, _)| content == "Second 2031-01-02")
            .expect("`{{title}}` is the day");
        assert_eq!(second.1, page_id);
        assert_eq!(second.2, 2);
        let nested = blocks
            .iter()
            .find(|(_, parent, _)| parent != &page_id)
            .expect("the nested block keeps its nesting");
        let notes_id: String = sqlx::query_scalar!(
            r#"SELECT id as "id!: String" FROM blocks WHERE page_id = ?1 AND content = ?2"#,
            page_id,
            "Notes for 2031-01-02",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(nested.1, notes_id, "nested under the copied Notes block");
        let (prefix, rest) = nested.0.split_at("On 2031-01-02 at ".len());
        assert_eq!(prefix, "On 2031-01-02 at ");
        let (clock, tail) = rest.split_at(5);
        assert!(
            clock.as_bytes()[2] == b':' && clock.bytes().filter(u8::is_ascii_digit).count() == 4,
            "`<% time %>` is HH:MM, got {clock:?}"
        );
        assert_eq!(
            tail, ", 2031-01-02",
            "`{{{{date}}}}` is the day and `{{{{cursor}}}}` goes"
        );

        // One transaction: the page's own two ops and the three copies are
        // one contiguous seq range, so one undo group holds them all.
        let seqs: Vec<i64> = sqlx::query_scalar!(
            r#"SELECT seq as "seq!: i64" FROM op_log
               WHERE json_extract(payload, '$.content') LIKE '%2031-01-02%'
                  OR (op_type = 'set_property' AND block_id = ?1)
               ORDER BY seq"#,
            page_id,
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(seqs.len(), 5, "page create, space, three copies: {seqs:?}");
        assert_eq!(seqs[4] - seqs[0], 4, "contiguous: {seqs:?}");

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_template_the_copy_refuses_leaves_no_day() {
        // A carriage return does not read back from the source grammar, so
        // the copy refuses after the page and its space were applied, and the
        // refusal rolls the page back with it.
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space = mk_space(&pool, "Personal").await;
        let template = seed_template(&pool, &mat, &space).await;
        child(&pool, &mat, &template, "one\r- two").await;

        let day = NaiveDate::parse_from_str(DAY, "%Y-%m-%d").unwrap();
        let err = journal_for_date_inner(&pool, DEV, &mat, day, &space)
            .await
            .expect_err("the copy must refuse");
        assert!(matches!(err, AppError::Validation { .. }), "{err:?}");
        mat.flush_background().await.unwrap();

        assert_eq!(
            count_journal_pages_for_date_in_space(&pool, DAY, &space).await,
            0,
            "no page survives a refused copy"
        );
        let ops: i64 = sqlx::query_scalar!(
            r#"SELECT COUNT(*) as "c: i64" FROM op_log
               WHERE json_extract(payload, '$.content') LIKE '%2031-01-02%'"#,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(ops, 0, "no op of the day survives either");

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn quick_capture_lands_under_the_templated_day() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space = mk_space(&pool, "Personal").await;
        seed_template(&pool, &mat, &space).await;

        let captured = quick_capture_block_inner(&pool, DEV, &mat, "captured".into(), &space)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let page_id = captured.parent_id.unwrap().into_string();
        let top: Vec<(String, i64)> = page_blocks(&pool, &page_id)
            .await
            .into_iter()
            .filter(|(_, parent, _)| parent == &page_id)
            .map(|(content, _, position)| (content, position))
            .collect();
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert_eq!(
            top,
            vec![
                (format!("Notes for {today}"), 1),
                (format!("Second {today}"), 2),
                ("captured".to_owned(), 3),
            ],
            "the template first, the capture after it"
        );

        // The day exists now: a second capture appends, re-inserting nothing.
        quick_capture_block_inner(&pool, DEV, &mat, "again".into(), &space)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();
        assert_eq!(page_blocks(&pool, &page_id).await.len(), 5);

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_space_without_a_template_creates_an_empty_day() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space = mk_space(&pool, "Personal").await;
        // A page template that is not the journal's does not apply.
        let other =
            create_page_in_space_inner(&pool, DEV, &mat, None, "Meeting".into(), space.clone())
                .await
                .unwrap()
                .into_string();
        flag(&pool, &mat, &other, "template").await;
        child(&pool, &mat, &other, "Attendees").await;

        let day = NaiveDate::parse_from_str(DAY, "%Y-%m-%d").unwrap();
        let page = journal_for_date_inner(&pool, DEV, &mat, day, &space)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(page_blocks(&pool, page.id.as_str()).await, vec![]);

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_trashed_template_creates_an_empty_day() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space = mk_space(&pool, "Personal").await;
        let template = seed_template(&pool, &mat, &space).await;
        delete_block_inner(&pool, DEV, &mat, BlockId::from_trusted(&template))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let day = NaiveDate::parse_from_str(DAY, "%Y-%m-%d").unwrap();
        let page = journal_for_date_inner(&pool, DEV, &mat, day, &space)
            .await
            .expect("a trashed template never blocks the day");
        mat.flush_background().await.unwrap();

        assert_eq!(page_blocks(&pool, page.id.as_str()).await, vec![]);
        assert_eq!(
            count_journal_pages_for_date_in_space(&pool, DAY, &space).await,
            1
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_existing_day_is_not_templated_again() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space = mk_space(&pool, "Personal").await;
        seed_template(&pool, &mat, &space).await;

        let first = resolve_or_create_journal_page(&pool, DEV, &mat, DAY, &space)
            .await
            .unwrap();
        let again = resolve_or_create_journal_page(&pool, DEV, &mat, DAY, &space)
            .await
            .unwrap();
        // The frontend's own creator resolves a taken title to the page too.
        let via_page =
            create_page_in_space_inner(&pool, DEV, &mat, None, DAY.into(), space.clone())
                .await
                .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(first.id, again.id);
        assert_eq!(first.id, via_page);
        assert_eq!(page_blocks(&pool, first.id.as_str()).await.len(), 3);

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_page_in_space_templates_a_date_title_and_only_that() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let space = mk_space(&pool, "Personal").await;
        seed_template(&pool, &mat, &space).await;

        let day = create_page_in_space_inner(&pool, DEV, &mat, None, DAY.into(), space.clone())
            .await
            .unwrap();
        let plain =
            create_page_in_space_inner(&pool, DEV, &mat, None, "Project".into(), space.clone())
                .await
                .unwrap();
        mat.flush_background().await.unwrap();

        let day_blocks = page_blocks(&pool, day.as_str()).await;
        assert_eq!(day_blocks.len(), 3, "{day_blocks:?}");
        assert!(
            day_blocks
                .iter()
                .any(|(c, _, _)| c == "Notes for 2031-01-02")
        );
        assert_eq!(page_blocks(&pool, plain.as_str()).await, vec![]);
        // The journal finds the page the frontend created as the day.
        let found = get_journal_page_by_date_inner(&pool, DAY, &space)
            .await
            .unwrap()
            .expect("a date-titled page is the day");
        assert_eq!(found.id, day);

        mat.shutdown();
    }

    #[test]
    fn journal_template_variables_expand_against_the_day() {
        let day = NaiveDate::from_ymd_opt(2031, 1, 2).unwrap();
        let time = NaiveTime::from_hms_opt(9, 5, 0).unwrap();
        let expand = |s: &str| expand_journal_template_variables(s, day, time);
        assert_eq!(
            expand("<% today %>|<% time %>|<% datetime %>"),
            "2031-01-02|09:05|2031-01-02 09:05"
        );
        assert_eq!(
            expand("<% page title %> / <%PAGE  TITLE%>"),
            "2031-01-02 / 2031-01-02"
        );
        assert_eq!(
            expand("{{date}} {{ time }} {{title}}x{{cursor}}"),
            "2031-01-02 09:05 2031-01-02x"
        );
        // A format is dropped for the default form, never left literal.
        assert_eq!(expand("<% today:MMMM d, yyyy %>"), "2031-01-02");
        assert_eq!(expand("{{date:HH:mm}}"), "2031-01-02");
        // What is not a variable stays as written.
        assert_eq!(
            expand("<% weekday %> {{foo}} <% open {{ x }}"),
            "<% weekday %> {{foo}} <% open {{ x }}"
        );
        assert_eq!(expand("plain"), "plain");
    }
}
