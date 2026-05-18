//! PEND-55 — toggle row pipeline for `Aa` / `Ab|` / `.*` search modes.
//!
//! Sits between [`crate::commands::search_blocks_inner`] and the two
//! candidate-set sources (FTS5 for the literal/whole-word/case-sensitive
//! path; recency-ordered SQL scan for the regex path). The default
//! (all-toggles-off) value short-circuits to today's
//! [`super::search::search_fts`] result — zero overhead.
//!
//! ## Pipeline shape
//!
//! ```text
//!                    ┌────────────────────────────────────┐
//!                    │ search_blocks_inner (queries.rs)   │
//!                    └─────────────┬──────────────────────┘
//!                                  │ SearchToggles
//!                       ┌──────────┴──────────────┐
//!                       │ search_with_toggles     │
//!                       └──┬───────────────────┬──┘
//!                          │                   │
//!                  off ────┘                   └──── any toggle on
//!                          │                   │
//!                          ▼                   ▼
//!                  search_fts (FTS5)   compose_post_filter
//!                          │                   │
//!                          └────────┬──────────┘
//!                                   ▼
//!                          post_filter_results
//!                          (offsets + caps)
//! ```
//!
//! ## Caps (all locked-in via constants)
//!
//! - [`MAX_PATTERN_LEN`] — reject patterns > 1 KiB up front before
//!   handing the string to `regex::RegexBuilder` so a degenerate
//!   client can't trigger megabyte-scale parser work.
//! - [`REGEX_SIZE_LIMIT_BYTES`] — handed to
//!   `RegexBuilder::size_limit`; matches the plan's
//!   `10 * 1024 * 1024` recommendation and bounds compiled-DFA memory.
//! - [`REGEX_DFA_SIZE_LIMIT_BYTES`] — bounds the lazy-DFA cache.
//! - [`MAX_OFFSETS_PER_BLOCK`] — caps the per-row offset vector so
//!   `.` against a long block doesn't balloon the IPC payload.
//! - [`REGEX_PRE_FILTER_CAP`] — bounds the regex-mode pre-filter
//!   row count so a worst-case scan stays sub-second on personal-
//!   notes-scale corpora.
//!
//! ## UTF-16 offset emission
//!
//! Rust string slicing uses byte indices; JavaScript indexes UTF-16
//! code units. Emit UTF-16 offsets so the frontend can splice
//! `row.content.substring(start, end)` against the same string it
//! rendered. See [`byte_to_utf16_offsets`].

use crate::commands::{MatchOffset, SearchBlockRow};
use crate::error::AppError;
use crate::pagination::{PageRequest, PageResponse};
use regex::{Regex, RegexBuilder};
use sqlx::SqlitePool;

use super::metadata_filter::MetadataPredicates;

/// Bundle of the three PEND-55 search toggles.
///
/// The all-false value reproduces the pre-PEND-55 FTS-only behaviour
/// (zero overhead — `search_with_toggles` short-circuits before
/// invoking the post-filter).
#[derive(Debug, Clone, Copy, Default)]
pub struct SearchToggles {
    /// PEND-55 — case-sensitive post-filter (FTS5 trigram tokenizer is
    /// `case_sensitive 0`, so this always forces the regex pass).
    pub case_sensitive: bool,
    /// PEND-55 — ASCII whole-word boundary via `(?-u:\b)`. CJK runs
    /// don't match `\b`; documented as v1 behaviour.
    pub whole_word: bool,
    /// PEND-55 — regex-mode. FTS5 MATCH is bypassed; candidates come
    /// from a recency-ordered SQL scan capped at
    /// [`REGEX_PRE_FILTER_CAP`].
    pub is_regex: bool,
}

impl SearchToggles {
    /// `true` iff any toggle is on. Used to gate the post-filter cost.
    #[must_use]
    pub fn any(&self) -> bool {
        self.case_sensitive || self.whole_word || self.is_regex
    }
}

/// Maximum length of the user-supplied regex pattern (in bytes).
///
/// Rejected up-front before invoking `RegexBuilder` so a pathological
/// client cannot force the parser to walk a megabyte-scale input. 1 KiB
/// is well above realistic hand-written patterns (the longest VS Code
/// preset regex is < 200 bytes).
pub const MAX_PATTERN_LEN: usize = 1024;

/// `RegexBuilder::size_limit` cap. Plan recommendation: `10 * 1024 *
/// 1024`. Caps the compiled regex's in-memory representation so a
/// repetition like `(a|b|c|...){200}` fails compilation instead of
/// allocating gigabytes.
pub const REGEX_SIZE_LIMIT_BYTES: usize = 10 * 1024 * 1024;

/// `RegexBuilder::dfa_size_limit` cap. Matches `size_limit`; the
/// lazy-DFA cache occupies a comparable budget at runtime.
pub const REGEX_DFA_SIZE_LIMIT_BYTES: usize = 10 * 1024 * 1024;

/// Maximum number of per-row match offsets emitted on the wire.
///
/// Prevents `.` against a long block from emitting thousands of
/// offsets and ballooning the IPC payload. Trailing matches are
/// dropped; the frontend documents this as "highlights truncated".
pub const MAX_OFFSETS_PER_BLOCK: usize = 50;

/// Pre-filter cap for the regex-mode SQL scan. Bounds the worst-case
/// wall-time of a regex that doesn't have a literal seed.
///
/// `10 * MAX_SEARCH_RESULTS` so the post-cap can still fill a page of
/// 100 results from a dense match. Document in `docs/SEARCH.md`.
pub const REGEX_PRE_FILTER_CAP: i64 = 1000;

/// Public entry-point. Dispatches between the FTS5 path
/// (`super::search::search_fts`) and the regex-mode path
/// ([`regex_mode_query`]) based on `toggles.is_regex`, then applies
/// the post-FTS filter when any non-regex toggle is on.
#[allow(clippy::too_many_arguments)]
pub async fn search_with_toggles(
    pool: &SqlitePool,
    query: &str,
    page: &PageRequest,
    parent_id: Option<&str>,
    tag_ids: Option<&[String]>,
    space_id: Option<&str>,
    include_page_globs: &[String],
    exclude_page_globs: &[String],
    toggles: SearchToggles,
    block_type_filter: Option<&str>,
    metadata: &MetadataPredicates,
) -> Result<PageResponse<SearchBlockRow>, AppError> {
    if toggles.is_regex {
        // Regex-mode bypasses FTS entirely — empty query short-circuits
        // here to avoid compiling an empty pattern (which would match
        // every row).
        if query.trim().is_empty() {
            return Ok(PageResponse {
                items: vec![],
                next_cursor: None,
                has_more: false,
                total_count: None,
            });
        }
        let mut response = regex_mode_query(
            pool,
            query,
            page,
            parent_id,
            tag_ids,
            space_id,
            include_page_globs,
            exclude_page_globs,
            toggles,
            metadata,
        )
        .await?;
        // PEND-51 — `block_type_filter` post-narrow for the regex path.
        // The regex SQL scan doesn't push the filter into the WHERE
        // clause (it's a hot path; keep the SQL stable), so we trim
        // the candidate rows here. The cap above (`REGEX_PRE_FILTER_CAP`)
        // already bounds the worst-case size of `response.items`.
        if let Some(bt) = block_type_filter {
            response.items.retain(|row| row.block_type == bt);
        }
        return Ok(response);
    }

    // FTS5 candidate set (today's path).
    let mut response = super::search::search_fts(
        pool,
        query,
        page,
        parent_id,
        tag_ids,
        space_id,
        include_page_globs,
        exclude_page_globs,
        block_type_filter,
        metadata,
    )
    .await?;

    if !toggles.any() {
        // All toggles off → return the FTS path verbatim (zero overhead).
        return Ok(response);
    }

    // `case_sensitive` and/or `whole_word` on → compile a post-filter
    // regex from the literal query and narrow the FTS candidate set.
    let pattern = compose_literal_pattern(query, toggles);
    let re = build_regex(&pattern)?;
    apply_post_filter(&mut response.items, &re);
    Ok(response)
}

/// Compose the post-FTS regex pattern for the **non-regex** toggle
/// combinations (i.e. one or both of `case_sensitive` / `whole_word`).
///
/// The user input is escaped via [`regex::escape`] so the FTS-mode
/// path never interprets metacharacters; only the regex-mode path
/// accepts metacharacters verbatim.
fn compose_literal_pattern(query: &str, toggles: SearchToggles) -> String {
    let escaped = regex::escape(query);
    let prefix = if toggles.case_sensitive {
        "(?-i)"
    } else {
        "(?i)"
    };
    if toggles.whole_word {
        // `(?-u:\b)` — explicit ASCII word boundary. CJK content does
        // NOT match (documented v1 limitation).
        format!("{prefix}(?-u:\\b){escaped}(?-u:\\b)")
    } else {
        format!("{prefix}{escaped}")
    }
}

/// Compile a user-supplied regex pattern through the capped
/// [`RegexBuilder`] and map errors onto
/// [`AppError::Validation`] with the typed `InvalidRegex:` prefix.
pub(crate) fn build_regex(pattern: &str) -> Result<Regex, AppError> {
    if pattern.len() > MAX_PATTERN_LEN {
        return Err(AppError::Validation(format!(
            "InvalidRegex: pattern length {} exceeds cap {MAX_PATTERN_LEN}",
            pattern.len()
        )));
    }
    RegexBuilder::new(pattern)
        .size_limit(REGEX_SIZE_LIMIT_BYTES)
        .dfa_size_limit(REGEX_DFA_SIZE_LIMIT_BYTES)
        .build()
        .map_err(|e| AppError::Validation(format!("InvalidRegex: {e}")))
}

/// Apply a compiled regex to the rows in-place — narrows the candidate
/// set to only those rows whose `content` matches, and attaches
/// UTF-16 match offsets.
fn apply_post_filter(rows: &mut Vec<SearchBlockRow>, re: &Regex) {
    rows.retain_mut(|row| {
        let Some(content) = row.content.as_deref() else {
            // No content → cannot match a post-filter regex. Drop.
            return false;
        };
        let byte_matches: Vec<(usize, usize)> = re
            .find_iter(content)
            // Drop zero-width matches — they don't produce a
            // meaningful highlight (locked in by the plan).
            .filter(|m| m.end() > m.start())
            .take(MAX_OFFSETS_PER_BLOCK)
            .map(|m| (m.start(), m.end()))
            .collect();
        if byte_matches.is_empty() {
            return false;
        }
        let utf16 = byte_to_utf16_offsets(content, &byte_matches);
        row.match_offsets = utf16;
        // Clear the FTS snippet — the frontend prefers offsets when
        // present, but clearing the snippet means a pre-PEND-55
        // frontend bundle won't double-render the highlight via two
        // paths.
        row.snippet = None;
        true
    });
}

/// Convert `(byte_start, byte_end)` pairs into UTF-16 code-unit offsets.
///
/// Walks the string once via `char_indices`, building a byte-to-UTF-16
/// table on the fly. ASCII-only content is a no-op (`len_utf16 == 1`,
/// `byte == utf16_index`).
pub(crate) fn byte_to_utf16_offsets(
    text: &str,
    byte_matches: &[(usize, usize)],
) -> Vec<MatchOffset> {
    if byte_matches.is_empty() {
        return Vec::new();
    }
    // Build a `byte_index → utf16_index` map. Sized for the full
    // string length + 1 (end sentinel) so callers can index past the
    // last byte for end positions.
    let mut byte_to_u16: Vec<u32> = Vec::with_capacity(text.len() + 1);
    let mut u16_pos: u32 = 0;
    for (b_idx, c) in text.char_indices() {
        while byte_to_u16.len() <= b_idx {
            byte_to_u16.push(u16_pos);
        }
        // `c.len_utf16()` returns 1 (BMP) or 2 (surrogate pair) — always fits a u32.
        u16_pos = u16_pos.saturating_add(u32::try_from(c.len_utf16()).unwrap_or(0));
    }
    // Final sentinel — end-of-string maps to the total UTF-16 length.
    while byte_to_u16.len() <= text.len() {
        byte_to_u16.push(u16_pos);
    }

    byte_matches
        .iter()
        .map(|&(s, e)| MatchOffset {
            start: byte_to_u16.get(s).copied().unwrap_or(u16_pos),
            end: byte_to_u16.get(e).copied().unwrap_or(u16_pos),
        })
        .collect()
}

/// PEND-55 — regex-mode query path. **Bypasses FTS5 entirely**: FTS5
/// MATCH cannot accept a regex, so we run a recency-ordered SQL scan
/// over the structurally-filtered block set and apply the user's
/// regex post-hoc.
///
/// Wall-time scales with the structurally-filtered block count, not
/// the FTS candidate count. The pre-filter cap
/// ([`REGEX_PRE_FILTER_CAP`]) bounds the worst case.
#[allow(clippy::too_many_arguments)]
async fn regex_mode_query(
    pool: &SqlitePool,
    query: &str,
    page: &PageRequest,
    parent_id: Option<&str>,
    tag_ids: Option<&[String]>,
    space_id: Option<&str>,
    include_page_globs: &[String],
    exclude_page_globs: &[String],
    toggles: SearchToggles,
    metadata: &MetadataPredicates,
) -> Result<PageResponse<SearchBlockRow>, AppError> {
    // Compose the final regex. `case_sensitive` flips the (?i) flag;
    // `whole_word` wraps in `(?-u:\b)`. The user's input is the regex
    // pattern verbatim (NOT escaped).
    let mut pattern = String::with_capacity(query.len() + 16);
    if toggles.case_sensitive {
        pattern.push_str("(?-i)");
    } else {
        pattern.push_str("(?i)");
    }
    if toggles.whole_word {
        pattern.push_str("(?-u:\\b)(?:");
        pattern.push_str(query);
        pattern.push_str(")(?-u:\\b)");
    } else {
        pattern.push_str(query);
    }
    let re = build_regex(&pattern)?;

    // Build a recency-ordered SQL scan with the structural filters
    // applied. We do not use cursor pagination on this path (the
    // candidate set is bounded by `REGEX_PRE_FILTER_CAP`); the
    // `next_cursor` field returns `None`.
    let limit = page.limit.clamp(1, 100);
    let _ = limit; // for future per-page slicing; today's response is single-page

    let mut sql = String::from(
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                  b.deleted_at, b.todo_state, b.priority, b.due_date,
                  b.scheduled_date, b.page_id
           FROM blocks b
           WHERE b.deleted_at IS NULL
             AND b.content IS NOT NULL"#,
    );

    let mut next_param = 1;
    let parent_idx = parent_id.map(|_| {
        let i = next_param;
        sql.push_str(&format!("\n             AND b.parent_id = ?{i}"));
        next_param += 1;
        i
    });

    let tag_ids_active: &[String] = tag_ids.filter(|t| !t.is_empty()).unwrap_or(&[]);
    let tag_start = if !tag_ids_active.is_empty() {
        let start = next_param;
        let placeholders: Vec<String> = (0..tag_ids_active.len())
            .map(|i| format!("?{}", start + i))
            .collect();
        next_param += tag_ids_active.len();
        let count_idx = next_param;
        next_param += 1;
        sql.push_str(&format!(
            "\n             AND (SELECT COUNT(DISTINCT bt.tag_id) FROM block_tags bt WHERE bt.block_id = b.id AND bt.tag_id IN ({})) = ?{count_idx}",
            placeholders.join(", ")
        ));
        Some((start, count_idx))
    } else {
        None
    };

    let space_idx = space_id.map(|_| {
        let i = next_param;
        sql.push_str(&format!(
            "\n             AND b.page_id IN (\
              SELECT bp.block_id FROM block_properties bp \
              WHERE bp.key = 'space' AND bp.value_ref = ?{i})"
        ));
        next_param += 1;
        i
    });

    let include_start = if !include_page_globs.is_empty() {
        let start = next_param;
        let placeholders: Vec<String> = (0..include_page_globs.len())
            .map(|i| format!("LOWER(pc.title) GLOB ?{}", start + i))
            .collect();
        sql.push_str(&format!(
            "\n             AND b.page_id IN (SELECT pc.page_id FROM pages_cache pc WHERE {})",
            placeholders.join(" OR ")
        ));
        next_param += include_page_globs.len();
        Some(start)
    } else {
        None
    };

    let exclude_start = if !exclude_page_globs.is_empty() {
        let start = next_param;
        let placeholders: Vec<String> = (0..exclude_page_globs.len())
            .map(|i| format!("LOWER(pc.title) GLOB ?{}", start + i))
            .collect();
        sql.push_str(&format!(
            "\n             AND b.page_id NOT IN (SELECT pc.page_id FROM pages_cache pc WHERE {})",
            placeholders.join(" OR ")
        ));
        next_param += exclude_page_globs.len();
        Some(start)
    } else {
        None
    };

    // PEND-53 — metadata predicates (same shape as `search_fts`).
    let metadata_binds =
        super::metadata_filter::append_metadata_sql(&mut sql, &mut next_param, metadata, "b");

    let cap_idx = next_param;
    // PEND-55 — ULID prefixes are monotonically time-sortable, so
    // `ORDER BY b.id DESC` yields most-recent-first without a
    // dedicated `created_at` column (the `blocks` table doesn't carry
    // one — see migration `0001_initial.sql`). Document this in
    // `docs/SEARCH.md`'s regex-mode trade-off section.
    sql.push_str(&format!(
        "\n           ORDER BY b.id DESC\n           LIMIT ?{cap_idx}"
    ));

    let _ = (
        parent_idx,
        tag_start,
        space_idx,
        include_start,
        exclude_start,
    );

    let mut db_query = sqlx::query_as::<_, RegexScanRow>(&sql);
    if let Some(pid) = parent_id {
        db_query = db_query.bind(pid);
    }
    for tid in tag_ids_active {
        db_query = db_query.bind(tid);
    }
    if !tag_ids_active.is_empty() {
        let count: i64 = i64::try_from(tag_ids_active.len()).unwrap_or(i64::MAX);
        db_query = db_query.bind(count);
    }
    if let Some(sid) = space_id {
        db_query = db_query.bind(sid);
    }
    for pat in include_page_globs {
        db_query = db_query.bind(pat);
    }
    for pat in exclude_page_globs {
        db_query = db_query.bind(pat);
    }
    // PEND-53 — bind metadata values in declaration order.
    for v in &metadata_binds {
        db_query = db_query.bind(v);
    }
    db_query = db_query.bind(REGEX_PRE_FILTER_CAP);

    let rows = db_query.fetch_all(pool).await.map_err(AppError::Database)?;

    // Run the regex post-filter. Trim to `limit` survivors.
    let limit_usize = usize::try_from(limit).unwrap_or(usize::MAX);
    let mut out: Vec<SearchBlockRow> = Vec::new();
    for r in rows {
        if out.len() >= limit_usize {
            break;
        }
        let Some(ref content) = r.content else {
            continue;
        };
        let byte_matches: Vec<(usize, usize)> = re
            .find_iter(content)
            .filter(|m| m.end() > m.start())
            .take(MAX_OFFSETS_PER_BLOCK)
            .map(|m| (m.start(), m.end()))
            .collect();
        if byte_matches.is_empty() {
            continue;
        }
        let offsets = byte_to_utf16_offsets(content, &byte_matches);
        out.push(SearchBlockRow {
            id: crate::ulid::ActiveBlockId::from_trusted_active(&r.id),
            block_type: r.block_type,
            content: r.content,
            parent_id: r.parent_id,
            position: r.position,
            deleted_at: r.deleted_at,
            todo_state: r.todo_state,
            priority: r.priority,
            due_date: r.due_date,
            scheduled_date: r.scheduled_date,
            page_id: r.page_id,
            snippet: None,
            match_offsets: offsets,
        });
    }

    // Regex-mode never emits a cursor — the candidate set is bounded
    // by `REGEX_PRE_FILTER_CAP`. Document the trade-off in
    // `docs/SEARCH.md`.
    Ok(PageResponse {
        items: out,
        next_cursor: None,
        has_more: false,
        total_count: None,
    })
}

/// Row from the regex-mode SQL scan. No `search_rank` because FTS is
/// bypassed; recency ordering is used instead.
#[derive(Debug, sqlx::FromRow)]
struct RegexScanRow {
    id: String,
    block_type: String,
    content: Option<String>,
    parent_id: Option<String>,
    position: Option<i64>,
    deleted_at: Option<String>,
    todo_state: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
    scheduled_date: Option<String>,
    page_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Unit tests — pure functions (regex compose, UTF-16 conversion)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn toggles_default_is_all_off() {
        let t = SearchToggles::default();
        assert!(!t.any(), "default toggles must report any()==false");
        assert!(!t.case_sensitive);
        assert!(!t.whole_word);
        assert!(!t.is_regex);
    }

    #[test]
    fn compose_literal_pattern_case_sensitive_off_is_case_insensitive_flag() {
        let pat = compose_literal_pattern(
            "Alpha",
            SearchToggles {
                case_sensitive: false,
                whole_word: false,
                is_regex: false,
            },
        );
        assert!(pat.starts_with("(?i)"), "expected (?i) prefix: {pat}");
        assert!(pat.contains("Alpha"));
    }

    #[test]
    fn compose_literal_pattern_case_sensitive_on_emits_negative_flag() {
        let pat = compose_literal_pattern(
            "Alpha",
            SearchToggles {
                case_sensitive: true,
                whole_word: false,
                is_regex: false,
            },
        );
        assert!(pat.starts_with("(?-i)"), "expected (?-i) prefix: {pat}");
    }

    #[test]
    fn compose_literal_pattern_whole_word_wraps_in_ascii_boundary() {
        let pat = compose_literal_pattern(
            "cat",
            SearchToggles {
                case_sensitive: false,
                whole_word: true,
                is_regex: false,
            },
        );
        // ASCII-only boundary via `(?-u:\b)` — documented in the plan.
        assert!(pat.contains("(?-u:\\b)cat(?-u:\\b)"), "got: {pat}");
    }

    #[test]
    fn compose_literal_pattern_escapes_user_regex_metacharacters() {
        // Literal mode must escape `.`, `*`, `[`, etc. — those only
        // become metacharacters when `is_regex=true`.
        let pat = compose_literal_pattern(
            "a.b*c",
            SearchToggles {
                case_sensitive: false,
                whole_word: false,
                is_regex: false,
            },
        );
        assert!(
            pat.contains("a\\.b\\*c"),
            "expected escaped metachars: {pat}"
        );
    }

    #[test]
    fn build_regex_rejects_oversized_pattern() {
        let big = "a".repeat(MAX_PATTERN_LEN + 1);
        match build_regex(&big) {
            Err(AppError::Validation(msg)) => {
                assert!(msg.starts_with("InvalidRegex:"), "msg: {msg}");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn build_regex_surfaces_compile_error_with_prefix() {
        // `*` at the start is invalid in Rust regex.
        match build_regex("*") {
            Err(AppError::Validation(msg)) => {
                assert!(
                    msg.starts_with("InvalidRegex:"),
                    "expected InvalidRegex prefix, got: {msg}"
                );
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    #[test]
    fn byte_to_utf16_offsets_ascii_passthrough() {
        let text = "hello world";
        let offsets = byte_to_utf16_offsets(text, &[(0, 5), (6, 11)]);
        assert_eq!(
            offsets,
            vec![
                MatchOffset { start: 0, end: 5 },
                MatchOffset { start: 6, end: 11 }
            ]
        );
    }

    #[test]
    fn byte_to_utf16_offsets_cjk_single_units() {
        // `日本語` — three CJK chars, each 3 bytes UTF-8 / 1 UTF-16 unit.
        let text = "日本語";
        // Byte offsets for `本`: starts at byte 3, ends at byte 6.
        let offsets = byte_to_utf16_offsets(text, &[(3, 6)]);
        assert_eq!(offsets, vec![MatchOffset { start: 1, end: 2 }]);
    }

    #[test]
    fn byte_to_utf16_offsets_emoji_surrogate_pair() {
        // `🌟` = 4 bytes UTF-8 / 2 UTF-16 code units (surrogate pair).
        // `Hello` starts at byte 4, runs to byte 9.
        let text = "🌟Hello";
        let offsets = byte_to_utf16_offsets(text, &[(4, 9)]);
        assert_eq!(offsets, vec![MatchOffset { start: 2, end: 7 }]);
    }

    #[test]
    fn apply_post_filter_caps_offsets_at_max() {
        // Build a row with `'a' * 100` content; regex `.` matches every
        // char; expect exactly `MAX_OFFSETS_PER_BLOCK` offsets.
        use crate::ulid::ActiveBlockId;
        let mut rows = vec![SearchBlockRow {
            id: ActiveBlockId::from_trusted_active("01HQBLKA00000000000000BKA1"),
            block_type: "content".into(),
            content: Some("a".repeat(100)),
            parent_id: None,
            position: None,
            deleted_at: None,
            todo_state: None,
            priority: None,
            due_date: None,
            scheduled_date: None,
            page_id: None,
            snippet: Some("dropped".into()),
            match_offsets: vec![],
        }];
        let re = build_regex("a").unwrap();
        apply_post_filter(&mut rows, &re);
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].match_offsets.len(),
            MAX_OFFSETS_PER_BLOCK,
            "offsets must be capped at MAX_OFFSETS_PER_BLOCK"
        );
        assert!(
            rows[0].snippet.is_none(),
            "snippet must be cleared when offsets are emitted"
        );
    }

    #[test]
    fn apply_post_filter_drops_rows_with_no_match() {
        use crate::ulid::ActiveBlockId;
        let mut rows = vec![SearchBlockRow {
            id: ActiveBlockId::from_trusted_active("01HQBLKA00000000000000BKA1"),
            block_type: "content".into(),
            content: Some("xyz".into()),
            parent_id: None,
            position: None,
            deleted_at: None,
            todo_state: None,
            priority: None,
            due_date: None,
            scheduled_date: None,
            page_id: None,
            snippet: Some("xyz".into()),
            match_offsets: vec![],
        }];
        let re = build_regex("notpresent").unwrap();
        apply_post_filter(&mut rows, &re);
        assert!(rows.is_empty(), "non-matching rows must be dropped");
    }

    #[test]
    fn apply_post_filter_drops_rows_with_null_content() {
        use crate::ulid::ActiveBlockId;
        let mut rows = vec![SearchBlockRow {
            id: ActiveBlockId::from_trusted_active("01HQBLKA00000000000000BKA1"),
            block_type: "content".into(),
            content: None,
            parent_id: None,
            position: None,
            deleted_at: None,
            todo_state: None,
            priority: None,
            due_date: None,
            scheduled_date: None,
            page_id: None,
            snippet: None,
            match_offsets: vec![],
        }];
        let re = build_regex("anything").unwrap();
        apply_post_filter(&mut rows, &re);
        assert!(rows.is_empty(), "rows with NULL content cannot match");
    }

    #[test]
    fn whole_word_does_not_match_cjk_runs() {
        // Documented v1 limitation: `(?-u:\b)` is ASCII-only. CJK
        // characters aren't ASCII word characters, so `\b会議\b`
        // never asserts a boundary inside a CJK run.
        let pat = compose_literal_pattern(
            "会議",
            SearchToggles {
                case_sensitive: false,
                whole_word: true,
                is_regex: false,
            },
        );
        let re = build_regex(&pat).unwrap();
        // `会議に行く` — no ASCII boundary anywhere; expect zero matches.
        assert!(
            re.find("会議に行く").is_none(),
            "ASCII \\b cannot match inside CJK"
        );
    }
}
