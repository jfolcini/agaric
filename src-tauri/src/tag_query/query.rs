//! Public query API: `eval_tag_query`, `list_tags_by_prefix`, `list_tags_for_block`.

use rustc_hash::FxHashSet;
use sqlx::SqlitePool;

use super::resolve::{compile_candidate_subquery, resolve_expr};
use super::{TagCacheRow, TagExpr};
use crate::error::AppError;
use crate::pagination::{ActiveBlockRow, Cursor, PageRequest, PageResponse};
use crate::sql_utils::escape_like;

/// Evaluate a boolean tag expression and return a paginated set of blocks.
///
/// `space_id` (FEAT-3p4) — when `Some`, the final projection restricts
/// results to blocks whose owning page (`b.page_id`)
/// carries `space = ?space_id`. `None` is the unscoped (pre-FEAT-3)
/// behaviour. The space filter is applied at the projection step (after
/// the tag resolver) so the tag expression continues to operate on the
/// full universe and only the visible result set is space-scoped.
///
/// `block_type` (PEND-35 Tier 3.4) — when `Some`, restricts the result
/// set to blocks whose `block_type` equals the supplied value. `None`
/// is the unfiltered (pre-Tier-3.4) behaviour. Pushes GraphView's
/// JS-side `pagesResp.items.filter(p => p.block_type === 'page')`
/// predicate into SQL so the unbounded `limit:5000` over-fetch and
/// post-filter discard collapses into one paginated query.
pub async fn eval_tag_query(
    pool: &SqlitePool,
    expr: &TagExpr,
    page: &PageRequest,
    include_inherited: bool,
    space_id: Option<&str>,
    block_type: Option<&str>,
) -> Result<PageResponse<ActiveBlockRow>, AppError> {
    // #414 — pushed-down fast path for the two LEAF expression kinds.
    // For a single `Tag` / `Prefix` the candidate set is exactly the
    // UNION subquery owned by `resolve_tag_leaves` /
    // `resolve_tag_prefix_leaves`. Computing it as an `IN (<subquery>)`
    // inside SQLite — instead of materialising the FULL `FxHashSet` of
    // every matching id into Rust, serialising it to a multi-hundred-KB
    // JSON string, and re-parsing it via `json_each(?)` on EVERY page —
    // means only one page of rows is ever produced. The subquery is a
    // fixed string literal; `tag_id` / the LIKE pattern are BOUND, so
    // there is no user interpolation. The `And`/`Or`/`Not` variants stay
    // on the existing resolve-then-`json_each` path verbatim.
    let (query_str, candidate_binds): (String, Vec<String>) = match expr {
        TagExpr::Tag(tag_id) => {
            let candidate_clause = tag_leaf_candidate_clause(include_inherited);
            // tag_id is bound once per UNION arm (2 arms non-inherited,
            // 3 arms inherited).
            let arms = if include_inherited { 3 } else { 2 };
            let binds = std::iter::repeat_n(tag_id.clone(), arms).collect();
            (build_projection_sql(candidate_clause), binds)
        }
        TagExpr::Prefix(prefix) => {
            let escaped = format!("{}%", escape_like(prefix));
            let candidate_clause = prefix_leaf_candidate_clause(include_inherited);
            // The LIKE pattern is bound once per UNION arm.
            let arms = if include_inherited { 3 } else { 2 };
            let binds = std::iter::repeat_n(escaped, arms).collect();
            (build_projection_sql(candidate_clause), binds)
        }
        TagExpr::And(_) | TagExpr::Or(_) | TagExpr::Not(_) => {
            // #1597 — reject pathologically deep trees before either the
            // recursive candidate-subquery compiler or `resolve_expr`'s
            // `Box::pin` fan-out walks the (otherwise unbounded) tree,
            // mirroring `FilterExpr::validate_depth`.
            expr.validate_depth()?;
            if expr.depth() <= TagExpr::MAX_PUSHDOWN_DEPTH {
                // #1622 — compile the whole boolean tree to a SINGLE id-set
                // subquery (And→INTERSECT, Or→UNION, Not→`b.id NOT IN
                // (<inner>)` against the non-deleted universe) and push it
                // down as `b.id IN (<subquery>)`. SQLite then applies the
                // cursor/`LIMIT` keyset directly — instead of materialising
                // the FULL `FxHashSet` of every matching id into Rust,
                // serialising it to a multi-hundred-KB JSON string, and
                // re-parsing it via `json_each(?)` on EVERY page (and, for
                // `not`, computing the entire `all-blocks-minus-matched`
                // complement up front). All leaf values are BOUND
                // positionally; there is no interpolation.
                let (subquery, binds) = compile_candidate_subquery(expr, include_inherited);
                (
                    build_projection_sql(&format!("b.id IN ({subquery})")),
                    binds,
                )
            } else {
                // #1622 — fallback for trees deeper than the safe SQL
                // expression-nesting bound (SQLite's
                // `SQLITE_MAX_EXPR_DEPTH = 1000` would otherwise reject the
                // nested subquery). Such trees are pathological and never
                // produced by the real `commands::tags` caller; preserve the
                // legacy materialise-then-`json_each(?)` semantics verbatim
                // so the result stays byte-identical.
                let block_ids: FxHashSet<String> =
                    resolve_expr(pool, expr, include_inherited).await?;
                if block_ids.is_empty() {
                    return Ok(PageResponse {
                        items: vec![],
                        next_cursor: None,
                        has_more: false,
                        total_count: None,
                    });
                }
                let id_vec: Vec<&str> = block_ids.iter().map(String::as_str).collect();
                let json_ids = serde_json::to_string(&id_vec)?;
                (
                    build_projection_sql("b.id IN (SELECT value FROM json_each(?))"),
                    vec![json_ids],
                )
            }
        }
    };

    let projection = ProjectionParams {
        space_id,
        block_type,
        page,
    };
    run_projection(pool, &query_str, projection, &candidate_binds).await
}

/// Parameters shared by every projection (the filters that are identical
/// across the json_each path and the #414 pushed-down leaf path).
struct ProjectionParams<'a> {
    space_id: Option<&'a str>,
    block_type: Option<&'a str>,
    page: &'a PageRequest,
}

/// Candidate-set subquery for a single `TagExpr::Tag` leaf. Mirrors
/// `resolve_tag_leaves` (resolve.rs) EXACTLY: `block_tags` ∪
/// `block_tag_refs` (∪ `block_tag_inherited` when inherited), each arm
/// joining `blocks` and filtering `b.deleted_at IS NULL`. `tag_id` is
/// bound once per arm (caller binds 2 non-inherited / 3 inherited).
fn tag_leaf_candidate_clause(include_inherited: bool) -> &'static str {
    if include_inherited {
        "b.id IN ( \
            SELECT bt.block_id \
            FROM block_tags bt JOIN blocks b ON b.id = bt.block_id \
            WHERE bt.tag_id = ? AND b.deleted_at IS NULL \
            UNION \
            SELECT btr.source_id \
            FROM block_tag_refs btr JOIN blocks b ON b.id = btr.source_id \
            WHERE btr.tag_id = ? AND b.deleted_at IS NULL \
            UNION \
            SELECT bti.block_id \
            FROM block_tag_inherited bti JOIN blocks b ON b.id = bti.block_id \
            WHERE bti.tag_id = ? AND b.deleted_at IS NULL)"
    } else {
        "b.id IN ( \
            SELECT bt.block_id \
            FROM block_tags bt JOIN blocks b ON b.id = bt.block_id \
            WHERE bt.tag_id = ? AND b.deleted_at IS NULL \
            UNION \
            SELECT btr.source_id \
            FROM block_tag_refs btr JOIN blocks b ON b.id = btr.source_id \
            WHERE btr.tag_id = ? AND b.deleted_at IS NULL)"
    }
}

/// Candidate-set subquery for a single `TagExpr::Prefix` leaf. Mirrors
/// `resolve_tag_prefix_leaves` (resolve.rs) EXACTLY: same UNION shape as
/// the tag leaf but joining `tags_cache tc` with
/// `tc.name LIKE ? ESCAPE '\'` and `SELECT DISTINCT`. The LIKE pattern
/// is bound once per arm (caller binds 2 non-inherited / 3 inherited).
fn prefix_leaf_candidate_clause(include_inherited: bool) -> &'static str {
    if include_inherited {
        "b.id IN ( \
            SELECT DISTINCT bt.block_id \
            FROM tags_cache tc \
            JOIN block_tags bt ON bt.tag_id = tc.tag_id \
            JOIN blocks b ON b.id = bt.block_id \
            WHERE tc.name LIKE ? ESCAPE '\\' AND b.deleted_at IS NULL \
            UNION \
            SELECT DISTINCT btr.source_id \
            FROM tags_cache tc \
            JOIN block_tag_refs btr ON btr.tag_id = tc.tag_id \
            JOIN blocks b ON b.id = btr.source_id \
            WHERE tc.name LIKE ? ESCAPE '\\' AND b.deleted_at IS NULL \
            UNION \
            SELECT DISTINCT bti.block_id \
            FROM tags_cache tc \
            JOIN block_tag_inherited bti ON bti.tag_id = tc.tag_id \
            JOIN blocks b ON b.id = bti.block_id \
            WHERE tc.name LIKE ? ESCAPE '\\' AND b.deleted_at IS NULL)"
    } else {
        "b.id IN ( \
            SELECT DISTINCT bt.block_id \
            FROM tags_cache tc \
            JOIN block_tags bt ON bt.tag_id = tc.tag_id \
            JOIN blocks b ON b.id = bt.block_id \
            WHERE tc.name LIKE ? ESCAPE '\\' AND b.deleted_at IS NULL \
            UNION \
            SELECT DISTINCT btr.source_id \
            FROM tags_cache tc \
            JOIN block_tag_refs btr ON btr.tag_id = tc.tag_id \
            JOIN blocks b ON b.id = btr.source_id \
            WHERE tc.name LIKE ? ESCAPE '\\' AND b.deleted_at IS NULL)"
    }
}

/// Build the paginated projection SELECT for a given candidate clause.
///
/// `candidate_clause` is the predicate that selects the candidate block
/// set — either `b.id IN (SELECT value FROM json_each(?))` (the
/// resolve-then-project path for And/Or/Not) or a pushed-down
/// `b.id IN (<UNION subquery>)` for the #414 leaf fast path. It is a
/// fixed string literal in every caller (no user interpolation; all
/// values are BOUND), so the assembled SQL is injection-safe.
///
/// Every projection filter is identical regardless of candidate source:
///
/// I-Search-14: defense-in-depth — the leaf SQL already excludes
/// soft-deleted rows, but the explicit `b.deleted_at IS NULL` here means
/// a future candidate clause that re-includes the universe cannot
/// surface a soft-deleted row.
///
/// FEAT-3p4 — `(? IS NULL OR b.page_id IN (…))` mirrors
/// `crate::space_filter_clause!`; the single `?` is bound twice (NULL
/// guard + value comparison) to keep the short-circuit.
///
/// PEND-35 Tier 3.4 — `(? IS NULL OR b.block_type = ?)` push-down.
///
/// Issue #112 sub-item 1 — `(? IS NULL OR b.id > ?)` is the cursor walk;
/// combined with `ORDER BY b.id ASC LIMIT ?` it replaces the Rust-side
/// sort/slice.
fn build_projection_sql(candidate_clause: &str) -> String {
    // NB: use the positional `{}` placeholder (not a named `{cols}`) for the
    // BLOCK_ROW_RUNTIME_SELECT interpolation — the
    // `block_row_canonical_runtime_sites_match_canonical_columns` drift guard
    // matches the canonical positional placeholder shape across every runtime
    // BlockRow projection site, and a named placeholder slips past it.
    format!(
        "SELECT {} \
         FROM blocks b \
         WHERE {candidate_clause} \
           AND b.deleted_at IS NULL \
           AND (? IS NULL OR b.space_id = ?) \
           AND (? IS NULL OR b.block_type = ?) \
           AND (? IS NULL OR b.id > ?) \
         ORDER BY b.id ASC \
         LIMIT ?",
        crate::pagination::block_row_columns::BLOCK_ROW_RUNTIME_SELECT,
    )
}

/// Bind the candidate-specific parameters (`candidate_binds`, in
/// placeholder order), then the shared projection filters, run the query,
/// and apply the `fetch_limit = limit + 1` / truncate / has_more /
/// next_cursor logic.
///
/// `candidate_binds` is the ordered list of values for the placeholders
/// in the candidate clause: the single json string for the And/Or/Not
/// path, or `tag_id` / the LIKE pattern repeated once per UNION arm for
/// the #414 leaf paths. The shared filter binds (space, block_type,
/// cursor, limit) are applied here so they cannot drift between paths.
async fn run_projection<'a>(
    pool: &SqlitePool,
    query_str: &'a str,
    params: ProjectionParams<'a>,
    candidate_binds: &[String],
) -> Result<PageResponse<ActiveBlockRow>, AppError> {
    let page = params.page;
    let start_after = page.after.as_ref().map(|c| c.id.as_str());
    // page.limit is a validated positive pagination bound; safe to convert
    let limit_usize = usize::try_from(page.limit).unwrap_or(usize::MAX);
    // Fetch `limit + 1` so we can detect `has_more` without a separate
    // count query — mirrors the pre-pushdown behaviour.
    let fetch_limit = page.limit.saturating_add(1);

    // MAINT-113 M2 — query the rows as ActiveBlockRow directly. The SQL
    // filters `deleted_at IS NULL`, so every row sqlx hydrates is active.
    let mut q = sqlx::query_as::<_, ActiveBlockRow>(sqlx::AssertSqlSafe(query_str));
    for v in candidate_binds {
        q = q.bind(v);
    }
    let mut items: Vec<ActiveBlockRow> = q
        .bind(params.space_id)
        .bind(params.space_id)
        .bind(params.block_type)
        .bind(params.block_type)
        .bind(start_after)
        .bind(start_after)
        .bind(fetch_limit)
        .fetch_all(pool)
        .await?;

    let has_more = items.len() > limit_usize;
    if has_more {
        items.truncate(limit_usize);
    }
    let next_cursor = if has_more {
        let last = items.last().expect("has_more implies non-empty");
        Some(Cursor::for_id(last.id.as_str().to_string()).encode()?)
    } else {
        None
    };
    Ok(PageResponse {
        items,
        next_cursor,
        has_more,
        total_count: None,
    })
}

const MAX_TAGS_PREFIX: i64 = 200;

/// List all tags whose name starts with `prefix`, ordered by name.
///
/// `limit` must be in `[1, MAX_TAGS_PREFIX]` when supplied; a value
/// outside that range surfaces as `AppError::Validation`
/// (limit-clamp-followup Phase 1).  `None` falls through to
/// `MAX_TAGS_PREFIX` as the default cap.
pub async fn list_tags_by_prefix(
    pool: &SqlitePool,
    prefix: &str,
    limit: Option<i64>,
) -> Result<Vec<TagCacheRow>, AppError> {
    let like_pattern = format!("{}%", escape_like(prefix));
    let effective_limit = match limit {
        Some(l) if (1..=MAX_TAGS_PREFIX).contains(&l) => l,
        Some(l) => {
            return Err(AppError::Validation(format!(
                "list_tags_by_prefix limit must be in [1, {MAX_TAGS_PREFIX}]; got {l}. \
                 Tag listings are typeahead-style — clamp your input to a sensible \
                 upper bound."
            )));
        }
        None => MAX_TAGS_PREFIX,
    };
    let mut rows = sqlx::query_as!(
        TagCacheRow,
        r#"SELECT tag_id, name, usage_count, updated_at
         FROM tags_cache WHERE name LIKE ?1 ESCAPE '\' ORDER BY name LIMIT ?2"#,
        like_pattern,
        effective_limit
    )
    .fetch_all(pool)
    .await?;

    // #768 — guarantee the exact (case-insensitive) match is present even when
    // it would otherwise fall off the `LIMIT` page. `tags_cache.name` is
    // BINARY-collated (migration 0001), so `ORDER BY name` sorts uppercase
    // case-variants ahead of a lowercase exact match: with 20+ siblings like
    // `WIP-1`…`WIP-25` an exact `wip` sorts past the page and the frontend
    // resolver settles the name as unresolved (false-empty after #717). Fetch
    // the exact NOCASE match separately and splice it to the front (deduped) so
    // a valid tag always resolves. The bounded LIKE scan above is unchanged, so
    // the NOCASE prefix-index plan (migration 0050) still applies.
    if !prefix.is_empty() {
        let exact = sqlx::query_as!(
            TagCacheRow,
            r#"SELECT tag_id, name, usage_count, updated_at
             FROM tags_cache WHERE name = ?1 COLLATE NOCASE ORDER BY name LIMIT 1"#,
            prefix,
        )
        .fetch_optional(pool)
        .await?;
        if let Some(exact) = exact
            && !rows.iter().any(|r| r.tag_id == exact.tag_id)
        {
            // Drop the page's last row if inserting the exact match would push
            // the result over the caller's requested limit, keeping the cap.
            if i64::try_from(rows.len()).unwrap_or(i64::MAX) >= effective_limit {
                rows.pop();
            }
            rows.insert(0, exact);
        }
    }
    Ok(rows)
}

/// Return every tag in `space_id`, ordered by name. No pagination, no
/// clamp.
///
/// Tags are space-scoped: each tag block (`block_type = 'tag'`) carries
/// its own `blocks.space_id` column (Phase 2, #533 — the previous
/// `block_properties(key = 'space')` row was retired in migration 0087;
/// see `spaces::cross_space_validation` and the `add_tag` cross-space
/// guard at `commands/tags.rs:116`). The space filter therefore selects
/// tag blocks directly on `space_id`, keyed on the tag block itself
/// rather than on a page's owning block.
///
/// The result set is bounded by the space's intrinsic tag count
/// (workspaces typically have tens to hundreds of distinct tags). Use
/// this when the caller genuinely needs every tag (the tag-management
/// list view); use the prefix-paginated `list_tags_by_prefix` for
/// typeahead pickers.
pub async fn list_all_tags_in_space(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<Vec<TagCacheRow>, AppError> {
    let rows = sqlx::query_as!(
        TagCacheRow,
        r#"SELECT tc.tag_id, tc.name, tc.usage_count, tc.updated_at
         FROM tags_cache tc
         WHERE tc.tag_id IN (
             SELECT id FROM blocks
             WHERE block_type = 'tag' AND space_id = ?1
         )
         ORDER BY tc.name"#,
        space_id,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// List all tag_ids associated with a block.
///
/// The cap (`BLOCK_TAG_CAP`) is practical insurance against a runaway row
/// count surfacing in the UI: in real use a block carries on the order
/// of ≤100 tags, and 1000 is well below any UI render budget. Callers
/// that need every tag (admin / migration paths) should query
/// `block_tags` directly.
///
/// #347 (R5): the cap used to be silent. We over-fetch by one row and
/// `warn!` on actual truncation so an anomalous block surfaces in logs.
const BLOCK_TAG_CAP: usize = 1000;

pub async fn list_tags_for_block(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<Vec<String>, AppError> {
    let mut rows = sqlx::query_scalar!(
        "SELECT tag_id FROM block_tags WHERE block_id = ?1 ORDER BY tag_id LIMIT 1001",
        block_id
    )
    .fetch_all(pool)
    .await?;
    if rows.len() > BLOCK_TAG_CAP {
        tracing::warn!(
            target: "agaric::list_tags_for_block",
            block_id,
            cap = BLOCK_TAG_CAP,
            "block tag count exceeds the typeahead cap; result truncated"
        );
        rows.truncate(BLOCK_TAG_CAP);
    }
    Ok(rows)
}

/// List the tag_ids a block holds via **inheritance** (`block_tag_inherited`),
/// i.e. tags that a strict ancestor applies directly and which propagate down
/// to this block. Direct tags (`block_tags`) are intentionally NOT returned —
/// the caller pairs this with [`list_tags_for_block`] to distinguish derived
/// chips from directly-applied ones (#1423).
///
/// A given tag can appear in BOTH lists when a block is tagged directly *and*
/// inherits the same tag from an ancestor; callers that render a single chip
/// per tag should treat "direct" as winning (a direct tag is removable, an
/// inherited one is not). The same `BLOCK_TAG_CAP` insurance applies.
pub async fn list_inherited_tags_for_block(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<Vec<String>, AppError> {
    let mut rows = sqlx::query_scalar!(
        "SELECT tag_id FROM block_tag_inherited WHERE block_id = ?1 ORDER BY tag_id LIMIT 1001",
        block_id
    )
    .fetch_all(pool)
    .await?;
    if rows.len() > BLOCK_TAG_CAP {
        tracing::warn!(
            target: "agaric::list_inherited_tags_for_block",
            block_id,
            cap = BLOCK_TAG_CAP,
            "inherited block tag count exceeds the typeahead cap; result truncated"
        );
        rows.truncate(BLOCK_TAG_CAP);
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::pagination::Cursor;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }
    async fn insert_block(pool: &SqlitePool, id: &str, block_type: &str, content: &str) {
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)")
            .bind(id)
            .bind(block_type)
            .bind(content)
            .execute(pool)
            .await
            .unwrap();
    }
    async fn insert_tag_assoc(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(block_id)
            .bind(tag_id)
            .execute(pool)
            .await
            .unwrap();
    }
    async fn insert_tag_cache(pool: &SqlitePool, tag_id: &str, name: &str, usage_count: i64) {
        sqlx::query("INSERT INTO tags_cache (tag_id, name, usage_count, updated_at) VALUES (?, ?, ?, '2025-01-01T00:00:00Z')")
            .bind(tag_id).bind(name).bind(usage_count).execute(pool).await.unwrap();
    }
    async fn insert_child_block(
        pool: &SqlitePool,
        id: &str,
        block_type: &str,
        content: &str,
        parent_id: &str,
    ) {
        sqlx::query("INSERT INTO blocks (id, block_type, content, parent_id, position) VALUES (?, ?, ?, ?, 1)")
            .bind(id).bind(block_type).bind(content).bind(parent_id).execute(pool).await.unwrap();
    }

    /// Build a `Not`-nested chain wrapping a `Tag` leaf at the given
    /// boolean-tree depth. `nots == 0` is the bare leaf; each `Not` adds one
    /// to `TagExpr::validate_depth`'s frame count (the gate checks
    /// `depth > MAX_DEPTH`, so `nots == MAX_DEPTH` is the last accepted depth
    /// and `nots == MAX_DEPTH + 1` is the first rejected one).
    fn nested_not(tag: &str, nots: usize) -> TagExpr {
        let mut expr = TagExpr::Tag(tag.into());
        for _ in 0..nots {
            expr = TagExpr::Not(Box::new(expr));
        }
        expr
    }

    #[test]
    fn validate_depth_accepts_at_limit_rejects_beyond() {
        // At the boundary (`MAX_DEPTH` nested frames) validation passes.
        assert!(
            nested_not("TAG_A", TagExpr::MAX_DEPTH)
                .validate_depth()
                .is_ok()
        );
        // One frame deeper is rejected with a Validation error whose message
        // names the bound (mirrors `FilterExpr::validate_depth`).
        let err = nested_not("TAG_A", TagExpr::MAX_DEPTH + 1)
            .validate_depth()
            .unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "over-limit TagExpr must be rejected with AppError::Validation, got {err:?}"
        );
        assert!(
            err.to_string().contains(&TagExpr::MAX_DEPTH.to_string()),
            "error message should name MAX_DEPTH: {err}"
        );
    }

    #[tokio::test]
    async fn eval_tag_query_rejects_over_depth_tree() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        let expr = nested_not("TAG_A", TagExpr::MAX_DEPTH + 1);
        let page = PageRequest::new(None, Some(10)).unwrap();
        let result = eval_tag_query(&pool, &expr, &page, false, None, None).await;
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "over-depth tag query must be rejected before resolution, got {result:?}"
        );
    }

    #[tokio::test]
    async fn eval_tag_query_resolves_tree_at_depth_limit() {
        // A tree exactly at the limit must validate and resolve normally.
        // `Not(Not(Tag))` is an even number of negations, so the result is
        // the set of blocks carrying the tag. Build the chain with an even
        // depth at/under MAX_DEPTH so the leaf semantics are preserved.
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "BLK_1", "content", "hello").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_block(&pool, "BLK_2", "content", "world").await;

        let even_depth = TagExpr::MAX_DEPTH - (TagExpr::MAX_DEPTH % 2);
        let expr = nested_not("TAG_A", even_depth);
        assert!(expr.validate_depth().is_ok());
        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = eval_tag_query(&pool, &expr, &page, false, None, None)
            .await
            .unwrap();
        let ids: Vec<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["BLK_1"],
            "even-NOT chain resolves to the tagged block"
        );
    }

    #[tokio::test]
    async fn eval_tag_query_paginates_results() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_X", "tag", "x-tag").await;
        for suffix in &["A", "B", "C", "D", "E"] {
            let id = format!("BLK_{suffix}");
            insert_block(&pool, &id, "content", &format!("block {suffix}")).await;
            insert_tag_assoc(&pool, &id, "TAG_X").await;
        }
        let expr = TagExpr::Tag("TAG_X".into());
        let page1 = PageRequest::new(None, Some(2)).unwrap();
        let resp1 = eval_tag_query(&pool, &expr, &page1, false, None, None)
            .await
            .unwrap();
        assert_eq!(resp1.items.len(), 2);
        assert_eq!(resp1.items[0].id, "BLK_A");
        assert_eq!(resp1.items[1].id, "BLK_B");
        assert!(resp1.has_more);
        let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
        let resp2 = eval_tag_query(&pool, &expr, &page2, false, None, None)
            .await
            .unwrap();
        assert_eq!(resp2.items.len(), 2);
        assert_eq!(resp2.items[0].id, "BLK_C");
        assert_eq!(resp2.items[1].id, "BLK_D");
        let page3 = PageRequest::new(resp2.next_cursor, Some(2)).unwrap();
        let resp3 = eval_tag_query(&pool, &expr, &page3, false, None, None)
            .await
            .unwrap();
        assert_eq!(resp3.items.len(), 1);
        assert_eq!(resp3.items[0].id, "BLK_E");
        assert!(!resp3.has_more);
        assert!(resp3.next_cursor.is_none());
    }
    #[tokio::test]
    async fn eval_tag_query_empty_result() {
        let (pool, _dir) = test_pool().await;
        let expr = TagExpr::Tag("NONEXISTENT".into());
        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = eval_tag_query(&pool, &expr, &page, false, None, None)
            .await
            .unwrap();
        assert!(resp.items.is_empty());
        assert!(!resp.has_more);
    }
    #[tokio::test]
    async fn eval_tag_query_returns_full_block_rows() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "BLK_1", "content", "hello world").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        let expr = TagExpr::Tag("TAG_A".into());
        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = eval_tag_query(&pool, &expr, &page, false, None, None)
            .await
            .unwrap();
        assert_eq!(resp.items.len(), 1);
        let row = &resp.items[0];
        assert_eq!(row.id, "BLK_1");
        assert_eq!(row.block_type, "content");
        assert_eq!(row.content, Some("hello world".into()));
        assert!(row.deleted_at.is_none());
    }
    #[tokio::test]
    async fn eval_tag_query_cursor_past_all_returns_empty() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "BLK_1", "content", "one").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        let expr = TagExpr::Tag("TAG_A".into());
        let cursor = Cursor {
            id: "ZZZZZZZZZZ".into(),
            position: None,
            deleted_at: None,
            seq: None,
            rank: None,
        }
        .encode()
        .unwrap();
        let page = PageRequest::new(Some(cursor), Some(10)).unwrap();
        let resp = eval_tag_query(&pool, &expr, &page, false, None, None)
            .await
            .unwrap();
        assert!(resp.items.is_empty());
        assert!(!resp.has_more);
    }
    #[tokio::test]
    async fn eval_tag_query_with_inheritance_paginates() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_PG", "tag", "pg").await;
        insert_block(&pool, "PAGE_PG", "page", "paginated page").await;
        insert_tag_assoc(&pool, "PAGE_PG", "TAG_PG").await;
        for suffix in &["PG_C1", "PG_C2", "PG_C3", "PG_C4"] {
            insert_child_block(
                &pool,
                suffix,
                "content",
                &format!("child {suffix}"),
                "PAGE_PG",
            )
            .await;
        }
        crate::tag_inheritance::rebuild_all(&pool).await.unwrap();
        let expr = TagExpr::Tag("TAG_PG".into());
        let page1 = PageRequest::new(None, Some(2)).unwrap();
        let resp1 = eval_tag_query(&pool, &expr, &page1, true, None, None)
            .await
            .unwrap();
        assert_eq!(resp1.items.len(), 2);
        assert!(resp1.has_more);
        let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
        let resp2 = eval_tag_query(&pool, &expr, &page2, true, None, None)
            .await
            .unwrap();
        assert_eq!(resp2.items.len(), 2);
        let page3 = PageRequest::new(resp2.next_cursor, Some(2)).unwrap();
        let resp3 = eval_tag_query(&pool, &expr, &page3, true, None, None)
            .await
            .unwrap();
        assert_eq!(resp3.items.len(), 1);
        assert!(!resp3.has_more);
        let total = resp1.items.len() + resp2.items.len() + resp3.items.len();
        assert_eq!(total, 5);
    }
    #[tokio::test]
    async fn list_tags_by_prefix_returns_matching_tags() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_WM", "tag", "work/meeting").await;
        insert_block(&pool, "TAG_WE", "tag", "work/email").await;
        insert_block(&pool, "TAG_P", "tag", "personal").await;
        insert_tag_cache(&pool, "TAG_WM", "work/meeting", 5).await;
        insert_tag_cache(&pool, "TAG_WE", "work/email", 3).await;
        insert_tag_cache(&pool, "TAG_P", "personal", 10).await;
        let result = list_tags_by_prefix(&pool, "work/", None).await.unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "work/email");
        assert_eq!(result[1].name, "work/meeting");
    }
    #[tokio::test]
    async fn list_tags_by_prefix_empty_prefix_returns_all() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_tag_cache(&pool, "TAG_A", "alpha", 1).await;
        insert_tag_cache(&pool, "TAG_B", "beta", 2).await;
        let result = list_tags_by_prefix(&pool, "", None).await.unwrap();
        assert_eq!(result.len(), 2);
    }
    #[tokio::test]
    async fn list_tags_by_prefix_no_match_returns_empty() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_tag_cache(&pool, "TAG_A", "alpha", 1).await;
        let result = list_tags_by_prefix(&pool, "zzz", None).await.unwrap();
        assert!(result.is_empty());
    }
    #[tokio::test]
    async fn list_tags_by_prefix_escapes_percent_in_prefix() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "100%_done").await;
        insert_block(&pool, "TAG_B", "tag", "alpha").await;
        insert_tag_cache(&pool, "TAG_A", "100%_done", 1).await;
        insert_tag_cache(&pool, "TAG_B", "alpha", 2).await;
        let result = list_tags_by_prefix(&pool, "%", None).await.unwrap();
        assert_eq!(result.len(), 0);
        let result = list_tags_by_prefix(&pool, "100%", None).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "100%_done");
    }

    /// PEND-35 Tier 3.3 — the LIKE-prefix query in `list_tags_by_prefix`
    /// (`WHERE name LIKE ?1 ESCAPE '\' ORDER BY name LIMIT ?2`) is hit
    /// on every keystroke of every tag picker. SQLite's default LIKE is
    /// case-insensitive on ASCII, so the implicit BINARY index from
    /// `tags_cache.name UNIQUE` cannot satisfy the query. Migration 0050
    /// adds `idx_tags_cache_name_nocase ON tags_cache(name COLLATE
    /// NOCASE)` so the planner can do a NOCASE prefix range-scan.
    ///
    /// This test pins that the planner picks `idx_tags_cache_name_nocase`
    /// for that exact query shape — regressing the index (drop, rename,
    /// or accidentally dropping the `COLLATE NOCASE` clause) would flip
    /// the plan back to a full scan and fail this test.
    #[tokio::test]
    async fn list_tags_by_prefix_uses_nocase_index() {
        use sqlx::Row as _;
        let (pool, _dir) = test_pool().await;
        // Populate a few rows so the planner has stats to reason about
        // (also makes the test fail loudly if it ever returned wrong rows).
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_tag_cache(&pool, "TAG_A", "alpha", 1).await;
        insert_tag_cache(&pool, "TAG_B", "beta", 2).await;

        // Mirror the exact query shape from `list_tags_by_prefix`. Use
        // dynamic `sqlx::query` (not `query!`) so the EXPLAIN prefix
        // doesn't get type-checked against the offline cache.
        let rows = sqlx::query(
            r#"EXPLAIN QUERY PLAN
               SELECT tag_id, name, usage_count, updated_at
               FROM tags_cache WHERE name LIKE ?1 ESCAPE '\' ORDER BY name LIMIT ?2"#,
        )
        .bind("a%")
        .bind(50_i64)
        .fetch_all(&pool)
        .await
        .unwrap();

        let plan: String = rows
            .iter()
            .map(|r| r.try_get::<String, _>("detail").unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            plan.contains("idx_tags_cache_name_nocase"),
            "expected query plan to use the NOCASE index added by \
             migration 0050, got plan:\n{plan}"
        );
    }

    /// #768 — an exact (case-insensitive) match must resolve even when 20+
    /// BINARY-collated case-variant siblings sort ahead of it and would push
    /// it off the `LIMIT` page. Reproduction: seed `WIP-1`…`WIP-25` (uppercase,
    /// which BINARY-sorts before lowercase) plus a lowercase exact `wip`; with
    /// `limit = 20` the bare prefix page never includes `wip`. Fix proof: the
    /// exact-match splice puts `wip` in the returned set.
    #[tokio::test]
    async fn list_tags_by_prefix_exact_match_survives_full_page_768() {
        let (pool, _dir) = test_pool().await;

        // 25 uppercase case-variant siblings (`WIP-1`…`WIP-25`). Uppercase
        // ASCII (0x57 'W') sorts before lowercase (0x77 'w') under BINARY, so
        // these all precede the lowercase exact in `ORDER BY name`.
        for i in 1..=25 {
            let id = format!("TAGWIP{i:020}");
            let name = format!("WIP-{i}");
            insert_block(&pool, &id, "tag", &name).await;
            insert_tag_cache(&pool, &id, &name, 1).await;
        }
        // The lowercase exact match the user is resolving.
        insert_block(&pool, "TAGWIPEXACT00000000000001A", "tag", "wip").await;
        insert_tag_cache(&pool, "TAGWIPEXACT00000000000001A", "wip", 1).await;

        // Sanity: the bare prefix page (limit 20) does NOT contain the exact
        // match — it is pushed off by the 25 uppercase siblings. This is the
        // pre-fix failure mode the splice repairs.
        let bare = sqlx::query_scalar::<_, String>(
            r#"SELECT name FROM tags_cache WHERE name LIKE 'wip%' ESCAPE '\' ORDER BY name LIMIT 20"#,
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert!(
            !bare.iter().any(|n| n == "wip"),
            "fixture invariant: exact 'wip' must fall off the bare 20-row prefix page"
        );

        // With the fix, resolving `wip` at limit 20 returns the exact match.
        let result = list_tags_by_prefix(&pool, "wip", Some(20)).await.unwrap();
        assert!(
            result
                .iter()
                .any(|r| r.name == "wip" && r.tag_id == "TAGWIPEXACT00000000000001A"),
            "#768: exact lowercase 'wip' must resolve despite 25 uppercase siblings"
        );
        // The cap is still honoured.
        assert!(
            result.len() <= 20,
            "result must not exceed the requested limit; got {}",
            result.len()
        );
    }

    /// Helper: assign a tag block to a space via the denormalized
    /// `blocks.space_id` column (mirrors what the materializer writes).
    async fn assign_tag_to_space(pool: &SqlitePool, tag_id: &str, space_id: &str) {
        // Phase 2 (#533): space membership is keyed on `blocks.space_id`, the
        // sole source of truth. Set the column so `list_all_tags_in_space`
        // (which filters on `block_type = 'tag' AND space_id = ?`) sees the tag.
        sqlx::query("UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?")
            .bind(space_id)
            .bind(tag_id)
            .bind(tag_id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Seed the space block so the FK on `blocks.space_id → blocks(id)`
    /// is satisfied.  Idempotent.
    async fn ensure_space_block(pool: &SqlitePool, space_id: &str) {
        sqlx::query(
            "INSERT OR IGNORE INTO blocks (id, block_type, content) \
             VALUES (?, 'page', 'Space')",
        )
        .bind(space_id)
        .execute(pool)
        .await
        .unwrap();
        // #708: register in the `spaces` table — `blocks.space_id`
        // REFERENCES spaces(id) since migration 0089.
        sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
            .bind(space_id)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn list_all_tags_in_space_returns_every_tag_in_scope() {
        let (pool, _dir) = test_pool().await;
        let space_a = "01TAGSPACEA0000000000000001";
        ensure_space_block(&pool, space_a).await;

        // Seed 350 tag rows in space_a — well above the
        // `MAX_TAGS_PREFIX = 200` cap that `list_tags_by_prefix`
        // applies, to prove this path is unclamped.
        for i in 0..350 {
            let id = format!("TAG_{i:04}");
            let name = format!("tag-{i:04}");
            insert_block(&pool, &id, "tag", &name).await;
            insert_tag_cache(&pool, &id, &name, 1).await;
            assign_tag_to_space(&pool, &id, space_a).await;
        }

        let result = list_all_tags_in_space(&pool, space_a).await.unwrap();
        assert_eq!(
            result.len(),
            350,
            "must return every tag in the space (no clamp); got {} rows",
            result.len()
        );
        // ORDER BY name keeps the result deterministic.
        assert_eq!(result[0].name, "tag-0000");
        assert_eq!(result[349].name, "tag-0349");
    }

    #[tokio::test]
    async fn list_all_tags_in_space_excludes_other_spaces() {
        let (pool, _dir) = test_pool().await;
        let space_a = "01TAGSPACEA0000000000000001";
        let space_b = "01TAGSPACEB0000000000000002";
        ensure_space_block(&pool, space_a).await;
        ensure_space_block(&pool, space_b).await;

        insert_block(&pool, "TAG_AA", "tag", "alpha").await;
        insert_tag_cache(&pool, "TAG_AA", "alpha", 3).await;
        assign_tag_to_space(&pool, "TAG_AA", space_a).await;

        insert_block(&pool, "TAG_AB", "tag", "beta").await;
        insert_tag_cache(&pool, "TAG_AB", "beta", 2).await;
        assign_tag_to_space(&pool, "TAG_AB", space_a).await;

        insert_block(&pool, "TAG_BB", "tag", "bravo").await;
        insert_tag_cache(&pool, "TAG_BB", "bravo", 5).await;
        assign_tag_to_space(&pool, "TAG_BB", space_b).await;

        // Unscoped tag — must be excluded from every space result.
        insert_block(&pool, "TAG_OO", "tag", "orphan").await;
        insert_tag_cache(&pool, "TAG_OO", "orphan", 1).await;

        let in_a = list_all_tags_in_space(&pool, space_a).await.unwrap();
        let ids_a: Vec<&str> = in_a.iter().map(|r| r.tag_id.as_str()).collect();
        assert_eq!(
            ids_a,
            vec!["TAG_AA", "TAG_AB"],
            "space A must surface only its own tags, ordered by name; \
             must exclude space B's tag and the unscoped orphan",
        );

        let in_b = list_all_tags_in_space(&pool, space_b).await.unwrap();
        let ids_b: Vec<&str> = in_b.iter().map(|r| r.tag_id.as_str()).collect();
        assert_eq!(
            ids_b,
            vec!["TAG_BB"],
            "space B must surface only its own tag",
        );
    }

    #[tokio::test]
    async fn list_all_tags_in_space_empty_space_returns_empty() {
        let (pool, _dir) = test_pool().await;
        let result = list_all_tags_in_space(&pool, "01NOSUCHSPACE00000000000000")
            .await
            .unwrap();
        assert!(
            result.is_empty(),
            "unknown space must return empty; got {result:?}"
        );
    }

    #[tokio::test]
    async fn list_tags_for_block_returns_tag_ids() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "BLK_1", "content", "hello").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_B").await;
        let result = list_tags_for_block(&pool, "BLK_1").await.unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0], "TAG_A");
        assert_eq!(result[1], "TAG_B");
    }
    #[tokio::test]
    async fn list_tags_for_block_no_tags_returns_empty() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BLK_1", "content", "no tags").await;
        let result = list_tags_for_block(&pool, "BLK_1").await.unwrap();
        assert!(result.is_empty());
    }
    #[tokio::test]
    async fn list_tags_for_block_nonexistent_block_returns_empty() {
        let (pool, _dir) = test_pool().await;
        let result = list_tags_for_block(&pool, "DOES_NOT_EXIST").await.unwrap();
        assert!(result.is_empty());
    }

    /// Safety cap: `list_tags_for_block` ends with `LIMIT 1000` so a
    /// runaway tag count cannot blow up the UI render budget. Insert
    /// 1001 distinct tags on a single block and assert the result is
    /// clamped to exactly 1000 — proves the cap is enforced and the
    /// query did not silently fall back to all rows.
    #[tokio::test]
    async fn list_tags_for_block_caps_at_1000() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BLK_CAP", "content", "many tags").await;
        for i in 0..1001 {
            let tag_id = format!("TAG_{i:05}");
            insert_block(&pool, &tag_id, "tag", &tag_id).await;
            insert_tag_assoc(&pool, "BLK_CAP", &tag_id).await;
        }
        let result = list_tags_for_block(&pool, "BLK_CAP").await.unwrap();
        assert_eq!(
            result.len(),
            1000,
            "list_tags_for_block must cap at LIMIT 1000; got {}",
            result.len()
        );
    }

    async fn insert_inherited_assoc(
        pool: &SqlitePool,
        block_id: &str,
        tag_id: &str,
        inherited_from: &str,
    ) {
        sqlx::query(
            "INSERT INTO block_tag_inherited (block_id, tag_id, inherited_from) VALUES (?, ?, ?)",
        )
        .bind(block_id)
        .bind(tag_id)
        .bind(inherited_from)
        .execute(pool)
        .await
        .unwrap();
    }

    /// #1423 — `list_inherited_tags_for_block` returns ONLY the inherited
    /// (`block_tag_inherited`) tag IDs, never the direct (`block_tags`)
    /// ones, so the UI can render derived chips distinctly. A parent holds
    /// a tag directly and the child inherits it; the child also carries a
    /// distinct direct tag. The two list functions must partition cleanly.
    #[tokio::test]
    async fn list_inherited_tags_for_block_returns_only_inherited() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_INH", "tag", "inherited-tag").await;
        insert_block(&pool, "TAG_DIR", "tag", "direct-tag").await;
        insert_block(&pool, "PARENT", "content", "parent").await;
        insert_child_block(&pool, "CHILD", "content", "child", "PARENT").await;

        // PARENT holds TAG_INH directly; CHILD inherits it from PARENT.
        insert_tag_assoc(&pool, "PARENT", "TAG_INH").await;
        insert_inherited_assoc(&pool, "CHILD", "TAG_INH", "PARENT").await;
        // CHILD also holds TAG_DIR directly.
        insert_tag_assoc(&pool, "CHILD", "TAG_DIR").await;

        let inherited = list_inherited_tags_for_block(&pool, "CHILD").await.unwrap();
        assert_eq!(inherited, vec!["TAG_INH".to_string()]);

        let direct = list_tags_for_block(&pool, "CHILD").await.unwrap();
        assert_eq!(direct, vec!["TAG_DIR".to_string()]);

        // The PARENT (which holds the tag directly) inherits nothing.
        let parent_inherited = list_inherited_tags_for_block(&pool, "PARENT")
            .await
            .unwrap();
        assert!(
            parent_inherited.is_empty(),
            "a directly-tagged block has no inherited rows; got {parent_inherited:?}"
        );
    }

    /// A block with no inherited tags yields an empty list.
    #[tokio::test]
    async fn list_inherited_tags_for_block_no_inherited_returns_empty() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_DIR", "tag", "direct-tag").await;
        insert_block(&pool, "BLK_1", "content", "only direct").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_DIR").await;
        let result = list_inherited_tags_for_block(&pool, "BLK_1").await.unwrap();
        assert!(result.is_empty());
    }

    /// I-Search-14 — defense-in-depth: the final projection SELECT in
    /// `eval_tag_query` filters `deleted_at IS NULL`.
    /// `resolve_expr` already excludes soft-deleted blocks at the
    /// leaves, but the defensive filter on the final SELECT guards
    /// against future regressions where the resolver might re-include
    /// the universe (e.g. an extension to `TagExpr::Not`).
    #[tokio::test]
    async fn eval_tag_query_excludes_deleted_blocks() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_X", "tag", "x").await;
        insert_block(&pool, "BLK_KEEP", "content", "keep me").await;
        insert_tag_assoc(&pool, "BLK_KEEP", "TAG_X").await;

        // Soft-deleted block tagged with TAG_X.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, deleted_at) \
             VALUES (?, 'content', 'soft-deleted', 1736942400000)",
        )
        .bind("BLK_DEL")
        .execute(&pool)
        .await
        .unwrap();
        insert_tag_assoc(&pool, "BLK_DEL", "TAG_X").await;

        let expr = TagExpr::Tag("TAG_X".into());
        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = eval_tag_query(&pool, &expr, &page, false, None, None)
            .await
            .unwrap();
        let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["BLK_KEEP"],
            "eval_tag_query must exclude soft-deleted blocks via the \
             defensive `deleted_at IS NULL` filter on the final \
             projection (I-Search-14)"
        );
    }

    // ----------------------------------------------------------------
    // #414 — pushed-down leaf fast-path differential tests.
    //
    // These pin that the SQL-side `IN (<UNION subquery>)` fast path for
    // `TagExpr::Tag` / `TagExpr::Prefix` returns results IDENTICAL to the
    // OLD `resolve_expr` + `json_each(?)` projection, across the full
    // {inherited} × {space} × {block_type} × {pagination} matrix.
    // ----------------------------------------------------------------

    async fn insert_tag_ref(pool: &SqlitePool, source_id: &str, tag_id: &str) {
        sqlx::query("INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)")
            .bind(source_id)
            .bind(tag_id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Reference projection: replicate the OLD behaviour exactly — take
    /// the FULL id set from `resolve_expr`, serialise it to JSON, and run
    /// the same `json_each(?)` projection (same space / block_type /
    /// cursor / ORDER BY / LIMIT and the same has_more/cursor logic). This
    /// is the oracle the new fast path must match bit-for-bit.
    async fn reference_eval(
        pool: &SqlitePool,
        expr: &TagExpr,
        page: &PageRequest,
        include_inherited: bool,
        space_id: Option<&str>,
        block_type: Option<&str>,
    ) -> PageResponse<ActiveBlockRow> {
        let block_ids: FxHashSet<String> =
            resolve_expr(pool, expr, include_inherited).await.unwrap();
        if block_ids.is_empty() {
            return PageResponse {
                items: vec![],
                next_cursor: None,
                has_more: false,
                total_count: None,
            };
        }
        let id_vec: Vec<&str> = block_ids.iter().map(String::as_str).collect();
        let json_ids = serde_json::to_string(&id_vec).unwrap();
        let query_str = build_projection_sql("b.id IN (SELECT value FROM json_each(?))");
        let projection = ProjectionParams {
            space_id,
            block_type,
            page,
        };
        run_projection(pool, &query_str, projection, &[json_ids])
            .await
            .unwrap()
    }

    /// Page through `eval_tag_query` (the fast path under test) and the
    /// reference oracle with the same params, concatenating ids across
    /// pages, and assert per-page has_more/next_cursor AND the
    /// concatenated id sequence match exactly.
    async fn assert_fast_path_matches_reference(
        pool: &SqlitePool,
        expr: &TagExpr,
        include_inherited: bool,
        space_id: Option<&str>,
        block_type: Option<&str>,
        page_size: i64,
    ) {
        let label = format!(
            "expr={expr:?} inherited={include_inherited} space={space_id:?} \
             block_type={block_type:?} page_size={page_size}"
        );

        let mut fast_ids: Vec<String> = Vec::new();
        let mut ref_ids: Vec<String> = Vec::new();
        let mut fast_cursor: Option<String> = None;
        let mut ref_cursor: Option<String> = None;
        // Bound the loop well above any seeded result set to catch a
        // runaway (non-terminating) cursor walk.
        for _ in 0..1000 {
            let fast_page = PageRequest::new(fast_cursor.clone(), Some(page_size)).unwrap();
            let ref_page = PageRequest::new(ref_cursor.clone(), Some(page_size)).unwrap();
            let fast = eval_tag_query(
                pool,
                expr,
                &fast_page,
                include_inherited,
                space_id,
                block_type,
            )
            .await
            .unwrap();
            let reference = reference_eval(
                pool,
                expr,
                &ref_page,
                include_inherited,
                space_id,
                block_type,
            )
            .await;

            let fast_page_ids: Vec<String> = fast
                .items
                .iter()
                .map(|r| r.id.as_str().to_string())
                .collect();
            let ref_page_ids: Vec<String> = reference
                .items
                .iter()
                .map(|r| r.id.as_str().to_string())
                .collect();
            assert_eq!(
                fast_page_ids, ref_page_ids,
                "per-page ids diverge ({label})"
            );
            assert_eq!(
                fast.has_more, reference.has_more,
                "has_more diverges ({label})"
            );
            assert_eq!(
                fast.next_cursor, reference.next_cursor,
                "next_cursor diverges ({label})"
            );

            fast_ids.extend(fast_page_ids);
            ref_ids.extend(ref_page_ids);

            if !fast.has_more {
                break;
            }
            fast_cursor = fast.next_cursor;
            ref_cursor = reference.next_cursor;
        }

        assert_eq!(
            fast_ids, ref_ids,
            "concatenated ids across all pages diverge ({label})"
        );
    }

    /// Seed a dataset exercising block_tags AND block_tag_refs AND
    /// inheritance, with a couple of blocks parked in a space and a mix
    /// of block_types, plus a soft-deleted tagged block. Returns the
    /// space id used.
    async fn seed_differential_dataset(pool: &SqlitePool) -> String {
        let space = "01DIFFSPACE0000000000000001";
        ensure_space_block(pool, space).await;

        // Tag block + tags_cache row so the Prefix path resolves it.
        insert_block(pool, "TAG_DIFF", "tag", "work/meeting").await;
        insert_tag_cache(pool, "TAG_DIFF", "work/meeting", 0).await;

        // Direct (block_tags) associations — mix of block_type and space.
        for suffix in &["A", "B", "C", "D", "E"] {
            let id = format!("DBLK_{suffix}");
            insert_block(pool, &id, "content", &format!("direct {suffix}")).await;
            insert_tag_assoc(pool, &id, "TAG_DIFF").await;
        }
        // A 'page'-typed direct block (exercises block_type filter).
        insert_block(pool, "DPAGE_1", "page", "direct page").await;
        insert_tag_assoc(pool, "DPAGE_1", "TAG_DIFF").await;

        // Inline-ref-only association (no block_tags row) — the easiest
        // semantic to get wrong; must appear via the block_tag_refs arm.
        insert_block(pool, "RBLK_ONLY", "content", "ref only").await;
        insert_tag_ref(pool, "RBLK_ONLY", "TAG_DIFF").await;

        // Block associated via BOTH block_tags and block_tag_refs — must
        // not be duplicated.
        insert_block(pool, "BOTH_BLK", "content", "both").await;
        insert_tag_assoc(pool, "BOTH_BLK", "TAG_DIFF").await;
        insert_tag_ref(pool, "BOTH_BLK", "TAG_DIFF").await;

        // Inheritance: a tagged page with children — children are only in
        // the result set when include_inherited=true.
        insert_block(pool, "IPAGE", "page", "inherited page").await;
        insert_tag_assoc(pool, "IPAGE", "TAG_DIFF").await;
        for suffix in &["I1", "I2", "I3"] {
            insert_child_block(pool, suffix, "content", &format!("child {suffix}"), "IPAGE").await;
        }
        crate::tag_inheritance::rebuild_all(pool).await.unwrap();

        // Space-scoped blocks: assign a couple of result blocks into `space`
        // so the space filter is non-trivial. Phase 2 (#533) — the projection
        // filters on `b.space_id` directly (the sole source of truth; the
        // `block_properties(key='space')` row is no longer read), so set the
        // column on the result blocks. Give DBLK_A and BOTH_BLK a page_id
        // pointing at the space-scoped page too, mirroring real materialized
        // shape.
        insert_block(pool, "SPACE_PAGE", "page", "space page").await;
        sqlx::query("UPDATE blocks SET space_id = ? WHERE id = ?")
            .bind(space)
            .bind("SPACE_PAGE")
            .execute(pool)
            .await
            .unwrap();
        for id in &["DBLK_A", "BOTH_BLK"] {
            sqlx::query("UPDATE blocks SET page_id = ?, space_id = ? WHERE id = ?")
                .bind("SPACE_PAGE")
                .bind(space)
                .bind(id)
                .execute(pool)
                .await
                .unwrap();
        }

        // Soft-deleted tagged block — must be excluded on every path.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, deleted_at) \
             VALUES ('DEL_BLK', 'content', 'gone', 1736942400000)",
        )
        .execute(pool)
        .await
        .unwrap();
        insert_tag_assoc(pool, "DEL_BLK", "TAG_DIFF").await;

        // #1622 — a SECOND tag with a deliberately PARTIAL overlap with
        // TAG_DIFF so And (INTERSECT) and Or (UNION) are non-trivial:
        //   - DBLK_A, DBLK_B carry BOTH tags  → in the And result.
        //   - OBLK_X, OBLK_Y carry ONLY TAG_OTHER → only in Or / in Not(TAG_DIFF).
        //   - DBLK_C/D/E, refs, inherited carry ONLY TAG_DIFF.
        insert_block(pool, "TAG_OTHER", "tag", "proj/alpha").await;
        insert_tag_cache(pool, "TAG_OTHER", "proj/alpha", 0).await;
        insert_tag_assoc(pool, "DBLK_A", "TAG_OTHER").await;
        insert_tag_assoc(pool, "DBLK_B", "TAG_OTHER").await;
        for suffix in &["X", "Y"] {
            let id = format!("OBLK_{suffix}");
            insert_block(pool, &id, "content", &format!("other {suffix}")).await;
            insert_tag_assoc(pool, &id, "TAG_OTHER").await;
        }

        space.to_string()
    }

    #[tokio::test]
    async fn fast_path_matches_reference_full_matrix() {
        let (pool, _dir) = test_pool().await;
        let space = seed_differential_dataset(&pool).await;

        let tag = TagExpr::Tag("TAG_DIFF".into());
        let prefix = TagExpr::Prefix("work/".into());
        // #1622 — boolean arms composed to INTERSECT/UNION/EXCEPT.
        let and = TagExpr::And(vec![
            TagExpr::Tag("TAG_DIFF".into()),
            TagExpr::Tag("TAG_OTHER".into()),
        ]);
        let or = TagExpr::Or(vec![
            TagExpr::Tag("TAG_DIFF".into()),
            TagExpr::Tag("TAG_OTHER".into()),
        ]);
        let not = TagExpr::Not(Box::new(TagExpr::Tag("TAG_DIFF".into())));
        // The production "not" mode shape: Not(Or(...)).
        let not_or = TagExpr::Not(Box::new(TagExpr::Or(vec![
            TagExpr::Tag("TAG_DIFF".into()),
            TagExpr::Tag("TAG_OTHER".into()),
        ])));
        // Nested combo mixing every operator + a Prefix leaf.
        let nested = TagExpr::And(vec![
            TagExpr::Or(vec![
                TagExpr::Tag("TAG_OTHER".into()),
                TagExpr::Prefix("work/".into()),
            ]),
            TagExpr::Not(Box::new(TagExpr::Tag("TAG_OTHER".into()))),
        ]);

        // {Tag, Prefix, And, Or, Not, Not(Or), nested} ×
        // {inherited} × {space} × {block_type} × pages.
        // Page sizes 1, 2, 3 force multi-page walks over the set.
        for expr in [&tag, &prefix, &and, &or, &not, &not_or, &nested] {
            for inherited in [false, true] {
                for space_id in [None, Some(space.as_str())] {
                    for block_type in [None, Some("content")] {
                        for page_size in [1_i64, 2, 3] {
                            assert_fast_path_matches_reference(
                                &pool, expr, inherited, space_id, block_type, page_size,
                            )
                            .await;
                        }
                    }
                }
            }
        }
    }

    /// #1622 — `not` complement semantics: `Not(Tag)` (and the production
    /// `Not(Or(...))` shape) must return EXACTLY the non-deleted blocks
    /// that do NOT carry the tag(s), with the soft-deleted block excluded.
    /// Asserted directly against a hand-computed expected set (not just the
    /// oracle) to pin the complement universe.
    #[tokio::test]
    async fn not_complement_excludes_matched_and_deleted() {
        let (pool, _dir) = test_pool().await;
        let _space = seed_differential_dataset(&pool).await;

        // Collect every non-deleted block id from the universe.
        let all_active: FxHashSet<String> =
            sqlx::query_scalar::<_, String>("SELECT id FROM blocks WHERE deleted_at IS NULL")
                .fetch_all(&pool)
                .await
                .unwrap()
                .into_iter()
                .collect();
        // Blocks carrying TAG_DIFF (direct path, no inheritance).
        let matched: FxHashSet<String> =
            resolve_expr(&pool, &TagExpr::Tag("TAG_DIFF".into()), false)
                .await
                .unwrap();
        let mut expected: Vec<String> = all_active.difference(&matched).cloned().collect();
        expected.sort();

        let expr = TagExpr::Not(Box::new(TagExpr::Tag("TAG_DIFF".into())));
        // Page through the whole complement with a small page.
        let mut got: Vec<String> = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = PageRequest::new(cursor.clone(), Some(3)).unwrap();
            let resp = eval_tag_query(&pool, &expr, &page, false, None, None)
                .await
                .unwrap();
            got.extend(resp.items.iter().map(|r| r.id.as_str().to_string()));
            if !resp.has_more {
                break;
            }
            cursor = resp.next_cursor;
        }
        got.sort();
        assert_eq!(
            got, expected,
            "Not(Tag) must equal all-non-deleted MINUS the matched set"
        );
        // The soft-deleted block must never appear.
        assert!(
            !got.iter().any(|id| id == "DEL_BLK"),
            "soft-deleted block must be excluded from the complement"
        );
        // A block carrying ONLY the other tag must be present.
        assert!(
            got.iter().any(|id| id == "OBLK_X"),
            "a block without TAG_DIFF must be in the complement"
        );
    }

    /// #1622 — pagination over a LARGE complement must not depend on
    /// materialising the universe: walk `Not(Tag)` over many blocks with a
    /// tiny page size and assert each page matches the oracle and the
    /// concatenation is complete (the production "not" mode pushes the
    /// whole complement through one keyset-paginated SQL read now).
    #[tokio::test]
    async fn not_paginates_large_universe_without_materialization() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_BIG", "tag", "big").await;
        insert_tag_cache(&pool, "TAG_BIG", "big", 0).await;
        // 200 untagged blocks + 50 tagged ones. The complement of TAG_BIG
        // is the 200 untagged blocks; a page size of 7 forces ~29 pages.
        for i in 0..200 {
            let id = format!("UBLK_{i:04}");
            insert_block(&pool, &id, "content", "untagged").await;
        }
        for i in 0..50 {
            let id = format!("TBLK_{i:04}");
            insert_block(&pool, &id, "content", "tagged").await;
            insert_tag_assoc(&pool, &id, "TAG_BIG").await;
        }
        let expr = TagExpr::Not(Box::new(TagExpr::Tag("TAG_BIG".into())));
        // Reference: the full set the old resolver would produce.
        let reference: FxHashSet<String> = resolve_expr(&pool, &expr, false).await.unwrap();
        let mut expected: Vec<String> = reference.into_iter().collect();
        expected.sort();

        let mut got: Vec<String> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0;
        loop {
            let page = PageRequest::new(cursor.clone(), Some(7)).unwrap();
            let resp = eval_tag_query(&pool, &expr, &page, false, None, None)
                .await
                .unwrap();
            // Each page is bounded by the requested limit.
            assert!(resp.items.len() <= 7, "page exceeded the limit");
            got.extend(resp.items.iter().map(|r| r.id.as_str().to_string()));
            pages += 1;
            if !resp.has_more {
                break;
            }
            cursor = resp.next_cursor;
            assert!(pages < 1000, "runaway pagination");
        }
        got.sort();
        assert_eq!(
            got, expected,
            "paginated complement must equal the full set"
        );
        // 200 untagged content blocks + the TAG_BIG tag block itself (which
        // does not carry TAG_BIG) = 201 non-deleted blocks in the complement.
        assert_eq!(
            got.len(),
            201,
            "complement is every non-deleted block sans TAG_BIG"
        );
        assert!(
            pages >= 28,
            "small page size must force many pages, got {pages}"
        );
    }

    /// #1622 — the depth-cutover is correct on BOTH sides: a tree at
    /// exactly `MAX_PUSHDOWN_DEPTH` (pushed down to nested SQL) and a tree
    /// one level deeper (the legacy `resolve_expr` materialisation
    /// fallback) must each equal the oracle across paginated pages. This
    /// proves the fallback boundary does not change results, and that a
    /// deep tree the pushed-down SQL could not express is still answered
    /// correctly.
    #[tokio::test]
    async fn depth_cutover_both_paths_match_reference() {
        let (pool, _dir) = test_pool().await;
        let _space = seed_differential_dataset(&pool).await;

        // `Not(Not(... Tag ...))` chains. Even depth resolves to the tagged
        // set; odd depth to the complement. Use even depths so we exercise
        // a non-trivial result on both sides of the boundary.
        let at_cap = TagExpr::MAX_PUSHDOWN_DEPTH; // 15 (odd → complement)
        let just_over = TagExpr::MAX_PUSHDOWN_DEPTH + 1; // 16 (even → tagged set)
        assert!(
            nested_not("TAG_DIFF", at_cap).depth() == at_cap
                && nested_not("TAG_DIFF", just_over).depth() == just_over,
            "depth() must equal the Not-chain length"
        );

        // Pushed-down path (depth <= cap) vs oracle.
        assert_fast_path_matches_reference(
            &pool,
            &nested_not("TAG_DIFF", at_cap),
            false,
            None,
            None,
            2,
        )
        .await;
        // Fallback path (depth > cap) vs oracle — same oracle, different
        // production code path inside eval_tag_query.
        assert_fast_path_matches_reference(
            &pool,
            &nested_not("TAG_DIFF", just_over),
            false,
            None,
            None,
            2,
        )
        .await;
    }

    /// A block associated to the tag ONLY via `block_tag_refs` (inline
    /// ref, no `block_tags` row) MUST appear in the fast-path result —
    /// this is the easiest UX-250 union semantic to drop.
    #[tokio::test]
    async fn fast_path_includes_block_tag_refs_only_block() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_R", "tag", "refonly").await;
        insert_tag_cache(&pool, "TAG_R", "refonly", 0).await;
        // No block_tags row for RONLY — only an inline ref.
        insert_block(&pool, "RONLY", "content", "ref-only block").await;
        insert_tag_ref(&pool, "RONLY", "TAG_R").await;

        let page = PageRequest::new(None, Some(10)).unwrap();

        // Tag leaf, both inherited modes (refs arm is present in both).
        for inherited in [false, true] {
            let resp = eval_tag_query(
                &pool,
                &TagExpr::Tag("TAG_R".into()),
                &page,
                inherited,
                None,
                None,
            )
            .await
            .unwrap();
            let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
            assert_eq!(
                ids,
                vec!["RONLY"],
                "Tag fast path must include a block_tag_refs-only block \
                 (inherited={inherited})"
            );

            // Prefix leaf, same assertion.
            let resp = eval_tag_query(
                &pool,
                &TagExpr::Prefix("ref".into()),
                &page,
                inherited,
                None,
                None,
            )
            .await
            .unwrap();
            let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
            assert_eq!(
                ids,
                vec!["RONLY"],
                "Prefix fast path must include a block_tag_refs-only \
                 block (inherited={inherited})"
            );
        }
    }
}
