//! App-layer pagination tests — the phase-7 cross-space link-enforcement
//! suite relocated out of `agaric_store::pagination`'s `tests.rs` (#2621, wave
//! S4b). These call the app-only command inner functions
//! (`batch_resolve_inner`, `get_page_inner`) in `crate::commands`, which live
//! above the store layer and cannot move down with the read module. Behaviour
//! is unchanged from the pre-move `pagination/tests.rs::tests_p7`.

// ====================================================================
// Phase 7 — cross-space link enforcement
// ====================================================================
//
// `batch_resolve_inner(ids, space_id)` and `get_page_inner(page_id,
// space_id, ...)` both gain a required `space_id` parameter that
// enforces space membership. The locked-in policy is "no live links
// between spaces, ever":
//
//   - `batch_resolve_inner` filters foreign-space targets out of the
//     result set so the chip falls into the "unknown id" branch on the
//     frontend → broken-link UX. Same `COALESCE(b.page_id, b.id) IN
//     (SELECT bp.block_id FROM block_properties bp WHERE bp.key='space'
//     AND bp.value_ref = ?)` filter shipped in Phase 2 for list paths.
//   - `get_page_inner` rejects with `AppError::Validation` when the
//     requested page's `space` property does not match `space_id` so
//     deep-linking into a foreign page from a different space's tab
//     stack is impossible.
//
// `list_block_history` (different from `list_page_history` — see
// `pagination::history`) is intentionally left unscoped: per-block
// history viewing is allowed across spaces (it's an admin/diagnostics
// surface, not a user-facing navigation entry-point). The umbrella
// Design explicitly carves it out.

mod tests_p7 {
    use crate::commands::{batch_resolve_inner, get_page_inner};
    use crate::error::AppError;
    use crate::space::{SpaceId, SpaceScope};
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    // ── Helpers (copied verbatim from the pre-move `pagination/tests.rs` so the
    //    relocated suite stays self-contained in the app crate). ─────────────

    /// ID used for the synthetic "SPACE_A" space block (satisfies the
    /// `block_properties.value_ref → blocks(id)` FK).
    const SPACE_A_ID: &str = "SPACE_AA";
    /// ID used for the synthetic "SPACE_B" space block.
    const SPACE_B_ID: &str = "SPACE_BB";
    /// Synthetic third space — required by the property-style regression
    /// test below to model "more than two spaces" without depending on
    /// the bootstrap-seeded Personal/Work pair.
    const SPACE_C_ID: &str = "SPACE_CC";

    /// Create a fresh SQLite pool with migrations applied (temp directory).
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = crate::db::init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Insert a block with optional parent and position.
    ///
    /// SQL-review §5.3 — stamps `page_id` per post-migration-0066 invariant.
    async fn insert_block(
        pool: &SqlitePool,
        id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        position: Option<i64>,
    ) {
        let page_id: Option<String> = if block_type == "page" {
            Some(id.to_string())
        } else {
            Some(parent_id.unwrap_or(id).to_string())
        };
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(block_type)
        .bind(content)
        .bind(parent_id)
        .bind(position)
        .bind(page_id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Insert a page block that is itself a space (`is_space = 'true'`). The
    /// page row must exist for the `block_properties.value_ref` FK to
    /// succeed when a later page is assigned to this space.
    async fn insert_space_block(pool: &SqlitePool, id: &str, name: &str) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', ?, NULL, 1, ?)",
        )
        .bind(id)
        .bind(name)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'is_space', 'true')",
        )
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Assign a block to a space by stamping the denormalized `blocks.space_id`
    /// column directly. Bypasses `set_property_in_tx` intentionally — these
    /// tests target the filter SQL, not the command layer.
    async fn assign_to_space(pool: &SqlitePool, block_id: &str, space_id: &str) {
        // #533: stamp the denormalized `blocks.space_id` column — every block
        // whose owning page is `block_id` (pages carry `page_id = id`) is in
        // this space. Equivalent to the old `b.page_id IN (...)` filter.
        sqlx::query("UPDATE blocks SET space_id = ? WHERE page_id = ?")
            .bind(space_id)
            .bind(block_id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Insert a block with an explicit `page_id` column value. Required for
    /// content blocks under a space-scoped parent — the space filter uses
    /// `COALESCE(b.page_id, b.id)` so children must carry the parent's id in
    /// `page_id` for the filter to resolve through the parent's `space`
    /// property.
    async fn insert_block_with_page_id(
        pool: &SqlitePool,
        id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        position: Option<i64>,
        page_id: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(block_type)
        .bind(content)
        .bind(parent_id)
        .bind(position)
        .bind(page_id)
        .execute(pool)
        .await
        .unwrap();
        // #533: a block inherits the denormalized `space_id` of its owning
        // page (mirrors production `set_block_space_id_from_parent`), so tests
        // that assign the page's space before inserting children still resolve.
        sqlx::query("UPDATE blocks SET space_id = (SELECT p.space_id FROM blocks p WHERE p.id = ?) WHERE id = ?")
            .bind(page_id)
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Test 1 — cross-space resolution: a chip whose target lives in a
    /// foreign space silently drops out of the resolution result. The
    /// frontend's `useResolveStore` then renders the chip via the
    /// "unknown id" branch (broken-link UX).
    #[tokio::test]
    async fn batch_resolve_excludes_foreign_space_pages() {
        let (pool, _dir) = test_pool().await;
        insert_space_block(&pool, SPACE_A_ID, "Personal").await;
        insert_space_block(&pool, SPACE_B_ID, "Work").await;

        // One page per space.
        insert_block(&pool, "PG_A", "page", "Personal page", None, Some(1)).await;
        assign_to_space(&pool, "PG_A", SPACE_A_ID).await;
        insert_block(&pool, "PG_B", "page", "Work page", None, Some(2)).await;
        assign_to_space(&pool, "PG_B", SPACE_B_ID).await;

        // From inside SPACE_A, asking to resolve both PG_A and PG_B must
        // return PG_A only — PG_B is in a foreign space and falls out.
        let resolved = batch_resolve_inner(
            &pool,
            vec!["PG_A".into(), "PG_B".into()],
            &SpaceScope::Active(SpaceId::from_trusted(SPACE_A_ID)),
        )
        .await
        .unwrap();

        assert_eq!(
            resolved.len(),
            1,
            "exactly the SPACE_A page must surface; foreign target must be silently dropped"
        );
        assert_eq!(
            resolved[0].id, "PG_A",
            "the surviving entry must be the SPACE_A page"
        );
        assert!(
            !resolved.iter().any(|r| r.id == "PG_B"),
            "PG_B (foreign space) MUST NOT appear in the result"
        );
    }

    /// Test 2 — `get_page_inner` rejects deep-link/page-fetch attempts
    /// that cross a space boundary with `AppError::Validation`.
    #[tokio::test]
    async fn get_page_rejects_foreign_space_target() {
        let (pool, _dir) = test_pool().await;
        insert_space_block(&pool, SPACE_A_ID, "Personal").await;
        insert_space_block(&pool, SPACE_B_ID, "Work").await;

        insert_block(
            &pool,
            "01PAGEA0NKY00000000000000A",
            "page",
            "Personal-only",
            None,
            Some(1),
        )
        .await;
        assign_to_space(&pool, "01PAGEA0NKY00000000000000A", SPACE_A_ID).await;

        // Same-space fetch must succeed (sanity check the happy path
        // before testing the foreign-space branch).
        let ok = get_page_inner(
            &pool,
            "01PAGEA0NKY00000000000000A",
            SPACE_A_ID,
            None,
            Some(10),
        )
        .await
        .expect("same-space fetch must succeed");
        assert_eq!(ok.page.id, "01PAGEA0NKY00000000000000A");

        // Foreign-space fetch must be rejected.
        let err = get_page_inner(
            &pool,
            "01PAGEA0NKY00000000000000A",
            SPACE_B_ID,
            None,
            Some(10),
        )
        .await
        .expect_err("foreign-space fetch must be rejected");
        assert!(
            matches!(err, AppError::Validation { .. }),
            "foreign-space rejection must be Validation, got {err:?}"
        );
    }

    /// Test 3 — there is no `get_block_with_children_inner` in this
    /// codebase. The single-block-with-subtree fetch surface is
    /// `get_page_inner` (the page editor / deep-link / journal nav
    /// entry-point). Bare `get_block_inner` returns a single row (no
    /// subtree) and is used by MCP / undo / batch-resolve paths where
    /// space scoping is enforced upstream.
    ///
    /// To keep the contract honest we cover the related
    /// regression — a page that has no `space` property at all (legacy
    /// pre-Phase-2 vault content that bypassed bootstrap somehow) is
    /// also rejected by `get_page_inner` regardless of the requested
    /// space, because no row matches the membership subquery.
    #[tokio::test]
    async fn get_page_rejects_unscoped_target() {
        let (pool, _dir) = test_pool().await;
        insert_space_block(&pool, SPACE_A_ID, "Personal").await;

        // Page with NO space property — represents legacy / corrupted
        // state. The membership query has nothing to match on.
        insert_block(
            &pool,
            "01PAGENSPACE000000000000NS",
            "page",
            "Unscoped",
            None,
            Some(1),
        )
        .await;

        let err = get_page_inner(
            &pool,
            "01PAGENSPACE000000000000NS",
            SPACE_A_ID,
            None,
            Some(10),
        )
        .await
        .expect_err("unscoped page must be rejected from any space");
        assert!(
            matches!(err, AppError::Validation { .. }),
            "unscoped page must be Validation, got {err:?}"
        );
    }

    /// Test 3b (#1652) — `get_page_inner` subtree walk across a page
    /// boundary. The subtree path assembles `has_more` / `next_cursor` /
    /// truncate via the shared `split_position_keyset_page` helper (rather
    /// than `build_page_response`, because `PageSubtreeResponse` is not a
    /// `PageResponse<T>`). The other `get_page_inner` tests only fetch a
    /// single page (limit ≥ child count), so none would catch an off-by-one
    /// in the `limit + 1` over-fetch / truncate / next-cursor-from-last-row
    /// logic of the refactored helper. This walks 3 children at limit=2 —
    /// page1 (2 children, has_more, cursor) then page2 (1 child, no more) —
    /// and asserts the union covers every child exactly once in `(position,
    /// id)` order, so a dropped / duplicated / off-by-one boundary fails.
    #[tokio::test]
    async fn get_page_subtree_paginates_across_boundary_1652() {
        let (pool, _dir) = test_pool().await;
        insert_space_block(&pool, SPACE_A_ID, "Personal").await;

        const PAGE: &str = "01PAGE1652000000000000PAGE";
        insert_block(&pool, PAGE, "page", "Boundary", None, Some(1)).await;
        assign_to_space(&pool, PAGE, SPACE_A_ID).await;

        // Three children at positions 1, 2, 3 — deterministic (position, id)
        // order: C1, C2, C3.
        const C1: &str = "01CHILD1652000000000000C1A";
        const C2: &str = "01CHILD1652000000000000C2B";
        const C3: &str = "01CHILD1652000000000000C3C";
        insert_block(&pool, C1, "content", "c1", Some(PAGE), Some(1)).await;
        insert_block(&pool, C2, "content", "c2", Some(PAGE), Some(2)).await;
        insert_block(&pool, C3, "content", "c3", Some(PAGE), Some(3)).await;

        // Page 1 — limit 2 over a 3-child subtree must over-fetch, truncate
        // to 2, flag has_more, and emit a resume cursor.
        let p1 = get_page_inner(&pool, PAGE, SPACE_A_ID, None, Some(2))
            .await
            .expect("page 1 must succeed");
        let ids1: Vec<String> = p1.children.iter().map(|c| c.id.to_string()).collect();
        assert_eq!(
            ids1,
            vec![C1.to_string(), C2.to_string()],
            "page1 = [C1, C2]"
        );
        assert!(p1.has_more, "page1 must flag more children remaining");
        let cursor = p1
            .next_cursor
            .clone()
            .expect("page1 must carry a resume cursor when has_more");

        // Page 2 — resuming from the cursor must yield exactly the final
        // child with no further pages and no trailing cursor.
        let p2 = get_page_inner(&pool, PAGE, SPACE_A_ID, Some(cursor), Some(2))
            .await
            .expect("page 2 must succeed");
        let ids2: Vec<String> = p2.children.iter().map(|c| c.id.to_string()).collect();
        assert_eq!(ids2, vec![C3.to_string()], "page2 = [C3]");
        assert!(!p2.has_more, "page2 must NOT flag more children");
        assert!(
            p2.next_cursor.is_none(),
            "no trailing cursor once has_more is false"
        );

        // Union covers every child exactly once — a dropped or duplicated
        // boundary row fails here.
        let mut all: Vec<String> = ids1.into_iter().chain(ids2).collect();
        all.sort();
        all.dedup();
        assert_eq!(
            all,
            vec![C1.to_string(), C2.to_string(), C3.to_string()],
            "the two pages together must cover all 3 children exactly once"
        );
    }

    /// Test 4 — deterministic property-style regression: 3 spaces × 5
    /// pages each (15 pages) × 2 foreign spaces per page (30 foreign
    /// pairs). Every foreign-space resolution MUST return None and
    /// every foreign-space `get_page_inner` MUST return Validation.
    /// Same-space queries MUST succeed (12 same-space pairs).
    ///
    /// The codebase has `proptest` available but a deterministic walk
    /// is sufficient for this regression — the predicate is a closed-form
    /// "for all (page, space)" assertion, not a search over a large
    /// State-space. Per the user's instruction,
    /// ship the deterministic version for clarity and CI determinism.
    #[tokio::test]
    async fn property_no_cross_space_resolution_or_fetch() {
        let (pool, _dir) = test_pool().await;
        insert_space_block(&pool, SPACE_A_ID, "Personal").await;
        insert_space_block(&pool, SPACE_B_ID, "Work").await;
        insert_space_block(&pool, SPACE_C_ID, "Archive").await;

        let spaces: [&str; 3] = [SPACE_A_ID, SPACE_B_ID, SPACE_C_ID];
        // Seed 5 pages per space. Page IDs encode (space_index,
        // page_index) so failures pinpoint the offending pair.
        let mut all_pages: Vec<(String, &'static str)> = Vec::with_capacity(15);
        for (s_idx, space_id) in spaces.iter().enumerate() {
            for p_idx in 0..5 {
                let page_id = format!("01PAGE0000000000000000S{s_idx}P{p_idx}");
                insert_block(
                    &pool,
                    &page_id,
                    "page",
                    &format!("page {p_idx} in space {s_idx}"),
                    None,
                    Some(i64::from(p_idx) + 1),
                )
                .await;
                assign_to_space(&pool, &page_id, space_id).await;
                // Add one descendant per page so `get_page_inner`'s
                // subtree walk has something to chew on. The descendant
                // inherits its parent's space via the `page_id` column.
                let child_id = format!("01CHKD0000000000000000S{s_idx}P{p_idx}");
                insert_block_with_page_id(
                    &pool,
                    &child_id,
                    "content",
                    &format!("child of page {p_idx}"),
                    Some(&page_id),
                    Some(1),
                    Some(&page_id),
                )
                .await;
                all_pages.push((page_id, space_id));
            }
        }

        // For every (page, space) pair: same-space succeeds, foreign-space fails.
        for (page_id, owning_space) in &all_pages {
            for candidate_space in &spaces {
                if candidate_space == owning_space {
                    // Same-space — both APIs must succeed.
                    let resolved = batch_resolve_inner(
                        &pool,
                        vec![page_id.clone().into()],
                        &SpaceScope::Active(SpaceId::from_trusted(candidate_space)),
                    )
                    .await
                    .expect("same-space resolve must succeed");
                    assert_eq!(
                        resolved.len(),
                        1,
                        "same-space resolve of {page_id} from {candidate_space} must return the page"
                    );
                    assert_eq!(resolved[0].id, *page_id);

                    let page_resp = get_page_inner(&pool, page_id, candidate_space, None, Some(10))
                        .await
                        .expect("same-space get_page must succeed");
                    assert_eq!(page_resp.page.id, *page_id);
                } else {
                    // Foreign-space — both APIs must reject.
                    let resolved = batch_resolve_inner(
                        &pool,
                        vec![page_id.clone().into()],
                        &SpaceScope::Active(SpaceId::from_trusted(candidate_space)),
                    )
                    .await
                    .expect("foreign-space resolve must not error, just drop the row");
                    assert!(
                        resolved.is_empty(),
                        "foreign-space resolve of {page_id} from {candidate_space} must return empty (got {} entries)",
                        resolved.len()
                    );

                    let err = get_page_inner(&pool, page_id, candidate_space, None, Some(10))
                        .await
                        .expect_err("foreign-space get_page must reject");
                    assert!(
                        matches!(err, AppError::Validation { .. }),
                        "foreign-space get_page of {page_id} from {candidate_space} must be Validation, got {err:?}"
                    );
                }
            }
        }
    }
}

// ====================================================================
// BlockRow canonical-SELECT drift guards (Test B + Test C)
// ====================================================================
//
// Relocated from `agaric_store::pagination::block_row_columns`'s test module
// (#2621, wave S4b). These scan the whole `src-tauri` source tree — both the
// `agaric` app crate and the `agaric-store` crate — for `query_as!(BlockRow,
// …)` / runtime `format!("SELECT {} FROM blocks …")` sites and assert every
// one uses the canonical column list. Because they `include_str!` app-only
// source files (`commands/…`, `domain/…`, `recurrence/…`, `backlink/…`) that
// stay in the app crate, they must live at the app level where both crates'
// files are reachable via relative paths. The canonical consts are read from
// `crate::pagination::block_row_columns` (re-exported from the store). Test A
// (const↔fields parity) and Test D (`b.`-alias parity) stay in the store since
// they are self-contained.

mod block_row_canonical_conformance {
    use crate::pagination::block_row_columns::{
        BLOCK_ROW_CANONICAL_FIELDS, BLOCK_ROW_CANONICAL_SELECT, BLOCK_ROW_RUNTIME_SELECT,
    };

    /// Collapse every run of ASCII whitespace (spaces, tabs, newlines,
    /// `\` line continuations after splitting) to a single space, and
    /// trim leading/trailing whitespace.  Used to render multi-line
    /// SQL SELECT clauses comparable to the canonical single-line
    /// constant. (Copied from the store's `block_row_columns` test mod.)
    fn normalize_whitespace(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut last_was_space = true;
        for c in s.chars() {
            if c.is_whitespace() {
                if !last_was_space {
                    out.push(' ');
                    last_was_space = true;
                }
            } else {
                out.push(c);
                last_was_space = false;
            }
        }
        out.trim().to_string()
    }

    /// Strip the `b.` table-alias prefix from column references so
    /// JOIN-style sites compare equal to the unprefixed canonical.
    /// (Copied from the store's `block_row_columns` test mod.)
    fn strip_blocks_alias(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut iter = s.char_indices().peekable();
        while let Some((_, c)) = iter.next() {
            if c == 'b' && iter.peek().map(|&(_, n)| n) == Some('.') {
                let at_word_boundary = out
                    .chars()
                    .last()
                    .is_none_or(|p| !(p.is_alphanumeric() || p == '_'));
                if at_word_boundary {
                    iter.next(); // consume the '.'
                    continue;
                }
            }
            out.push(c);
        }
        out
    }

    /// Normalise a `query_as!(BlockRow, …)` SELECT clause for comparison:
    /// strip the `b.` alias, collapse whitespace, and unify the `BlockId`
    /// type-cast crate path. The same `agaric_core::ulid::BlockId` type is
    /// spelled `agaric_core::ulid::BlockId` at the `agaric-store` sites (which
    /// import it directly) and `crate::ulid::BlockId` at the `agaric` app sites
    /// (which reach it via the app crate's `pub use agaric_core::ulid` re-export)
    /// — both must compare equal, so fold the store spelling onto the app one
    /// (#2621, wave S4b).
    fn canonicalize_select(s: &str) -> String {
        normalize_whitespace(&strip_blocks_alias(s)).replace("agaric_core::ulid::", "crate::ulid::")
    }

    /// Test B — every `query_as!(BlockRow, ...)` callsite in the
    /// production source tree must use the canonical SELECT column
    /// list (after stripping the `b.` alias and collapsing
    /// whitespace).  Each source file is embedded at compile time
    /// via `include_str!` so the test is fully self-contained and
    /// runs without any filesystem access.
    ///
    /// The fixed-list-of-files approach (rather than a directory
    /// walk) is deliberate: when a developer adds a new
    /// `query_as!(BlockRow, …)` site in a file not yet listed here,
    /// the count assertion below catches it and forces a conscious
    /// decision to extend the list.
    #[test]
    fn block_row_canonical_query_as_sites_match_canonical_columns() {
        // (display_path, file_contents).  Paths are relative to this
        // module file (`src-tauri/src/pagination_app_tests.rs`); the
        // `agaric-store` sites reach across the crate boundary via
        // `../agaric-store/src/…` (#2621, wave S4b).
        let sources: &[(&str, &str)] = &[
            (
                "commands/blocks/crud.rs",
                include_str!("commands/blocks/crud.rs"),
            ),
            // #882: the `set_property_in_tx` core (with its
            // `query_as!(BlockRow, …)` existence probe) moved here from
            // `commands/blocks/crud.rs`. #2621 (inversion): the block_ops
            // writers then moved into `agaric-engine`, so the site now lives
            // at `agaric-engine/src/block_ops.rs`, reached across the crate
            // boundary via `../agaric-engine/…` (like the pagination sites).
            // Net site count is unchanged.
            (
                "agaric-engine/src/block_ops.rs",
                include_str!("../agaric-engine/src/block_ops.rs"),
            ),
            (
                "commands/blocks/queries.rs",
                include_str!("commands/blocks/queries.rs"),
            ),
            ("commands/journal.rs", include_str!("commands/journal.rs")),
            (
                "commands/pages/markdown.rs",
                include_str!("commands/pages/markdown.rs"),
            ),
            (
                "commands/pages/listing.rs",
                include_str!("commands/pages/listing.rs"),
            ),
            (
                "commands/properties.rs",
                include_str!("commands/properties.rs"),
            ),
            (
                "pagination/agenda.rs",
                include_str!("../agaric-store/src/pagination/agenda.rs"),
            ),
            (
                "pagination/hierarchy.rs",
                include_str!("../agaric-store/src/pagination/hierarchy.rs"),
            ),
            (
                "pagination/tags.rs",
                include_str!("../agaric-store/src/pagination/tags.rs"),
            ),
            (
                "pagination/trash.rs",
                include_str!("../agaric-store/src/pagination/trash.rs"),
            ),
            (
                "pagination/undated.rs",
                include_str!("../agaric-store/src/pagination/undated.rs"),
            ),
            (
                "recurrence/compute.rs",
                include_str!("recurrence/compute.rs"),
            ),
            // #2621 (inversion): the recurrence sibling-compute core — with its
            // `query_as!(BlockRow, …)` sibling lookup — moved into
            // `agaric-engine`, so the production site now lives at
            // `agaric-engine/src/recurrence/compute.rs`, reached across the
            // crate boundary via `../agaric-engine/…` (like the block_ops and
            // pagination sites). Net site count is unchanged.
            (
                "agaric-engine/src/recurrence/compute.rs",
                include_str!("../agaric-engine/src/recurrence/compute.rs"),
            ),
        ];

        // Match `query_as!(\s*BlockRow\s*,\s*<string-literal opener>SELECT
        // <columns> FROM ...`.  The opener allows the Rust raw-string
        // forms `r#"`, `r"`, or the plain `"` form.  `(?s)` makes `.`
        // match newlines so multi-line SELECT clauses are captured.
        // The non-greedy `(.+?)` stops at the first ` FROM ` token,
        // which always introduces the table list.
        let re =
            regex::Regex::new(r#"(?s)query_as!\(\s*BlockRow\s*,\s*r?#?"SELECT\s+(.+?)\s+FROM\s+"#)
                .expect("regex compiles");

        let canonical_normalized = canonicalize_select(BLOCK_ROW_CANONICAL_SELECT);

        let mut total_hits = 0usize;
        let mut failures: Vec<String> = Vec::new();

        for (path, src) in sources {
            for cap in re.captures_iter(src) {
                total_hits += 1;
                let raw_select = &cap[1];
                let normalized = canonicalize_select(raw_select);
                if normalized != canonical_normalized {
                    let line = src[..cap.get(0).unwrap().start()].matches('\n').count() + 1;
                    failures.push(format!(
                        "  {path}:{line}\n    actual:    {normalized}\n    canonical: {canonical_normalized}",
                    ));
                }
            }
        }

        assert!(
            failures.is_empty(),
            "{} `query_as!(BlockRow, …)` site(s) drift from \
             BLOCK_ROW_CANONICAL_SELECT (after stripping `b.` alias \
             and collapsing whitespace):\n{}\n\nUpdate the drifted \
             SELECT clause(s) to match BLOCK_ROW_CANONICAL_SELECT, \
             or — if the deviation is intentional — add the file to \
             an exclusion list and document why.",
            failures.len(),
            failures.join("\n"),
        );

        // Catches: a new `query_as!(BlockRow, …)` site is added to a
        // file already in the list above, or to a file NOT yet in
        // the list (which would not be detected by the column-list
        // check because `include_str!` wouldn't see it).  The
        // expected count is the sum of hits across every listed
        // file as audited at the time this test was written.
        //
        // When BlockRow gains a query_as! site (or when one is
        // removed), this assertion fails — bump the constant
        // deliberately and confirm the new site uses the canonical
        // SELECT.
        // #660: export_page_markdown_inner inlined its page-row lookup as a
        // canonical-column `query_as!(BlockRow, …)` (snapshot-isolation fix),
        // adding one site in commands/pages/markdown.rs → 16.
        const EXPECTED_HITS: usize = 16;
        assert_eq!(
            total_hits, EXPECTED_HITS,
            "expected {EXPECTED_HITS} `query_as!(BlockRow, …)` \
             matches across the listed production source files, \
             found {total_hits}. Either a site was added/removed, \
             or the source file list above is missing a file. \
             Audit `grep -rn 'query_as!(' src-tauri/src/ | grep -B1 \
             'BlockRow,' | grep 'sqlx::query_as'` and reconcile.",
        );
    }

    /// Test C — every runtime `sqlx::query_as::<_, BlockRow>(…)` /
    /// `sqlx::query_as::<_, ActiveBlockRow>(…)` callsite covered by
    /// Must reference [`BLOCK_ROW_RUNTIME_SELECT`] (rather
    /// than embedding the 13-column list inline). Mirrors Test B but
    /// for the runtime form, which slips past Test B's regex because
    /// it uses turbofish syntax and a runtime `&str` argument.
    ///
    /// The captured SELECT-column slot is parametric: post-
    /// it is the literal `{}` placeholder (substituted by the
    /// `format!` arg), and substituting [`BLOCK_ROW_RUNTIME_SELECT`]
    /// in for the placeholder yields the canonical column list. If
    /// a future change inlines the columns again, the substitution
    /// is a no-op and the comparison catches the drift directly.
    ///
    /// Allowlist is intentionally narrow: `backlink/query.rs` and
    /// `tag_query/query.rs` are the 2 files covers. The
    /// `pagination/properties.rs` runtime sites have a `b.` alias on
    /// every column and additional `WHERE`-clause complexity; they
    /// are tracked separately and not part of this parity test.
    #[test]
    fn block_row_canonical_runtime_sites_match_canonical_columns() {
        // First: assert `BLOCK_ROW_RUNTIME_SELECT` itself parses to
        // the canonical field list (mirrors Test A's check for the
        // macro-form const). The runtime form has no `as "x: T"`
        // casts so the parse is a simple split-on-comma + trim. This
        // guards against drift in the const itself, independent of
        // the production callsites.
        let runtime_parsed: Vec<String> = BLOCK_ROW_RUNTIME_SELECT
            .split(',')
            .map(|raw| raw.trim().to_string())
            .collect();
        let expected_fields: Vec<String> = BLOCK_ROW_CANONICAL_FIELDS
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        assert_eq!(
            runtime_parsed, expected_fields,
            "BLOCK_ROW_RUNTIME_SELECT has drifted from \
             BLOCK_ROW_CANONICAL_FIELDS. Update both consts together \
             so the parsed column names exactly match the field list."
        );

        let sources: &[(&str, &str)] = &[
            (
                "backlink/query.rs",
                include_str!("../agaric-store/src/backlink/query.rs"),
            ),
            (
                "tag_query/query.rs",
                include_str!("../agaric-store/src/tag_query/query.rs"),
            ),
        ];

        // Match `format!("SELECT {} FROM blocks …")` — the
        // Post- placeholder form used at all 3 runtime sites.
        // `[\s\\]+` matches Rust string-continuation backslashes (the
        // plain `"…"` form joins lines via `\<newline>`, unlike the
        // raw `r#"…"#` form used by the macro sites in Test B). The
        // tightened regex (capturing `\{\}` literal, not arbitrary
        // text) avoids false positives from other `format!()` calls
        // in the same files (e.g. `resolve_root_pages` selects
        // `id as block_id, …` from `blocks` but is NOT a BlockRow
        // runtime site).
        let re = regex::Regex::new(
            r#"(?s)format!\(\s*r?#?"SELECT[\s\\]+(\{\})[\s\\]+FROM[\s\\]+blocks"#,
        )
        .expect("regex compiles");

        let canonical_normalized = normalize_whitespace(BLOCK_ROW_RUNTIME_SELECT);

        let mut total_hits = 0usize;
        let mut failures: Vec<String> = Vec::new();

        for (path, src) in sources {
            for cap in re.captures_iter(src) {
                total_hits += 1;
                let m = cap.get(0).expect("capture group 0 exists");
                let raw_select = &cap[1];

                // Substitute the captured `{}` placeholder with the
                // canonical const value and verify the result matches
                // the canonical column list. Substitution is
                // tautological for the placeholder form (always
                // produces `BLOCK_ROW_RUNTIME_SELECT`), but the explicit
                // comparison documents the contract and catches the
                // hypothetical case where the const itself drifts from
                // the placeholder substitution shape.
                let substituted = raw_select.replace("{}", BLOCK_ROW_RUNTIME_SELECT);
                let normalized = normalize_whitespace(&strip_blocks_alias(&substituted));
                if normalized != canonical_normalized {
                    failures.push(format!(
                        "  {path} (placeholder substitution failed)\n    actual:    {normalized}\n    canonical: {canonical_normalized}",
                    ));
                    continue;
                }

                // Verify the format! call passes `BLOCK_ROW_RUNTIME_SELECT`
                // as the substitution argument. The const reference
                // appears within ~500 chars after the SELECT-literal
                // match (immediately after the closing `"` of the
                // format string in all 3 sites). Drift case: someone
                // substitutes a wrong const that happens to share the
                // same visible form but isn't `BLOCK_ROW_RUNTIME_SELECT`.
                let after = &src[m.end()..];
                let window = &after[..after.len().min(500)];
                if !window.contains("BLOCK_ROW_RUNTIME_SELECT") {
                    failures.push(format!(
                        "  {path}: format!(\"SELECT {{}} FROM blocks…\") at byte {} does not reference BLOCK_ROW_RUNTIME_SELECT in its argument list (within 500 chars).",
                        m.start(),
                    ));
                }
            }
        }

        assert!(
            failures.is_empty(),
            "{} runtime `sqlx::query_as::<_, …>(format!(…))` site(s) \
             drift from BLOCK_ROW_RUNTIME_SELECT:\n{}\n\nUpdate the \
             drifted SELECT clause(s) to use `BLOCK_ROW_RUNTIME_SELECT` \
             via the `format!(\"SELECT {{}} FROM blocks…\", \
             …::BLOCK_ROW_RUNTIME_SELECT)` shape, or — if the \
             deviation is intentional — add the file to an exclusion \
             list and document why.",
            failures.len(),
            failures.join("\n"),
        );

        // Catches: a new runtime `query_as::<_, BlockRow>(format!(…))`
        // site is added to a file in the allowlist (count goes up), one
        // is removed (count goes down), or one drifts to inline-columns
        // (count goes down because the regex no longer matches it). The
        // 3 expected hits are: backlink/query.rs (small-IN-list +
        // large-IN-list paths) + tag_query/query.rs (eval_tag_query
        // final projection).
        const EXPECTED_HITS: usize = 3;
        assert_eq!(
            total_hits, EXPECTED_HITS,
            "expected {EXPECTED_HITS} runtime `format!(\"SELECT {{}} \
             FROM blocks…\")` matches across the listed production \
             source files, found {total_hits}. Either a site was \
             added/removed/drifted-to-inline-columns, or the source \
             file list above is missing a file. Audit `grep -rn \
             'query_as::<_, \\(Block\\|Active\\)Row>' src-tauri/src/` \
             and reconcile.",
        );
    }
}

// ====================================================================
// (position, id) keyset drift guard (#1652, Test B)
// ====================================================================
//
// Relocated from `agaric_store::pagination::tests::position_keyset_drift`
// (#2621, wave S4b). The `(COALESCE(position, sentinel), id)` keyset is inlined
// verbatim at three `sqlx::query_as!` sites that now span both crates:
// `pagination::list_children` (agaric-store) and `commands::pages::get_page_inner`
// + the `commands::pages::markdown` export walk (agaric app). A recursive walk
// of a single crate's `src/` can no longer see all three, so this scanning test
// lives at the app level and walks BOTH crate source roots. Test A
// (canonical-const self-consistency) stays in the store since it needs no walk.

mod position_keyset_drift {
    use crate::pagination::{POSITION_KEYSET_ORDER_CANONICAL, POSITION_KEYSET_WHERE_CANONICAL};
    use regex::Regex;

    /// Render a keyset SQL fragment into comparable canonical form by:
    /// 1. Replacing every `?<digits>` (e.g. `?3`, `?6`, `?7`) with `?N` —
    ///    the bind index varies per callsite.
    /// 2. Collapsing every run of ASCII whitespace (incl. the `\` line-
    ///    continuations in plain string literals and the newlines in raw
    ///    string SQL) to a single space.
    /// 3. Removing whitespace immediately adjacent to `(`/`)` so differing
    ///    indentation inside the parenthesised condition collapses.
    ///
    /// (Copied from the store's `position_keyset_drift` test mod.)
    fn normalize_keyset(s: &str) -> String {
        let numbered_re = Regex::new(r"\?\d+").expect("numbered placeholder regex compiles");
        let s = numbered_re.replace_all(s, "?N").to_string();
        let ws_re = Regex::new(r"[\s\\]+").expect("whitespace regex compiles");
        let s = ws_re.replace_all(&s, " ").to_string();
        let paren_open_re = Regex::new(r"\(\s+").expect("paren-open regex compiles");
        let s = paren_open_re.replace_all(&s, "(").to_string();
        let paren_close_re = Regex::new(r"\s+\)").expect("paren-close regex compiles");
        let s = paren_close_re.replace_all(&s, ")").to_string();
        s.trim().to_string()
    }

    /// Recursively collect `(relative_path, contents)` for every `*.rs` file
    /// under `dir`, with paths relative to `src_root`.
    /// (Copied from the store's `position_keyset_drift` test mod.)
    fn collect_rs_files(
        dir: &std::path::Path,
        src_root: &std::path::Path,
    ) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let entries = std::fs::read_dir(dir)
            .unwrap_or_else(|e| panic!("read_dir {} failed: {e}", dir.display()));
        for entry in entries {
            let entry = entry.expect("dir entry");
            let path = entry.path();
            if path.is_dir() {
                out.extend(collect_rs_files(&path, src_root));
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                let rel = path
                    .strip_prefix(src_root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let contents = std::fs::read_to_string(&path)
                    .unwrap_or_else(|e| panic!("read {} failed: {e}", path.display()));
                out.push((rel, contents));
            }
        }
        out
    }

    /// Test B — every inlined `(COALESCE(position, sentinel), id)` keyset
    /// WHERE condition and ORDER BY found by a recursive walk of BOTH the
    /// `agaric` app crate and the `agaric-store` crate source trees
    /// normalises to the canonical shape. A new copy in *any* file is
    /// automatically policed (no allowlist, no magic count). If the three
    /// known copies ever diverge again, this fails CI.
    #[test]
    fn position_keyset_production_sites_match_canonical() {
        // The store's `pagination/tests.rs` holds the hand-written `alternate`
        // strings in Test A, which are canonical by construction; policing them
        // is circular.
        const DENY_FILES: &[&str] = &["pagination/tests.rs"];

        // Walk both crate source roots. `CARGO_MANIFEST_DIR` is `src-tauri`
        // (the app crate); `agaric-store/src` is the store crate's tree.
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let app_src = manifest.join("src");
        let store_src = manifest.join("agaric-store").join("src");
        let mut sites = collect_rs_files(&app_src, &app_src);
        sites.extend(collect_rs_files(&store_src, &store_src));

        // WHERE-keyset locator: the parenthesised `(?N IS NULL OR ( COALESCE
        // (position, ?N) > ?N OR (COALESCE(position, ?N) = ?N AND id > ?N)))`
        // condition. `(?s)` so multi-line raw-string SQL is captured;
        // `[\s\\]*` between tokens absorbs whitespace + `\` continuations.
        let where_re = Regex::new(
            r"(?s)\(\s*\?\d+[\s\\]+IS[\s\\]+NULL[\s\\]+OR[\s\\]*\([\s\\]*COALESCE\(position,[\s\\]*\?\d+\)[\s\\]*>[\s\\]*\?\d+[\s\\]+OR[\s\\]*\(COALESCE\(position,[\s\\]*\?\d+\)[\s\\]*=[\s\\]*\?\d+[\s\\]+AND[\s\\]+id[\s\\]*>[\s\\]*\?\d+\)\)\)",
        )
        .expect("keyset WHERE pattern regex must compile");

        // ORDER-BY locator: `ORDER BY COALESCE(position, ?N) ASC, id ASC`.
        let order_re = Regex::new(
            r"(?s)ORDER[\s\\]+BY[\s\\]+COALESCE\(position,[\s\\]*\?\d+\)[\s\\]+ASC,[\s\\]+id[\s\\]+ASC",
        )
        .expect("keyset ORDER BY pattern regex must compile");

        let where_norm = normalize_keyset(POSITION_KEYSET_WHERE_CANONICAL);
        let order_norm = normalize_keyset(POSITION_KEYSET_ORDER_CANONICAL);
        let mut where_hits = 0usize;
        let mut order_hits = 0usize;
        let mut failures: Vec<String> = Vec::new();

        for (path, content) in &sites {
            if DENY_FILES.contains(&path.as_str()) {
                continue;
            }
            for m in where_re.find_iter(content) {
                where_hits += 1;
                let site = normalize_keyset(m.as_str());
                if site != where_norm {
                    failures.push(format!(
                        "  {path} (WHERE)\n    actual:    {site}\n    canonical: {where_norm}",
                    ));
                }
            }
            // Only assert ORDER BY shape where it accompanies a keyset
            // WHERE in the same file — `load_page_subtree` / the
            // `list_all_pages_in_space` content ordering also use ORDER BY but
            // are not (position, id) keyset walks. Restricting the ORDER-BY
            // parity to files that also carry the keyset WHERE keeps the guard
            // focused on the three duplicated keyset sites.
            if where_re.is_match(content) {
                for m in order_re.find_iter(content) {
                    order_hits += 1;
                    let site = normalize_keyset(m.as_str());
                    if site != order_norm {
                        failures.push(format!(
                            "  {path} (ORDER BY)\n    actual:    {site}\n    canonical: {order_norm}",
                        ));
                    }
                }
            }
        }

        assert!(
            failures.is_empty(),
            "{} (position, id) keyset fragment(s) drifted from the canonical \
             shape in pagination::mod (after bind-index + whitespace \
             normalisation):\n{}\n\nUpdate the drifted SQL to match \
             POSITION_KEYSET_WHERE_CANONICAL / POSITION_KEYSET_ORDER_CANONICAL, \
             or — if the deviation is intentional — extend `normalize_keyset` \
             and document why.",
            failures.len(),
            failures.join("\n"),
        );

        // The walk must always find the three known production copies; zero
        // means the regex or canonical shape changed and silently disabled
        // the guard. The keyset is duplicated at exactly three sites today;
        // assert at least that many so removing a copy (good) still leaves
        // ≥1 and a regex break (bad) trips the floor.
        assert!(
            where_hits >= 3,
            "expected ≥3 inlined keyset WHERE copies (list_children, \
             get_page_inner, markdown export); found {where_hits}. The \
             pattern regex or the canonical shape likely changed and \
             disabled this drift guard."
        );
        assert!(
            order_hits >= 3,
            "expected ≥3 inlined keyset ORDER BY copies; found {order_hits}."
        );
    }
}
