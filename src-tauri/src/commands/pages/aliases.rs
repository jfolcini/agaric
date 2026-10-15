//! Page alias command handlers (#644 split).
//!
//! `set_page_aliases`, `get_page_aliases`, `resolve_page_by_alias`,
//! `list_page_aliases_by_prefix` and their `*_inner` cores plus the
//! prefix-picker helpers.
//!
//! An alias edit is ops (#5387): `AddPageAlias` / `RemovePageAlias`, applied
//! to the page's Loro doc and projected into `page_aliases`, so it undoes,
//! lists in page history and reaches other devices on an ordinary sync. See
//! `docs/architecture/data-and-events.md § Op log`.

use serde::Serialize;
use specta::Type;
use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::{CommandTx, ReadPool, WriteCtx};
use crate::materializer::Materializer;
use agaric_core::error::{AppError, ValidationCode};
use agaric_core::ulid::{BlockId, PageId};
use agaric_engine::loro::engine::page_alias_key;
use agaric_store::op::{AddPageAliasPayload, OpPayload, RemovePageAliasPayload};
use agaric_store::op_log;
use agaric_store::space::SpaceScope;

use super::super::*;

/// The aliases a page holds after [`set_page_aliases`], under the key its
/// `WithOps` envelope flattens.
#[derive(Debug, Clone, Serialize, Type)]
pub struct PageAliases {
    pub aliases: Vec<String>,
}

/// Replace the full set of aliases for a page with `aliases`, trimmed, with
/// empty entries skipped and a second spelling of one alias (ASCII case fold,
/// as `page_aliases.alias COLLATE NOCASE`) dropped. Returns that list, in the
/// order given.
///
/// One `CommandTx` appends a `RemovePageAlias` per alias that goes and then an
/// `AddPageAlias` per alias that comes, so one Undo reverts the edit.
///
/// # Errors
///
/// - [`AppError::NotFound`] — `page_id` names no live page.
/// - [`AppError::Validation`] coded [`ValidationCode::DuplicatePageAlias`] —
///   another page, in any space or the Trash, holds one of the aliases.
#[instrument(skip(pool, device_id, materializer, aliases), err)]
pub async fn set_page_aliases_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    page_id: &str,
    aliases: Vec<String>,
) -> Result<Vec<String>, AppError> {
    // Raw strings from MCP tools / scripts are normalised to the uppercase
    // ULID the byte-exact `blocks.id` comparison needs (invariant #8).
    let page_id = page_id.to_ascii_uppercase();
    let mut tx = CommandTx::begin_immediate(pool, "set_page_aliases").await?;
    tx.arm_engine_rollback(materializer.loro_state());
    let wanted = wanted_aliases(&aliases);
    let taken = write_page_aliases_in_tx(
        &mut tx,
        materializer.loro_state(),
        device_id,
        &page_id,
        &wanted,
    )
    .await?;
    if let Some(alias) = taken.first() {
        return Err(AppError::validation_coded(
            ValidationCode::DuplicatePageAlias,
            format!("alias '{alias}' is already used by another page"),
        ));
    }
    tx.commit_and_dispatch(materializer).await?;
    Ok(wanted)
}

/// `aliases` trimmed, without empty entries or a second spelling of one alias.
pub(crate) fn wanted_aliases<S: AsRef<str>>(aliases: &[S]) -> Vec<String> {
    let mut keys = std::collections::HashSet::new();
    aliases
        .iter()
        .map(|alias| alias.as_ref().trim())
        .filter(|alias| !alias.is_empty() && keys.insert(page_alias_key(alias)))
        .map(str::to_owned)
        .collect()
}

/// `NotFound` unless `page_id` is a live page.
pub(crate) async fn require_live_page(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
) -> Result<(), AppError> {
    let exists: bool = sqlx::query_scalar!(
        r#"SELECT COUNT(*) > 0 AS "exists!: bool" FROM blocks WHERE id = ?1 AND block_type = 'page' AND deleted_at IS NULL"#,
        page_id,
    )
    .fetch_one(&mut *conn)
    .await?;
    if exists {
        Ok(())
    } else {
        Err(AppError::NotFound("page not found".into()))
    }
}

/// The page other than `page_id` that holds `alias`, if any.
pub(crate) async fn alias_holder_other_than(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
    alias: &str,
) -> Result<Option<String>, AppError> {
    Ok(sqlx::query_scalar!(
        "SELECT page_id FROM page_aliases WHERE alias = ?1 AND page_id <> ?2",
        alias,
        page_id,
    )
    .fetch_optional(&mut *conn)
    .await?)
}

/// Make `page_id`'s aliases `wanted` (already [`wanted_aliases`]) in the
/// caller's transaction: a `RemovePageAlias` for each alias that goes, then an
/// `AddPageAlias` for each that comes, each applied and enqueued for dispatch.
/// Returns the wanted aliases another page holds, which are not added.
///
/// # Errors
///
/// [`AppError::NotFound`] when `page_id` is not a live page.
pub(crate) async fn write_page_aliases_in_tx(
    tx: &mut CommandTx,
    state: &agaric_engine::loro::shared::LoroState,
    device_id: &str,
    page_id: &str,
    wanted: &[String],
) -> Result<Vec<String>, AppError> {
    require_live_page(tx, page_id).await?;
    let held = sqlx::query_scalar!(
        "SELECT alias FROM page_aliases WHERE page_id = ?1 ORDER BY alias",
        page_id,
    )
    .fetch_all(&mut ***tx)
    .await?;
    let page = BlockId::from_trusted(page_id);
    let mut ops: Vec<OpPayload> = held
        .iter()
        .filter(|alias| !wanted.contains(alias))
        .map(|alias| {
            OpPayload::RemovePageAlias(RemovePageAliasPayload {
                page_id: page.clone(),
                alias: alias.clone(),
            })
        })
        .collect();
    let mut taken = Vec::new();
    for alias in wanted.iter().filter(|alias| !held.contains(alias)) {
        if alias_holder_other_than(tx, page_id, alias).await?.is_some() {
            taken.push(alias.clone());
            continue;
        }
        ops.push(OpPayload::AddPageAlias(AddPageAliasPayload {
            page_id: page.clone(),
            alias: alias.clone(),
        }));
    }
    for payload in ops {
        let record =
            op_log::append_local_op_in_tx(tx, device_id, payload, crate::db::now_ms()).await?;
        crate::materializer::apply_op_projected(tx, &record, state, false).await?;
        tx.enqueue_background(record);
    }
    Ok(taken)
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
/// `scope` restricts the match to aliases pointing at pages whose
/// `b.space_id` equals the scope's [`SpaceId`](agaric_store::space::SpaceId)
/// (#533, migration 0086 — `space_id` is a first-class column), the same
/// scoping rule [`list_page_aliases_by_prefix_inner`] applies.
#[instrument(skip(pool), err)]
pub async fn resolve_page_by_alias_inner(
    pool: &SqlitePool,
    alias: &str,
    scope: &SpaceScope,
) -> Result<Option<(String, Option<String>)>, AppError> {
    let space_filter = scope.space_id().as_str();
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
/// Bounded by `MAX_PAGE_ALIASES_PREFIX` to keep the popup responsive
/// even if a user has hundreds of substring-matched aliases.
///
/// `scope` restricts the result set to aliases pointing at pages whose
/// `blocks.space_id` column equals the scope's
/// [`SpaceId`](agaric_store::space::SpaceId).
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
    let like_pattern = format!("%{}%", agaric_core::sql_utils::escape_like(prefix));
    // R1 (#347): reject out-of-range `limit` instead of silently passing
    // an unbounded value to SQLite. Matches the `list_blocks` / `list_trash`
    // contract (`pagination::PageParams::new`): a supplied limit must be in
    // `[1, MAX_PAGE_ALIASES_PREFIX]`; `None` falls through to the cap.
    let effective_limit = match limit {
        Some(l) if (1..=MAX_PAGE_ALIASES_PREFIX).contains(&l) => l,
        Some(l) => {
            return Err(AppError::validation(format!(
                "list_page_aliases_by_prefix limit must be in [1, {MAX_PAGE_ALIASES_PREFIX}]; got {l}"
            )));
        }
        None => MAX_PAGE_ALIASES_PREFIX,
    };
    let space_filter = scope.space_id().as_str();
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

/// Tauri command: set page aliases. Delegates to [`set_page_aliases_inner`];
/// the response carries the op refs it appended, for the undo stack (#2468).
#[tauri::command]
#[specta::specta]
pub async fn set_page_aliases(
    ctx: State<'_, WriteCtx>,
    page_id: PageId,
    aliases: Vec<String>,
) -> Result<WithOps<PageAliases>, AppError> {
    capture_op_refs(async {
        set_page_aliases_inner(
            ctx.pool(),
            ctx.device_id(),
            ctx.materializer(),
            page_id.as_str(),
            aliases,
        )
        .await
        .map(|aliases| PageAliases { aliases })
    })
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
