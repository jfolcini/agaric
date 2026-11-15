use sqlx::SqlitePool;

use super::{ActiveBlockRow, Cursor, PageRequest, PageResponse, build_page_response};
use crate::backlink::LinkKind;
use agaric_core::error::AppError;

/// List backlinks — blocks that link *to* `target_id`, paginated.
///
/// Ordered by `bl.source_id ASC` (≡ `b.id`, ULID ≈ chronological).
/// Uses covering index `idx_block_links_target_source(target_id, source_id)`,
/// so the order is index-supplied and no temp B-tree is built (audit #415).
///
/// `space_id` — when `Some`, restricts the result set to
/// source blocks whose owning page (`b.page_id`)
/// Carries `space = ?space_id`. `None` keeps the pre-existing behaviour
/// (no filter). See `crate::space_filter_clause` for the shared SQL
/// fragment definition.
///
/// Returns `ActiveBlockRow` because the SQL filters
/// `b.deleted_at IS NULL` on the source block.
pub async fn list_backlinks(
    pool: &SqlitePool,
    target_id: &str,
    page: &PageRequest,
    space_id: Option<&str>,
) -> Result<PageResponse<ActiveBlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_id): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), &c.id),
        None => (None, ""),
    };

    // ?5 (space_id) drives the shared space-filter clause.
    // The literal mirrors `crate::space_filter_clause!` — kept inline
    // here because `sqlx::query_as!` requires a string literal and does
    // not accept `concat!()`. Mirror any change to the filter SQL
    // across every inlined copy.
    //
    // `id as "id: agaric_core::ulid::ActiveBlockId"` is the
    // sqlx column-cast hint for the typed-id slot on ActiveBlockRow;
    // sqlx::Type for ActiveBlockId is `transparent` over String so the
    // decode is a free wrap.
    let rows = sqlx::query_as!(
        ActiveBlockRow,
        r#"SELECT b.id as "id: agaric_core::ulid::ActiveBlockId", b.block_type, b.content, b.parent_id as "parent_id: agaric_core::ulid::BlockId", b.position,
                b.deleted_at,
                b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id as "page_id: agaric_core::ulid::BlockId"
         FROM block_links bl
         JOIN blocks b ON b.id = bl.source_id
         WHERE bl.target_id = ?1 AND b.deleted_at IS NULL
           AND (?2 IS NULL OR bl.source_id > ?3)
           AND (?5 IS NULL OR b.space_id = ?5)
         ORDER BY bl.source_id ASC
         LIMIT ?4"#,
        target_id,   // ?1
        cursor_flag, // ?2
        cursor_id,   // ?3
        fetch_limit, // ?4
        space_id,    // ?5
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| {
        Cursor::for_id(last.id.as_str().to_string())
    })
}

/// One link a page's block holds: a row of the page's *Outgoing links*
/// section (#6749).
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct OutgoingLinkRow {
    /// The block on the page that holds the link.
    pub source_id: String,
    pub source_content: Option<String>,
    pub target_id: String,
    pub kind: LinkKind,
    /// The page the target lives on, the target itself for a page link.
    /// `None` when the target does not resolve: it is in the trash, purged,
    /// or in another space.
    pub target_page_id: Option<String>,
    pub target_page_title: Option<String>,
}

/// The links held by `page_id`'s live blocks, grouped by the page their
/// target lives on, the unresolved targets last, paginated.
///
/// A link whose target never got an edge (purged, never existed, or in
/// another space when the source was indexed) is in `block_links_unresolved`,
/// not `block_links`, so both are read; that table stores no kind, so it is
/// classified as migration 0119 classifies `block_links`. An edge kept to a
/// target since trashed or moved to another space is unresolved too.
///
/// Ordered by `(unresolved, target page, source_id || target_id)`: the ids
/// are fixed-width ULIDs, so the concatenation orders as the pair does, and
/// the cursor carries the three as `position`, `deleted_at` and `id`.
///
/// # Errors
/// Returns [`AppError`] if the query fails or the cursor cannot be encoded.
pub async fn list_outgoing_links(
    pool: &SqlitePool,
    page_id: &str,
    kind: Option<LinkKind>,
    page: &PageRequest,
    space_id: &str,
) -> Result<PageResponse<OutgoingLinkRow>, AppError> {
    let fetch_limit = page.limit + 1;
    let kind = kind.map(LinkKind::as_str);
    let (after_unresolved, after_group, after_pair) = match page.after.as_ref() {
        Some(c) => (
            c.position,
            c.deleted_at.clone().unwrap_or_default(),
            c.id.clone(),
        ),
        None => (None, String::new(), String::new()),
    };

    let rows = sqlx::query_as!(
        OutgoingLinkRecord,
        r#"WITH edges AS (
             SELECT bl.source_id, s.content AS source_content, bl.target_id, bl.kind
               FROM block_links bl
               JOIN blocks s ON s.id = bl.source_id
              WHERE s.page_id = ?1 AND s.deleted_at IS NULL AND +s.space_id = ?2
             UNION ALL
             SELECT u.source_id, s.content, u.target_id,
                    CASE WHEN instr(s.content, '((' || u.target_id || '))') > 0
                         THEN 'block_ref' ELSE 'page_link' END
               FROM block_links_unresolved u
               JOIN blocks s ON s.id = u.source_id
              WHERE s.page_id = ?1 AND s.deleted_at IS NULL AND +s.space_id = ?2
           ),
           resolved AS (
             SELECT e.source_id, e.source_content, e.target_id, e.kind,
                    CASE WHEN t.deleted_at IS NULL AND t.space_id = ?2
                         THEN COALESCE(t.page_id, t.id) END AS target_page_id
               FROM edges e
               LEFT JOIN blocks t ON t.id = e.target_id
              WHERE ?3 IS NULL OR e.kind = ?3
           ),
           keyed AS (
             SELECT r.*, r.target_page_id IS NULL AS unresolved,
                    COALESCE(r.target_page_id, '') AS group_key,
                    r.source_id || r.target_id AS pair_key
               FROM resolved r
           )
           SELECT k.source_id AS "source_id!", k.source_content, k.target_id AS "target_id!",
                  k.kind AS "kind!: String", k.target_page_id AS "target_page_id?: String",
                  p.content AS target_page_title,
                  k.unresolved AS "unresolved!: i64", k.group_key AS "group_key!: String",
                  k.pair_key AS "pair_key!: String"
             FROM keyed k
             LEFT JOIN blocks p ON p.id = k.target_page_id
            WHERE ?4 IS NULL OR (k.unresolved, k.group_key, k.pair_key) > (?4, ?5, ?6)
            ORDER BY k.unresolved, k.group_key, k.pair_key
            LIMIT ?7"#,
        page_id,          // ?1
        space_id,         // ?2
        kind,             // ?3
        after_unresolved, // ?4
        after_group,      // ?5
        after_pair,       // ?6
        fetch_limit,      // ?7
    )
    .fetch_all(pool)
    .await?;

    outgoing_page(rows, page.limit)
}

/// A row of [`list_outgoing_links`]'s query: the row and its sort keys.
struct OutgoingLinkRecord {
    source_id: String,
    source_content: Option<String>,
    target_id: String,
    kind: String,
    target_page_id: Option<String>,
    target_page_title: Option<String>,
    unresolved: i64,
    group_key: String,
    pair_key: String,
}

/// One page of `records`, fetched one past `limit`, with the cursor of its
/// last row when more follow.
fn outgoing_page(
    mut records: Vec<OutgoingLinkRecord>,
    limit: i64,
) -> Result<PageResponse<OutgoingLinkRow>, AppError> {
    // limit is a validated positive pagination bound; safe to convert
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    let has_more = records.len() > limit;
    records.truncate(limit);
    let next_cursor = match records.last() {
        Some(last) if has_more => Some(
            Cursor {
                id: last.pair_key.clone(),
                position: Some(last.unresolved),
                deleted_at: Some(last.group_key.clone()),
                seq: None,
                rank: None,
            }
            .encode()?,
        ),
        _ => None,
    };
    let items = records
        .into_iter()
        .map(|r| OutgoingLinkRow {
            source_id: r.source_id,
            source_content: r.source_content,
            target_id: r.target_id,
            kind: if r.kind == LinkKind::BlockRef.as_str() {
                LinkKind::BlockRef
            } else {
                LinkKind::PageLink
            },
            target_page_id: r.target_page_id,
            target_page_title: r.target_page_title,
        })
        .collect();
    Ok(PageResponse {
        items,
        next_cursor,
        has_more,
        total_count: None,
    })
}
