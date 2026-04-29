//! Pages command handlers.

use std::collections::HashMap;

use serde::Serialize;
use specta::Type;
use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::{CommandTx, ReadPool, WritePool};
use crate::device::DeviceId;
use crate::error::AppError;
use crate::import;
use crate::import::ImportResult;
use crate::materializer::Materializer;
use crate::pagination::{BlockRow, Cursor, PageRequest, PageResponse, NULL_POSITION_SENTINEL};

use super::*;

/// Soft cap applied to `list_pages_inner` / `get_page_inner` at the tool
/// boundary. Callers may pass any `Option<i64>`; the value is clamped to
/// [1, 100] before being forwarded to the underlying pagination layer.
/// Matches the FEAT-4c tool-surface cap documented in REVIEW-LATER.
pub const MCP_PAGE_LIMIT_CAP: i64 = 100;

/// Replace the full set of aliases for a page. Returns the aliases that were
/// actually inserted (empty/whitespace-only entries are skipped; duplicates
/// across different pages are silently ignored via INSERT OR IGNORE).
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

    // Verify page exists and is a page type
    let exists: bool = sqlx::query_scalar(
        "SELECT COUNT(*) > 0 FROM blocks WHERE id = ?1 AND block_type = 'page' AND deleted_at IS NULL",
    )
    .bind(&page_id)
    .fetch_one(pool)
    .await?;

    if !exists {
        return Err(AppError::NotFound("page not found".into()));
    }

    // M-21: wrap the DELETE + per-alias INSERT loop in a single
    // `BEGIN IMMEDIATE` transaction so that a crash, pool-acquire
    // failure, or per-row INSERT error mid-loop rolls the page back to
    // its prior alias set instead of leaving a partial replacement.
    // Concurrent callers for the same page also serialize on the
    // immediate write lock instead of interleaving their phases.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Delete existing aliases
    sqlx::query("DELETE FROM page_aliases WHERE page_id = ?1")
        .bind(&page_id)
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
        let result =
            sqlx::query("INSERT OR IGNORE INTO page_aliases (page_id, alias) VALUES (?1, ?2)")
                .bind(&page_id)
                .bind(&trimmed)
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
    let aliases: Vec<String> =
        sqlx::query_scalar("SELECT alias FROM page_aliases WHERE page_id = ?1 ORDER BY alias")
            .bind(page_id)
            .fetch_all(pool)
            .await?;
    Ok(aliases)
}

/// Look up a page by one of its aliases. Returns `(page_id, title)` if found.
#[instrument(skip(pool), err)]
pub async fn resolve_page_by_alias_inner(
    pool: &SqlitePool,
    alias: &str,
) -> Result<Option<(String, Option<String>)>, AppError> {
    let result: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT pa.page_id, b.content \
         FROM page_aliases pa \
         JOIN blocks b ON b.id = pa.page_id \
         WHERE pa.alias = ?1 COLLATE NOCASE \
           AND b.deleted_at IS NULL",
    )
    .bind(alias)
    .fetch_optional(pool)
    .await?;
    Ok(result)
}

/// Replace `#[ULID]` with `#tagname` and `[[ULID]]` with `[[Page Title]]`
/// in content, preserving all other markdown formatting.
fn resolve_ulids_for_export(
    content: &str,
    tag_names: &HashMap<String, String>,
    page_titles: &HashMap<String, String>,
) -> String {
    use crate::fts::{PAGE_LINK_RE, TAG_REF_RE};

    // Replace #[ULID] → #tagname
    let result = TAG_REF_RE
        .replace_all(content, |caps: &regex::Captures| {
            let ulid = &caps[1];
            if let Some(name) = tag_names.get(ulid) {
                format!("#{name}")
            } else {
                format!("#[{ulid}]") // Keep original if not found
            }
        })
        .into_owned();

    // Replace [[ULID]] → [[Page Title]]
    let result = PAGE_LINK_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let ulid = &caps[1];
            if let Some(title) = page_titles.get(ulid) {
                format!("[[{title}]]")
            } else {
                format!("[[{ulid}]]") // Keep original if not found
            }
        })
        .into_owned();

    result
}

/// Export a page and its child blocks as a Markdown string with
/// human-readable tag/page references and optional YAML frontmatter.
///
/// 1. Emits `# Page Title`
/// 2. If the page has properties, emits a `---` YAML frontmatter block
/// 3. For each child block (ordered by position), resolves `#[ULID]` and
///    `[[ULID]]` references to their human-readable names, preserving all
///    markdown formatting.
///
/// # Errors
///
/// - [`AppError::Validation`] — `page_id` does not refer to a `page` block
/// - [`AppError::NotFound`] — block not found
#[instrument(skip(pool), err)]
pub async fn export_page_markdown_inner(
    pool: &SqlitePool,
    page_id: &str,
) -> Result<String, AppError> {
    // 1. Get the page
    let page = get_block_inner(pool, page_id.to_string()).await?;
    if page.block_type != "page" {
        return Err(AppError::Validation("not a page".into()));
    }

    // 2. Get all child blocks (ordered by position)
    let children = pagination::list_children(
        pool,
        Some(page_id),
        &pagination::PageRequest::new(None, Some(1000))?,
        None, // FEAT-3 Phase 2: export is per-page — no space filter needed.
    )
    .await?;

    // 3. Get all tag names and page titles for ULID replacement
    let tag_rows = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT id, content FROM blocks WHERE block_type = 'tag' AND deleted_at IS NULL",
    )
    .fetch_all(pool)
    .await?;
    let tag_names: HashMap<String, String> = tag_rows
        .into_iter()
        .filter_map(|(id, content)| content.map(|c| (id, c)))
        .collect();

    let page_rows = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT id, content FROM blocks WHERE block_type = 'page' AND deleted_at IS NULL",
    )
    .fetch_all(pool)
    .await?;
    let page_titles: HashMap<String, String> = page_rows
        .into_iter()
        .map(|(id, content)| (id, content.unwrap_or_else(|| "Untitled".to_string())))
        .collect();

    // 4. Get page properties for frontmatter
    let properties: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT key, value_text, value_date FROM block_properties WHERE block_id = ?1",
    )
    .bind(page_id)
    .fetch_all(pool)
    .await?;

    // 5. Build markdown output
    let mut output = String::new();

    // Title
    let title = page.content.unwrap_or_else(|| "Untitled".to_string());
    output.push_str(&format!("# {title}\n\n"));

    // Frontmatter (if properties exist)
    if !properties.is_empty() {
        output.push_str("---\n");
        for (key, text, date) in &properties {
            let value = date.as_deref().or(text.as_deref()).unwrap_or("");
            output.push_str(&format!("{key}: {value}\n"));
        }
        output.push_str("---\n\n");
    }

    // Block content
    for block in &children.items {
        let content = block.content.as_deref().unwrap_or("");
        let resolved = resolve_ulids_for_export(content, &tag_names, &page_titles);
        output.push_str(&resolved);
        output.push('\n');
    }

    Ok(output)
}

/// Import a Logseq-style markdown file as a page with block hierarchy.
///
/// Creates a page from the filename (or first heading), then creates
/// blocks following the indentation hierarchy. Properties are set via
/// SetProperty ops. Returns import statistics.
///
/// REVIEW-LATER L-30 — All-or-nothing semantics: any per-block
/// `create_block_in_tx` or per-property `set_property_in_tx` failure
/// aborts the import. The enclosing `BEGIN IMMEDIATE` is rolled back on
/// `Drop` (no commit reached), so partially-imported rows never land in
/// the DB. `result.warnings` is reserved for non-transactional parse
/// diagnostics from [`import::parse_logseq_markdown`] (e.g. depth
/// clamping); per-row write failures surface as `Err(AppError)` rather
/// than entries in `warnings`. Savepoint-based partial recovery was
/// considered and rejected as too invasive for the available signal.
#[instrument(skip(pool, device_id, materializer, content), err)]
pub async fn import_markdown_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    content: String,
    filename: Option<String>,
) -> Result<ImportResult, AppError> {
    let parse_output = import::parse_logseq_markdown(&content);

    // Derive page title from filename (strip .md extension)
    let page_title = filename
        .map(|f| f.trim_end_matches(".md").to_string())
        .unwrap_or_else(|| "Imported Page".to_string());

    // --- Single IMMEDIATE transaction for entire import ---
    // MAINT-112: CommandTx couples commit + post-commit dispatch; op
    // records enqueue in the loop and drain in FIFO order after commit.
    // L-30: per-block / per-property failures propagate via `?` so the
    // transaction rolls back as a whole on first error — never partial.
    let mut tx = CommandTx::begin_immediate(pool, "import_markdown").await?;

    // Create the page inside the transaction
    let (page, page_op) = create_block_in_tx(
        &mut tx,
        device_id,
        "page".into(),
        page_title.clone(),
        None,
        None,
    )
    .await?;
    tx.enqueue_background(page_op);
    let page_id = page.id.clone();

    let mut blocks_created: i64 = 0;
    let mut properties_set: i64 = 0;
    // Parse-time diagnostics (e.g. depth clamping). Per-row write
    // failures are reported via `Err(AppError)` instead — see L-30 note.
    let warnings: Vec<String> = parse_output.warnings;

    // Track parent stack: (depth, block_id)
    let mut parent_stack: Vec<(usize, String)> = vec![(0, page_id.clone())];

    for block in &parse_output.blocks {
        // Find the correct parent: pop stack until we find a parent at depth < block.depth
        while parent_stack.len() > 1 && parent_stack.last().is_some_and(|(d, _)| *d >= block.depth)
        {
            parent_stack.pop();
        }
        let parent_id = parent_stack
            .last()
            .map(|(_, id)| id.clone())
            .unwrap_or(page_id.clone());

        // Create the block inside the transaction. L-30: a failure here
        // aborts the entire import — `?` drops `tx` and rolls back.
        let (new_block, block_op) = create_block_in_tx(
            &mut tx,
            device_id,
            "content".into(),
            block.content.clone(),
            Some(parent_id.clone()),
            None,
        )
        .await?;
        blocks_created += 1;
        tx.enqueue_background(block_op);
        parent_stack.push((block.depth, new_block.id.clone()));

        // Set properties inside the same transaction. L-30: same
        // all-or-nothing contract as the block-create above.
        for (key, value) in &block.properties {
            let (_block, prop_op) = set_property_in_tx(
                &mut tx,
                device_id,
                new_block.id.clone(),
                key,
                Some(value.clone()),
                None,
                None,
                None,
            )
            .await?;
            properties_set += 1;
            tx.enqueue_background(prop_op);
        }
    }

    // Commit + dispatch all queued ops in FIFO order.
    tx.commit_and_dispatch(materializer).await?;

    Ok(ImportResult {
        page_title,
        blocks_created,
        properties_set,
        warnings,
    })
}

/// List all links between pages (for graph view).
///
/// Returns edges where both source and target are non-deleted page blocks.
/// Block-level links (where source is a content block) are rolled up to
/// their parent page.
#[instrument(skip(pool), err)]
pub async fn list_page_links_inner(pool: &SqlitePool) -> Result<Vec<PageLink>, AppError> {
    // For each block_link, find the parent page of the source block.
    // The target in block_links is already a page (since [[links]] point to pages).
    // The source might be a content block under a page — we need the page ancestor.
    //
    // Simple approach: join source_id to blocks to get parent_id (the page),
    // then filter both sides to be page-type blocks that aren't deleted.
    //
    // P-15 optimized: JOIN tb first (smaller page-only set via idx_blocks_page_alive),
    // move LEFT JOIN conditions inline so pb.id IS NOT NULL replaces the WHERE filter.
    let links = sqlx::query_as::<_, PageLink>(
        "SELECT
            COALESCE(sb.parent_id, bl.source_id) AS source_id,
            bl.target_id AS target_id,
            COUNT(*) AS ref_count
         FROM block_links bl
         JOIN blocks tb ON tb.id = bl.target_id
             AND tb.block_type = 'page'
             AND tb.deleted_at IS NULL
             AND tb.is_conflict = 0
         JOIN blocks sb ON sb.id = bl.source_id
             AND sb.deleted_at IS NULL
             AND sb.is_conflict = 0
         LEFT JOIN blocks pb ON pb.id = sb.parent_id
             AND pb.deleted_at IS NULL
             AND pb.block_type = 'page'
             AND pb.is_conflict = 0
         WHERE COALESCE(sb.parent_id, bl.source_id) != bl.target_id
             AND (sb.parent_id IS NULL OR pb.id IS NOT NULL)
         GROUP BY 1, 2",
    )
    .fetch_all(pool)
    .await?;

    Ok(links)
}

/// List all pages in the database with cursor pagination.
///
/// Returns non-deleted, non-conflict blocks with `block_type = 'page'`,
/// ordered by `id ASC` (ULID ≈ chronological). `limit` is clamped to
/// `[1, MCP_PAGE_LIMIT_CAP]` at this boundary; callers can still fetch
/// all pages via the returned cursor.
///
/// Thin wrapper over [`pagination::list_by_type`]; used directly by the
/// FEAT-4c MCP `list_pages` tool. Frontend code reaches for backlinks /
/// FTS instead and does not call this.
#[instrument(skip(pool), err)]
pub async fn list_pages_inner(
    pool: &SqlitePool,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let capped = limit.map(|l| l.clamp(1, MCP_PAGE_LIMIT_CAP));
    let page = PageRequest::new(cursor, capped)?;
    // FEAT-3 Phase 2: `list_pages` is the MCP (agent) page enumeration
    // and stays unscoped — agents see every space. Frontend-facing page
    // lookups go through `list_blocks_inner` which threads `space_id`.
    pagination::list_by_type(pool, "page", &page, None).await
}

/// Response shape for [`get_page_inner`] — the page itself plus its
/// paginated subtree of non-conflict descendants.
///
/// `children` is ordered `(position ASC, id ASC)` over the keyset, where
/// the keyset walks **all** non-conflict, non-deleted blocks whose
/// `page_id` column points at the requested page (so grandchildren /
/// deeper descendants are included, not just direct children). This
/// matches the FEAT-4c tool-surface definition of
/// `list_blocks_inner(root, subtree=true)` — we denormalize via the
/// `page_id` column the materializer maintains rather than running a
/// recursive CTE at every call.
#[derive(Debug, Clone, Serialize, Type)]
pub struct PageSubtreeResponse {
    /// The page block itself (root of the subtree).
    pub page: BlockRow,
    /// Non-conflict, non-deleted descendants under `page`, ordered by
    /// `(position, id)` and paginated by [`MCP_PAGE_LIMIT_CAP`].
    pub children: Vec<BlockRow>,
    /// Opaque cursor for the next page of `children`; `None` when there
    /// are no further descendants.
    pub next_cursor: Option<String>,
    /// `true` when more `children` remain beyond `next_cursor`.
    pub has_more: bool,
}

/// Fetch a page and a paginated slice of its non-conflict subtree.
///
/// Composes [`get_block_inner`] for the root and a `page_id`-column
/// descendant walk for the children. Validates that the requested block
/// exists and is actually a `page`. Returns [`AppError::NotFound`] for
/// unknown IDs and [`AppError::Validation`] when the ID resolves to a
/// non-page block, or when the page does not belong to `space_id`.
///
/// FEAT-3 Phase 7 — `space_id` is required (not optional). Pages whose
/// `space` property does not match `space_id` are rejected with
/// [`AppError::Validation`]. This is the policy enforcement point for
/// "no live links between spaces, ever": deep-linking into a foreign
/// page from inside a different space's tab stack is impossible. See
/// REVIEW-LATER FEAT-3p7.
///
/// The descendant walk intentionally uses the denormalized `page_id`
/// column (index `idx_blocks_page_id`) rather than a recursive CTE —
/// the materializer maintains the column on every command path, and the
/// index makes the query O(log n + k) at any scale. Conflict copies are
/// excluded via `is_conflict = 0` per invariant #9.
#[instrument(skip(pool), err)]
pub async fn get_page_inner(
    pool: &SqlitePool,
    page_id: &str,
    space_id: &str,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageSubtreeResponse, AppError> {
    let page = get_block_inner(pool, page_id.to_string()).await?;
    if page.block_type != "page" {
        return Err(AppError::Validation(format!(
            "block '{page_id}' has block_type '{}', expected 'page'",
            page.block_type
        )));
    }

    // FEAT-3 Phase 7: enforce space membership. The page must carry a
    // `space` property equal to `space_id`, otherwise the request crosses
    // a space boundary — which the locked-in design forbids. Returning
    // `Validation` keeps the error category consistent with other
    // policy-violation rejections (e.g. wrong block_type above).
    let space_match = sqlx::query_scalar!(
        r#"SELECT 1 AS "ok!: i32" FROM block_properties
           WHERE block_id = ? AND key = 'space' AND value_ref = ?"#,
        page_id,
        space_id,
    )
    .fetch_optional(pool)
    .await?;
    if space_match.is_none() {
        return Err(AppError::Validation(format!(
            "page '{page_id}' not in current space '{space_id}'"
        )));
    }

    let capped = limit.map(|l| l.clamp(1, MCP_PAGE_LIMIT_CAP));
    let page_req = PageRequest::new(cursor, capped)?;
    let fetch_limit = page_req.limit + 1;

    // Keyset: `(position, id)`. `NULL_POSITION_SENTINEL` is used as the
    // default cursor-position so positioned rows sort before NULL-position
    // rows, matching the ordering convention in `pagination::list_children`.
    //
    // I-CommandsCRUD-12: previously hard-coded as a function-local
    // `const NULL_POSITION_SENTINEL: i64 = i64::MAX;` to avoid widening
    // `pagination::NULL_POSITION_SENTINEL`'s visibility. Now imported from
    // `pagination` directly (still `pub(crate)`, intra-crate re-use is the
    // intended scope), so any future change to the sentinel's value is
    // automatically picked up here without a silent drift hazard.
    let (cursor_flag, cursor_pos, cursor_id): (Option<i64>, i64, &str) =
        match page_req.after.as_ref() {
            Some(c) => (Some(1), c.position.unwrap_or(NULL_POSITION_SENTINEL), &c.id),
            None => (None, 0, ""),
        };

    // Invariant #9: `is_conflict = 0` excludes conflict-copy blocks that
    // share a `page_id` but must never appear in the user-facing subtree.
    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position,
                deleted_at, is_conflict as "is_conflict: bool",
                conflict_type, todo_state, priority, due_date, scheduled_date,
                page_id
         FROM blocks
         WHERE page_id = ?1
           AND id != ?1
           AND is_conflict = 0
           AND deleted_at IS NULL
           AND (?2 IS NULL OR (
                COALESCE(position, ?6) > ?3
                OR (COALESCE(position, ?6) = ?3 AND id > ?4)))
         ORDER BY COALESCE(position, ?6) ASC, id ASC
         LIMIT ?5"#,
        page_id,                // ?1
        cursor_flag,            // ?2
        cursor_pos,             // ?3
        cursor_id,              // ?4
        fetch_limit,            // ?5
        NULL_POSITION_SENTINEL  // ?6
    )
    .fetch_all(pool)
    .await?;

    // Mirror `build_page_response` locally because `PageSubtreeResponse`
    // is not a `PageResponse<T>` — we nest children inside the page shape.
    let limit_usize = usize::try_from(page_req.limit).unwrap_or(usize::MAX);
    let has_more = rows.len() > limit_usize;
    let mut children = rows;
    if has_more {
        children.truncate(limit_usize);
    }
    let next_cursor = if has_more {
        let last = children.last().expect("has_more implies non-empty");
        let cur = Cursor {
            id: last.id.clone(),
            position: Some(last.position.unwrap_or(NULL_POSITION_SENTINEL)),
            deleted_at: None,
            seq: None,
            rank: None,
        };
        Some(cur.encode()?)
    } else {
        None
    };

    Ok(PageSubtreeResponse {
        page,
        children,
        next_cursor,
        has_more,
    })
}

/// Fetch a page + paginated subtree without a caller-supplied
/// `space_id`. Looks up the page's own `space` property and feeds it
/// into [`get_page_inner`], so the FEAT-3 Phase 7 membership check is
/// trivially satisfied.
///
/// Used by the MCP `get_page` tool (`crate::mcp::tools_ro`) where the
/// agent is intentionally unscoped — every page the agent can name
/// belongs to its own space by construction. Frontend callers always
/// know their `space_id` and call [`get_page_inner`] directly; this
/// helper exists so the tool layer stays a "thin wrapper" instead of
/// owning a sibling `block_properties` query.
///
/// Error contract preserves the pre-Phase-7 MCP behaviour:
///
/// - unknown id → [`AppError::NotFound`]
/// - block_type ≠ `"page"` → [`AppError::Validation`]
///   (via [`get_page_inner`])
/// - page exists but has no `space` property → [`AppError::Validation`]
///   (so agents can distinguish "no such page" from "exists but
///   unscoped" via the error category).
///
/// MAINT-150 (g): pulled out of `mcp::tools_ro::handle_get_page` so
/// `mcp::tools_ro` no longer carries direct SQL — the module header
/// invariant is "thin wrapper around `*_inner`".
#[instrument(skip(pool), err)]
pub async fn get_page_unscoped_inner(
    pool: &SqlitePool,
    page_id: &str,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageSubtreeResponse, AppError> {
    // Look up the page's own `space` property. The `block_properties`
    // table is keyed `(block_id, key)` so a single query is enough; we
    // intentionally do not join `blocks` because the next branch wants
    // to distinguish "no row" (page may not exist) from "row with
    // null value_ref" (defensive — should not occur for `space`).
    let space_id: Option<String> = sqlx::query_scalar!(
        r#"SELECT value_ref FROM block_properties
           WHERE block_id = ? AND key = 'space'"#,
        page_id,
    )
    .fetch_optional(pool)
    .await?
    .flatten();
    let Some(space_id) = space_id else {
        // No space property — distinguish "unknown id" (NotFound) from
        // "exists but unscoped" (Validation) by hitting `get_block_inner`
        // first; it returns `NotFound` for unknown ids. If the block
        // exists but has no space, fall through to `Validation` so the
        // error category matches what an MCP agent would have seen
        // pre-Phase-7.
        get_block_inner(pool, page_id.to_string()).await?;
        return Err(AppError::Validation(format!(
            "page '{page_id}' has no space property"
        )));
    };
    get_page_inner(pool, page_id, &space_id, cursor, limit).await
}

/// Tauri command: set page aliases. Delegates to [`set_page_aliases_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn set_page_aliases(
    write_pool: State<'_, WritePool>,
    page_id: String,
    aliases: Vec<String>,
) -> Result<Vec<String>, AppError> {
    set_page_aliases_inner(&write_pool.0, &page_id, aliases)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: get page aliases. Delegates to [`get_page_aliases_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_page_aliases(
    read_pool: State<'_, ReadPool>,
    page_id: String,
) -> Result<Vec<String>, AppError> {
    get_page_aliases_inner(&read_pool.0, &page_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: resolve a page by alias. Delegates to [`resolve_page_by_alias_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn resolve_page_by_alias(
    read_pool: State<'_, ReadPool>,
    alias: String,
) -> Result<Option<(String, Option<String>)>, AppError> {
    resolve_page_by_alias_inner(&read_pool.0, &alias)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: export a page as Markdown. Delegates to [`export_page_markdown_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn export_page_markdown(
    read_pool: State<'_, ReadPool>,
    page_id: String,
) -> Result<String, AppError> {
    export_page_markdown_inner(&read_pool.0, &page_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: import a Logseq-style markdown file as a page with
/// block hierarchy. Delegates to [`import_markdown_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn import_markdown(
    content: String,
    filename: Option<String>,
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
) -> Result<ImportResult, AppError> {
    import_markdown_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        content,
        filename,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: list all page-to-page links for graph visualization.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_page_links(pool: State<'_, ReadPool>) -> Result<Vec<PageLink>, AppError> {
    list_page_links_inner(&pool.0)
        .await
        .map_err(sanitize_internal_error)
}
