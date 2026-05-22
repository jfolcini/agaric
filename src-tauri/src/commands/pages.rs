//! Pages command handlers.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::{CommandTx, ReadPool, WritePool};
use crate::device::DeviceId;
use crate::error::AppError;
use crate::filters::{FilterPrimitive, PagesProjection, Projection};
use crate::import;
use crate::import::ImportResult;
use crate::materializer::Materializer;
use crate::pagination::{BlockRow, Cursor, PageRequest, PageResponse, NULL_POSITION_SENTINEL};
use crate::space::SpaceScope;
use crate::ulid::BlockId;

use super::*;

/// Soft cap applied to `list_pages_inner` / `get_page_inner` at the tool
/// boundary. Callers may pass any `Option<i64>`; the value is clamped to
/// [1, 100] before being forwarded to the underlying pagination layer.
/// Matches the FEAT-4c tool-surface cap documented in REVIEW-LATER.
pub const MCP_PAGE_LIMIT_CAP: i64 = 100;

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
///
/// `scope` (PEND-35 Tier 1.2) — [`SpaceScope::Active`] restricts the
/// match to aliases pointing at pages whose `space` property equals the
/// wrapped [`SpaceId`]. Mirrors the
/// `(?N IS NULL OR pa.page_id IN (SELECT bp.block_id ...))` short-circuit
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
    let result: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT pa.page_id, b.content \
         FROM page_aliases pa \
         JOIN blocks b ON b.id = pa.page_id \
         WHERE pa.alias = ?1 COLLATE NOCASE \
           AND b.deleted_at IS NULL \
           AND (?2 IS NULL OR pa.page_id IN ( \
                SELECT bp.block_id FROM block_properties bp \
                WHERE bp.key = 'space' AND bp.value_ref = ?2))",
    )
    .bind(alias)
    .bind(space_filter)
    .fetch_optional(pool)
    .await?;
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
    page_id: String,
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
/// `scope` (FEAT-3p4 / PEND-34) — [`SpaceScope::Active`] restricts the
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
    let effective_limit = limit.unwrap_or(MAX_PAGE_ALIASES_PREFIX);
    let space_filter = scope.as_filter_param();
    let rows = sqlx::query_as!(
        PageAliasPrefixRow,
        r#"SELECT pa.page_id AS "page_id!", pa.alias AS "alias!", b.content AS "title?"
         FROM page_aliases pa
         JOIN blocks b ON b.id = pa.page_id
         WHERE pa.alias LIKE ?1 ESCAPE '\' COLLATE NOCASE
           AND b.deleted_at IS NULL
           AND (?3 IS NULL OR b.id IN (
                SELECT bp.block_id FROM block_properties bp
                WHERE bp.key = 'space' AND bp.value_ref = ?3))
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
        .map(|r| (r.page_id, r.alias, r.title))
        .collect())
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

/// Export a page and its full descendant subtree as a Markdown string with
/// human-readable tag/page references and optional YAML frontmatter.
///
/// 1. Emits `# Page Title`
/// 2. If the page has properties, emits a `---` YAML frontmatter block
/// 3. For each descendant block — direct children **and** transitively
///    nested blocks — ordered by `(position, id)` over the keyset,
///    resolves `#[ULID]` and `[[ULID]]` references to their human-readable
///    names, preserving all markdown formatting.
///
/// The descendant walk is cursor-paginated through the denormalized
/// `page_id` column (`idx_blocks_page_id`) and accumulates every page of
/// rows into a single `Vec<BlockRow>` — there is no silent truncation.
/// Tag and page reference targets are resolved with one batched
/// `json_each(?)` query (M-27): pre-fix the function loaded *every*
/// non-deleted tag and page in the vault on every export.
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
    use crate::fts::{PAGE_LINK_RE, TAG_REF_RE};
    use std::collections::HashSet;

    // L-136: validate ULID format upfront so malformed inputs surface
    // `AppError::Ulid` rather than the imprecise `AppError::NotFound`
    // that the SQL `WHERE id = ?` lookup would otherwise produce.
    BlockId::from_string(page_id)?;

    // 1. Get the page
    //
    // M-98 — `get_active_block_inner` (not `get_block_inner`) so a
    // soft-deleted page surfaces as `NotFound` instead of exporting
    // as `# Title\n\n` with no descendants. The descendant walk
    // below already filters `deleted_at IS NULL`, so prior to this
    // fix the page row itself was the only row that could leak.
    let page = get_active_block_inner(pool, page_id.to_string()).await?;
    if page.block_type != "page" {
        return Err(AppError::Validation("not a page".into()));
    }

    // 2. Walk the full descendant subtree, cursor-paginated over the
    //    `(position, id)` keyset on the denormalised `page_id` column.
    //    Loops through every page of results — `next_cursor = None`
    //    ends the walk. Pre-fix this used `list_children` with a hard
    //    `limit = 1000` direct-children cap and silently dropped every
    //    descendant beyond it (M-27).
    //
    //    Page size of 200 matches `MAX_PAGE_SIZE` in the pagination
    //    layer; the `+ 1` fetch-limit + `truncate` shape mirrors
    //    `pagination::build_page_response`. `Cursor` and `PageRequest`
    //    are reused from `crate::pagination` as the single source of
    //    truth for keyset cursor encoding (versioning, base64).
    const DESCENDANT_PAGE_SIZE: i64 = 200;
    let mut descendants: Vec<BlockRow> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let req = PageRequest::new(cursor, Some(DESCENDANT_PAGE_SIZE))?;
        let fetch_limit = req.limit + 1;
        let (cursor_flag, cursor_pos, cursor_id): (Option<i64>, i64, &str) =
            match req.after.as_ref() {
                Some(c) => (Some(1), c.position.unwrap_or(NULL_POSITION_SENTINEL), &c.id),
                None => (None, 0, ""),
            };

        // Mirrors `get_page_inner`'s subtree walk: keyset on
        // `(COALESCE(position, sentinel), id)` over `page_id = ?1`, with
        // the page row itself (`id = ?1`) excluded.
        let rows = sqlx::query_as!(
            BlockRow,
            r#"SELECT id, block_type, content, parent_id, position,
                    deleted_at,
                     todo_state, priority, due_date, scheduled_date,
                    page_id
             FROM blocks
             WHERE page_id = ?1
               AND id != ?1
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
            NULL_POSITION_SENTINEL, // ?6
        )
        .fetch_all(pool)
        .await?;

        let limit_usize = usize::try_from(req.limit).unwrap_or(usize::MAX);
        let has_more = rows.len() > limit_usize;
        let mut page_rows = rows;
        if has_more {
            page_rows.truncate(limit_usize);
        }

        let next_cursor = if has_more {
            let last = page_rows.last().expect("has_more implies non-empty");
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

        descendants.extend(page_rows);
        match next_cursor {
            None => break,
            Some(s) => cursor = Some(s),
        }
    }

    // 3. Batch-resolve tag/page references: regex-extract the union of
    //    `#[ULID]` and `[[ULID]]` tokens from descendant content, then
    //    issue ONE `json_each(?)` query for the deduped ULID set.
    //    Pre-fix two full-table scans loaded every non-deleted tag /
    //    page in the vault on each export (M-27).
    //
    //    The block_type discriminator is applied in Rust rather than in
    //    SQL: the union query returns `(id, block_type, content)` and
    //    the loop fans rows into `tag_names` / `page_titles` per type,
    //    preserving the existing maps' semantics (tags drop NULL
    //    content; pages substitute `"Untitled"`).
    let mut ulid_set: HashSet<String> = HashSet::new();
    for block in &descendants {
        if let Some(content) = block.content.as_deref() {
            for cap in TAG_REF_RE.captures_iter(content) {
                ulid_set.insert(cap[1].to_string());
            }
            for cap in PAGE_LINK_RE.captures_iter(content) {
                ulid_set.insert(cap[1].to_string());
            }
        }
    }

    let mut tag_names: HashMap<String, String> = HashMap::new();
    let mut page_titles: HashMap<String, String> = HashMap::new();
    if !ulid_set.is_empty() {
        let ulids: Vec<String> = ulid_set.into_iter().collect();
        // sqlx requires `String` (NOT `Vec<String>`) for `json_each(?)`
        // binds — encode the set as a JSON array text and bind that.
        let ids_json = serde_json::to_string(&ulids)?;
        let rows = sqlx::query!(
            r#"SELECT id, block_type, content FROM blocks
               WHERE id IN (SELECT value FROM json_each(?1))
                 AND deleted_at IS NULL"#,
            ids_json,
        )
        .fetch_all(pool)
        .await?;
        for r in rows {
            match r.block_type.as_str() {
                "tag" => {
                    if let Some(c) = r.content {
                        tag_names.insert(r.id, c);
                    }
                }
                "page" => {
                    page_titles.insert(r.id, r.content.unwrap_or_else(|| "Untitled".to_string()));
                }
                _ => {}
            }
        }
    }

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
    for block in &descendants {
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
    space_id: String,
) -> Result<ImportResult, AppError> {
    // PEND-35 Tier 1.1 — normalize ULID to uppercase per AGENTS.md
    // invariant #8. Mirrors `create_page_in_space_inner` so a raw String
    // arg from MCP tools / sync replay / scripted imports can never land
    // a page whose `space` ref disagrees with the case-sensitive
    // `block_properties.value_ref` lookup downstream.
    let space_id = space_id.to_ascii_uppercase();

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

    // PEND-35 Tier 1.1 — validate `space_id` upfront inside the tx,
    // identically to `create_page_in_space_inner`. The target must
    // exist as a live, non-conflict block carrying `is_space = 'true'`.
    // Inside the tx the check is TOCTOU-safe against a concurrent
    // delete. Rejecting here means the import never partially writes a
    // page + blocks before failing — the early `?` rolls the whole
    // transaction back.
    let space_ok = sqlx::query_scalar!(
        r#"SELECT 1 as "ok: i32" FROM blocks b
           WHERE b.id = ?
             AND b.deleted_at IS NULL
             AND EXISTS (
                 SELECT 1 FROM block_properties p
                 WHERE p.block_id = b.id
                   AND p.key = 'is_space'
                   AND p.value_text = 'true'
             )"#,
        space_id,
    )
    .fetch_optional(&mut **tx)
    .await?;
    if space_ok.is_none() {
        return Err(AppError::Validation(format!(
            "space_id '{space_id}' does not refer to a live space block (is_space = 'true')"
        )));
    }

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

    // PEND-35 Tier 1.1 — stamp the `space` ref property on the imported
    // page. Mirrors `create_page_in_space_inner`: ops are emitted in
    // the order (create-page → set-space) so a sync peer materializes
    // them in the same order and never observes a page without its
    // space property in steady state.
    let (_page_block, page_space_op) = set_property_in_tx(
        &mut tx,
        device_id,
        page_id.clone(),
        "space",
        None,
        None,
        None,
        Some(space_id.clone()),
        None,
    )
    .await?;
    tx.enqueue_background(page_space_op);

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
///
/// `scope` (FEAT-3p4) — [`SpaceScope::Active`] restricts the result set
/// to edges where **both** the source page (`COALESCE(sb.parent_id,
/// bl.source_id)`) and the target page (`bl.target_id`) carry
/// `space = ?space_id`. This is the policy enforcement point for
/// "no live links between spaces, ever" in the graph view: an edge
/// crossing space boundaries must not surface in either space's
/// graph. [`SpaceScope::Global`] keeps the pre-FEAT-3 cross-space
/// behaviour for callers that span every space.
///
/// `tag_ids` (PEND-35 Tier 4.5) — when `Some(non-empty)`, restricts
/// edges to those whose **target page** carries at least one of the
/// listed tags via `block_tags` or `block_tag_inherited` (the same
/// UX-250 union semantics `query_by_tags` resolves to: explicit
/// `block_tags`, materialised inheritance via `block_tag_inherited`,
/// and inline `[[ULID]]` references via `block_tag_refs`). The audit
/// implies the tag predicate filters the **page being linked TO** —
/// so a graph filtered by `#project` shows only the edges whose
/// target page is project-tagged. `None` / empty leaves the edge
/// set unfiltered (pre-Tier-4.5 behaviour).
///
/// Pushed down so the renderer no longer ships every space-wide edge
/// then drops any whose endpoint is not in the post-filtered node
/// set. The unfiltered path passes a SQL NULL via the `(?2 IS NULL OR
/// …)` short-circuit so the planner picks the same shape as before.
#[instrument(skip(pool, tag_ids), err)]
pub async fn list_page_links_inner(
    pool: &SqlitePool,
    scope: &SpaceScope,
    tag_ids: Option<&[String]>,
) -> Result<Vec<PageLink>, AppError> {
    // PEND-35 Tier 4.5 — encode the tag set as a JSON array so the SQL
    // can fan it out via `json_each(?2)` (mirrors the
    // `value_text_in_json` shape in `pagination::properties`). The
    // unfiltered branch passes `None` and the `(?2 IS NULL OR …)`
    // short-circuit collapses the EXISTS subquery away.
    let tag_ids_json: Option<String> = match tag_ids {
        Some(ids) if !ids.is_empty() => Some(serde_json::to_string(ids)?),
        _ => None,
    };

    // SQL-review §H-2 — lazy-rebuild guard. The production hot path is
    // the materializer's per-`ReindexBlockLinks` rollup into
    // `page_link_cache`, so this branch is normally a no-op (the
    // `EXISTS / NOT EXISTS` short-circuit terminates after the first
    // matching row in either table). The fallback fires only when
    // `block_links` has been mutated outside the materializer (test
    // fixtures that `INSERT OR IGNORE INTO block_links` directly, or
    // a partial-migration window where the cache hasn't been backfilled
    // yet) — in that case we run a one-shot full rebuild so the read
    // path observes the same edge set the legacy query did. This keeps
    // the hard constraint "All existing list_page_links tests must pass
    // without modification" true while preserving the steady-state
    // perf win.
    let cache_empty: bool =
        sqlx::query_scalar::<_, i32>("SELECT NOT EXISTS (SELECT 1 FROM page_link_cache)")
            .fetch_one(pool)
            .await?
            == 1;
    if cache_empty {
        let block_links_present: bool =
            sqlx::query_scalar::<_, i32>("SELECT EXISTS (SELECT 1 FROM block_links)")
                .fetch_one(pool)
                .await?
                == 1;
        if block_links_present {
            crate::cache::rebuild_page_link_cache(pool).await?;
        }
    }

    // SQL-review §H-2: read from the materialised `page_link_cache`
    // (populated by `cache::reindex_page_link_cache_for_block` on every
    // `ReindexBlockLinks` task, and rebuilt en masse by
    // `RebuildPageLinkCache` on delete/restore/purge cascades) instead
    // of recomputing the 3-JOIN `block_links × blocks × block_properties`
    // roll-up on every call. The cache holds one row per
    // `(source_page_id, target_page_id, edge_count)` triple, so the
    // read collapses to two index joins (one per endpoint of `blocks`
    // for the `deleted_at IS NULL` filter) plus the optional
    // space / tag filters. Replaces the documented 1.3 s @ 100K
    // bottleneck called out in ARCH §25 (the Problem-tier row in
    // `interactive_slo`).
    //
    // The cache mirrors the legacy query's semantics ("source page =
    // COALESCE(parent_id, source_id), target page = target_id, drop
    // self-edges, soft-deleted source blocks contribute zero edges")
    // inside the materializer (see
    // `cache::page_links::reindex_page_link_cache_for_block`), so the
    // read no longer needs to re-derive any of that. The remaining
    // `blocks` joins enforce only the soft-delete filter — `block_type
    // = 'page'` stays on the target side because `block_links.target_id`
    // is by construction a page id (the `[[ULID]]` token only ever
    // resolves to a page in the markdown serializer).
    //
    // FEAT-3p4 (preserved) — `(?1 IS NULL OR ...)` filters both
    // endpoints by space membership. Cross-space rows cannot exist in
    // `page_link_cache` to begin with because the underlying
    // `block_links` rows are write-time-filtered to same-space pairs
    // (PEND-15 Phase 3 in `cache::block_links::reindex_block_links`),
    // but the explicit filter here defends against legacy rows that
    // slipped in pre-PEND-15.
    //
    // PEND-20 F (preserved) — the `space_members` CTE is materialised
    // once and reused for both endpoints. PEND-35 Tier 4.5 (preserved)
    // — the tag-EXISTS branch UNIONs `block_tags`,
    // `block_tag_inherited`, and `block_tag_refs` to mirror the
    // canonical `tag_query::resolve_tag_leaves` union semantics.
    let links = sqlx::query_as::<_, PageLink>(
        "WITH space_members AS MATERIALIZED (
             SELECT block_id FROM block_properties
             WHERE key = 'space' AND value_ref = ?1
         )
         SELECT
            plc.source_page_id AS source_id,
            plc.target_page_id AS target_id,
            plc.edge_count AS ref_count
         FROM page_link_cache plc
         JOIN blocks src ON src.id = plc.source_page_id
             AND src.deleted_at IS NULL
         JOIN blocks tgt ON tgt.id = plc.target_page_id
             AND tgt.block_type = 'page'
             AND tgt.deleted_at IS NULL
         WHERE plc.source_page_id != plc.target_page_id
             AND (?1 IS NULL OR (
                 plc.source_page_id IN (SELECT block_id FROM space_members)
                 AND plc.target_page_id IN (SELECT block_id FROM space_members)
             ))
             AND (?2 IS NULL OR EXISTS (
                 SELECT 1 FROM block_tags bt
                 WHERE bt.block_id = plc.target_page_id
                   AND bt.tag_id IN (SELECT value FROM json_each(?2))
                 UNION ALL
                 SELECT 1 FROM block_tag_inherited bti
                 WHERE bti.block_id = plc.target_page_id
                   AND bti.tag_id IN (SELECT value FROM json_each(?2))
                 UNION ALL
                 SELECT 1 FROM block_tag_refs btr
                 WHERE btr.source_id = plc.target_page_id
                   AND btr.tag_id IN (SELECT value FROM json_each(?2))
             ))",
    )
    .bind(scope.as_filter_param())
    .bind(tag_ids_json.as_deref())
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
    // limit-clamp-followup Phase 1: reject limits outside
    // `[1, MCP_PAGE_LIMIT_CAP]` loudly (was silently clamped).
    if let Some(l) = limit {
        if !(1..=MCP_PAGE_LIMIT_CAP).contains(&l) {
            return Err(AppError::Validation(format!(
                "list_pages limit must be in [1, {MCP_PAGE_LIMIT_CAP}]; got {l}. \
                 For larger result sets, use cursor pagination."
            )));
        }
    }
    let page = PageRequest::new(cursor, limit)?;
    // FEAT-3 Phase 2: `list_pages` is the MCP (agent) page enumeration
    // and stays unscoped — agents see every space. Frontend-facing page
    // lookups go through `list_blocks_inner` which threads `space_id`.
    // Downcast at the MCP-facing boundary to keep the tool's wire shape
    // stable; the active-typing invariant lives inside `list_by_type`.
    let resp = pagination::list_by_type(pool, "page", &page, None).await?;
    Ok(PageResponse {
        items: resp.items.into_iter().map(BlockRow::from).collect(),
        next_cursor: resp.next_cursor,
        has_more: resp.has_more,
        total_count: resp.total_count,
    })
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
/// Composes [`get_active_block_inner`] for the root and a
/// `page_id`-column descendant walk for the children. Validates that
/// the requested block exists and is actually a `page`. Returns
/// [`AppError::NotFound`] for unknown **or soft-deleted** IDs (M-98),
/// and [`AppError::Validation`] when the ID resolves to a non-page
/// block, or when the page does not belong to `space_id`.
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
/// excluded via  per invariant #9.
#[instrument(skip(pool), err)]
pub async fn get_page_inner(
    pool: &SqlitePool,
    page_id: &str,
    space_id: &str,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageSubtreeResponse, AppError> {
    // L-136: validate ULID format upfront so malformed inputs surface
    // `AppError::Ulid` rather than the imprecise `AppError::NotFound`
    // that the SQL `WHERE id = ?` lookup would otherwise produce.
    BlockId::from_string(page_id)?;

    // M-98 — `get_active_block_inner` (not `get_block_inner`) so the
    // page-fetch surface never returns a soft-deleted row to the
    // frontend / MCP. A tombstoned page now surfaces as
    // `AppError::NotFound`, matching the unknown-id case the
    // frontend's deep-link / journal-nav already handles.
    let page = get_active_block_inner(pool, page_id.to_string()).await?;
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

    // limit-clamp-followup Phase 1: reject limits outside
    // `[1, MCP_PAGE_LIMIT_CAP]` loudly (was silently clamped).
    if let Some(l) = limit {
        if !(1..=MCP_PAGE_LIMIT_CAP).contains(&l) {
            return Err(AppError::Validation(format!(
                "get_page limit must be in [1, {MCP_PAGE_LIMIT_CAP}]; got {l}. \
                 For larger result sets, use cursor pagination."
            )));
        }
    }
    let page_req = PageRequest::new(cursor, limit)?;
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

    // Invariant #9:  excludes conflict-copy blocks that
    // share a `page_id` but must never appear in the user-facing subtree.
    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position,
                deleted_at,
                 todo_state, priority, due_date, scheduled_date,
                page_id
         FROM blocks
         WHERE page_id = ?1
           AND id != ?1
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
        // "exists but unscoped" (Validation) by hitting
        // `get_active_block_inner` first; it returns `NotFound` for
        // unknown ids. If the block exists and is active but has no
        // space, fall through to `Validation` so the error category
        // matches what an MCP agent would have seen pre-Phase-7.
        //
        // M-98 — switched from `get_block_inner` to
        // `get_active_block_inner` so a soft-deleted page surfaces as
        // `NotFound` to the MCP read tool. Agents must not be able to
        // discover tombstoned pages via this surface; the only
        // legitimate path to soft-deleted rows is the (frontend-only)
        // trash UI.
        get_active_block_inner(pool, page_id.to_string()).await?;
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
    scope: SpaceScope,
) -> Result<Option<(String, Option<String>)>, AppError> {
    resolve_page_by_alias_inner(&read_pool.0, &alias, &scope)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list page aliases by prefix.
/// Delegates to [`list_page_aliases_by_prefix_inner`].
#[cfg(not(tarpaulin_include))]
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
///
/// PEND-35 Tier 1.1 — `space_id` is required. The imported page is
/// stamped with `space = ?space_id` inside the same transaction as the
/// `CreateBlock` op, so an imported page can never exist in the op log
/// without its space property (FEAT-3 invariant). Validation against a
/// live space block happens TOCTOU-safe inside the same transaction.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn import_markdown(
    content: String,
    filename: Option<String>,
    space_id: String,
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
        space_id,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: list all page-to-page links for graph visualization.
///
/// `tag_ids` (PEND-35 Tier 4.5) — when non-empty, restricts edges to
/// those whose target page carries at least one of the listed tags. The
/// frontend GraphView passes its active tag filter here so the backend
/// no longer ships every space-wide edge for the renderer to discard.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_page_links(
    pool: State<'_, ReadPool>,
    scope: SpaceScope,
    tag_ids: Option<Vec<String>>,
) -> Result<Vec<PageLink>, AppError> {
    list_page_links_inner(&pool.0, &scope, tag_ids.as_deref())
        .await
        .map_err(sanitize_internal_error)
}

/// Page header for callers that need every page in a space without
/// pagination.  Used by the markdown export (`exportGraphAsZip`) and by
/// the graph view, which both want the full set in one shot.
///
/// Includes the four agenda-shaped native columns on `blocks`
/// (`todo_state` / `priority` / `due_date` / `scheduled_date`) because
/// the graph node renderer keys node colour / icons on them.  The
/// markdown exporter ignores them.
#[derive(Serialize, Type, Clone, Debug, sqlx::FromRow)]
pub struct PageHeading {
    pub id: String,
    pub content: Option<String>,
    pub todo_state: Option<String>,
    pub priority: Option<String>,
    pub due_date: Option<String>,
    pub scheduled_date: Option<String>,
}

/// Return every live page in `space_id`, ordered by content
/// (case-insensitive) then id.  No pagination, no clamp.
///
/// The result set is bounded by the space's page count — intrinsic to
/// the workspace.  Use this when the caller genuinely needs every
/// page (markdown export, graph rendering); use the paginated
/// `list_blocks_inner` for list views.
///
/// When `tag_ids` is `Some(non-empty)`, restricts the result to pages
/// that carry at least one of those tags via the direct
/// `block_tags(block_id, tag_id)` table.  Inherited tags are
/// intentionally excluded — mirrors the existing GraphView semantics
/// (its previous `queryByTags(include_inherited=false)` call).
///
/// Returns only `(id, content)` because the existing callers
/// (markdown export, graph view) ignore every other column.
#[instrument(skip(pool, tag_ids), err)]
pub async fn list_all_pages_in_space_inner(
    pool: &SqlitePool,
    space_id: &str,
    tag_ids: Option<&[String]>,
) -> Result<Vec<PageHeading>, AppError> {
    if let Some(tags) = tag_ids.filter(|t| !t.is_empty()) {
        // Tag-filter branch: build an `IN (?, ?, ...)` clause inline.  We
        // can't use `query_as!` because the placeholder count is dynamic.
        let placeholders = std::iter::repeat_n("?", tags.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT b.id, b.content, b.todo_state, b.priority, b.due_date, b.scheduled_date \
             FROM blocks b \
             WHERE b.block_type = 'page' \
               AND b.deleted_at IS NULL \
               AND b.page_id IN ( \
                   SELECT bp.block_id FROM block_properties bp \
                   WHERE bp.key = 'space' AND bp.value_ref = ?) \
               AND b.id IN ( \
                   SELECT block_id FROM block_tags WHERE tag_id IN ({placeholders})) \
             ORDER BY COALESCE(b.content, '') COLLATE NOCASE ASC, b.id ASC",
        );
        let mut q = sqlx::query_as::<_, PageHeading>(&sql).bind(space_id);
        for t in tags {
            q = q.bind(t);
        }
        return Ok(q.fetch_all(pool).await?);
    }

    let rows = sqlx::query_as!(
        PageHeading,
        r#"SELECT
               b.id as "id!: String",
               b.content as "content: String",
               b.todo_state as "todo_state: String",
               b.priority as "priority: String",
               b.due_date as "due_date: String",
               b.scheduled_date as "scheduled_date: String"
           FROM blocks b
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.page_id IN (
                 SELECT bp.block_id FROM block_properties bp
                 WHERE bp.key = 'space' AND bp.value_ref = ?1
             )
           ORDER BY COALESCE(b.content, '') COLLATE NOCASE ASC, b.id ASC"#,
        space_id,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Tauri command: list every page in `space_id` as `{ id, content }`,
/// optionally restricted to pages carrying at least one of `tag_ids`.
/// Delegates to [`list_all_pages_in_space_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_all_pages_in_space(
    pool: State<'_, ReadPool>,
    space_id: String,
    tag_ids: Option<Vec<String>>,
) -> Result<Vec<PageHeading>, AppError> {
    list_all_pages_in_space_inner(&pool.0, &space_id, tag_ids.as_deref())
        .await
        .map_err(sanitize_internal_error)
}

/// Return the IDs of every page in `space_id` whose `template`
/// property is set to `'true'`.  Used by the graph view to flag
/// template pages with a visual marker; no pagination, no clamp —
/// templates are a small, bounded set by convention.
#[instrument(skip(pool), err)]
pub async fn list_template_page_ids_in_space_inner(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query_scalar!(
        r#"SELECT b.id as "id!: String"
           FROM blocks b
           JOIN block_properties bp_tpl
               ON bp_tpl.block_id = b.id
              AND bp_tpl.key = 'template'
              AND bp_tpl.value_text = 'true'
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.page_id IN (
                 SELECT bp.block_id FROM block_properties bp
                 WHERE bp.key = 'space' AND bp.value_ref = ?1
             )"#,
        space_id,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Tauri command: list template page IDs in `space_id`.
/// Delegates to [`list_template_page_ids_in_space_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_template_page_ids_in_space(
    pool: State<'_, ReadPool>,
    space_id: String,
) -> Result<Vec<String>, AppError> {
    list_template_page_ids_in_space_inner(&pool.0, &space_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Safety bound on the FE page-tree loader.  Pages with deeper / wider
/// trees than this should already be the user's signal to split the
/// page; the loader truncates rather than blocking the editor.
pub(crate) const PAGE_SUBTREE_MAX_BLOCKS: i64 = 10_000;

/// Load every active descendant under `root_block_id` in `space_id`,
/// in a single SELECT against the materializer-maintained `page_id`
/// index.  No per-parent pagination, no per-call clamp the FE can
/// silently overrun — replaces the FE-side recursive `listBlocks`
/// walk that was capped at the 100-row default and silently truncated
/// any parent with >100 children.
///
/// The returned set excludes the root block itself and any soft-deleted
/// descendant; it is bounded by [`PAGE_SUBTREE_MAX_BLOCKS`] as a safety
/// rail against pathologically large pages.
///
/// Order is `(position, id)` ascending — the FE reassembles via
/// `buildFlatTree` which groups by `parent_id`, so the global order is
/// not load-bearing, but keyset-style ordering keeps the truncation
/// boundary deterministic when the cap fires.
#[instrument(skip(pool), err)]
pub async fn load_page_subtree_inner(
    pool: &SqlitePool,
    root_block_id: &str,
    space_id: &str,
) -> Result<Vec<BlockRow>, AppError> {
    BlockId::from_string(root_block_id)?;

    // FEAT-3 Phase 7 — enforce space membership.  A request whose root
    // page does not carry `space = ?space_id` is rejected with
    // `Validation`, matching `get_page_inner`.
    let space_match = sqlx::query_scalar!(
        r#"SELECT 1 AS "ok!: i32" FROM block_properties
           WHERE block_id = ? AND key = 'space' AND value_ref = ?"#,
        root_block_id,
        space_id,
    )
    .fetch_optional(pool)
    .await?;
    if space_match.is_none() {
        return Err(AppError::Validation(format!(
            "block '{root_block_id}' not in current space '{space_id}'"
        )));
    }

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position,
                deleted_at, todo_state, priority, due_date,
                scheduled_date, page_id
           FROM blocks
           WHERE page_id = ?1
             AND id != ?1
             AND deleted_at IS NULL
           ORDER BY COALESCE(position, ?2) ASC, id ASC
           LIMIT ?3"#,
        root_block_id,
        NULL_POSITION_SENTINEL,
        PAGE_SUBTREE_MAX_BLOCKS,
    )
    .fetch_all(pool)
    .await?;

    if i64::try_from(rows.len()).unwrap_or(i64::MAX) >= PAGE_SUBTREE_MAX_BLOCKS {
        tracing::warn!(
            root_block_id,
            max_blocks = PAGE_SUBTREE_MAX_BLOCKS,
            rows_returned = rows.len(),
            "load_page_subtree: result at the safety cap; descendants \
             may have been truncated. Consider splitting the page."
        );
    }

    Ok(rows)
}

/// Tauri command: load every active descendant under `root_block_id`
/// in `space_id`.  Delegates to [`load_page_subtree_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn load_page_subtree(
    pool: State<'_, ReadPool>,
    root_block_id: String,
    space_id: String,
) -> Result<Vec<BlockRow>, AppError> {
    load_page_subtree_inner(&pool.0, &root_block_id, &space_id)
        .await
        .map_err(sanitize_internal_error)
}

// ───────────────────────────────────────────────────────────────────────────
// PEND-56 — list_pages_with_metadata
//
// Sibling IPC to `list_pages_inner`. Returns the same column shape as
// `BlockRow` PLUS four metadata columns:
//
//   - `last_modified_at`: max(`op_log.created_at`) over the page itself.
//     Page-only (not subtree-aware) per PEND-56 open-question 1 — the
//     recursive-CTE variant is deferred until a benchmark says it's
//     worth the cost.
//   - `inbound_link_count`: COUNT of distinct source blocks linking to
//     this page OR any of its descendants, EXCLUDING same-page/self links
//     (a source on this same page) and deleted/orphan sources — matching
//     the canonical backlink count in `backlink/grouped.rs`. Read straight
//     from the materializer-maintained `pages_cache.inbound_link_count`
//     column (recomputed by `recompute_pages_cache_counts_for_pages` and
//     backfilled by migration 0070), not computed here.
//   - `child_block_count`: COUNT non-deleted blocks whose `page_id`
//     matches AND id != page_id (descendants only).
//   - `has_property_flags`: 4-bit bitmask. Initial allowlist per the
//     plan:
//       bit 0 (1): page has tags applied directly
//       bit 1 (2): page has any descendant with a `todo_state`
//       bit 2 (4): page has any descendant with a `scheduled_date`
//       bit 3 (8): page has any descendant with a `due_date`
//     Adding new flags is an additive bit; the frontend renders the
//     first matched flag as a chip at "regular" density.
//
// Cursor strategy reuses the existing `Cursor` slots per the doc
// comment's "composite overload" guidance (see `pagination/mod.rs:285`):
// each sort mode encodes its sort-key value into either `deleted_at`
// (strings / ISO timestamps) or `seq` (i64 counts), with `id` as the
// tiebreaker. No new field on the `Cursor` struct.
//
// Sort modes:
//   - Alphabetical: keyset (`COALESCE(content,'')` COLLATE NOCASE, id)
//   - RecentlyModified: keyset (`last_modified_at`, id) DESC NULLS LAST
//   - MostLinked: keyset (`inbound_link_count` DESC, id ASC)
//   - MostContent: keyset (`child_block_count` DESC, id ASC)
//   - Default: keyset (id) ASC — power-user / debug
// ───────────────────────────────────────────────────────────────────────────

/// Sort mode for [`list_pages_with_metadata_inner`].
///
/// These are the server-derived sort modes the IPC exposes. The
/// frontend may layer two additional sorts that don't go over the wire:
///
///   - `recent` — per-device visit history (sourced from `getRecentPages()`).
///   - `created` — ULID DESC (just `Default` reversed in JS).
///
/// Both reuse the `Default` SQL ordering and re-sort the loaded page
/// client-side.
#[derive(Debug, Clone, Copy, Default, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PageSort {
    /// Title ascending, case-insensitive. Default for "browse my pages".
    #[default]
    Alphabetical,
    // Perf ceiling (PEND-58d D5): unlike `MostLinked` / `MostContent`
    // (which read materialised `pages_cache` columns), `RecentlyModified`
    // computes `MAX(op_log.created_at)` per page via a correlated subquery
    // across the space *before* the LIMIT — it is NOT materialised. The
    // `idx_op_log_block_id` index (migration 0030) serves each subquery,
    // but the per-row aggregate still dominates at scale. The
    // `recently_modified_perf_gate_20k_pages` `#[ignore]`-d test gates the
    // first-page latency at 20k pages. Materialising a
    // `pages_cache.last_edited_at` column (kept fresh by the materializer on
    // every op) is the heavier alternative — DEFERRED, not done here; it
    // would let this sort read a column like the other count sorts. Revisit
    // if the perf gate trips. (Intentionally a non-doc `//` comment: the
    // doc comment below is specta-exposed, so keeping the ceiling text out
    // of it avoids drifting the committed `src/lib/bindings.ts`.)
    //
    /// Last-modified timestamp (max op_log.created_at) DESC.
    RecentlyModified,
    /// Inbound-link count DESC (page + descendant link targets).
    MostLinked,
    /// Descendant-block count DESC.
    MostContent,
    /// Default backend ordering — block id ASC. Useful for debugging
    /// and as the wire shape for the frontend-only `recent` / `created`
    /// sorts that re-sort client-side.
    #[serde(rename = "default")]
    Default,
}

/// Filter / sort bundle for [`list_pages_with_metadata`].
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ListPagesWithMetadataFilter {
    #[serde(default)]
    pub sort: PageSort,
    pub space_id: String,
    /// PEND-58 Phase 3 — compound filter primitives applied server-side,
    /// AND-joined into the WHERE before the keyset/ORDER BY/LIMIT. Empty
    /// (the default) preserves the pre-PEND-58 "no filter" behaviour, so
    /// existing callers and the flag-off path are unaffected. Each
    /// primitive is gated against [`PagesProjection::allowed_keys`] and
    /// rejected with [`AppError::Validation`] if it is not a Pages-surface
    /// token (defence-in-depth — the frontend never sends Search-only
    /// primitives, but the backend must not trust that).
    #[serde(default)]
    pub filters: Vec<FilterPrimitive>,
}

/// Boolean facts about a page's contents (Review Round 1: replaces a
/// `has_property_flags: i64` bitmask). Each field maps 1:1 to an
/// `EXISTS` subquery in the metadata SELECT. Adding a new flag is
/// purely additive — new `bool` column, no consumer surprises.
#[derive(Debug, Clone, Serialize, sqlx::FromRow, Type)]
#[serde(rename_all = "camelCase")]
pub struct PagePropertyFlags {
    /// Page itself carries a `block_tags` row.
    pub has_tags: bool,
    /// At least one descendant has a non-NULL `todo_state`.
    pub has_todo: bool,
    /// At least one descendant has a non-NULL `scheduled_date`.
    pub has_scheduled: bool,
    /// At least one descendant has a non-NULL `due_date`.
    pub has_due: bool,
}

/// Row returned by [`list_pages_with_metadata_inner`].
///
/// Carries every `BlockRow` column verbatim so the frontend can read
/// `id`, `content`, etc. via the same accessors. Four extra metadata
/// columns drive the new sort modes + density badges.
#[derive(Debug, Clone, Serialize, sqlx::FromRow, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageWithMetadataRow {
    pub id: String,
    pub block_type: String,
    pub content: Option<String>,
    pub parent_id: Option<String>,
    pub position: Option<i64>,
    pub deleted_at: Option<String>,
    pub todo_state: Option<String>,
    pub priority: Option<String>,
    pub due_date: Option<String>,
    pub scheduled_date: Option<String>,
    pub page_id: Option<String>,
    /// max(`op_log.created_at`) over the page itself. None if the
    /// page has no op-log entries (which should never happen — every
    /// active page has at least its own creation row — but the column
    /// is `Option` to absorb edge cases like manually-imported rows
    /// without a synthesised op-log entry).
    pub last_modified_at: Option<String>,
    /// COUNT of `block_links` targeting this page or any of its
    /// descendants. Always emitted (zero for un-linked pages).
    pub inbound_link_count: i64,
    /// COUNT of non-deleted descendants (blocks where `page_id = id`,
    /// excluding the page itself). Always emitted.
    pub child_block_count: i64,
    /// Typed flag struct (Review Round 1: replaces the prior
    /// `has_property_flags: i64` bitmask — see [`PagePropertyFlags`]).
    #[sqlx(flatten)]
    pub flags: PagePropertyFlags,
}

/// Build the `position` slot's encoded sort-mode tag. Used by
/// [`encode_pages_metadata_cursor`] / [`validate_pages_metadata_cursor`]
/// to refuse a cursor whose sort-mode discriminator doesn't match the
/// request — the user-visible alternative is a silent "scrolled past
/// end" with no recovery, which Review Round 1 flagged across three
/// independent reviewers as a BLOCKER. Per-sort i64 stamped into the
/// already-unused `Cursor.position` slot.
fn sort_discriminator(sort: PageSort) -> i64 {
    match sort {
        PageSort::Alphabetical => 1,
        PageSort::RecentlyModified => 2,
        PageSort::MostLinked => 3,
        PageSort::MostContent => 4,
        PageSort::Default => 5,
    }
}

/// Reject a cursor whose `position` slot doesn't match the requested
/// sort. Returns `AppError::Validation` with the `RequiresRefresh:`
/// prefix the frontend uses to render a "Sort changed — refresh to
/// continue" toast (PEND-56 acceptance criterion #3).
fn validate_pages_metadata_cursor(cursor: &Cursor, sort: PageSort) -> Result<(), AppError> {
    match cursor.position {
        Some(d) if d == sort_discriminator(sort) => Ok(()),
        Some(_) | None => Err(AppError::Validation(format!(
            "RequiresRefresh: cursor sort mismatch (expected {sort:?})"
        ))),
    }
}

/// Sentinel substituted for NULL `last_modified_at` in the
/// `RecentlyModified` keyset (Review Round 1 HIGH #2 fix). A string
/// that sorts BEFORE any plausible ISO timestamp in DESC order so the
/// keyset comparison works uniformly for NULL and non-NULL rows;
/// `'0001-...'` is the smallest, sorted last in DESC.
const LAST_MOD_NULL_SENTINEL: &str = "0001-01-01T00:00:00Z";

/// Heterogeneous bind value for the runtime-composed
/// `list_pages_with_metadata_inner` query. The IPC composes the SQL
/// per sort mode and binds parameters in order; this enum exists so
/// the per-mode bind list can mix `&str` (space_id, content cursor)
/// and `i64` (counts, limits) without per-arm `.bind()` chains.
#[derive(Clone)]
enum SqlBind<'a> {
    Str(&'a str),
    OwnedStr(String),
    I64(i64),
}

impl<'a> SqlBind<'a> {
    /// Bind this value onto a `sqlx::query_as::<…>` chain. Helper to
    /// keep the binding loop in `list_pages_with_metadata_inner` a
    /// one-liner per parameter.
    fn bind_to<'q, O>(
        self,
        q: sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments<'q>>,
    ) -> sqlx::query::QueryAs<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments<'q>>
    where
        'a: 'q,
    {
        match self {
            SqlBind::Str(s) => q.bind(s),
            SqlBind::OwnedStr(s) => q.bind(s),
            SqlBind::I64(i) => q.bind(i),
        }
    }

    /// Bind this value onto a `sqlx::query_scalar::<…>` chain. The
    /// `total_count` COUNT query (PEND-58b P1-D) reuses the same compiled
    /// filter binds as the fetch but returns a single scalar, so it needs
    /// a `QueryScalar`-shaped sibling of [`Self::bind_to`].
    fn bind_to_scalar<'q, O>(
        self,
        q: sqlx::query::QueryScalar<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments<'q>>,
    ) -> sqlx::query::QueryScalar<'q, sqlx::Sqlite, O, sqlx::sqlite::SqliteArguments<'q>>
    where
        'a: 'q,
    {
        match self {
            SqlBind::Str(s) => q.bind(s),
            SqlBind::OwnedStr(s) => q.bind(s),
            SqlBind::I64(i) => q.bind(i),
        }
    }
}

/// Per-sort descriptor extracted from the body of
/// `list_pages_with_metadata_inner`. Collapses what used to be a
/// 5-arm match with ~250 lines of near-duplicate SQL composition into
/// a small lookup table; each arm of `keyset_for` is one of these
/// variants and the IPC consumes the descriptor via a single shared
/// `apply` method.
///
/// **Bind contract:** `?1 = filter.space_id` always. PEND-58 splices
/// compound-filter clauses (with their own `?` binds) into the WHERE
/// between space_id and the keyset; `SortKeyset::apply` therefore numbers
/// its placeholders from a runtime `base` offset (`1 + filter_bind_count`)
/// rather than the hardcoded `?2`. With no filters, `base = 1` reproduces
/// the original `?2 .. ?N` numbering.
///
/// **Why an enum rather than a `struct` with fn pointers / closures?**
/// The five sort modes have three distinct keyset shapes (string-ASC,
/// string-DESC-with-null-sentinel, i64-DESC) plus a degenerate "id
/// only" mode. A flat struct couldn't model the `RecentlyModified`
/// null-sentinel slot without optional fields that the other variants
/// would have to leave `None`; modelling each shape explicitly keeps
/// the bind-position arithmetic readable and the exhaustiveness check
/// honest.
enum SortKeyset {
    /// `(key_expr, id) ASC` keyset. Cursor stashes the last row's key
    /// in the `deleted_at` slot (string). Used by `Alphabetical`.
    StringAsc {
        /// SQL expression for the sort key (e.g.
        /// `COALESCE(b.content,'') COLLATE NOCASE`). Composed verbatim
        /// into the keyset predicate and ORDER BY.
        key_expr: &'static str,
    },
    /// `(key_expr, id) DESC` keyset where `key_expr` references a
    /// trailing NULL-sentinel bind slot (`?S`). The composer
    /// substitutes the runtime bind position into the placeholder.
    /// Used by `RecentlyModified`.
    StringDescNullCoalesced {
        /// SQL template with `{S}` as the sentinel bind placeholder.
        /// E.g. `COALESCE((SELECT MAX(created_at) FROM op_log WHERE
        /// block_id = b.id), ?{S})`. The composer substitutes `{S}`
        /// with the actual bind position.
        key_expr_template: &'static str,
        /// String written to the sentinel slot at runtime.
        null_sentinel: &'static str,
    },
    /// `(key_expr, id) DESC` keyset over an i64-typed column. Cursor
    /// stashes the last row's count in the `seq` slot. Used by
    /// `MostLinked` and `MostContent` — both now read from
    /// `pages_cache` (materialised by the materializer) so the
    /// expression is a column reference, not a subquery.
    I64Desc {
        /// SQL expression for the sort key. After PEND-56b this is
        /// `pc.inbound_link_count` or `pc.child_block_count` — a
        /// materialised column reached via the LEFT JOIN to
        /// `pages_cache pc`.
        key_expr: &'static str,
    },
    /// `b.id ASC` only. No extra sort-key slot. Used by `Default`.
    IdOnly,
}

/// Map a [`PageSort`] to its [`SortKeyset`] descriptor.
fn keyset_for(sort: PageSort) -> SortKeyset {
    match sort {
        PageSort::Alphabetical => SortKeyset::StringAsc {
            key_expr: "COALESCE(b.content,'') COLLATE NOCASE",
        },
        // PEND-58d D5 perf ceiling: this key is the UN-materialised
        // `MAX(op_log.created_at)` correlated subquery (served by
        // `idx_op_log_block_id`), evaluated per page before the LIMIT — the
        // heaviest sort key. Gated by `recently_modified_perf_gate_20k_pages`
        // (`#[ignore]`'d). Materialising `pages_cache.last_edited_at` is the
        // deferred remedy (see the `PageSort::RecentlyModified` comment).
        PageSort::RecentlyModified => SortKeyset::StringDescNullCoalesced {
            key_expr_template:
                "COALESCE((SELECT MAX(created_at) FROM op_log WHERE block_id = b.id), ?{S})",
            null_sentinel: LAST_MOD_NULL_SENTINEL,
        },
        // PEND-56b: read from the materialised `pages_cache` column
        // instead of the per-row `COUNT(DISTINCT bl.source_id) FROM
        // block_links` correlated subquery. The materializer keeps
        // `pc.inbound_link_count` byte-identical to the canonical
        // SELECT on every block-lifecycle op; see
        // `pages_cache_count_parity` for the guarding test.
        PageSort::MostLinked => SortKeyset::I64Desc {
            key_expr: "COALESCE(pc.inbound_link_count, 0)",
        },
        // PEND-56b: see above; reads `pc.child_block_count` via the
        // same LEFT JOIN.
        PageSort::MostContent => SortKeyset::I64Desc {
            key_expr: "COALESCE(pc.child_block_count, 0)",
        },
        PageSort::Default => SortKeyset::IdOnly,
    }
}

/// Append the keyset WHERE clause and ORDER BY for this descriptor.
/// Returns the bind values (in order) that the caller must append to
/// the `query_as` chain after the leading `?1 = space_id`.
///
/// `cursor` is the decoded keyset position from the prior page (None
/// for first-page requests). `limit_plus_one` is the LIMIT bind value
/// (probe-for-more pattern).
///
/// **Bind position arithmetic:** the leading bind is `?1` (space_id),
/// and this function appends binds at positions `?2 .. ?N` in the
/// order returned. Each variant computes the LIMIT placeholder
/// position from the trailing bind count so the SQL stays
/// self-consistent.
impl SortKeyset {
    /// Append the keyset predicate + ORDER BY + LIMIT and return the
    /// keyset binds in order.
    ///
    /// **PEND-58 — `base` bind offset:** the keyset's placeholders used to
    /// be hardcoded `?2 .. ?5` on the assumption that `?1 = space_id` was
    /// the only bind before them. Phase 3 splices compound-filter clauses
    /// (each with its own `?` binds) into the WHERE *between* the space_id
    /// bind and the keyset. `base` is the highest placeholder position
    /// already consumed (`1` for space_id plus the filter-bind count); the
    /// keyset numbers its own placeholders from `base + 1` so SQLite's
    /// positional binding stays aligned regardless of how many filter
    /// binds preceded it. With no filters, `base = 1` reproduces the old
    /// `?2 ..` numbering exactly.
    fn apply<'a>(
        self,
        sql: &mut String,
        cursor: Option<&'a Cursor>,
        limit_plus_one: i64,
        base: usize,
    ) -> Vec<SqlBind<'a>> {
        let mut binds: Vec<SqlBind<'a>> = Vec::new();
        // Placeholder positions, computed from the running `base`. Named
        // for readability so the SQL templates read like the originals.
        let p1 = base + 1;
        let p2 = base + 2;
        let p3 = base + 3;
        let p4 = base + 4;
        match (self, cursor) {
            // ── StringAsc: (key, id) ASC ──────────────────────────
            (SortKeyset::StringAsc { key_expr }, Some(c)) => {
                let last_key = c.deleted_at.clone().unwrap_or_default();
                // Binds: last_key, last_id, limit.
                sql.push_str(&format!(
                    " AND ( {key_expr} > ?{p1} \
                            OR ({key_expr} = ?{p1} AND b.id > ?{p2}) ) \
                       ORDER BY {key_expr} ASC, b.id ASC \
                       LIMIT ?{p3}"
                ));
                binds.push(SqlBind::OwnedStr(last_key));
                binds.push(SqlBind::Str(c.id.as_str()));
                binds.push(SqlBind::I64(limit_plus_one));
            }
            (SortKeyset::StringAsc { key_expr }, None) => {
                // Binds: limit.
                sql.push_str(&format!(" ORDER BY {key_expr} ASC, b.id ASC LIMIT ?{p1}"));
                binds.push(SqlBind::I64(limit_plus_one));
            }
            // ── StringDescNullCoalesced: (key, id) DESC + sentinel ─
            (
                SortKeyset::StringDescNullCoalesced {
                    key_expr_template,
                    null_sentinel,
                },
                Some(c),
            ) => {
                let last_key = c
                    .deleted_at
                    .clone()
                    .unwrap_or_else(|| null_sentinel.to_string());
                // Sentinel lives at p4; cursor binds are p1=last_key,
                // p2=last_id, p3=limit. The template references the
                // sentinel via `{S}` so we substitute the literal
                // bind position before pushing.
                let key_expr = key_expr_template.replace("{S}", &p4.to_string());
                sql.push_str(&format!(
                    " AND ( {key_expr} < ?{p1} \
                            OR ({key_expr} = ?{p1} AND b.id > ?{p2}) ) \
                       ORDER BY {key_expr} DESC, b.id ASC \
                       LIMIT ?{p3}"
                ));
                binds.push(SqlBind::OwnedStr(last_key));
                binds.push(SqlBind::Str(c.id.as_str()));
                binds.push(SqlBind::I64(limit_plus_one));
                binds.push(SqlBind::Str(null_sentinel));
            }
            (
                SortKeyset::StringDescNullCoalesced {
                    key_expr_template,
                    null_sentinel,
                },
                None,
            ) => {
                // Sentinel at p1; limit at p2.
                let key_expr = key_expr_template.replace("{S}", &p1.to_string());
                sql.push_str(&format!(" ORDER BY {key_expr} DESC, b.id ASC LIMIT ?{p2}"));
                binds.push(SqlBind::Str(null_sentinel));
                binds.push(SqlBind::I64(limit_plus_one));
            }
            // ── I64Desc: (key, id) DESC over an i64 column ────────
            (SortKeyset::I64Desc { key_expr }, Some(c)) => {
                let last_count = c.seq.unwrap_or(0);
                // Binds: last_count, last_id, limit.
                sql.push_str(&format!(
                    " AND ( {key_expr} < ?{p1} \
                            OR ({key_expr} = ?{p1} AND b.id > ?{p2}) ) \
                       ORDER BY {key_expr} DESC, b.id ASC LIMIT ?{p3}"
                ));
                binds.push(SqlBind::I64(last_count));
                binds.push(SqlBind::Str(c.id.as_str()));
                binds.push(SqlBind::I64(limit_plus_one));
            }
            (SortKeyset::I64Desc { key_expr }, None) => {
                // Binds: limit.
                sql.push_str(&format!(" ORDER BY {key_expr} DESC, b.id ASC LIMIT ?{p1}"));
                binds.push(SqlBind::I64(limit_plus_one));
            }
            // ── IdOnly: id ASC only (Default sort) ────────────────
            (SortKeyset::IdOnly, Some(c)) => {
                // Binds: last_id, limit.
                sql.push_str(&format!(" AND b.id > ?{p1} ORDER BY b.id ASC LIMIT ?{p2}"));
                binds.push(SqlBind::Str(c.id.as_str()));
                binds.push(SqlBind::I64(limit_plus_one));
            }
            (SortKeyset::IdOnly, None) => {
                // Binds: limit.
                sql.push_str(&format!(" ORDER BY b.id ASC LIMIT ?{p1}"));
                binds.push(SqlBind::I64(limit_plus_one));
            }
        }
        binds
    }
}

/// PEND-58d D15 — validate a `LastEdited` `Range` date bound, matching the
/// legacy Search date contract (`fts::metadata_filter::resolve_date_filter`,
/// `InvalidDateFilter:` prefix the frontend keys on).
///
/// Pages compares the bound string against `op_log.created_at` (full ISO
/// timestamps), so we accept either a bare calendar date (`YYYY-MM-DD`) OR
/// a full RFC 3339 timestamp (`YYYY-MM-DDTHH:MM:SSZ`). An empty string or
/// an otherwise-unparseable value is rejected — an unvalidated malformed
/// date would otherwise compare-fail every row and silently return zero
/// results (the bug D15 closes).
fn validate_last_edited_date(label: &str, value: &str) -> Result<(), AppError> {
    if value.trim().is_empty() {
        return Err(AppError::Validation(format!(
            "InvalidDateFilter: {label} must not be empty"
        )));
    }
    // Accept a bare calendar date first, then a full RFC 3339 timestamp.
    if chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
        || chrono::DateTime::parse_from_rfc3339(value).is_ok()
    {
        return Ok(());
    }
    Err(AppError::Validation(format!(
        "InvalidDateFilter: {label} expected YYYY-MM-DD or RFC 3339, got '{value}'"
    )))
}

/// PEND-58 Phase 3 — compile the compound-filter primitives for the Pages
/// surface into a single AND-joined SQL fragment plus its ordered binds.
///
/// Returns `(sql_fragment, binds)` where `sql_fragment` is either empty
/// (no filters) or a leading-` AND (...)`-style string ready to splice
/// after the base WHERE and `binds` are the bind values in the SAME
/// left-to-right order their `?` placeholders appear in the fragment.
///
/// Steps (mirrors PEND-58 §"Filter primitive contract" / §Performance):
///
/// 1. **Allowed-keys gate** — reject any primitive whose token is not in
///    [`PagesProjection::allowed_keys`] with [`AppError::Validation`]
///    (`InvalidFilter:` prefix). Defence-in-depth: the frontend never
///    sends Search-only primitives, but the backend must not trust that.
/// 2. **Date validation (PEND-58d D15)** — `LastEdited::Range` bounds are
///    validated against the legacy Search date contract (`InvalidDateFilter:`
///    prefix); empty or malformed dates are rejected here rather than
///    silently returning zero rows.
/// 3. **Cost-order** — sort by [`FilterPrimitive::cost_hint`] (stable, so
///    equal-cost primitives keep their request order) so index-backed
///    clauses run before full-scan ones, letting SQLite narrow the row
///    set with the cheap clause's index first.
/// 4. **Compile + AND-join** — each clause is `PagesProjection.compile`d
///    into a `WhereClause`; the SQL fragments are AND-joined and the binds
///    concatenated in the same order.
fn compile_pages_filters(
    filters: &[FilterPrimitive],
) -> Result<(String, Vec<SqlBind<'static>>), AppError> {
    if filters.is_empty() {
        return Ok((String::new(), Vec::new()));
    }

    let allowed = PagesProjection::allowed_keys();
    // Allowed-keys gate first — fail loudly before compiling anything.
    for prim in filters {
        let key = prim.allowed_key();
        if !allowed.contains(key) {
            return Err(AppError::Validation(format!(
                "InvalidFilter: `{key}` is not a valid filter on the Pages surface"
            )));
        }
    }

    // PEND-58d D15 — validate `LastEdited::Range` date bounds before they
    // reach SQL. A malformed bound silently compare-fails every row
    // (zero results); reject it loudly with the `InvalidDateFilter:` prefix.
    for prim in filters {
        if let FilterPrimitive::LastEdited {
            spec: crate::filters::LastEditedSpec::Range { start, end },
        } = prim
        {
            validate_last_edited_date("range start", start)?;
            validate_last_edited_date("range end", end)?;
        }
    }

    // Cost-order: stable sort by cost_hint keeps equal-cost primitives in
    // their request order while floating index-backed clauses first.
    let mut ordered: Vec<&FilterPrimitive> = filters.iter().collect();
    ordered.sort_by_key(|p| p.cost_hint());

    let proj = PagesProjection;
    let mut clauses: Vec<String> = Vec::with_capacity(ordered.len());
    let mut binds: Vec<SqlBind<'static>> = Vec::new();
    // The projection emits anonymous `?` placeholders. The base SELECT
    // already uses an explicit `?1` (space_id) and the keyset uses explicit
    // `?N` numbers downstream — mixing explicit and anonymous placeholders
    // makes SQLite's positional numbering ambiguous (a bare `?` is numbered
    // relative to the largest number seen so far, which is brittle across
    // the spliced statement). We therefore renumber each fragment's `?` to
    // explicit positions starting at `?2` (right after `?1 = space_id`) so
    // the placeholder numbers are unambiguous regardless of compose order.
    let mut next_pos = 2; // ?1 is space_id
    for prim in ordered {
        let wc = proj.compile(prim);
        // The allowed-keys gate above admits only Pages-surface tokens, but
        // a primitive could still compile to `unsupported()` via the
        // cross-surface default trait methods if a future variant lands on
        // the wrong surface (after PEND-58d D8 + D26, `HasProperty` itself
        // never returns `unsupported()` — every predicate × value combo
        // compiles, and invalid combos are unrepresentable). In release
        // builds a bare `debug_assert!` would be compiled out and the
        // splice would emit a silent `1=0`, returning zero rows for what is
        // really an invalid filter shape. Reject it loudly in **all** build
        // profiles instead (PEND-58b P2-A). `is_unsupported()` reads the
        // explicit boolean flag on `WhereClause` (PEND-58d D18), not a SQL
        // substring.
        if wc.is_unsupported() {
            return Err(AppError::Validation(format!(
                "InvalidFilter: filter shape is not supported on the Pages surface: {prim:?}"
            )));
        }
        // Substitute each anonymous `?` left-to-right with `?{next_pos}`.
        let mut sql = String::with_capacity(wc.sql.len());
        for ch in wc.sql.chars() {
            if ch == '?' {
                sql.push('?');
                sql.push_str(&next_pos.to_string());
                next_pos += 1;
            } else {
                sql.push(ch);
            }
        }
        clauses.push(format!("({sql})"));
        for b in wc.binds {
            binds.push(match b {
                crate::filters::primitive::Bind::Text(s) => SqlBind::OwnedStr(s),
                crate::filters::primitive::Bind::Int(i) => SqlBind::I64(i),
            });
        }
    }

    let fragment = format!(" AND {}", clauses.join(" AND "));
    Ok((fragment, binds))
}

/// The base SELECT for `list_pages_with_metadata_inner` (everything up to
/// but NOT including the compound-filter fragment, the keyset, the ORDER BY,
/// and the LIMIT). Hoisted to a `const` so the test-only
/// [`compose_list_pages_with_metadata_sql`] accessor (PEND-58e E9) composes
/// the SAME real SQL the IPC emits rather than a hand-rebuilt copy — a plan
/// regression in the IPC's actual query is then caught by the EXPLAIN tests.
///
/// `?1` is the space_id bind. The compound-filter fragment (its `?` binds
/// renumbered from `?2`) is appended after this, then the keyset / ORDER BY
/// / LIMIT.
const PAGES_METADATA_BASE_SELECT: &str = r#"SELECT
               b.id, b.block_type, b.content, b.parent_id, b.position,
               b.deleted_at, b.todo_state, b.priority, b.due_date,
               b.scheduled_date, b.page_id,
               (SELECT MAX(created_at) FROM op_log WHERE block_id = b.id)
                   AS last_modified_at,
               COALESCE(pc.inbound_link_count, 0) AS inbound_link_count,
               COALESCE(pc.child_block_count, 0) AS child_block_count,
               EXISTS(SELECT 1 FROM block_tags WHERE block_id = b.id) AS has_tags,
               EXISTS(SELECT 1 FROM blocks descendant
                       WHERE descendant.page_id = b.id
                         AND descendant.deleted_at IS NULL
                         AND descendant.todo_state IS NOT NULL) AS has_todo,
               EXISTS(SELECT 1 FROM blocks descendant
                       WHERE descendant.page_id = b.id
                         AND descendant.deleted_at IS NULL
                         AND descendant.scheduled_date IS NOT NULL) AS has_scheduled,
               EXISTS(SELECT 1 FROM blocks descendant
                       WHERE descendant.page_id = b.id
                         AND descendant.deleted_at IS NULL
                         AND descendant.due_date IS NOT NULL) AS has_due
           FROM blocks b
           LEFT JOIN pages_cache pc ON pc.page_id = b.id
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.page_id IN (
                 SELECT bp.block_id FROM block_properties bp
                 WHERE bp.key = 'space' AND bp.value_ref = ?1
             )
        "#;

/// PEND-58e E9 — test-only accessor that composes the **real** first-page
/// (no cursor) SQL `list_pages_with_metadata_inner` emits for the given
/// `filter`, so EXPLAIN-plan tests run against the IPC's actual statement
/// instead of a hand-rebuilt copy that could silently drift from it.
///
/// Mirrors the compose sequence in `list_pages_with_metadata_inner`:
/// base SELECT (`?1` = space_id) → compiled compound-filter fragment
/// (`?2 ..`) → keyset / ORDER BY / LIMIT (first page, `cursor = None`).
/// The error path (invalid filter / date) surfaces verbatim so a test can
/// also assert rejection. The space_id, filter binds, and `limit` are
/// supplied by the caller via the bound `?N` placeholders at execution.
#[cfg(test)]
pub(crate) fn compose_list_pages_with_metadata_sql(
    filter: &ListPagesWithMetadataFilter,
    limit_plus_one: i64,
) -> Result<String, AppError> {
    let mut sql = String::from(PAGES_METADATA_BASE_SELECT);
    let (filter_sql, filter_binds) = compile_pages_filters(&filter.filters)?;
    sql.push_str(&filter_sql);
    let base = 1 + filter_binds.len();
    let keyset = keyset_for(filter.sort);
    // First page: no cursor. The returned binds are discarded — the test
    // only needs the SQL string for EXPLAIN QUERY PLAN.
    let _ = keyset.apply(&mut sql, None, limit_plus_one, base);
    Ok(sql)
}

/// Inner implementation of `list_pages_with_metadata`. Cursor-paginated
/// page enumeration with metadata columns; sort mode chosen via
/// [`PageSort`].
///
/// **Cursor semantics:** the cursor carries the LAST row's sort-key
/// value (in `deleted_at` for string / ISO-timestamp sorts; in `seq`
/// for i64-count sorts), the last row's `id` as the tiebreaker, and
/// a sort-mode discriminator in `position` (Review Round 1 — protects
/// against cross-sort / cross-IPC cursor reuse). First-page requests
/// pass `cursor = None`. A stale cursor (e.g. from `list_blocks`) is
/// rejected with `AppError::Validation("RequiresRefresh: …")` so the
/// frontend can render a "Sort changed — refresh to continue" toast
/// (PEND-56 acceptance criterion #3).
///
/// **PEND-56b — materialised counts:** `inbound_link_count` and
/// `child_block_count` are read from `pages_cache.{inbound_link_count,
/// child_block_count}` via a LEFT JOIN, NOT computed per-row via the
/// `COUNT(DISTINCT …) FROM block_links` / `COUNT(*) FROM blocks`
/// correlated subqueries the prior implementation used. The
/// materializer keeps `pages_cache` rows byte-identical to the
/// canonical SELECT on every CreateBlock / EditBlock / DeleteBlock /
/// RestoreBlock / PurgeBlock op; see `materializer::tests::
/// pages_cache_count_parity` for the guarding integration test.
///
/// **Defensive contract:** the JOIN is LEFT and the columns are
/// COALESCE'd to 0. The materializer guarantees a `pages_cache` row
/// for every live page (`apply_create_block_via_loro` for block_type
/// = 'page' INSERTs the row), so a missing row indicates a
/// materializer bug. The COALESCE keeps the IPC alive while the bug
/// is investigated — the parity tests should catch the underlying
/// drift before users see a stale `0`.
#[instrument(skip(pool), err)]
pub async fn list_pages_with_metadata_inner(
    pool: &SqlitePool,
    filter: ListPagesWithMetadataFilter,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<PageWithMetadataRow>, AppError> {
    // Mirror the limit-clamp policy from `list_pages_inner`.
    if let Some(l) = limit {
        if !(1..=MCP_PAGE_LIMIT_CAP).contains(&l) {
            return Err(AppError::Validation(format!(
                "list_pages_with_metadata limit must be in [1, {MCP_PAGE_LIMIT_CAP}]; got {l}"
            )));
        }
    }
    let req = PageRequest::new(cursor, limit)?;
    // Reject any cursor whose sort-mode discriminator doesn't match the
    // requested sort. This is the BLOCKER fix from Review Round 1.
    if let Some(c) = req.after.as_ref() {
        validate_pages_metadata_cursor(c, filter.sort)?;
    }
    let limit_plus_one = req.limit + 1; // probe-for-more pattern

    // SELECT shape — the two count aggregates (inbound_link_count,
    // child_block_count) are now reads from the materialised
    // `pages_cache` columns (PEND-56b). The remaining metadata
    // aggregates stay as correlated subqueries — out of scope for this
    // refactor:
    //   - last_modified_at via `idx_op_log_block_id` (migration 0030)
    //   - has_property_flags: 4 EXISTS short-circuits over the
    //     `idx_blocks_page_id` + `idx_block_tags_block_id` indexes.
    //
    // The SQL is hand-written rather than `sqlx::query_as!` because
    // the ORDER BY / WHERE keyset depends on the runtime sort mode;
    // the compile-time macro would force four near-identical query
    // bodies.
    let mut sql = String::from(PAGES_METADATA_BASE_SELECT);

    // PEND-58 — splice the compound-filter WHERE clauses BEFORE the
    // keyset/ORDER BY/LIMIT. Their `?` placeholders land at positions
    // `?2 .. ?{1 + filter_bind_count}` (right after `?1 = space_id`); the
    // keyset then numbers its own placeholders from `base` so SQLite's
    // positional binding stays aligned. Gate + cost-order + AND-join all
    // happen in `compile_pages_filters`.
    let (filter_sql, filter_binds) = compile_pages_filters(&filter.filters)?;
    sql.push_str(&filter_sql);
    let base = 1 + filter_binds.len();

    // PEND-58b P1-D — compute a real `total_count` so the "X of Y"
    // header chip survives the `densityV1` default-on flip (the prior
    // `total_count: None` silently dropped it for every user). The COUNT
    // reuses the SAME space-membership predicate + compiled compound-filter
    // WHERE clause as the fetch, but DROPS the keyset/cursor terms and the
    // per-row metadata aggregate subqueries (last_modified_at, has_*) — so
    // the count stays index-served and behind the same predicates, keeping
    // the 20k-page perf gate (`most_linked_perf_gate_20k_pages`) green.
    // The `LEFT JOIN pages_cache pc` is retained because the Pages-only
    // filter fragments (Orphan / Stub / HasNoInboundLinks) read `pc.*`.
    //
    // PEND-58d D6 — the COUNT only runs on the FIRST page (`req.after`
    // is None). The total of the filtered set does not change as the user
    // loads more pages with the same filters, so recomputing it on every
    // cursor page is wasted work (the COUNT scans the whole filtered set
    // each time). Subsequent (cursor) pages return `total_count = None`;
    // the frontend retains the first page's total.
    let total_count: Option<i64> = if req.after.is_none() {
        let count_sql = format!(
            "SELECT COUNT(*) FROM blocks b \
             LEFT JOIN pages_cache pc ON pc.page_id = b.id \
             WHERE b.block_type = 'page' \
               AND b.deleted_at IS NULL \
               AND b.page_id IN ( \
                   SELECT bp.block_id FROM block_properties bp \
                   WHERE bp.key = 'space' AND bp.value_ref = ?1 \
               ){filter_sql}"
        );
        let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql).bind(&filter.space_id);
        for bind in filter_binds.clone() {
            count_query = bind.bind_to_scalar(count_query);
        }
        Some(count_query.fetch_one(pool).await?)
    } else {
        None
    };

    // Per-sort keyset + ORDER BY. The `SortKeyset` descriptor encodes
    // the SQL fragment, ORDER BY, and the per-mode bind list so the
    // composition stays in one place rather than the 5 inline arms
    // the prior implementation duplicated.
    let keyset = keyset_for(filter.sort);
    let cursor_ref = req.after.as_ref();
    let keyset_binds = keyset.apply(&mut sql, cursor_ref, limit_plus_one, base);

    // Bind order: ?1 = space_id, then the filter binds (?2 ..), then the
    // keyset binds (?{base+1} ..) — exactly matching the `?` appearance
    // order in the composed SQL.
    let mut query = sqlx::query_as::<_, PageWithMetadataRow>(&sql).bind(&filter.space_id);
    for bind in filter_binds {
        query = bind.bind_to(query);
    }
    for bind in keyset_binds {
        query = bind.bind_to(query);
    }
    let rows = query.fetch_all(pool).await?;
    build_metadata_response(rows, req.limit, filter.sort, total_count)
}

/// Pack the fetched rows into a `PageResponse` with `has_more` + the
/// next-page cursor. Encodes the last-row's sort-key value into the
/// appropriate `Cursor` slot per sort mode.
fn build_metadata_response(
    mut rows: Vec<PageWithMetadataRow>,
    limit: i64,
    sort: PageSort,
    total_count: Option<i64>,
) -> Result<PageResponse<PageWithMetadataRow>, AppError> {
    let limit_us = usize::try_from(limit).unwrap_or(0);
    let has_more = rows.len() > limit_us;
    if has_more {
        rows.truncate(limit_us);
    }
    // Tag every cursor with the sort discriminator (Review Round 1) so
    // `validate_pages_metadata_cursor` can reject cross-sort reuse.
    let disc = Some(sort_discriminator(sort));
    let next_cursor = if has_more {
        rows.last().map(|last| -> Result<String, AppError> {
            let cursor = match sort {
                PageSort::Alphabetical => Cursor {
                    id: last.id.clone(),
                    position: disc,
                    deleted_at: last.content.clone(),
                    seq: None,
                    rank: None,
                },
                PageSort::RecentlyModified => Cursor {
                    id: last.id.clone(),
                    position: disc,
                    // RecentlyModified always stashes the COALESCE'd
                    // value (real ISO timestamp OR `LAST_MOD_NULL_SENTINEL`)
                    // so the keyset works uniformly for NULL and
                    // non-NULL rows — Review Round 1 HIGH #2 fix.
                    deleted_at: Some(
                        last.last_modified_at
                            .clone()
                            .unwrap_or_else(|| LAST_MOD_NULL_SENTINEL.to_string()),
                    ),
                    seq: None,
                    rank: None,
                },
                PageSort::MostLinked => Cursor {
                    id: last.id.clone(),
                    position: disc,
                    deleted_at: None,
                    seq: Some(last.inbound_link_count),
                    rank: None,
                },
                PageSort::MostContent => Cursor {
                    id: last.id.clone(),
                    position: disc,
                    deleted_at: None,
                    seq: Some(last.child_block_count),
                    rank: None,
                },
                PageSort::Default => Cursor {
                    id: last.id.clone(),
                    position: disc,
                    deleted_at: None,
                    seq: None,
                    rank: None,
                },
            };
            cursor.encode()
        })
    } else {
        None
    }
    .transpose()?;
    Ok(PageResponse {
        items: rows,
        next_cursor,
        has_more,
        // PEND-58b P1-D / PEND-58d D6 — the COUNT over the same space +
        // compiled filter predicates (computed in
        // `list_pages_with_metadata_inner`) so the FE "X of Y" header chip
        // renders on the metadata path. `Some(n)` on the first page;
        // `None` on cursor (load-more) pages, where the COUNT is gated off
        // and the FE retains the first page's total.
        total_count,
    })
}

/// Tauri command: paginated page list with per-page metadata columns
/// (last-modified timestamp, inbound link count, descendant count,
/// has-property bitmask) and a richer sort taxonomy than `list_pages`.
///
/// Frontend wires this from `PageBrowser` when the `densityV1` flag is
/// on; the flag-off path continues to use `list_blocks(blockType='page')`.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_pages_with_metadata(
    pool: State<'_, ReadPool>,
    filter: ListPagesWithMetadataFilter,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<PageWithMetadataRow>, AppError> {
    list_pages_with_metadata_inner(&pool.0, filter, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}
