//! Page alias command handlers (#644 split).
//!
//! `set_page_aliases`, `get_page_aliases`, `resolve_page_by_alias`,
//! `list_page_aliases_by_prefix` and their `*_inner` cores plus the
//! prefix-picker helpers.

use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::{ReadPool, WritePool};
use crate::error::AppError;
use crate::space::SpaceScope;
use crate::ulid::PageId;

use super::super::*;

/// Replace the full set of aliases for a page. Returns the aliases that were
/// actually inserted (empty/whitespace-only entries are skipped; duplicates
/// across different pages are silently ignored via INSERT OR IGNORE).
///
/// **Sync semantics (I-CommandsCRUD-4):** the `page_aliases` table is
/// intentionally maintained outside the op log. There is no
/// `SetPageAliases` `OpPayload` variant, so day-to-day op-log replay does
/// **not** propagate alias edits to peers; aliases reach other devices only
/// when a snapshot is exchanged. Aliases are treated as local-display
/// metadata for case-insensitive page lookup, and promoting them to a
/// fully sync-replicated entity would require a new op type, which is
/// gated by AGENTS.md "Architectural Stability". See `docs/ARCHITECTURE.md §4`
/// (op-log invariant) and `§20` page-aliases bullet.
#[instrument(skip(pool, aliases), err)]
pub async fn set_page_aliases_inner(
    pool: &SqlitePool,
    page_id: &str,
    aliases: Vec<String>,
) -> Result<Vec<String>, AppError> {
    // I-CommandsCRUD-2: normalise to canonical uppercase form. AGENTS.md
    // invariant #8 requires ULID uppercase for blake3 hash determinism;
    // SQLite text comparison is byte-exact, so a lowercase caller would
    // silently get NotFound. BlockId::from_trusted normalises on
    // construction (op_log path), but raw String args from MCP tools /
    // sync replay / scripted imports must be normalised here.
    let page_id = page_id.to_ascii_uppercase();

    // Wrap the DELETE + per-alias INSERT loop in a single
    // `BEGIN IMMEDIATE` transaction so that a crash, pool-acquire
    // failure, or per-row INSERT error mid-loop rolls the page back to
    // its prior alias set instead of leaving a partial replacement.
    // Concurrent callers for the same page also serialize on the
    // immediate write lock instead of interleaving their phases.
    // allow-raw-tx: page_aliases is its own table, emits no op_log entries (#110)
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // #661 — verify the page exists and is a live page block INSIDE the
    // IMMEDIATE tx (the F01/F02/F03 sibling-command pattern). Pre-fix the
    // probe ran on the pool BEFORE `BEGIN IMMEDIATE`; a concurrent
    // `delete_block` landing in the gap between the probe and the write
    // lock would leave the freshly-inserted aliases attached to a
    // tombstoned page (TOCTOU). Running it under the writer lock makes
    // the existence check and the alias writes atomic against any
    // concurrent delete.
    let exists: bool = sqlx::query_scalar!(
        r#"SELECT COUNT(*) > 0 AS "exists!: bool" FROM blocks WHERE id = ?1 AND block_type = 'page' AND deleted_at IS NULL"#,
        page_id,
    )
    .fetch_one(&mut *tx)
    .await?;

    if !exists {
        return Err(AppError::NotFound("page not found".into()));
    }

    // Delete existing aliases
    sqlx::query!("DELETE FROM page_aliases WHERE page_id = ?1", page_id)
        .execute(&mut *tx)
        .await?;

    // Insert new aliases (skip empty, trim whitespace, deduplicate)
    let mut inserted = Vec::new();
    for alias in aliases {
        let trimmed = alias.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        // INSERT OR IGNORE handles duplicate alias across different pages
        let result = sqlx::query!(
            "INSERT OR IGNORE INTO page_aliases (page_id, alias) VALUES (?1, ?2)",
            page_id,
            trimmed,
        )
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() > 0 {
            inserted.push(trimmed);
        }
    }

    tx.commit().await?;

    Ok(inserted)
}

/// Return all aliases for a page, sorted alphabetically.
#[instrument(skip(pool), err)]
pub async fn get_page_aliases_inner(
    pool: &SqlitePool,
    page_id: &str,
) -> Result<Vec<String>, AppError> {
    let aliases: Vec<String> = sqlx::query_scalar!(
        "SELECT alias FROM page_aliases WHERE page_id = ?1 ORDER BY alias",
        page_id,
    )
    .fetch_all(pool)
    .await?;
    Ok(aliases)
}

/// Look up a page by one of its aliases. Returns `(page_id, title)` if found.
///
/// `scope` — [`SpaceScope::Active`] restricts the
/// match to aliases pointing at pages whose `b.space_id` equals the
/// wrapped [`SpaceId`] (#533, migration 0086 — `space_id` is a first-class
/// column). Mirrors the
/// `(?N IS NULL OR b.space_id = ?N)` short-circuit
/// already used by [`list_page_aliases_by_prefix_inner`] so the alias
/// resolver and the prefix picker apply the same scoping rule.
/// [`SpaceScope::Global`] keeps the cross-space behaviour for callers
/// (e.g. agent / MCP tools) that span every space.
#[instrument(skip(pool), err)]
pub async fn resolve_page_by_alias_inner(
    pool: &SqlitePool,
    alias: &str,
    scope: &SpaceScope,
) -> Result<Option<(String, Option<String>)>, AppError> {
    let space_filter = scope.as_filter_param();
    let result = sqlx::query!(
        r#"SELECT pa.page_id AS "page_id!", b.content
         FROM page_aliases pa
         JOIN blocks b ON b.id = pa.page_id
         WHERE pa.alias = ?1 COLLATE NOCASE
           AND b.deleted_at IS NULL
           AND (?2 IS NULL OR b.space_id = ?2)"#,
        alias,
        space_filter,
    )
    .fetch_optional(pool)
    .await?
    .map(|r| (r.page_id, r.content));
    Ok(result)
}

/// Soft cap on the number of alias-prefix matches the picker may surface
/// per keystroke. Mirrors `tag_query::MAX_TAGS_PREFIX` in shape (named
/// const, single-source-of-truth) and is wide enough that the popup's
/// own UI cap (20) is the binding limit in practice.
const MAX_PAGE_ALIASES_PREFIX: i64 = 50;

/// Row shape returned by [`list_page_aliases_by_prefix_inner`]: the page
/// id, the alias text that matched (so the frontend can render
/// `Page Title (alias: X)` without a second round trip), and the page's
/// current title (`blocks.content`).
struct PageAliasPrefixRow {
    page_id: PageId,
    alias: String,
    title: Option<String>,
}

/// List page aliases whose alias *contains* `prefix` as a substring
/// (case-insensitive, `COLLATE NOCASE` matches the index on
/// `page_aliases.alias`).
///
/// The `prefix` parameter name is historical — the function originally
/// did prefix-only matching (`LIKE 'q%'`). It now uses substring
/// matching (`LIKE '%q%'`) so the picker mirrors the FTS-backed
/// page-title behaviour: a user typing `[[oj` resolves an alias like
/// `projects` the same way it would resolve a page titled "Projects".
///
/// Returns `(page_id, alias, title)` rows so the frontend can render
/// "Page Title (alias: pp)" without a second round trip per match.
///
/// Bounded by [`MAX_PAGE_ALIASES_PREFIX`] to keep the popup responsive
/// even if a user has hundreds of substring-matched aliases.
///
/// `scope` — [`SpaceScope::Active`] restricts the
/// result set to aliases pointing at pages whose `space` property
/// equals the wrapped [`SpaceId`]. Mirrors the
/// `(?N IS NULL OR ... IN (...))` short-circuit pattern used by
/// `pagination::list_by_tag` and friends. [`SpaceScope::Global`] keeps
/// the cross-space behaviour for callers that span every space.
///
/// Ordering: `length(alias), alias` puts the shortest match at the
/// top (so a typed-in-full exact alias bubbles up over longer
/// neighbours that merely contain the query), then alphabetical. The
/// in-memory sort runs over the LIKE candidate set; the `LIMIT` keeps
/// that set small (≤ 50) so the sort is effectively free.
#[instrument(skip(pool), err)]
pub async fn list_page_aliases_by_prefix_inner(
    pool: &SqlitePool,
    prefix: &str,
    limit: Option<i64>,
    scope: &SpaceScope,
) -> Result<Vec<(String, String, Option<String>)>, AppError> {
    let like_pattern = format!("%{}%", crate::sql_utils::escape_like(prefix));
    // R1 (#347): reject out-of-range `limit` instead of silently passing
    // an unbounded value to SQLite. Matches the `list_blocks` / `list_trash`
    // contract (`pagination::PageParams::new`): a supplied limit must be in
    // `[1, MAX_PAGE_ALIASES_PREFIX]`; `None` falls through to the cap.
    let effective_limit = match limit {
        Some(l) if (1..=MAX_PAGE_ALIASES_PREFIX).contains(&l) => l,
        Some(l) => {
            return Err(AppError::Validation(format!(
                "list_page_aliases_by_prefix limit must be in [1, {MAX_PAGE_ALIASES_PREFIX}]; got {l}"
            )));
        }
        None => MAX_PAGE_ALIASES_PREFIX,
    };
    let space_filter = scope.as_filter_param();
    let rows = sqlx::query_as!(
        PageAliasPrefixRow,
        r#"SELECT pa.page_id AS "page_id!: PageId", pa.alias AS "alias!", b.content AS "title?"
         FROM page_aliases pa
         JOIN blocks b ON b.id = pa.page_id
         WHERE pa.alias LIKE ?1 ESCAPE '\' COLLATE NOCASE
           AND b.deleted_at IS NULL
           AND (?3 IS NULL OR b.space_id = ?3)
         ORDER BY length(pa.alias), pa.alias
         LIMIT ?2"#,
        like_pattern,
        effective_limit,
        space_filter,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.page_id.into_string(), r.alias, r.title))
        .collect())
}

/// Tauri command: set page aliases. Delegates to [`set_page_aliases_inner`].
#[tauri::command]
#[specta::specta]
pub async fn set_page_aliases(
    write_pool: State<'_, WritePool>,
    page_id: PageId,
    aliases: Vec<String>,
) -> Result<Vec<String>, AppError> {
    set_page_aliases_inner(&write_pool.0, page_id.as_str(), aliases)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: get page aliases. Delegates to [`get_page_aliases_inner`].
#[tauri::command]
#[specta::specta]
pub async fn get_page_aliases(
    read_pool: State<'_, ReadPool>,
    page_id: PageId,
) -> Result<Vec<String>, AppError> {
    get_page_aliases_inner(&read_pool.0, page_id.as_str())
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: resolve a page by alias. Delegates to [`resolve_page_by_alias_inner`].
#[tauri::command]
#[specta::specta]
pub async fn resolve_page_by_alias(
    read_pool: State<'_, ReadPool>,
    alias: String,
    scope: SpaceScope,
) -> Result<Option<(String, Option<String>)>, AppError> {
    resolve_page_by_alias_inner(&read_pool.0, &alias, &scope)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list page aliases by prefix.
/// Delegates to [`list_page_aliases_by_prefix_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_page_aliases_by_prefix(
    read_pool: State<'_, ReadPool>,
    prefix: String,
    limit: Option<i64>,
    scope: SpaceScope,
) -> Result<Vec<(String, String, Option<String>)>, AppError> {
    list_page_aliases_by_prefix_inner(&read_pool.0, &prefix, limit, &scope)
        .await
        .map_err(sanitize_internal_error)
}
