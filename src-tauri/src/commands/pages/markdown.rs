//! Markdown export / import command handlers (#644 split).
//!
//! `export_page_markdown`, `import_markdown` and their `*_inner` cores plus
//! the progress-streaming import variant and the ULID-resolution helper.

use std::collections::HashMap;

use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::{CommandTx, ReadPool, WriteCtx};
use crate::error::AppError;
use crate::import;
use crate::import::{ImportProgressSink, ImportProgressUpdate, ImportResult};
use crate::materializer::Materializer;
use crate::pagination::{BlockRow, Cursor, NULL_POSITION_SENTINEL, PageRequest};
use crate::ulid::{BlockId, PageId};

use super::super::*;

/// #662 — minimum number of content blocks written into one import chunk
/// before the import is allowed to flush (commit + release the writer
/// lock) at the next top-level (depth-0) subtree boundary.
///
/// Tuning rationale (see #662): a hard *cap* on import size was rejected
/// because it would break legitimate large imports, and the verified bug
/// is the writer-lock *hold time*, not the row count. A chunk size of 500
/// keeps the common case — the import benches exercise 100 / 1000 / 5000
/// blocks — single-transaction at 100 blocks (preserving the original
/// whole-import atomicity for typical files) while splitting a 5000-block
/// import into ~10 chunks, so the writer lock is released ~10 times mid-
/// import instead of being held throughout. It is a `usize` because it is
/// compared against the per-chunk `chunk_blocks` counter.
///
/// Note this is a *floor*, not a cap: a chunk may exceed it when a single
/// top-level subtree is itself larger than the floor — the subtree is
/// never split, so correctness (no half-written subtree) always wins over
/// the size target.
///
/// `pub(crate)` so chunk-boundary tests can size a multi-chunk import
/// relative to the threshold instead of hardcoding the number.
pub(crate) const IMPORT_CHUNK_BLOCKS: usize = 500;

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

    PAGE_LINK_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let ulid = &caps[1];
            if let Some(title) = page_titles.get(ulid) {
                format!("[[{title}]]")
            } else {
                format!("[[{ulid}]]") // Keep original if not found
            }
        })
        .into_owned()
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

    // #660 — open ONE read transaction and run every read below through
    // it so the entire export observes a single, consistent WAL
    // snapshot. Pre-fix the keyset descendant walk issued N independent
    // `fetch_all(pool)` calls, each taking its own snapshot; a
    // concurrent edit/move/delete landing between two pages of the
    // keyset could skip or duplicate blocks in the exported markdown.
    // `pool.begin()` opens a `BEGIN DEFERRED` transaction (read-only —
    // every statement here is a SELECT, so no writer lock is taken);
    // SQLite pins the snapshot at the first read and holds it until the
    // tx drops. The page-row lookup, descendant walk, reference
    // resolution and property reads all execute against `&mut *tx`, so
    // they cannot interleave with a concurrent writer's commit.
    let mut tx = pool.begin().await?;

    // 1. Get the page
    //
    // M-98 — filter `deleted_at IS NULL` (mirrors `get_active_block_inner`)
    // so a soft-deleted page surfaces as `NotFound` instead of exporting
    // as `# Title\n\n` with no descendants. The descendant walk below
    // already filters `deleted_at IS NULL`, so prior to this fix the page
    // row itself was the only row that could leak. Inlined here (rather
    // than calling `get_active_block_inner`, which takes `&SqlitePool`)
    // so the page read shares the #660 snapshot tx with the walk below.
    let page = sqlx::query_as!(
        BlockRow,
        r#"SELECT id as "id!: crate::ulid::BlockId", block_type, content,
                parent_id as "parent_id: crate::ulid::BlockId", position,
                deleted_at, todo_state, priority, due_date, scheduled_date,
                page_id as "page_id: crate::ulid::BlockId"
           FROM blocks
           WHERE id = ? AND deleted_at IS NULL"#,
        page_id,
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("block '{page_id}'")))?;
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
            r#"SELECT id as "id!: crate::ulid::BlockId", block_type, content,
                    parent_id as "parent_id: crate::ulid::BlockId", position,
                    deleted_at,
                     todo_state, priority, due_date, scheduled_date,
                    page_id as "page_id: crate::ulid::BlockId"
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
        .fetch_all(&mut *tx)
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
                id: last.id.clone().into_string(),
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
        .fetch_all(&mut *tx)
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

    // 4. Get page properties for frontmatter.
    //
    // #384: exclude internal/system-managed keys so they don't leak into the
    // exported frontmatter. The explicit list is required because
    // `op::is_builtin_property_key` does NOT cover `space` / `is_space` /
    // `template` (those are space-membership + template markers, not
    // builtin lifecycle keys). The list below is the union of those three
    // plus the lifecycle keys from `is_builtin_property_key` that get
    // stored in `block_properties` (the reserved-column keys —
    // todo_state/priority/due_date/scheduled_date — live on the `blocks`
    // table, never in `block_properties`, so they never appear here).
    //
    // #384: also project value_ref and value_num so numeric and
    // page-reference properties render instead of silently dropping to
    // empty (the old query only selected value_text + value_date).
    struct FrontmatterRow {
        key: String,
        value_text: Option<String>,
        value_date: Option<String>,
        value_num: Option<f64>,
        value_ref: Option<String>,
        value_bool: Option<i64>,
    }
    let property_rows = sqlx::query!(
        r#"SELECT key AS "key!", value_text, value_date, value_num, value_ref,
                  value_bool AS "value_bool: i64"
           FROM block_properties
           WHERE block_id = ?1
             AND key NOT IN (
                'space', 'is_space', 'created_at', 'completed_at',
                'repeat', 'repeat-until', 'repeat-count', 'repeat-seq',
                'repeat-origin', 'template'
             )"#,
        page_id,
    )
    .fetch_all(&mut *tx)
    .await?;

    // Resolve value_ref ULIDs to page titles where possible. Unresolved
    // refs (target missing/deleted) fall back to the raw ULID so the value
    // never renders empty.
    let mut ref_ids: HashSet<String> = HashSet::new();
    for r in &property_rows {
        if let Some(rf) = r.value_ref.as_deref()
            && !rf.is_empty()
        {
            ref_ids.insert(rf.to_string());
        }
    }
    let mut ref_titles: HashMap<String, String> = HashMap::new();
    if !ref_ids.is_empty() {
        let ids: Vec<String> = ref_ids.into_iter().collect();
        let ids_json = serde_json::to_string(&ids)?;
        let rows = sqlx::query!(
            r#"SELECT id, content FROM blocks
               WHERE id IN (SELECT value FROM json_each(?1))
                 AND deleted_at IS NULL"#,
            ids_json,
        )
        .fetch_all(&mut *tx)
        .await?;
        for r in rows {
            if let Some(c) = r.content {
                ref_titles.insert(r.id, c);
            }
        }
    }

    let properties: Vec<FrontmatterRow> = property_rows
        .into_iter()
        .map(|r| FrontmatterRow {
            key: r.key,
            value_text: r.value_text,
            value_date: r.value_date,
            value_num: r.value_num,
            value_ref: r.value_ref,
            value_bool: r.value_bool,
        })
        .collect();

    // 4b. (#1433) Read the page's aliases and tag names for frontmatter.
    //
    // Aliases come straight from `page_aliases`, sorted alphabetically so
    // the exported sequence is deterministic (mirrors
    // `get_page_aliases_inner`'s `ORDER BY alias`). Read through the #660
    // snapshot tx so they observe the same consistent state as the rest of
    // the export.
    let aliases: Vec<String> = sqlx::query_scalar!(
        "SELECT alias FROM page_aliases WHERE page_id = ?1 ORDER BY alias",
        page_id,
    )
    .fetch_all(&mut *tx)
    .await?;

    // Tags are the tag blocks explicitly associated with the page block via
    // `block_tags`; the human-readable NAME is the tag block's `content`.
    // We emit names (not ULIDs). NULL-content tag blocks are skipped, and
    // the results are ordered by name (NOCASE, matching the `tags_cache`
    // UNIQUE index collation) then id for a stable, reproducible sequence.
    let tag_names_fm: Vec<String> = sqlx::query_scalar!(
        r#"SELECT t.content AS "content!"
             FROM block_tags bt
             JOIN blocks t ON t.id = bt.tag_id
            WHERE bt.block_id = ?1
              AND t.block_type = 'tag'
              AND t.deleted_at IS NULL
              AND t.content IS NOT NULL
            ORDER BY t.content COLLATE NOCASE ASC, t.id ASC"#,
        page_id,
    )
    .fetch_all(&mut *tx)
    .await?;

    // #660 — all reads are done; release the snapshot tx. A read-only
    // `BEGIN DEFERRED` tx takes no writer lock, so the `commit` here is
    // effectively a rollback (nothing was written); committing rather
    // than letting the tx drop makes the snapshot-release point explicit
    // and returns the connection to the pool promptly.
    tx.commit().await?;

    // 5. Build markdown output
    let mut output = String::new();

    // Title
    let title = page.content.unwrap_or_else(|| "Untitled".to_string());
    output.push_str(&format!("# {title}\n\n"));

    // Frontmatter (if properties, aliases, or tags exist)
    //
    // (#1433) `aliases`/`tags` are emitted as YAML *flow sequences*
    // (`[a, b]`). An item is emitted *bare* only when it is unambiguously a
    // plain string in flow context — i.e. it does not look like a YAML
    // scalar token (`true`/`null`/a number/etc.), does not start with a YAML
    // indicator, has no surrounding whitespace, and contains no
    // flow-significant or control characters. Anything else is emitted as a
    // YAML double-quoted scalar with `\`, `"` and all control characters
    // (`\n`, `\t`, `\r`, and `\xNN` for the rest) escaped, which is valid for
    // *any* string. Legacy scalar property values keep their verbatim
    // emission below.
    fn yaml_looks_like_special_token(s: &str) -> bool {
        // YAML 1.1 boolean / null tokens (the common spellings parsers accept).
        const RESERVED: &[&str] = &[
            "null", "Null", "NULL", "~", "true", "True", "TRUE", "false", "False", "FALSE", "yes",
            "Yes", "YES", "no", "No", "NO", "on", "On", "ON", "off", "Off", "OFF",
        ];
        if RESERVED.contains(&s) {
            return true;
        }
        // Numeric-looking scalars (int / float / hex / octal / inf / nan).
        // A bare numeric value would round-trip as a number, not a string, so
        // we quote it. Be conservative: any token that parses as i64 or f64,
        // or matches the common hex / sexagesimal-free special forms.
        if s.parse::<i64>().is_ok() || s.parse::<f64>().is_ok() {
            return true;
        }
        matches!(
            s,
            ".inf" | ".Inf" | ".INF" | "-.inf" | "+.inf" | ".nan" | ".NaN" | ".NAN"
        ) || s
            .strip_prefix("0x")
            .is_some_and(|h| !h.is_empty() && h.chars().all(|c| c.is_ascii_hexdigit() || c == '_'))
            || s.strip_prefix("0o").is_some_and(|o| {
                !o.is_empty() && o.chars().all(|c| ('0'..='7').contains(&c) || c == '_')
            })
    }
    fn yaml_flow_item(s: &str) -> String {
        let plain_safe = !s.is_empty()
            && s == s.trim()
            && !yaml_looks_like_special_token(s)
            // First char must not be a YAML indicator that changes meaning.
            && !s.starts_with([
                '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"',
                '%', '@', '`', ' ',
            ])
            // No flow-significant, comment, mapping, or control characters.
            && s.chars().all(|c| {
                !matches!(c, ',' | '[' | ']' | '{' | '}' | ':' | '#' | '"' | '\'')
                    && !c.is_control()
            });
        if plain_safe {
            return s.to_string();
        }
        let mut escaped = String::with_capacity(s.len() + 2);
        escaped.push('"');
        for c in s.chars() {
            match c {
                '\\' => escaped.push_str("\\\\"),
                '"' => escaped.push_str("\\\""),
                '\n' => escaped.push_str("\\n"),
                '\t' => escaped.push_str("\\t"),
                '\r' => escaped.push_str("\\r"),
                c if c.is_control() => {
                    // YAML double-quoted escapes: `\xNN` (8-bit) covers C0 and
                    // DEL; C1 controls (U+0080..=U+009F) need `\uNNNN`.
                    let cp = c as u32;
                    if cp <= 0xFF {
                        escaped.push_str(&format!("\\x{cp:02X}"));
                    } else {
                        escaped.push_str(&format!("\\u{cp:04X}"));
                    }
                }
                c => escaped.push(c),
            }
        }
        escaped.push('"');
        escaped
    }
    fn yaml_flow_sequence(items: &[String]) -> String {
        let inner: Vec<String> = items.iter().map(|s| yaml_flow_item(s)).collect();
        format!("[{}]", inner.join(", "))
    }

    if !properties.is_empty() || !aliases.is_empty() || !tag_names_fm.is_empty() {
        output.push_str("---\n");
        if !aliases.is_empty() {
            output.push_str(&format!("aliases: {}\n", yaml_flow_sequence(&aliases)));
        }
        if !tag_names_fm.is_empty() {
            output.push_str(&format!("tags: {}\n", yaml_flow_sequence(&tag_names_fm)));
        }
        for prop in &properties {
            // Precedence: date, then text, then ref (resolved to page title
            // or raw ULID), then numeric, then bool. A `block_properties` row
            // stores its value in exactly one column, so at most one of these
            // is populated; the order is a defensive fallback.
            let num_str;
            let value: &str = if let Some(d) = prop.value_date.as_deref() {
                d
            } else if let Some(t) = prop.value_text.as_deref() {
                t
            } else if let Some(rf) = prop.value_ref.as_deref().filter(|s| !s.is_empty()) {
                ref_titles.get(rf).map_or(rf, String::as_str)
            } else if let Some(n) = prop.value_num {
                // Render integers without a trailing ".0"; keep fractional
                // values as-is. `{n}` on an f64 already emits "3" for 3.0 in
                // Rust's default float formatting, so no lossy `as i64` cast
                // is needed.
                num_str = format!("{n}");
                &num_str
            } else if let Some(b) = prop.value_bool {
                if b != 0 { "true" } else { "false" }
            } else {
                ""
            };
            output.push_str(&format!("{}: {value}\n", prop.key));
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
/// #662 — Chunked, atomic-subtree semantics (relaxes the original L-30
/// single-transaction contract). The import is split into a sequence of
/// `BEGIN IMMEDIATE` transactions so the single SQLite writer lock is
/// acquired and released per chunk rather than held for the whole
/// (unbounded) import — interleaved writes and the UI can proceed between
/// chunks. See [`import_markdown_with_progress`] for the full chunk-
/// boundary and partial-import contract. A failure anywhere still surfaces
/// as `Err(AppError)`; `result.warnings` is reserved for non-transactional
/// parse diagnostics from [`import::parse_logseq_markdown`] (e.g. depth
/// clamping). Savepoint-based partial recovery was considered and rejected
/// as too invasive for the available signal.
#[instrument(skip(pool, device_id, materializer, content), err)]
pub async fn import_markdown_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    content: String,
    filename: Option<String>,
    space_id: String,
) -> Result<ImportResult, AppError> {
    // Progress-free path (MCP tools, sync replay, scripted imports, tests
    // / benches). The Tauri command calls
    // [`import_markdown_with_progress`] with a live channel sink instead.
    import_markdown_with_progress(
        pool,
        device_id,
        materializer,
        content,
        filename,
        space_id,
        None,
    )
    .await
}

/// Progress-streaming core of [`import_markdown_inner`] (#128, PEND-38 /
/// PEND-06 Tier 3).
///
/// # #662 — chunked writer-lock release
///
/// The import is written as a *sequence* of `BEGIN IMMEDIATE`
/// transactions (chunks) instead of one transaction spanning the whole
/// file. Each chunk acquires the single SQLite writer lock, commits, and
/// releases it; between chunks the lock is free, so a multi-MB import no
/// longer blocks every other write (or the UI) for its full duration.
///
/// ## Chunk boundaries — never split a subtree
///
/// A chunk is only ever closed at a **top-level (depth-0) subtree
/// boundary**: blocks accumulate into the open transaction and the chunk
/// is flushed (committed) only once it holds at least
/// [`IMPORT_CHUNK_BLOCKS`] blocks *and* the next parsed block starts a new
/// depth-0 subtree. Consequently a parent block and every one of its
/// descendants always land in the **same** transaction — a child is never
/// committed without its parent, and a parent is never committed missing
/// any of its (parsed) children. The page block + its `space` property are
/// written in the first chunk together with the first subtree(s).
///
/// Cross-chunk parent references are sound: a block's `parent_id` may point
/// at a block committed in an *earlier* chunk (e.g. the page itself, or a
/// preceding top-level subtree's root is never a parent of a later one), and
/// `create_block_in_tx`'s `WHERE id = ? AND deleted_at IS NULL` parent check
/// sees the committed row.
///
/// ## Partial-import semantics
///
/// If the import is interrupted mid-way (process crash, or an in-tx error
/// that rolls back the *current* chunk), the visible, durable state is the
/// page plus a **prefix of its complete top-level subtrees** — every
/// committed subtree is whole and navigable, and no half-written subtree,
/// orphaned child, or parent-missing-children state is ever exposed. This
/// relaxes the original L-30 "all-or-nothing for the whole file" contract
/// to "all-or-nothing per chunk" (a deliberate trade for the lock-hold fix
/// — see #662). Imports small enough to fit in a single chunk (the common
/// case, `<= IMPORT_CHUNK_BLOCKS` blocks) keep the original whole-import
/// atomicity: there is exactly one chunk, so a mid-import error rolls back
/// everything including the page.
///
/// ## Op-log / materializer correctness
///
/// Each chunk's ops still go through the normal `append_local_op_in_tx`
/// path inside the chunk's transaction and are dispatched (in FIFO order)
/// by that chunk's `commit_and_dispatch` only *after* the chunk commits —
/// identical to the single-transaction path, just repeated per chunk.
/// Global op ordering is preserved because chunks commit strictly in
/// sequence (the next chunk's `BEGIN IMMEDIATE` cannot start until the
/// previous chunk has committed and released the lock).
///
/// ## Progress events
///
/// When `progress` is `Some`, the function emits:
///
///   1. one [`ImportProgressUpdate::Started`] before any block is written,
///   2. one [`ImportProgressUpdate::Progress`] after each block create,
///   3. one [`ImportProgressUpdate::Complete`] **after the final chunk
///      commits** — never before, so a `Complete` event always implies the
///      whole import is durable.
///
/// On any error the function returns `Err` before reaching the `Complete`
/// emit, so a consumer that sees `Started` but no `Complete` must treat the
/// import as failed (possibly partially-applied per the chunk semantics
/// above). Sends are best-effort (see [`ImportProgressSink`]).
#[instrument(skip(pool, device_id, materializer, content, progress), err)]
pub async fn import_markdown_with_progress(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    content: String,
    filename: Option<String>,
    space_id: String,
    progress: Option<&dyn ImportProgressSink>,
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

    // #128 — emit `Started` with the parser's block count so the UI can
    // render a determinate progress bar from the first event. Sent before
    // the transaction opens; if the import later fails, the consumer sees
    // no `Complete` and treats it as failed.
    let blocks_total = parse_output.blocks.len() as u64;
    if let Some(sink) = progress {
        sink.emit(ImportProgressUpdate::Started {
            page_title: page_title.clone(),
            blocks_total,
        });
    }

    // --- Chunked IMMEDIATE transactions (#662) ---
    // MAINT-112: CommandTx couples commit + post-commit dispatch; op
    // records enqueue per chunk and drain in FIFO order on that chunk's
    // commit. Pre-#662 this was a *single* IMMEDIATE transaction spanning
    // the whole (unbounded) import, so a multi-MB file held the single
    // SQLite writer lock — blocking every other write + the UI — for its
    // entire duration. We now flush the transaction at top-level
    // (depth-0) subtree boundaries once it has accumulated at least
    // `IMPORT_CHUNK_BLOCKS` blocks, releasing and re-acquiring the writer
    // lock between chunks so interleaved writes can proceed. See this
    // function's doc comment for the chunk-boundary + partial-import
    // contract. A per-block / per-property failure still propagates via
    // `?`, rolling back the *current* chunk (committed chunks survive).
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
    let page_id = page.id.clone().into_string();

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
    // Parse-time diagnostics (e.g. depth clamping, frontmatter array/invalid
    // lines). Per-row write failures are reported via `Err(AppError)` instead
    // — see the doc note. Made mutable so the frontmatter apply step below can
    // append its own non-fatal diagnostics (e.g. a `ref` value whose target
    // title couldn't be resolved).
    let mut warnings: Vec<String> = parse_output.warnings;

    // #1432 — apply the leading YAML frontmatter as PAGE-level properties,
    // closing the export↔import asymmetry: `export_page_markdown_inner`
    // already emits page properties as frontmatter, but the importer used to
    // discard them. The parser (`import::parse_logseq_markdown`) has already
    // filtered the exporter's internal/reserved keys and validated each key
    // against the `^[A-Za-z0-9_-]{1,64}$` alphabet, so every pair here is a
    // user-visible scalar safe to stamp onto the page. These properties are
    // written into the FIRST chunk (alongside the page + space property),
    // before the block loop opens any new chunk, so they share the page's
    // atomic write.
    for (key, value) in &parse_output.frontmatter {
        // Registry-aware coercion: look up the declared `value_type` so a
        // `number` / `boolean` / `date` value round-trips into the right
        // typed column instead of always landing as text. `ref`-typed values
        // are special-cased below (the exporter renders refs as the target
        // page's *title*, not its ULID, so we reverse-resolve the title).
        let value_type: Option<String> = sqlx::query_scalar!(
            "SELECT value_type FROM property_definitions WHERE key = ?",
            key,
        )
        .fetch_optional(&mut **tx)
        .await?;

        let (value_text, value_num, value_date, value_ref, value_bool) =
            if value_type.as_deref() == Some("ref") {
                // The exporter emits a ref as the resolved target *title*
                // (`export_page_markdown_inner`). Reverse-resolve it back to a
                // live page/tag block id so the round-trip preserves the
                // reference. On no/ambiguous match, fall back to text so the
                // human-readable value is never dropped (and warn).
                //
                // Resolution is SAME-SPACE-SCOPED (`AND space_id = ?`): a
                // title that collides with a page/tag in a DIFFERENT space
                // must NOT resolve here. Otherwise the foreign block id would
                // flow into `set_property_in_tx` →
                // `validate_ref_property_cross_space`, which hard-rejects with
                // `AppError::Validation` and aborts/rolls back the entire
                // import. Scoping to the import's own space means a cross-space
                // title simply doesn't match and falls through to the text +
                // warning branch below — the import never aborts on a
                // collision. (Blocks carry `space_id` directly, Phase 2.)
                let resolved: Option<String> = sqlx::query_scalar!(
                    r#"SELECT id FROM blocks
                       WHERE content = ?
                         AND block_type IN ('page', 'tag')
                         AND deleted_at IS NULL
                         AND space_id = ?
                       ORDER BY id ASC
                       LIMIT 1"#,
                    value,
                    space_id,
                )
                .fetch_optional(&mut **tx)
                .await?;
                match resolved {
                    Some(id) => (None, None, None, Some(id), None),
                    None => {
                        // No same-space page/tag carries this title (it may
                        // live in another space, or not exist). The value type
                        // is declared `ref`, so we cannot persist the raw title
                        // as a `ref` (no live target) NOR as `text` (the typed
                        // def would reject text). Skip this single property with
                        // a warning rather than abort the whole import — the
                        // human-readable title is surfaced in the warning so it
                        // is never silently lost.
                        warnings.push(format!(
                            "frontmatter ref property '{key}' could not resolve target \
                             '{value}' to a page in this space; skipped"
                        ));
                        continue;
                    }
                }
            } else {
                crate::domain::block_ops::typed_property_args_for_registry_value(
                    key,
                    value.clone(),
                    value_type.as_deref(),
                )
            };

        let (_page_block, prop_op) = set_property_in_tx(
            &mut tx,
            device_id,
            page_id.clone(),
            key,
            value_text,
            value_num,
            value_date,
            value_ref,
            value_bool,
        )
        .await?;
        properties_set += 1;
        tx.enqueue_background(prop_op);
    }

    // #662 — number of blocks written into the *current* chunk's
    // transaction. Reset to 0 each time a chunk is flushed. A new chunk is
    // only opened at a top-level (depth-0) subtree boundary, so a chunk
    // never splits a subtree (parent + all descendants commit together).
    let mut chunk_blocks: usize = 0;

    // Track parent stack: (depth, block_id). Survives chunk flushes
    // unchanged — every id in it refers to a block committed in this or an
    // earlier chunk, so `create_block_in_tx`'s in-tx parent check (which
    // reads committed rows) resolves cross-chunk parents fine.
    let mut parent_stack: Vec<(usize, String)> = vec![(0, page_id.clone())];

    for block in &parse_output.blocks {
        // #662 — chunk-boundary flush. We may only break the import into a
        // new transaction at a top-level (depth-0) block: that guarantees
        // the chunk just closed holds whole subtrees (a parent and all its
        // descendants), never a half-written one. Flush when the open
        // chunk has reached the size threshold AND this block starts a new
        // depth-0 subtree. The page + space property written above count
        // toward neither threshold; `chunk_blocks` tracks content blocks.
        if block.depth == 0 && chunk_blocks >= IMPORT_CHUNK_BLOCKS {
            // Commit the current chunk (drains its op queue in FIFO order,
            // releasing the writer lock) and open a fresh one. A commit
            // failure here aborts the import; chunks already committed
            // survive (documented partial-import semantics).
            tx.commit_and_dispatch(materializer).await?;
            tx = CommandTx::begin_immediate(pool, "import_markdown").await?;
            chunk_blocks = 0;
        }

        // Find the correct parent: pop stack until we find a parent at depth < block.depth
        while parent_stack.len() > 1 && parent_stack.last().is_some_and(|(d, _)| *d >= block.depth)
        {
            parent_stack.pop();
        }
        let parent_id = parent_stack
            .last()
            .map(|(_, id)| id.clone())
            .unwrap_or(page_id.clone());

        // Create the block inside the current chunk's transaction. A
        // failure here aborts the import — `?` drops `tx` and rolls back
        // the current chunk (earlier committed chunks survive).
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
        chunk_blocks += 1;
        tx.enqueue_background(block_op);
        parent_stack.push((block.depth, new_block.id.clone().into_string()));

        // #128 — per-block progress tick. Emitted inside the loop so a
        // large file shows forward motion; the rows are not yet committed
        // (the `Complete` event after `commit_and_dispatch` is the
        // durability signal).
        if let Some(sink) = progress {
            sink.emit(ImportProgressUpdate::Progress {
                // `blocks_created` is a monotonically incremented counter,
                // always >= 0 — `cast_unsigned` documents that intent.
                blocks_done: blocks_created.cast_unsigned(),
                blocks_total,
            });
        }

        // Set properties inside the same chunk transaction as their
        // owning block — a block and its properties are never split across
        // a chunk boundary (properties are emitted immediately after the
        // block create, before the next depth-0 flush check).
        for (key, value) in &block.properties {
            // #623 — build the correct typed `PropertyValue` shape per key:
            // reserved date keys (`due_date`/`scheduled_date`) must hit the
            // `value_date` field, or `validate_property_value` rejects the
            // chunk.
            let (value_text, value_num, value_date, value_ref, value_bool) =
                crate::domain::block_ops::typed_property_args_for_string_value(key, value.clone());
            let (_block, prop_op) = set_property_in_tx(
                &mut tx,
                device_id,
                new_block.id.clone().into_string(),
                key,
                value_text,
                value_num,
                value_date,
                value_ref,
                value_bool,
            )
            .await?;
            properties_set += 1;
            tx.enqueue_background(prop_op);
        }
    }

    // Commit + dispatch the final chunk's queued ops in FIFO order,
    // releasing the writer lock.
    tx.commit_and_dispatch(materializer).await?;

    // #128 — `Complete` is emitted only after the final chunk commits, so
    // a consumer can treat it as the "whole import is durable" signal.
    // Mirrors the returned `ImportResult` counts.
    if let Some(sink) = progress {
        sink.emit(ImportProgressUpdate::Complete {
            page_title: page_title.clone(),
            blocks_created: blocks_created.cast_unsigned(),
            properties_set: properties_set.cast_unsigned(),
        });
    }

    Ok(ImportResult {
        page_title,
        blocks_created,
        properties_set,
        warnings,
    })
}

/// Tauri command: export a page as Markdown. Delegates to [`export_page_markdown_inner`].
#[tauri::command]
#[specta::specta]
pub async fn export_page_markdown(
    read_pool: State<'_, ReadPool>,
    page_id: PageId,
) -> Result<String, AppError> {
    export_page_markdown_inner(&read_pool.0, page_id.as_str())
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: import a Logseq-style markdown file as a page with
/// block hierarchy. Delegates to [`import_markdown_with_progress`].
///
/// PEND-35 Tier 1.1 — `space_id` is required. The imported page is
/// stamped with `space = ?space_id` inside the same transaction as the
/// `CreateBlock` op, so an imported page can never exist in the op log
/// without its space property (FEAT-3 invariant). Validation against a
/// live space block happens TOCTOU-safe inside the same transaction.
///
/// #128 (PEND-38 / PEND-06 Tier 3) — `progress` streams per-block import
/// progress to the frontend. The frontend always supplies a
/// `Channel<ImportProgressUpdate>` (mirroring `start_sync`); sends are
/// best-effort, so a dropped channel never aborts the import.
#[tauri::command]
#[specta::specta]
pub async fn import_markdown(
    content: String,
    filename: Option<String>,
    space_id: String,
    progress: tauri::ipc::Channel<ImportProgressUpdate>,
    ctx: State<'_, WriteCtx>,
) -> Result<ImportResult, AppError> {
    import_markdown_with_progress(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        content,
        filename,
        space_id,
        Some(&progress),
    )
    .await
    .map_err(sanitize_internal_error)
}
