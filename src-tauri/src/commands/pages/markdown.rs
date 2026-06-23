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
use crate::import::{ImportProgressSink, ImportProgressUpdate, ImportResult, VaultFile};
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
///
/// #1921 — chunking bounds only the writer-lock *hold time* (it commits +
/// releases the lock periodically); it does NOT bound the per-block
/// sibling-reproject cost incurred when each block is created. That reproject
/// cost is a separate concern tracked on its own and is unaffected by this
/// threshold.
pub(crate) const IMPORT_CHUNK_BLOCKS: usize = 500;

/// Matches a HUMAN-readable wiki-link token `[[Page Name]]` on import (#1446
/// Part B). The inner capture is the page NAME (any run of characters that is
/// neither `]` nor a newline, non-greedy so `[[A]] [[B]]` matches twice). A
/// token whose body is a canonical 26-char Crockford-base32 ULID is left
/// untouched (it is already an internal `[[ULID]]` ref) — the resolver checks
/// the captured body against [`crate::cache::PAGE_LINK_RE`] before rewriting.
///
/// #1920 — this Rust regex (`\[\[([^\]\n]+?)\]\]`) is the CANONICAL source for
/// the inbound wiki-link grammar. It is mirrored byte-for-byte by the frontend
/// `HUMAN_PAGE_LINK_RE` in `src/lib/block-clipboard.ts` (the paste path,
/// #1484). The two implement the SAME rule — `[[Page]]` → ULID,
/// create-if-missing, ambiguous duplicate titles stay plain text — so any
/// change to the pattern MUST be made in both. A cross-language parity test
/// over a shared fixture pins them together (`page_link_re_parity_*` here and
/// `page-link-re-parity.test.ts` in the frontend).
static HUMAN_PAGE_LINK_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"\[\[([^\]\n]+?)\]\]").expect("invalid human page-link regex")
});

/// Matches a HUMAN-readable bare/nested/hyphenated inline tag `#tag` on import
/// (#1924). Group 1 is the leading boundary char (or empty at line start);
/// group 2 is the tag NAME — a run of `[\p{L}\p{N}_]` then `[\p{L}\p{N}_/-]*`
/// (Unicode letters/digits/underscore, with `/` and `-` allowed after the
/// first char for nested + hyphenated tags). This mirrors the frontend
/// `HUMAN_TAG_RE` in `src/lib/block-clipboard.ts` byte-for-byte.
///
/// The leading boundary `(^|[^\p{L}\p{N}_])` prevents matching `# heading`
/// (the `#` is followed by a space, not a name char), `word#frag` (the `#` is
/// preceded by a word char), and `a#b`. Because the name's FIRST char must be
/// a word char and a canonical `#[ULID]` ref's next char is `[` (not a word
/// char), this regex never matches an already-internal `#[ULID]` token — so
/// canonical refs survive untouched.
static HUMAN_TAG_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"(^|[^\p{L}\p{N}_])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)")
        .expect("invalid human inline-tag regex")
});

/// Matches a HUMAN-readable multi-word inline tag `#[[Tag With Space]]` on
/// import (#1950). A `#` immediately followed by a `[[...]]` body. Group 1 is
/// the inner tag name (any run that is neither `]` nor a newline, non-greedy).
/// Distinct from a bare `[[Page]]` wiki-link by the leading `#` — the wiki-link
/// pre-pass skips any `[[...]]` immediately preceded by `#` (see
/// `collect_inbound_page_link_names` / `rewrite_inbound_page_links`) so a
/// `#[[...]]` becomes a TAG here, never a page.
static HUMAN_MULTIWORD_TAG_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"#\[\[([^\]\n]+?)\]\]").expect("invalid human multi-word-tag regex")
});

/// Map an import path (basename or folder-relative path) to the namespaced
/// page TITLE (#1446 Part B — folder → namespace, the inverse of the
/// namespaced export). Strips a trailing `.md`, normalises `\` to `/`, drops
/// empty segments, and rejoins with `/` so `Project/Backend/API.md` →
/// `Project/Backend/API`. Returns an empty string when nothing usable remains
/// (the caller falls back to a default title).
pub(crate) fn folder_path_to_namespace_title(path: &str) -> String {
    let without_ext = path.strip_suffix(".md").unwrap_or(path);
    without_ext
        .replace('\\', "/")
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

/// Collect the DISTINCT human-readable `[[Page Name]]` names referenced across
/// every parsed block's content (#1446 Part B). A token whose body is already a
/// canonical `[[ULID]]` ref is skipped (it needs no resolution). Used to drive
/// the create-if-missing pre-pass before the block-write loop, so each distinct
/// name is resolved/created exactly once regardless of how many blocks cite it.
fn collect_inbound_page_link_names(blocks: &[import::ParsedBlock]) -> Vec<String> {
    use std::collections::BTreeSet;
    let mut names: BTreeSet<String> = BTreeSet::new();
    for block in blocks {
        // #1921 — skip the regex scan for link-free blocks (the common case).
        if !block.content.contains("[[") {
            continue;
        }
        for cap in HUMAN_PAGE_LINK_RE.captures_iter(&block.content) {
            let whole = cap.get(0).expect("group 0 always present");
            // #1950 — a `[[...]]` immediately preceded by `#` is the multi-word
            // tag form `#[[Tag With Space]]`, NOT a page link. Leave it for the
            // tag pre-pass: do not collect it as a page name (so no page is
            // created) and the matching rewrite guard below leaves the token in
            // place for the tag rewrite. The check is byte-safe — a `#` is a
            // single ASCII byte, so `[..start]` ending with `'#'` is exact.
            //
            // #1925 — a `[[...]]` immediately preceded by `!` is an Obsidian
            // EMBED `![[file]]` (an attachment ref), NOT a page link. Skip it
            // here so no page is created and the embed token survives intact for
            // the attachment detection/ingest pass.
            if block.content[..whole.start()].ends_with('#')
                || block.content[..whole.start()].ends_with('!')
            {
                continue;
            }
            let name = cap[1].trim();
            // Skip canonical `[[ULID]]` bodies — they are already internal refs.
            if name.is_empty() || crate::cache::PAGE_LINK_RE.is_match(&cap[0]) {
                continue;
            }
            names.insert(name.to_string());
        }
    }
    names.into_iter().collect()
}

/// Rewrite human-readable `[[Page Name]]` tokens in `content` to internal
/// `[[ULID]]` refs using the resolved `name → ULID` map (#1446 Part B). A name
/// absent from the map (unresolvable / ambiguous duplicate title / creation
/// failure) is left as its original plain-text token — nothing is dropped.
/// Canonical `[[ULID]]` tokens already in the content are left untouched.
fn rewrite_inbound_page_links(content: &str, resolved: &HashMap<String, String>) -> String {
    // #1921 fast-path: a block with no `[[` can carry no wiki-link, so skip the
    // regex scan + capture/replace work entirely. Behaviour is identical for
    // link-free blocks (the regex would have matched nothing and returned the
    // content unchanged anyway).
    if !content.contains("[[") {
        return content.to_string();
    }
    HUMAN_PAGE_LINK_RE
        .replace_all(content, |caps: &regex::Captures<'_>| {
            let m = caps.get(0).expect("group 0 always present");
            let whole = m.as_str();
            // #1950 — IDENTICAL guard to `collect_inbound_page_link_names`: a
            // `[[...]]` immediately preceded by `#` is the `#[[Tag]]` multi-word
            // tag form. Leave it untouched here so the tag rewrite (which runs
            // separately) turns it into a `#[ULID]` tag ref, not a page ref.
            // `m.start()` is the absolute byte offset within `content`.
            //
            // #1925 — likewise a `!`-prefixed `![[file]]` is an Obsidian embed
            // (attachment ref), not a page link: leave it for the attachment
            // pass.
            if content[..m.start()].ends_with('#') || content[..m.start()].ends_with('!') {
                return whole.to_string();
            }
            // Already an internal `[[ULID]]` ref — keep verbatim.
            if crate::cache::PAGE_LINK_RE.is_match(whole) {
                return whole.to_string();
            }
            let name = caps[1].trim();
            match resolved.get(name) {
                Some(ulid) => format!("[[{ulid}]]"),
                None => whole.to_string(),
            }
        })
        .into_owned()
}

/// #1924 — byte ranges of `content` that lie inside an inline-code span
/// (`` `...` ``). A simple left-to-right scan that pairs backticks: text
/// between a backtick and the next backtick is a code span (the backticks
/// themselves are included in the range). The inline-tag pre-pass skips any
/// `#tag` token whose match falls inside one of these ranges, so a `#tag` in
/// `` `code` `` stays literal — mirroring the fenced-code skip (`is_code`) for
/// inline spans. Deliberately minimal: it does not implement the full CommonMark
/// backtick-run-length matching rule (a span opened by N backticks closes only
/// on a run of exactly N); a single-backtick pairing is sufficient for the
/// import safety net and matches the spirit of the fence handling.
fn inline_code_spans(content: &str) -> Vec<(usize, usize)> {
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut open: Option<usize> = None;
    for (i, b) in content.bytes().enumerate() {
        if b == b'`' {
            match open {
                None => open = Some(i),
                Some(start) => {
                    // Range covers the opening backtick through the closing one.
                    spans.push((start, i + 1));
                    open = None;
                }
            }
        }
    }
    spans
}

/// `true` when byte offset `pos` falls inside any inline-code span range.
fn is_in_code_span(pos: usize, spans: &[(usize, usize)]) -> bool {
    spans.iter().any(|&(s, e)| pos >= s && pos < e)
}

/// Collect the DISTINCT human-readable inline-tag names referenced across every
/// TAG-ELIGIBLE block's content (#1924/#1950), in both forms:
///   * bare/nested/hyphenated `#tag` (`HUMAN_TAG_RE`, group 2 is the name), and
///   * multi-word `#[[Tag With Space]]` (`HUMAN_MULTIWORD_TAG_RE`, group 1).
///
/// A block flagged `is_code` (born inside a ```` ``` ```` fence) is skipped
/// entirely — its `#tag`-looking text stays literal. Within a non-code block,
/// matches falling inside an inline-code span (`` `...` ``) are skipped too.
/// Canonical `#[ULID]` refs never match `HUMAN_TAG_RE` (the char after `#` is
/// `[`, not a name char), so they are not collected. The multi-word form is
/// scanned FIRST and its byte ranges are excluded from the bare scan so a
/// `#[[a b]]` is not also double-counted as a bare `#a`-style fragment (it
/// cannot be — `[` is not a name char — but the ordering keeps the rewrite and
/// collect passes symmetric).
///
/// Used to drive the resolve-or-create tag pre-pass before the block-write loop,
/// so each distinct name is resolved/created exactly once.
fn collect_inbound_tag_names(blocks: &[import::ParsedBlock]) -> Vec<String> {
    use std::collections::BTreeSet;
    let mut names: BTreeSet<String> = BTreeSet::new();
    for block in blocks {
        if block.is_code {
            continue;
        }
        if !block.content.contains('#') {
            continue;
        }
        let spans = inline_code_spans(&block.content);
        // Multi-word `#[[...]]` first.
        for cap in HUMAN_MULTIWORD_TAG_RE.captures_iter(&block.content) {
            let whole = cap.get(0).expect("group 0 always present");
            if is_in_code_span(whole.start(), &spans) {
                continue;
            }
            let name = cap[1].trim();
            if !name.is_empty() {
                names.insert(name.to_string());
            }
        }
        // Bare `#tag`. The `#` is at `name_match.start() - 1` (group 1 is the
        // boundary char, which may be empty at line start); the match start of
        // group 0 is the boundary, so use the name group's start for the span
        // check (its preceding `#` shares the same span membership).
        for cap in HUMAN_TAG_RE.captures_iter(&block.content) {
            let name_m = cap.get(2).expect("name group present");
            if is_in_code_span(name_m.start(), &spans) {
                continue;
            }
            let name = name_m.as_str();
            if !name.is_empty() {
                names.insert(name.to_string());
            }
        }
    }
    names.into_iter().collect()
}

/// Rewrite human-readable inline tags in `content` to internal `#[ULID]` refs
/// using the resolved `name → ULID` map (#1924/#1950). Both `#tag` and
/// `#[[Tag With Space]]` forms become `#[ULID]`. A name absent from the map
/// (creation failure) keeps its original literal token — nothing is dropped.
/// Code blocks (`is_code`) are handled by the CALLER (skipped before this runs);
/// inline-code spans are skipped here. Canonical `#[ULID]` refs are never
/// touched (they don't match the human regexes).
fn rewrite_inbound_tags(content: &str, resolved: &HashMap<String, String>) -> String {
    if !content.contains('#') {
        return content.to_string();
    }
    let spans = inline_code_spans(content);
    // Pass 1: multi-word `#[[name]]` → `#[ULID]`.
    let after_multi = HUMAN_MULTIWORD_TAG_RE.replace_all(content, |caps: &regex::Captures<'_>| {
        let m = caps.get(0).expect("group 0 present");
        let whole = m.as_str();
        if is_in_code_span(m.start(), &spans) {
            return whole.to_string();
        }
        let name = caps[1].trim();
        match resolved.get(name) {
            Some(ulid) => format!("#[{ulid}]"),
            None => whole.to_string(),
        }
    });

    // Pass 2: bare `#tag` → `<boundary>#[ULID]`. The boundary char (group 1)
    // is preserved verbatim so the leading separator is not consumed. The
    // inline-code spans are recomputed against `after_multi` because pass 1 may
    // have shifted byte offsets; a `#[[name]]` rewrite changes length, so reuse
    // of the original `spans` would mis-align. Recompute defensively.
    let spans2 = inline_code_spans(&after_multi);
    HUMAN_TAG_RE
        .replace_all(&after_multi, |caps: &regex::Captures<'_>| {
            let boundary = caps.get(1).map_or("", |m| m.as_str());
            let name_m = caps.get(2).expect("name group present");
            let name = name_m.as_str();
            if is_in_code_span(name_m.start(), &spans2) {
                return format!("{boundary}#{name}");
            }
            match resolved.get(name) {
                Some(ulid) => format!("{boundary}#[{ulid}]"),
                None => format!("{boundary}#{name}"),
            }
        })
        .into_owned()
}

/// Replace `#[ULID]` with `#tagname` and `[[ULID]]` with `[[Page Title]]`
/// in content, preserving all other markdown formatting.
fn resolve_ulids_for_export(
    content: &str,
    tag_names: &HashMap<String, String>,
    page_titles: &HashMap<String, String>,
) -> String {
    // #1920 — `crate::cache` is the canonical definition site for both regexes;
    // `crate::fts::strip` imports them for FTS stripping. Reference the
    // canonical cache path here rather than going through `fts`.
    use crate::cache::{PAGE_LINK_RE, TAG_REF_RE};

    // Replace #[ULID] → #tagname. A tag whose name contains whitespace is
    // emitted in the `#[[multi word]]` form (#1924/#1950) so it survives a
    // re-import as a single tag — the bare `#name` form would truncate at the
    // first space (`HUMAN_TAG_RE` stops at non-name chars), splitting the tag.
    let result = TAG_REF_RE
        .replace_all(content, |caps: &regex::Captures| {
            let ulid = &caps[1];
            if let Some(name) = tag_names.get(ulid) {
                if name.chars().any(char::is_whitespace) {
                    format!("#[[{name}]]")
                } else {
                    format!("#{name}")
                }
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

/// One projected `block_properties` row destined for the exported YAML
/// frontmatter (#384). A row stores its value in exactly one of the typed
/// columns; the emit loop in [`export_page_markdown_inner`] picks the populated
/// one. Lifted to module scope (#1920) from the function body for readability.
struct FrontmatterRow {
    key: String,
    value_text: Option<String>,
    value_date: Option<String>,
    value_num: Option<f64>,
    value_ref: Option<String>,
    value_bool: Option<i64>,
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
/// `json_each(?)` query: pre-fix the function loaded *every*
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
    // #1920 — canonical path (`crate::cache` defines these; `crate::fts::strip`
    // imports them for its own use).
    use crate::cache::{PAGE_LINK_RE, TAG_REF_RE};
    use std::collections::HashSet;

    // Validate ULID format upfront so malformed inputs surface
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
    // Filter `deleted_at IS NULL` (mirrors `get_active_block_inner`)
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
    // Descendant beyond it.
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
    // Page in the vault on each export.
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
    // emission below. #1920 — the emit helpers now live in `markdown_yaml`
    // (symmetric with the import-side `strip_yaml_quotes`).
    use super::markdown_yaml::yaml_flow_sequence;

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

    // Block content (#1916).
    //
    // Each descendant must be emitted as `<indent>- <content>` where
    // `<indent>` is `"  ".repeat(depth)` — the *exact* shape
    // `import::parse_logseq_markdown` reconstructs (it derives block identity
    // from the `- ` prefix and nesting depth from leading-spaces / 2). The
    // pre-fix loop wrote raw content with no bullet and no indentation, so
    // Agaric's own export collapsed to a single block on re-import.
    //
    // CRITICAL: `descendants` is ordered FLAT by `(position, id)` over the
    // keyset — `position` is the *sibling* slot (dense within a parent), so
    // two blocks under different parents can share a position and the global
    // order does NOT guarantee parent-before-child (e.g. a child whose id
    // sorts before its parent's). Emitting in that flat order would both
    // mis-compute depth AND, worse, present a child bullet before its parent
    // bullet, which the importer's document-order parent-stack would
    // mis-reparent. So we re-order the subtree into DFS pre-order here:
    // build `parent_id -> children` (children sorted by `(position, id)`,
    // matching the read order), then walk depth-first from the page root.
    // This guarantees every parent precedes its children and yields the
    // correct depth for indentation.
    let mut children_by_parent: HashMap<String, Vec<&BlockRow>> = HashMap::new();
    for block in &descendants {
        let parent_key = block
            .parent_id
            .as_ref()
            .map_or_else(|| page_id.to_string(), |p| p.clone().into_string());
        children_by_parent
            .entry(parent_key)
            .or_default()
            .push(block);
    }
    for children in children_by_parent.values_mut() {
        // The read query already orders by `(COALESCE(position, sentinel),
        // id)`; preserve that sibling order within each parent.
        children.sort_by(|a, b| {
            let pa = a.position.unwrap_or(NULL_POSITION_SENTINEL);
            let pb = b.position.unwrap_or(NULL_POSITION_SENTINEL);
            pa.cmp(&pb)
                .then_with(|| a.id.clone().into_string().cmp(&b.id.clone().into_string()))
        });
    }

    // Iterative DFS pre-order from the page root. A visited set guards against
    // a pathological parent cycle (a block whose ancestor chain loops back) so
    // export can never infinite-loop on corrupt data.
    let mut visited: HashSet<String> = HashSet::new();
    // Stack of (block, depth), pushed in reverse so siblings pop in order.
    let mut stack: Vec<(&BlockRow, usize)> = Vec::new();
    if let Some(roots) = children_by_parent.get(page_id) {
        for child in roots.iter().rev() {
            stack.push((child, 0));
        }
    }
    while let Some((block, depth)) = stack.pop() {
        let id = block.id.clone().into_string();
        if !visited.insert(id.clone()) {
            continue;
        }

        let indent = "  ".repeat(depth);
        let content = block.content.as_deref().unwrap_or("");
        let resolved = resolve_ulids_for_export(content, &tag_names, &page_titles);
        output.push_str(&format!("{indent}- {resolved}\n"));

        // #1916 — task metadata (TODO/DONE state, priority, scheduled/due
        // dates) lives in the reserved `blocks` columns, not in
        // `block_properties`, so it is invisible to the content render above.
        // Emit each populated column as a `key:: value` property line indented
        // one level under the bullet — the EXACT form the importer's property
        // parser reads back (`parse_logseq_markdown` attaches a `key:: value`
        // line to its owning block, and the apply path routes the reserved
        // keys `todo_state` / `priority` / `due_date` / `scheduled_date` into
        // their columns via `typed_property_args_for_string_value`). No new
        // syntax is invented — these are ordinary Logseq property lines.
        let prop_indent = "  ".repeat(depth + 1);
        for (key, value) in [
            ("todo_state", block.todo_state.as_deref()),
            ("priority", block.priority.as_deref()),
            ("scheduled_date", block.scheduled_date.as_deref()),
            ("due_date", block.due_date.as_deref()),
        ] {
            if let Some(v) = value.filter(|s| !s.is_empty()) {
                output.push_str(&format!("{prop_indent}{key}:: {v}\n"));
            }
        }

        // Push this block's children (reversed so they pop in sibling order)
        // at depth + 1.
        if let Some(kids) = children_by_parent.get(&id) {
            for kid in kids.iter().rev() {
                stack.push((kid, depth + 1));
            }
        }
    }

    // Safety net: any descendant NOT reachable by DFS from the page root
    // (e.g. an orphan whose `parent_id` points outside this subtree while its
    // denormalised `page_id` still names this page) would otherwise be
    // silently dropped — the pre-fix flat loop emitted every descendant. Emit
    // such strays at depth 0 in the read order so the export stays lossless.
    for block in &descendants {
        let id = block.id.clone().into_string();
        if visited.contains(&id) {
            continue;
        }
        let content = block.content.as_deref().unwrap_or("");
        let resolved = resolve_ulids_for_export(content, &tag_names, &page_titles);
        output.push_str(&format!("- {resolved}\n"));
        for (key, value) in [
            ("todo_state", block.todo_state.as_deref()),
            ("priority", block.priority.as_deref()),
            ("scheduled_date", block.scheduled_date.as_deref()),
            ("due_date", block.due_date.as_deref()),
        ] {
            if let Some(v) = value.filter(|s| !s.is_empty()) {
                output.push_str(&format!("  {key}:: {v}\n"));
            }
        }
    }

    Ok(output)
}

/// Import a Logseq-style markdown file as a page with block hierarchy.
///
/// Creates a page from the filename (or first heading), then creates
/// blocks following the indentation hierarchy. Properties are set via
/// SetProperty ops. Returns import statistics.
///
/// #662 — Chunked, atomic-subtree semantics (relaxes the original
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
#[instrument(
    skip(pool, device_id, materializer, content, app_data_dir, vault_files),
    err
)]
#[allow(clippy::too_many_arguments)]
pub async fn import_markdown_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    app_data_dir: &std::path::Path,
    content: String,
    filename: Option<String>,
    space_id: String,
    // #1925 — referenced sibling files' bytes. `None`/empty ⇒ exactly the
    // pre-#1925 behaviour (no attachment ingest).
    vault_files: Option<Vec<VaultFile>>,
) -> Result<ImportResult, AppError> {
    // Progress-free path (MCP tools, sync replay, scripted imports, tests
    // / benches). The Tauri command calls
    // [`import_markdown_with_progress`] with a live channel sink instead.
    import_markdown_with_progress(
        pool,
        device_id,
        materializer,
        app_data_dir,
        content,
        filename,
        space_id,
        vault_files,
        None,
    )
    .await
}

/// Progress-streaming core of [`import_markdown_inner`] (#128).
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
/// Relaxes the original "all-or-nothing for the whole file" contract
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
// #1934 — declare identifying span fields up front so the import span can be
// filtered/grouped in logs by page title, target space, and size. `content`,
// `progress`, and the heavy handles are `skip`-ped; `space_id` is recorded
// here (it is an arg) while `page_title` / `blocks_total` are derived inside
// and back-filled via `Span::current().record(...)` once known.
#[instrument(
    skip(pool, device_id, materializer, content, progress, app_data_dir, vault_files),
    fields(page_title = tracing::field::Empty, blocks_total = tracing::field::Empty, space = %space_id),
    err
)]
#[allow(clippy::too_many_arguments)]
pub async fn import_markdown_with_progress(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    app_data_dir: &std::path::Path,
    content: String,
    filename: Option<String>,
    space_id: String,
    // #1925 — referenced sibling files' bytes. `None`/empty ⇒ no attachment
    // ingest (exact pre-#1925 behaviour).
    vault_files: Option<Vec<VaultFile>>,
    progress: Option<&dyn ImportProgressSink>,
) -> Result<ImportResult, AppError> {
    // #1934 — wall-clock measurement of the whole import so duration is
    // observable in the field. Paired with the completion summary log below.
    let started_at = std::time::Instant::now();

    // Normalize ULID to uppercase per AGENTS.md
    // invariant #8. Mirrors `create_page_in_space_inner` so a raw String
    // arg from MCP tools / sync replay / scripted imports can never land
    // a page whose `space` ref disagrees with the case-sensitive
    // `block_properties.value_ref` lookup downstream.
    let space_id = space_id.to_ascii_uppercase();

    let parse_output = import::parse_logseq_markdown(&content);

    // Derive the page title from the filename (#1446 Part B — folder →
    // namespace). The caller may pass either a bare basename (`API.md`) or a
    // relative path within the imported folder/vault (`Project/Backend/API.md`,
    // e.g. a browser `webkitRelativePath`). We strip the `.md` extension and
    // keep the `/`-delimited path AS the namespaced page title, the inverse of
    // the namespaced export (Part A): `Project/Backend/API.md` → page title
    // `Project/Backend/API`. Backslash separators (Windows-authored paths) are
    // normalised to `/` first. Empty path segments (leading/trailing or doubled
    // separators) are dropped so a stray slash never yields a blank namespace.
    let page_title = filename
        .map(|f| folder_path_to_namespace_title(&f))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Imported Page".to_string());

    // #128 — emit `Started` with the parser's block count so the UI can
    // render a determinate progress bar from the first event. Sent before
    // the transaction opens; if the import later fails, the consumer sees
    // no `Complete` and treats it as failed.
    let blocks_total = parse_output.blocks.len() as u64;

    // #1934 — back-fill the identifying span fields now that the page title
    // and block count are known, so every event emitted within this span (and
    // the `err` line on failure) carries them.
    let span = tracing::Span::current();
    span.record("page_title", page_title.as_str());
    span.record("blocks_total", blocks_total);

    // #1932 — start-of-import log line. Until now the entire backend import
    // path emitted nothing on the happy path, leaving a completed/partial
    // import invisible in `agaric.log`. Structured fields (not interpolation)
    // match the codebase logging baseline (e.g. `materializer/consumer.rs`).
    tracing::info!(
        page = %page_title,
        blocks_total,
        space = %space_id,
        parse_warnings = parse_output.warnings.len(),
        "import: starting markdown import"
    );

    if let Some(sink) = progress {
        sink.emit(ImportProgressUpdate::Started {
            page_title: page_title.clone(),
            blocks_total,
        });
    }

    // --- Chunked IMMEDIATE transactions (#662) ---
    // CommandTx couples commit + post-commit dispatch; op
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

    // Validate `space_id` upfront inside the tx,
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

    // Stamp the `space` ref property on the imported
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

    let mut blocks_created: u64 = 0;
    let mut properties_set: u64 = 0;
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
    //
    // #1920 (A7) / #1921 (B1) — batch the property-definition lookup. Pre-fix
    // the loop ran `SELECT value_type FROM property_definitions WHERE key = ?`
    // once PER key, and `set_property_in_tx` then re-queried `value_type,
    // options` for the SAME key a second time. We now fetch every distinct
    // frontmatter key's `(value_type, options)` in ONE `json_each(?1)` query
    // (the exporter's established batched idiom) into a map, drive the loop
    // from it, and pass the pre-fetched declaration straight into
    // `set_property_in_tx_with_declaration` — eliminating BOTH round-trips.
    // A key absent from the map is undeclared (declaration `None`), preserving
    // the missing-key behaviour exactly.
    let frontmatter_decls: HashMap<String, (Option<String>, Option<String>)> = {
        let distinct_keys: std::collections::BTreeSet<&str> = parse_output
            .frontmatter
            .iter()
            .map(|(k, _)| k.as_str())
            .collect();
        if distinct_keys.is_empty() {
            HashMap::new()
        } else {
            let keys: Vec<&str> = distinct_keys.into_iter().collect();
            let keys_json = serde_json::to_string(&keys)?;
            let rows = sqlx::query!(
                r#"SELECT key AS "key!", value_type, options
                   FROM property_definitions
                   WHERE key IN (SELECT value FROM json_each(?1))"#,
                keys_json,
            )
            .fetch_all(&mut **tx)
            .await?;
            rows.into_iter()
                .map(|r| (r.key, (Some(r.value_type), r.options)))
                .collect()
        }
    };

    for (key, value) in &parse_output.frontmatter {
        // Registry-aware coercion: consult the declared `value_type` (from the
        // batched map above) so a `number` / `boolean` / `date` value
        // round-trips into the right typed column instead of always landing as
        // text. `ref`-typed values are special-cased below (the exporter
        // renders refs as the target page's *title*, not its ULID, so we
        // reverse-resolve the title).
        let (value_type, options): (Option<String>, Option<String>) =
            frontmatter_decls.get(key).cloned().unwrap_or((None, None));

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
                if let Some(id) = resolved {
                    (None, None, None, Some(id), None)
                } else {
                    // No same-space page/tag carries this title (it may
                    // live in another space, or not exist). The value type
                    // is declared `ref`, so we cannot persist the raw title
                    // as a `ref` (no live target) NOR as `text` (the typed
                    // def would reject text). Skip this single property with
                    // a warning rather than abort the whole import — the
                    // human-readable title is surfaced in the warning so it
                    // is never silently lost.
                    // #1933 — per-occurrence diagnostic for this lossy skip.
                    tracing::debug!(
                        key = %key,
                        value = %value,
                        "import: frontmatter ref property could not resolve; skipped (#1933)"
                    );
                    warnings.push(format!(
                        "frontmatter ref property '{key}' could not resolve target \
                         '{value}' to a page in this space; skipped"
                    ));
                    continue;
                }
            } else {
                crate::domain::block_ops::typed_property_args_for_registry_value(
                    key,
                    value.clone(),
                    value_type.as_deref(),
                )
            };

        // #1921 (B1) — reuse the declaration already fetched into the batched
        // map instead of letting `set_property_in_tx` re-query it. A key with
        // no `property_definitions` row stays undeclared (`None`), matching the
        // wrapper's behaviour. Frontmatter always sets a value (never a clear),
        // so a declared key carries a real declaration here.
        let declaration =
            value_type
                .clone()
                .map(|vt| crate::domain::block_ops::PropertyDeclaration {
                    value_type: vt,
                    options: options.clone(),
                });
        let (_page_block, prop_op) = crate::domain::block_ops::set_property_in_tx_with_declaration(
            &mut tx,
            device_id,
            page_id.clone(),
            key,
            value_text,
            value_num,
            value_date,
            value_ref,
            value_bool,
            declaration,
        )
        .await?;
        properties_set += 1;
        tx.enqueue_background(prop_op);
    }

    // #1446 Part B — resolve inbound `[[Page Name]]` wiki-links to internal
    // `[[ULID]]` refs, creating any missing target page (create-if-missing).
    // This is a PRE-PASS over the whole parsed document so each distinct name
    // is resolved/created exactly once (a name cited by N blocks creates at
    // most one page), and so the created pages share the FIRST chunk's atomic
    // write alongside the importing page itself (before the block loop opens a
    // new chunk). The resolved `name → ULID` map then drives an in-loop rewrite
    // of each block's content.
    //
    // Resolution mirrors the paste path (#1484) duplicate-title rule, scoped to
    // the import's OWN space (`AND space_id = ?`):
    //   * exactly one same-space page with that title → link to it,
    //   * none                                        → create the page + link,
    //   * more than one (ambiguous)                   → leave plain text.
    // A name we cannot resolve or create is simply absent from the map, so the
    // rewrite leaves its original `[[Name]]` token untouched — nothing is lost.
    let mut resolved_page_links: HashMap<String, String> = HashMap::new();
    for name in collect_inbound_page_link_names(&parse_output.blocks) {
        // Count same-space live pages carrying this exact title. The importing
        // page (created above, in this tx) is visible here, so a self-reference
        // `[[<this page title>]]` resolves to it.
        let matches: Vec<String> = sqlx::query_scalar!(
            r#"SELECT id FROM blocks
               WHERE content = ?
                 AND block_type = 'page'
                 AND deleted_at IS NULL
                 AND space_id = ?
               ORDER BY id ASC
               LIMIT 2"#,
            name,
            space_id,
        )
        .fetch_all(&mut **tx)
        .await?;

        match matches.as_slice() {
            [single] => {
                resolved_page_links.insert(name, single.clone());
            }
            [] => {
                // Create the missing target page inside this chunk's tx, then
                // stamp its `space` ref (mirrors the importing page above), so
                // the new page is a first-class member of the import's space.
                let (new_page, new_page_op) =
                    create_block_in_tx(&mut tx, device_id, "page".into(), name.clone(), None, None)
                        .await?;
                tx.enqueue_background(new_page_op);
                let new_page_id = new_page.id.clone().into_string();
                let (_b, new_space_op) = set_property_in_tx(
                    &mut tx,
                    device_id,
                    new_page_id.clone(),
                    "space",
                    None,
                    None,
                    None,
                    Some(space_id.clone()),
                    None,
                )
                .await?;
                tx.enqueue_background(new_space_op);
                resolved_page_links.insert(name, new_page_id);
            }
            _ => {
                // Ambiguous: two or more pages share this title in the space.
                // Never guess which was meant — leave the token as plain text
                // and surface a non-fatal warning.
                // #1933 — per-occurrence diagnostic for this lossy transform
                // (the `[[Name]]` link is dropped to plain text).
                tracing::debug!(
                    name = %name,
                    "import: ambiguous wiki-link left as plain text (#1933)"
                );
                warnings.push(format!(
                    "wiki-link '[[{name}]]' matches multiple pages in this space; left as plain text"
                ));
            }
        }
    }

    // #1924 / #1950 — resolve inbound inline tags (`#tag` and `#[[Tag With
    // Space]]`) to internal `#[ULID]` refs, creating any missing tag block
    // (resolve-or-create). This mirrors the wiki-link pre-pass above and the
    // frontend paste path (`buildImportRefInternalizers().tag` in
    // `src/stores/page-blocks.ts`): resolve a tag by its NORMALIZED name
    // (`tag_norm::normalize_tag_name` — the engine's tag identity key) else
    // create a new `block_type='tag'` block whose content is the display name,
    // and return its ULID. NO explicit `block_tags` association is written:
    // typing/pasting `#tag` in the editor creates an INLINE ref (materialized
    // into `block_tag_refs` from the `#[ULID]` content by the `CreateBlock`
    // dispatch's `ReindexBlockTagRefs` task — identical to how `[[ULID]]` page
    // links materialize `block_links`), not a `block_tags` row.
    //
    // The pre-pass runs in this (first) chunk's tx so created tags share its
    // atomic write. `resolved_tag_norm` keys on the normalized name so `#Foo`
    // and `#foo` converge to ONE tag; `resolved_tag_tokens` keys on the
    // ORIGINAL token name so the per-block rewrite can map each literal token
    // back to its ULID. A creation failure degrades gracefully: the token is
    // absent from `resolved_tag_tokens`, so the rewrite leaves it literal and a
    // warning is recorded (mirroring the page-link / paste degrade behavior).
    //
    // FRONTMATTER `tags:` is intentionally NOT processed here — converting a
    // frontmatter `tags:` array into tag links is blocked on #1917 typed arrays
    // and is out of scope for #1924/#1950.
    let mut resolved_tag_norm: HashMap<String, String> = HashMap::new();
    let mut resolved_tag_tokens: HashMap<String, String> = HashMap::new();
    // #1990 — snapshot the in-space live tag blocks ONCE, indexed by normalized
    // name → smallest-id winner, instead of re-scanning every in-space tag per
    // token. The loop only CREATES tags (never mutates existing tag content), so
    // a single pre-loop snapshot stays valid; within-pass creations are tracked
    // in `resolved_tag_norm`. SQLite cannot apply `normalize_tag_name`
    // (NFC → Unicode lowercase → NFC) and NOCASE folds only ASCII A–Z, so we
    // fold in Rust here to catch every case-variant the Loro engine (which keys
    // by `normalize_tag_name`) already merges. Tag count is bounded by the
    // user's vocabulary, so the snapshot is cheap.
    let existing_tag_by_norm: HashMap<String, String> = {
        let rows = sqlx::query!(
            r#"SELECT id, content FROM blocks
               WHERE block_type = 'tag'
                 AND deleted_at IS NULL
                 AND content IS NOT NULL
                 AND space_id = ?1
               ORDER BY id ASC"#,
            space_id,
        )
        .fetch_all(&mut **tx)
        .await?;
        let mut map: HashMap<String, String> = HashMap::new();
        for r in rows {
            if let Some(c) = r.content {
                // `or_insert` keeps the FIRST (smallest-id, since ORDER BY id
                // ASC) row per normalized name — the tags-cache winner.
                map.entry(crate::tag_norm::normalize_tag_name(&c))
                    .or_insert(r.id);
            }
        }
        map
    };
    for token_name in collect_inbound_tag_names(&parse_output.blocks) {
        let norm = crate::tag_norm::normalize_tag_name(&token_name);

        // Already resolved/created in this pass (case/dedup convergence).
        if let Some(ulid) = resolved_tag_norm.get(&norm) {
            resolved_tag_tokens.insert(token_name, ulid.clone());
            continue;
        }

        // Reuse an EXISTING in-space tag whose normalized name matches, from the
        // pre-loop snapshot (smallest-id winner, mirroring the tags-cache). Tags
        // are space-scoped: a same-name tag in ANOTHER space must NOT be reused —
        // the cross-space gate in `reindex_block_tag_refs` would then drop the
        // inline `#[ULID]` ref and silently fail to attach — so the snapshot is
        // already filtered to `space_id`, and a new in-space tag is created
        // below when there is no match.
        if let Some(id) = existing_tag_by_norm.get(&norm) {
            resolved_tag_norm.insert(norm, id.clone());
            resolved_tag_tokens.insert(token_name, id.clone());
            continue;
        }

        // Create the missing tag block inside this chunk's tx. On failure,
        // degrade: warn and leave the token literal (it is simply absent from
        // `resolved_tag_tokens`).
        match create_block_in_tx(
            &mut tx,
            device_id,
            "tag".into(),
            token_name.clone(),
            None,
            None,
        )
        .await
        {
            Ok((new_tag, new_tag_op)) => {
                tx.enqueue_background(new_tag_op);
                let new_tag_id = new_tag.id.clone().into_string();
                // Stamp the tag's `space` ref (mirrors the importing page + new
                // wiki-link pages). Tags are space-scoped (Path A): without this
                // the new tag resolves to NO space, and the cross-space gate in
                // `reindex_block_tag_refs` would drop the inline `#[ULID]` ref
                // (the source content block IS space-scoped, so `tag_space NULL
                // != source_space` excludes it). Stamping keeps the inline ref
                // materializing into `block_tag_refs`.
                let (_b, tag_space_op) = set_property_in_tx(
                    &mut tx,
                    device_id,
                    new_tag_id.clone(),
                    "space",
                    None,
                    None,
                    None,
                    Some(space_id.clone()),
                    None,
                )
                .await?;
                tx.enqueue_background(tag_space_op);
                resolved_tag_norm.insert(norm, new_tag_id.clone());
                resolved_tag_tokens.insert(token_name, new_tag_id);
            }
            Err(e) => {
                tracing::warn!(
                    name = %token_name,
                    error = %e,
                    "import: tag create failed; leaving token as plain text (#1924)"
                );
                warnings.push(format!(
                    "tag '#{token_name}' could not be created; left as plain text"
                ));
            }
        }
    }

    // #662 — number of blocks written into the *current* chunk's
    // transaction. Reset to 0 each time a chunk is flushed. A new chunk is
    // only opened at a top-level (depth-0) subtree boundary, so a chunk
    // never splits a subtree (parent + all descendants commit together).
    let mut chunk_blocks: usize = 0;
    // #1925 — attachment refs detected per committed content block, collected
    // DURING the block loop but ingested AFTER the import writer tx fully
    // commits (see the post-commit phase below). Each entry is (block_id,
    // detected refs in that block's content). The block content is written with
    // its ORIGINAL refs here; the post-commit phase ingests the matched bytes
    // and edits the block content to the canonical `attachment:<id>` form. This
    // sequencing is what avoids the deadlock: `add_attachment_with_bytes_inner`
    // is pool-based and opens its OWN writer tx, which would deadlock against
    // the held `import_markdown` IMMEDIATE tx — so NO attachment ingest runs
    // while any import chunk tx is open. `vault_files` empty/None ⇒ this stays
    // empty and the whole phase is a no-op.
    let vault_files: Vec<VaultFile> = vault_files.unwrap_or_default();
    let mut pending_attachments: Vec<(String, Vec<import::AttachmentRef>)> = Vec::new();
    // #1932 (OBS-LOG-05) — count committed chunks so a partial import (a
    // mid-chunk abort) leaves a log trail of how many chunks/blocks were
    // already made durable before the failure, rather than a lone error line.
    let mut chunks_committed: u64 = 0;

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
            //
            // #1934 — attach import context to a chunk-commit failure via an
            // `error!` log (which chunk / how many blocks were durable when the
            // abort happened), instead of a bare `Database error: …`. The error
            // itself is routed through `AppError::from(sqlx::Error)` so the IPC
            // `kind` discrimination is preserved (a writer-busy `PoolTimedOut`
            // stays `pool_busy`, a `Conflict` stays `conflict`); flattening to
            // `Internal` would have collapsed every commit failure to one kind
            // and lost the frontend's retry affordance.
            tx.commit_and_dispatch(materializer).await.map_err(|e| {
                tracing::error!(
                    page = %page_title,
                    chunks_committed,
                    blocks_created,
                    error = %e,
                    "import: chunk commit failed; committed chunks remain durable"
                );
                AppError::from(e)
            })?;
            chunks_committed += 1;
            // #1932 (OBS-LOG-05) — per-chunk durability signal so a partial
            // import is observable in the log.
            tracing::debug!(
                page = %page_title,
                chunks_committed,
                blocks_created,
                "import: chunk committed (writer lock released)"
            );
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

        // Create the block inside the current chunk's transaction.
        // #1446 Part B — rewrite inbound `[[Page Name]]` wiki-links to internal
        // `[[ULID]]` refs using the pre-resolved map. Names that were
        // ambiguous / unresolvable (absent from the map) keep their original
        // plain-text token; canonical `[[ULID]]` tokens are left untouched.
        let content = rewrite_inbound_page_links(&block.content, &resolved_page_links);
        // #1924 / #1950 — then rewrite inbound inline tags (`#tag`,
        // `#[[Tag With Space]]`) to `#[ULID]` refs using the pre-resolved
        // token→ULID map. A code block (`is_code`, born inside a ```` ``` ````
        // fence) is SKIPPED entirely so its `#tag`-looking text stays literal;
        // inline-code spans within a non-code block are skipped inside
        // `rewrite_inbound_tags`. The page-link rewrite ran first and leaves a
        // `#[[...]]` token in place (its `#`-prefix guard), so the tag rewrite
        // is the sole owner of that token.
        let content = if block.is_code {
            content
        } else {
            rewrite_inbound_tags(&content, &resolved_tag_tokens)
        };

        // #1925 — detect attachment refs in this block's (already
        // tag/link-rewritten) content, to be ingested + rewritten AFTER the
        // import tx commits. A code block keeps its `![[...]]`/`![](...)` text
        // literal (skipped here, mirroring the inline-tag skip). Detection only
        // runs when the caller supplied vault files; with none it is a no-op.
        let detected_attachment_refs: Vec<import::AttachmentRef> =
            if vault_files.is_empty() || block.is_code {
                Vec::new()
            } else {
                let spans = import::inline_code_spans(&content);
                import::detect_attachment_refs(&content, &spans)
            };

        // #1918 — a SINGLE problematic block must degrade gracefully
        // (skip-and-warn) rather than `?`-abort the whole chunk/import. Two
        // RECOVERABLE per-block validation conditions are skipped here:
        //
        //   1. The block would exceed `MAX_BLOCK_DEPTH` (a deeply-nested import
        //      block whose absolute depth lands over the create-path bound —
        //      the depth clamp now leaves page-root headroom, but a residual
        //      over-deep block must still skip, not abort).
        //   2. The block's content exceeds `MAX_CONTENT_LENGTH` (a single huge
        //      block must not strand the rest of the import).
        //
        // Both conditions are surfaced by `create_block_in_tx` as
        // `AppError::Validation` with a STABLE message, AND both checks run
        // BEFORE any write inside `create_block_in_tx`, so on rejection the
        // chunk transaction is still clean and we can keep importing. We match
        // ONLY those two specific validation messages: every other error
        // (`AppError::Database` / pool / connection / a NotFound parent / any
        // other Validation) STILL propagates via the `?` below and aborts as
        // before — this is not a blanket catch-all.
        let create_result = create_block_in_tx(
            &mut tx,
            device_id,
            "content".into(),
            content,
            Some(parent_id.clone()),
            None,
        )
        .await;
        let (new_block, block_op) = match create_result {
            Ok(pair) => pair,
            Err(AppError::Validation(msg))
                if msg.contains("maximum nesting depth")
                    || (msg.contains("content length") && msg.contains("exceeds maximum")) =>
            {
                // Recoverable: skip just this block, warn, and keep the chunk
                // open. The parent stack is NOT pushed, so any children of the
                // skipped block re-parent onto the nearest surviving ancestor
                // (matching the depth-clamp flattening semantics).
                tracing::warn!(
                    page = %page_title,
                    depth = block.depth,
                    reason = %msg,
                    "import: skipping block that failed a recoverable validation check (#1918)"
                );
                warnings.push(format!(
                    "1 block skipped during import (recoverable validation failure: {msg})"
                ));
                continue;
            }
            Err(e) => return Err(e),
        };
        blocks_created += 1;
        chunk_blocks += 1;
        tx.enqueue_background(block_op);
        let new_block_id = new_block.id.clone().into_string();
        parent_stack.push((block.depth, new_block_id.clone()));

        // #1925 — record this block's detected attachment refs against its now
        // committed-pending id. Ingested + rewritten in the post-commit phase.
        if !detected_attachment_refs.is_empty() {
            pending_attachments.push((new_block_id, detected_attachment_refs));
        }

        // #128 — per-block progress tick. Emitted inside the loop so a
        // large file shows forward motion; the rows are not yet committed
        // (the `Complete` event after `commit_and_dispatch` is the
        // durability signal).
        if let Some(sink) = progress {
            sink.emit(ImportProgressUpdate::Progress {
                blocks_done: blocks_created,
                blocks_total,
            });
        }

        // Set properties inside the same chunk transaction as their
        // owning block — a block and its properties are never split across
        // a chunk boundary (properties are emitted immediately after the
        // block create, before the next depth-0 flush check).
        //
        // #1921 — body-block properties INTENTIONALLY do NOT share the
        // frontmatter declaration map: they use the string-value coercion
        // (`typed_property_args_for_string_value`, not the registry-aware
        // variant) and their key set is unbounded across all imported blocks,
        // so they keep using the `set_property_in_tx` wrapper (one declaration
        // fetch per write). Only the bounded, registry-coerced FRONTMATTER keys
        // are pre-fetched and reused above.
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
    //
    // #1934 — attach import context to a final-commit failure via an `error!`
    // log (block count / chunks already durable). The error is routed through
    // `AppError::from(sqlx::Error)` so the IPC `kind` is preserved (e.g. a
    // writer-busy `PoolTimedOut` stays `pool_busy`); flattening to `Internal`
    // would have collapsed the discrimination the frontend relies on.
    tx.commit_and_dispatch(materializer).await.map_err(|e| {
        tracing::error!(
            page = %page_title,
            chunks_committed,
            blocks_created,
            error = %e,
            "import: final chunk commit failed"
        );
        AppError::from(e)
    })?;

    // #1925 — attachment ingest + content rewrite phase. Runs HERE, AFTER the
    // import writer tx has fully committed and released the writer lock, so it
    // never overlaps the held IMMEDIATE tx. `add_attachment_with_bytes_inner`
    // and `edit_block_inner` are both pool-based (each opens its OWN
    // `BEGIN IMMEDIATE` tx); running them inside the import tx would deadlock on
    // the single SQLite writer lock — sequencing them strictly after the final
    // commit is what makes this safe.
    //
    // OWNERSHIP: each attachment is owned by the CONTENT block it appears in
    // (the block's `block_id` FK), matching editor semantics — an attachment's
    // lifecycle follows its owning block (delete the block, the attachment GCs).
    // The block already exists + is committed (durable) by the time we ingest,
    // so the FK is satisfied and the rewrite is a normal `edit_block_inner`.
    //
    // DEDUP: ingest a FRESH attachment per owning block (matching the editor's
    // `add_attachment_inner`, which does not dedup). The ONLY dedup here is
    // within a single block: the same `original_ref` appearing multiple times
    // in ONE block ingests once and both rewrites share that id — safe because
    // the duplicates share the same owning block and thus the same CASCADE
    // lifetime. Cross-page/cross-block asset dedup is intentionally DEFERRED:
    // it needs attachment refcounting/GC the schema lacks (`attachments.block_id`
    // is `ON DELETE CASCADE` and not space-scoped, so reusing one row across
    // blocks would dangle peers when the owner block is deleted, and cross-space
    // peers would never receive the `AddAttachment` op). Tracked separately.
    //
    // Warnings (not-found, oversized, disallowed mime, ingest failure, and any
    // transient DB read/write error) are pushed to `warnings` and NEVER abort
    // the import — a missing/bad attachment leaves the original ref. This phase
    // runs AFTER the chunked tx commit, so an aborting `?` would turn a durable
    // import into a hard failure and suppress the `Complete` event; every DB
    // op below therefore warn-and-continues instead.
    if !pending_attachments.is_empty() {
        for (block_id, refs) in &pending_attachments {
            // Per-BLOCK cache: original_ref → resolved `attachment:<id>` for
            // refs already ingested for THIS block, so a ref repeated within the
            // SAME block ingests once. NOT carried across blocks.
            let mut block_ingested: HashMap<String, String> = HashMap::new();
            // Per-block ref → canonical-token map for the rewrite below.
            let mut block_rewrites: Vec<(import::AttachmentRef, String)> = Vec::new();

            for att in refs {
                // Already ingested for this block (same original ref string).
                if let Some(attachment_id) = block_ingested.get(&att.original_ref) {
                    block_rewrites.push((att.clone(), attachment_id.clone()));
                    continue;
                }

                // Match the ref against the supplied vault files.
                let Some((idx, ambiguous)) =
                    import::match_vault_file(&att.original_ref, &vault_files)
                else {
                    warnings.push(format!(
                        "referenced attachment '{}' was not found among the imported \
                         vault files; left as-is",
                        att.original_ref
                    ));
                    continue;
                };
                if ambiguous {
                    warnings.push(format!(
                        "attachment ref '{}' matched multiple vault files by basename; \
                         used the first match",
                        att.original_ref
                    ));
                }
                let vf = &vault_files[idx];
                let filename = vf
                    .path
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or(&vf.path)
                    .to_string();
                let mime_type = import::guess_attachment_mime(&vf.path);

                // Size guard (mirrors the attachment ingest's 50 MB limit). On
                // an oversized file: warn + skip (leave the original ref).
                // `i64::try_from` avoids the `usize as i64` wrap; a length that
                // doesn't fit i64 is by definition over the limit.
                let size_bytes = i64::try_from(vf.bytes.len()).unwrap_or(i64::MAX);
                if size_bytes > crate::commands::MAX_ATTACHMENT_SIZE {
                    warnings.push(format!(
                        "attachment '{}' ({} bytes) exceeds the maximum size; skipped",
                        att.original_ref,
                        vf.bytes.len()
                    ));
                    continue;
                }

                // Fresh ingest, owned by this content block. A failure
                // (disallowed mime, write error, transient DB error, etc.)
                // degrades to warn+skip so a single bad asset never fails the
                // (already durable) import.
                let attachment_id =
                    match crate::commands::attachments::add_attachment_with_bytes_inner(
                        pool,
                        device_id,
                        materializer,
                        app_data_dir,
                        BlockId::from_trusted(block_id),
                        filename,
                        mime_type,
                        vf.bytes.clone(),
                    )
                    .await
                    {
                        Ok(row) => row.id.into_string(),
                        Err(e) => {
                            tracing::warn!(
                                reference = %att.original_ref,
                                error = %e,
                                "import: attachment ingest failed; leaving original ref (#1925)"
                            );
                            warnings.push(format!(
                                "attachment '{}' could not be imported ({e}); left as-is",
                                att.original_ref
                            ));
                            continue;
                        }
                    };

                block_ingested.insert(att.original_ref.clone(), attachment_id.clone());
                block_rewrites.push((att.clone(), attachment_id));
            }

            if block_rewrites.is_empty() {
                continue;
            }

            // Rewrite this block's content: each matched ref's full token
            // (`![[file]]` / `![alt](path)`) → canonical `![alt](attachment:<id>)`,
            // preserving the original alt text. Fetch the CURRENT content (it is
            // the durable, tag/link-rewritten version) and replace tokens in it.
            // A transient DB read error here must NOT abort the (already
            // durable) import — warn + skip the rewrite instead of `?`.
            let current: Option<String> = match sqlx::query_scalar!(
                "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL",
                block_id,
            )
            .fetch_optional(pool)
            .await
            {
                Ok(row) => row.flatten(),
                Err(e) => {
                    tracing::warn!(
                        block_id = %block_id,
                        error = %e,
                        "import: attachment-ref content re-fetch failed (#1925)"
                    );
                    warnings.push(format!(
                        "block '{block_id}' attachment refs could not be rewritten \
                         (content re-fetch failed: {e})"
                    ));
                    continue;
                }
            };
            let Some(mut new_content) = current else {
                // Block vanished (concurrent delete) — nothing to rewrite.
                continue;
            };
            for (att, attachment_id) in &block_rewrites {
                let canonical = format!("![{}](attachment:{})", att.alt, attachment_id);
                new_content = new_content.replacen(&att.full_match, &canonical, 1);
            }

            // Edit via the normal in-tx content-update path (opens its own
            // writer tx — safe now the import tx is committed). A rewrite
            // failure degrades to warn rather than aborting the (already
            // durable) import.
            if let Err(e) = crate::commands::blocks::crud::edit_block_inner(
                pool,
                device_id,
                materializer,
                BlockId::from_trusted(block_id),
                new_content,
            )
            .await
            {
                tracing::warn!(
                    block_id = %block_id,
                    error = %e,
                    "import: attachment-ref content rewrite failed (#1925)"
                );
                warnings.push(format!(
                    "block '{block_id}' attachment refs could not be rewritten ({e})"
                ));
            }
        }
    }

    // #128 — `Complete` is emitted only after the final chunk commits, so
    // a consumer can treat it as the "whole import is durable" signal.
    // Mirrors the returned `ImportResult` counts.
    if let Some(sink) = progress {
        sink.emit(ImportProgressUpdate::Complete {
            page_title: page_title.clone(),
            blocks_created,
            properties_set,
        });
    }

    // #1932 (OBS-LOG-02) — log every collected diagnostic at WARN. Until now
    // warnings lived only in the returned struct (frontend toast), so once the
    // import dialog was dismissed there was no record that, e.g., blocks were
    // flattened or a property/block-ref was dropped. Logging them makes every
    // silently-skipped item recoverable from `agaric.log`.
    if !warnings.is_empty() {
        tracing::warn!(
            page = %page_title,
            count = warnings.len(),
            warnings = ?warnings,
            "import produced parse/apply diagnostics"
        );
    }

    // #1932 / #1934 — completion summary line with the final counts and the
    // measured elapsed time, so a completed import is no longer invisible in
    // logs and its duration/size are observable in the field.
    let elapsed_ms = started_at.elapsed().as_millis();
    tracing::info!(
        page = %page_title,
        blocks_created,
        properties_set,
        warnings = warnings.len(),
        chunks_committed = chunks_committed + 1,
        elapsed_ms,
        "import: completed markdown import"
    );

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
/// `space_id` is required. The imported page is
/// stamped with `space = ?space_id` inside the same transaction as the
/// `CreateBlock` op, so an imported page can never exist in the op log
/// Without its space property (invariant). Validation against a
/// live space block happens TOCTOU-safe inside the same transaction.
///
/// #128 — `progress` streams per-block import
/// progress to the frontend. The frontend always supplies a
/// `Channel<ImportProgressUpdate>` (mirroring `start_sync`); sends are
/// best-effort, so a dropped channel never aborts the import.
#[tauri::command]
#[specta::specta]
pub async fn import_markdown(
    app: tauri::AppHandle,
    content: String,
    filename: Option<String>,
    space_id: String,
    // #1925 — referenced vault files' bytes. `None`/omitted ⇒ no attachment
    // ingest (the pre-#1925 behaviour). PR 2 wires the frontend picker to
    // pre-scan + supply only the referenced siblings.
    vault_files: Option<Vec<VaultFile>>,
    progress: tauri::ipc::Channel<ImportProgressUpdate>,
    ctx: State<'_, WriteCtx>,
) -> Result<ImportResult, AppError> {
    use tauri::Manager;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    import_markdown_with_progress(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        &app_data_dir,
        content,
        filename,
        space_id,
        vault_files,
        Some(&progress),
    )
    .await
    .map_err(sanitize_internal_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #1920 — cross-language parity fixture for the inbound wiki-link regex.
    /// `HUMAN_PAGE_LINK_RE` (the CANONICAL Rust source) must match these exact
    /// boundaries; the TS mirror `HUMAN_PAGE_LINK_RE` in
    /// `src/lib/block-clipboard.ts` is pinned to the SAME fixture by
    /// `src/lib/__tests__/page-link-re-parity.test.ts`. Keep the two in sync:
    /// any change here must be mirrored there (and in both regexes).
    ///
    /// Each case is `(input, expected_inner_captures)` — the run of group-1
    /// (inner-name) matches the regex produces, in order.
    #[test]
    fn page_link_re_parity_boundaries_1920() {
        let cases: &[(&str, &[&str])] = &[
            ("[[A]]", &["A"]),
            ("[[A B]]", &["A B"]),
            ("[[A]] text [[B]]", &["A", "B"]),
            // Non-greedy: `[[a[[b]]` → the first `]]` closes the match opened at
            // the LAST `[[`, so the inner capture is `a[[b`.
            ("[[a[[b]]", &["a[[b"]),
            // Empty `[[]]` — the inner is `[^\]\n]+?` (one-or-more), so an empty
            // body does NOT match.
            ("[[]]", &[]),
            // A newline inside the brackets prevents a match (body excludes
            // `\n`).
            ("[[A\nB]]", &[]),
        ];
        for (input, expected) in cases {
            let got: Vec<String> = HUMAN_PAGE_LINK_RE
                .captures_iter(input)
                .map(|c| c[1].to_string())
                .collect();
            let got_refs: Vec<&str> = got.iter().map(String::as_str).collect();
            assert_eq!(
                got_refs.as_slice(),
                *expected,
                "wiki-link match boundaries for {input:?} must match the TS mirror"
            );
        }
    }

    /// #1950 — the page-link collect/rewrite guard skips a `[[...]]` that is
    /// immediately preceded by `#` (the `#[[Tag]]` multi-word tag form), so it
    /// is neither collected as a page name nor rewritten as a page ref. A plain
    /// `[[...]]` (no `#`) is still collected/rewritten as a page.
    #[test]
    fn page_link_guard_skips_hash_prefixed_brackets_1950() {
        let blocks = vec![import::ParsedBlock {
            content: "a #[[Tag With Space]] and [[Real Page]]".to_string(),
            depth: 0,
            properties: Vec::new(),
            is_code: false,
        }];
        // Only the un-prefixed `[[Real Page]]` is collected as a page name.
        let names = collect_inbound_page_link_names(&blocks);
        assert_eq!(names, vec!["Real Page".to_string()], "got {names:?}");

        // Rewrite: the `#[[Tag With Space]]` token survives untouched; the page
        // link is rewritten to its ULID.
        let mut resolved: HashMap<String, String> = HashMap::new();
        resolved.insert(
            "Real Page".to_string(),
            "01PAGE0000000000000000PAGE".to_string(),
        );
        let out = rewrite_inbound_page_links(&blocks[0].content, &resolved);
        assert_eq!(
            out, "a #[[Tag With Space]] and [[01PAGE0000000000000000PAGE]]",
            "the `#[[...]]` must be left for the tag pass; got {out:?}"
        );
    }

    /// #1924 — `collect_inbound_tag_names` gathers both bare and multi-word
    /// tags, skips `is_code` blocks entirely, skips inline-code spans, ignores
    /// `# heading`, and never collects a canonical `#[ULID]` ref.
    #[test]
    fn collect_inbound_tag_names_covers_forms_and_skips_1924() {
        let ulid = "01TAG00000000000000000TAG0";
        let blocks = vec![
            import::ParsedBlock {
                content: format!(
                    "see #projectx and #[[my tag]] not # heading nor `#incode` nor #[{ulid}]"
                ),
                depth: 0,
                properties: Vec::new(),
                is_code: false,
            },
            import::ParsedBlock {
                content: "fenced #shouldskip".to_string(),
                depth: 0,
                properties: Vec::new(),
                is_code: true,
            },
        ];
        let names = collect_inbound_tag_names(&blocks);
        assert_eq!(
            names,
            vec!["my tag".to_string(), "projectx".to_string()],
            "bare + multi-word collected; heading/inline-code/canonical/code-block skipped; \
             got {names:?}"
        );
    }

    /// #1924 — `rewrite_inbound_tags` rewrites resolved tokens to `#[ULID]`,
    /// leaves unresolved tokens literal, and never touches a `#[ULID]` already
    /// present.
    #[test]
    fn rewrite_inbound_tags_rewrites_and_degrades_1924() {
        let mut resolved: HashMap<String, String> = HashMap::new();
        resolved.insert(
            "known".to_string(),
            "01KNOWN000000000000000TAG0".to_string(),
        );
        resolved.insert(
            "my tag".to_string(),
            "01MULTI000000000000000TAG0".to_string(),
        );
        let out = rewrite_inbound_tags("a #known b #[[my tag]] c #unknown d", &resolved);
        assert_eq!(
            out, "a #[01KNOWN000000000000000TAG0] b #[01MULTI000000000000000TAG0] c #unknown d",
            "resolved tokens rewrite; unknown stays literal; got {out:?}"
        );
    }

    /// #1921 — a block with no `[[` is returned UNCHANGED by
    /// `rewrite_inbound_page_links` (the fast path), with no allocation-visible
    /// difference in the result.
    #[test]
    fn rewrite_inbound_page_links_fast_path_returns_unchanged_1921() {
        let resolved: HashMap<String, String> = HashMap::new();
        let content = "a plain block with no wiki link, just #tag-ish text";
        assert_eq!(
            rewrite_inbound_page_links(content, &resolved),
            content,
            "a link-free block must be returned unchanged"
        );
        // And a block WITH a link still rewrites via the resolved map.
        let mut resolved2: HashMap<String, String> = HashMap::new();
        resolved2.insert("Target".to_string(), "01ABC".to_string());
        assert_eq!(
            rewrite_inbound_page_links("see [[Target]] here", &resolved2),
            "see [[01ABC]] here",
            "a resolved name must be rewritten to its ULID ref"
        );
    }
}
