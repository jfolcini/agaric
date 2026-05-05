#![allow(unused_imports)]
use super::super::*;
use super::common::*;
use crate::space::{SpaceId, SpaceScope};

// ======================================================================
// page_aliases (#598)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_creates_and_returns_aliases() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE-1", "page", "My Page", None, Some(0)).await;

    let inserted = set_page_aliases_inner(&pool, "PAGE-1", vec!["Alpha".into(), "Beta".into()])
        .await
        .unwrap();

    assert_eq!(inserted.len(), 2, "should insert 2 aliases");
    assert!(
        inserted.contains(&"Alpha".to_string()),
        "should contain Alpha"
    );
    assert!(
        inserted.contains(&"Beta".to_string()),
        "should contain Beta"
    );

    // Verify persistence
    let aliases = get_page_aliases_inner(&pool, "PAGE-1").await.unwrap();
    assert_eq!(
        aliases,
        vec!["Alpha", "Beta"],
        "persisted aliases should match"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_replaces_existing() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE-2", "page", "Page Two", None, Some(0)).await;

    // Set initial aliases
    set_page_aliases_inner(&pool, "PAGE-2", vec!["Old1".into(), "Old2".into()])
        .await
        .unwrap();

    // Replace with new aliases
    let inserted = set_page_aliases_inner(
        &pool,
        "PAGE-2",
        vec!["New1".into(), "New2".into(), "New3".into()],
    )
    .await
    .unwrap();

    assert_eq!(inserted.len(), 3, "should insert 3 replacement aliases");

    let aliases = get_page_aliases_inner(&pool, "PAGE-2").await.unwrap();
    assert_eq!(
        aliases,
        vec!["New1", "New2", "New3"],
        "aliases should be fully replaced"
    );

    // Old aliases should be gone
    let resolved = resolve_page_by_alias_inner(&pool, "Old1").await.unwrap();
    assert!(resolved.is_none(), "old alias should no longer resolve");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_skips_empty_and_duplicates() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE-3", "page", "Page Three", None, Some(0)).await;

    let inserted = set_page_aliases_inner(
        &pool,
        "PAGE-3",
        vec![
            "  ".into(), // whitespace only — skipped
            "".into(),   // empty — skipped
            "Valid".into(),
            "Valid".into(), // duplicate — second insert is ignored
            "  Trimmed  ".into(),
        ],
    )
    .await
    .unwrap();

    // "Valid" appears once, "Trimmed" appears once
    assert_eq!(inserted.len(), 2, "should insert 2 unique aliases");
    assert!(
        inserted.contains(&"Valid".to_string()),
        "should contain Valid"
    );
    assert!(
        inserted.contains(&"Trimmed".to_string()),
        "should contain Trimmed"
    );
}

// M-21: `set_page_aliases_inner` wraps DELETE + INSERT in a single
// `BEGIN IMMEDIATE` transaction so that a mid-loop failure rolls the
// page back to its prior alias set instead of leaving a partial
// replacement. The three tests below exercise:
//   1. atomic full-set replacement (existing semantics preserved)
//   2. empty input clears all aliases
//   3. mid-loop failure rolls back to the original aliases
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_atomic_replaces_full_set() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE-TX-1", "page", "Page Tx 1", None, Some(0)).await;

    // Initial set: A, B, C
    set_page_aliases_inner(&pool, "PAGE-TX-1", vec!["A".into(), "B".into(), "C".into()])
        .await
        .unwrap();
    let initial = get_page_aliases_inner(&pool, "PAGE-TX-1").await.unwrap();
    assert_eq!(initial, vec!["A", "B", "C"], "initial set should be A,B,C");

    // Replace with: D, E
    let inserted = set_page_aliases_inner(&pool, "PAGE-TX-1", vec!["D".into(), "E".into()])
        .await
        .unwrap();
    assert_eq!(inserted.len(), 2, "should insert exactly 2 new aliases");

    // Final state must be EXACTLY D, E — no leftovers from the prior set.
    let final_state = get_page_aliases_inner(&pool, "PAGE-TX-1").await.unwrap();
    assert_eq!(
        final_state,
        vec!["D", "E"],
        "transactional replace should leave exactly the new set"
    );

    // And the prior aliases must no longer resolve.
    for old in ["A", "B", "C"] {
        let r = resolve_page_by_alias_inner(&pool, old).await.unwrap();
        assert!(
            r.is_none(),
            "old alias {old} must not resolve after replace"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_empty_clears_all() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE-TX-2", "page", "Page Tx 2", None, Some(0)).await;

    set_page_aliases_inner(&pool, "PAGE-TX-2", vec!["A".into(), "B".into()])
        .await
        .unwrap();
    assert_eq!(
        get_page_aliases_inner(&pool, "PAGE-TX-2").await.unwrap(),
        vec!["A", "B"],
        "preconditions: aliases A, B should be set"
    );

    // Pass an empty list — should clear the set entirely.
    let inserted = set_page_aliases_inner(&pool, "PAGE-TX-2", vec![])
        .await
        .unwrap();
    assert!(inserted.is_empty(), "empty input should insert nothing");

    let after = get_page_aliases_inner(&pool, "PAGE-TX-2").await.unwrap();
    assert!(
        after.is_empty(),
        "alias set must be empty after empty replace"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_in_transaction() {
    // Regression for M-21: if a per-row INSERT fails mid-loop, the
    // entire DELETE + INSERT sequence must roll back so the page
    // retains its original alias set. We force the failure with a
    // temporary BEFORE-INSERT trigger that calls RAISE(ABORT) on a
    // sentinel alias value.
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE-TX-3", "page", "Page Tx 3", None, Some(0)).await;

    // Prior set: A, B
    set_page_aliases_inner(&pool, "PAGE-TX-3", vec!["A".into(), "B".into()])
        .await
        .unwrap();
    let before = get_page_aliases_inner(&pool, "PAGE-TX-3").await.unwrap();
    assert_eq!(before, vec!["A", "B"], "preconditions: prior set is A, B");

    // Install a trigger that aborts the INSERT when alias = '__FAIL__'.
    sqlx::query(
        "CREATE TRIGGER test_m21_fail_mid_loop \
         BEFORE INSERT ON page_aliases \
         WHEN NEW.alias = '__FAIL__' \
         BEGIN \
            SELECT RAISE(ABORT, 'simulated mid-loop failure'); \
         END",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Try to replace with C, __FAIL__, D. The INSERT for __FAIL__ fires
    // RAISE(ABORT), which propagates as a sqlx error. Without the
    // transaction, the DELETE + the C insert would already be committed
    // and the page would be left with just C (or empty).
    let result = set_page_aliases_inner(
        &pool,
        "PAGE-TX-3",
        vec!["C".into(), "__FAIL__".into(), "D".into()],
    )
    .await;
    assert!(
        result.is_err(),
        "expected the trigger to abort the insert, got: {:?}",
        result.as_ref().ok()
    );

    // Drop the trigger before re-querying so any future writes succeed.
    sqlx::query("DROP TRIGGER test_m21_fail_mid_loop")
        .execute(&pool)
        .await
        .unwrap();

    // The original aliases must still be present — DELETE rolled back.
    let after = get_page_aliases_inner(&pool, "PAGE-TX-3").await.unwrap();
    assert_eq!(
        after, before,
        "transaction rollback must restore the original alias set"
    );
    // And the partially-attempted new aliases must not have leaked through.
    for leaked in ["C", "D", "__FAIL__"] {
        let r = resolve_page_by_alias_inner(&pool, leaked).await.unwrap();
        assert!(
            r.is_none(),
            "alias '{leaked}' must not be resolvable after rollback"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_page_aliases_returns_sorted_list() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE-4", "page", "Page Four", None, Some(0)).await;

    set_page_aliases_inner(
        &pool,
        "PAGE-4",
        vec!["Zulu".into(), "Alpha".into(), "Mike".into()],
    )
    .await
    .unwrap();

    let aliases = get_page_aliases_inner(&pool, "PAGE-4").await.unwrap();
    assert_eq!(
        aliases,
        vec!["Alpha", "Mike", "Zulu"],
        "aliases should be sorted alphabetically"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resolve_page_by_alias_case_insensitive() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE-5", "page", "Page Five", None, Some(0)).await;

    set_page_aliases_inner(&pool, "PAGE-5", vec!["MyAlias".into()])
        .await
        .unwrap();

    // Exact case
    let r1 = resolve_page_by_alias_inner(&pool, "MyAlias").await.unwrap();
    assert!(r1.is_some(), "exact alias should resolve");
    let (pid, title) = r1.unwrap();
    assert_eq!(pid, "PAGE-5", "resolved page id should match");
    assert_eq!(
        title.as_deref(),
        Some("Page Five"),
        "resolved page title should match"
    );

    // Different case
    let r2 = resolve_page_by_alias_inner(&pool, "myalias").await.unwrap();
    assert!(r2.is_some(), "lowercase alias should resolve");
    assert_eq!(
        r2.unwrap().0,
        "PAGE-5",
        "lowercase should resolve to same page"
    );

    let r3 = resolve_page_by_alias_inner(&pool, "MYALIAS").await.unwrap();
    assert!(r3.is_some(), "uppercase alias should resolve");
    assert_eq!(
        r3.unwrap().0,
        "PAGE-5",
        "uppercase should resolve to same page"
    );

    // Non-existent alias
    let r4 = resolve_page_by_alias_inner(&pool, "NoSuchAlias")
        .await
        .unwrap();
    assert!(r4.is_none(), "non-existent alias should return None");
}

// ======================================================================
// list_page_aliases_by_prefix (PEND-34)
// ======================================================================
//
// Prefix-indexed alias autocomplete used by the `[[` page-link picker.
// Mirrors the `list_tags_by_prefix_inner_*` test trio: returns matches,
// case-insensitive, soft-delete excluded, limit honoured, exact-first
// ordering by length, escape-like correctness for `_` / `%` literals.
// Plus PEND-34 Q3 — active-space scoping when `space_id` is `Some`.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_aliases_by_prefix_inner_returns_matching() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE_W1", "page", "Work One", None, Some(0)).await;
    insert_block(&pool, "PAGE_W2", "page", "Work Two", None, Some(0)).await;
    insert_block(&pool, "PAGE_P", "page", "Personal", None, Some(0)).await;

    set_page_aliases_inner(&pool, "PAGE_W1", vec!["work-meeting".into()])
        .await
        .unwrap();
    set_page_aliases_inner(&pool, "PAGE_W2", vec!["work-email".into()])
        .await
        .unwrap();
    set_page_aliases_inner(&pool, "PAGE_P", vec!["personal".into()])
        .await
        .unwrap();

    let result = list_page_aliases_by_prefix_inner(&pool, "work-", None, &SpaceScope::Global)
        .await
        .unwrap();

    assert_eq!(result.len(), 2, "should match both work- aliases");
    let aliases: Vec<&str> = result.iter().map(|(_, a, _)| a.as_str()).collect();
    assert!(aliases.contains(&"work-email"));
    assert!(aliases.contains(&"work-meeting"));
    // Titles travel with the row so the picker renders without a second
    // round trip.
    let titles: Vec<Option<&str>> = result.iter().map(|(_, _, t)| t.as_deref()).collect();
    assert!(titles.contains(&Some("Work One")));
    assert!(titles.contains(&Some("Work Two")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_aliases_by_prefix_inner_case_insensitive() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE_CI", "page", "Case Page", None, Some(0)).await;
    set_page_aliases_inner(&pool, "PAGE_CI", vec!["MyAlias".into()])
        .await
        .unwrap();

    let result = list_page_aliases_by_prefix_inner(&pool, "myAL", None, &SpaceScope::Global)
        .await
        .unwrap();

    assert_eq!(result.len(), 1, "case-insensitive prefix should match");
    assert_eq!(result[0].0, "PAGE_CI");
    assert_eq!(result[0].1, "MyAlias");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_aliases_by_prefix_inner_excludes_deleted_pages() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE_LIVE", "page", "Alive", None, Some(0)).await;
    insert_block(&pool, "PAGE_GONE", "page", "Tombstoned", None, Some(0)).await;

    set_page_aliases_inner(&pool, "PAGE_LIVE", vec!["zoo".into()])
        .await
        .unwrap();
    set_page_aliases_inner(&pool, "PAGE_GONE", vec!["zoom".into()])
        .await
        .unwrap();

    // Soft-delete the second page. Its alias must not surface.
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = 'PAGE_GONE'")
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();

    let result = list_page_aliases_by_prefix_inner(&pool, "zo", None, &SpaceScope::Global)
        .await
        .unwrap();

    assert_eq!(
        result.len(),
        1,
        "soft-deleted page's alias must be excluded"
    );
    assert_eq!(result[0].0, "PAGE_LIVE");
    assert_eq!(result[0].1, "zoo");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_aliases_by_prefix_inner_respects_limit() {
    let (pool, _dir) = test_pool().await;

    for i in 0..5 {
        let id = format!("PAGE_L{i}");
        insert_block(&pool, &id, "page", &format!("Limit {i}"), None, Some(0)).await;
        // Suffix the index so the aliases sort deterministically by
        // `length, alias` (all length 7 → alphabetical secondary).
        set_page_aliases_inner(&pool, &id, vec![format!("limit-{i}")])
            .await
            .unwrap();
    }

    let result = list_page_aliases_by_prefix_inner(&pool, "limit-", Some(2), &SpaceScope::Global)
        .await
        .unwrap();
    assert_eq!(result.len(), 2, "limit=2 should return exactly 2 aliases");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_aliases_by_prefix_inner_orders_shortest_first() {
    // ORDER BY length(alias), alias — exact-typed alias (the shortest
    // one matching the prefix) bubbles to the top, then alphabetical.
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE_A", "page", "Page A", None, Some(0)).await;
    insert_block(&pool, "PAGE_B", "page", "Page B", None, Some(0)).await;
    insert_block(&pool, "PAGE_C", "page", "Page C", None, Some(0)).await;

    set_page_aliases_inner(&pool, "PAGE_A", vec!["pp".into()])
        .await
        .unwrap();
    set_page_aliases_inner(&pool, "PAGE_B", vec!["ppp".into()])
        .await
        .unwrap();
    set_page_aliases_inner(&pool, "PAGE_C", vec!["pproject".into()])
        .await
        .unwrap();

    let result = list_page_aliases_by_prefix_inner(&pool, "pp", None, &SpaceScope::Global)
        .await
        .unwrap();

    assert_eq!(result.len(), 3);
    // Length 2 < 3 < 8 — the shortest must come first so a typed-in-full
    // exact match isn't buried below partial-prefix neighbours.
    assert_eq!(result[0].1, "pp");
    assert_eq!(result[1].1, "ppp");
    assert_eq!(result[2].1, "pproject");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_aliases_by_prefix_inner_escapes_like_metachars() {
    // Mirrors PERF-27's `filter_property_text_contains_pushed_into_sql`:
    // a literal `_` in the query must be matched as a literal, not as
    // SQLite's LIKE single-char wildcard. Without `escape_like` the
    // query `a_b` would also match `axb`, `a-b`, etc. — the test pins
    // the escape behaviour so a future refactor can't silently drop it.
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE_LIT", "page", "Literal", None, Some(0)).await;
    insert_block(&pool, "PAGE_OTH", "page", "Other", None, Some(0)).await;

    set_page_aliases_inner(&pool, "PAGE_LIT", vec!["a_b".into()])
        .await
        .unwrap();
    set_page_aliases_inner(&pool, "PAGE_OTH", vec!["axb".into()])
        .await
        .unwrap();

    let result = list_page_aliases_by_prefix_inner(&pool, "a_", None, &SpaceScope::Global)
        .await
        .unwrap();

    assert_eq!(
        result.len(),
        1,
        "literal `_` must not behave as a LIKE wildcard"
    );
    assert_eq!(result[0].1, "a_b");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_aliases_by_prefix_inner_scopes_to_active_space() {
    // PEND-34 Q3 — when `space_id` is Some, only aliases whose page
    // carries `space = ?space_id` may surface. Mirrors the FEAT-3p4
    // `(? IS NULL OR ... IN (...))` short-circuit applied elsewhere in
    // the picker so cross-space aliases don't leak into the popup.
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE_SP_A", "page", "In Space A", None, Some(0)).await;
    insert_block(&pool, "PAGE_SP_B", "page", "In Space B", None, Some(0)).await;

    set_page_aliases_inner(&pool, "PAGE_SP_A", vec!["alpha-a".into()])
        .await
        .unwrap();
    set_page_aliases_inner(&pool, "PAGE_SP_B", vec!["alpha-b".into()])
        .await
        .unwrap();

    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;
    assign_to_space(&pool, "PAGE_SP_A", TEST_SPACE_ID).await;
    assign_to_space(&pool, "PAGE_SP_B", TEST_SPACE_B_ID).await;

    // Scoped to space A: only PAGE_SP_A's alias surfaces.
    let scoped = list_page_aliases_by_prefix_inner(
        &pool,
        "alpha-",
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
    )
    .await
    .unwrap();
    assert_eq!(scoped.len(), 1, "scoped query must filter to space A");
    assert_eq!(scoped[0].0, "PAGE_SP_A");

    // Unscoped (Global): both spaces' aliases surface — proves the filter
    // is opt-in, not on by default.
    let unscoped = list_page_aliases_by_prefix_inner(&pool, "alpha-", None, &SpaceScope::Global)
        .await
        .unwrap();
    assert_eq!(unscoped.len(), 2);
}

// ======================================================================
// export_page_markdown (#519)
// ======================================================================
//
// M-27 — `export_page_markdown_inner` walks the full descendant subtree
// via the denormalised `blocks.page_id` column rather than the
// `parent_id` direct-children filter. The raw `insert_block` helper
// bypasses the materializer, so each export test must call
// `crate::cache::rebuild_page_ids` after seeding rows so the column the
// new walk keys on is populated. (Production paths set `page_id`
// inside `create_block_in_tx`, so this is purely a test fixture
// concern.)

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_page_markdown_basic() {
    let (pool, _dir) = test_pool().await;

    // Create a page with two child content blocks
    insert_block(
        &pool,
        "01AAAAAAAAAAAAAAAAAAAAPAGE",
        "page",
        "My Test Page",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "01AAAAAAAAAAAAAAAAAAAABLK1",
        "content",
        "First block",
        Some("01AAAAAAAAAAAAAAAAAAAAPAGE"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "01AAAAAAAAAAAAAAAAAAAABLK2",
        "content",
        "Second block with **bold**",
        Some("01AAAAAAAAAAAAAAAAAAAAPAGE"),
        Some(2),
    )
    .await;
    crate::cache::rebuild_page_ids(&pool).await.unwrap();

    let md = export_page_markdown_inner(&pool, "01AAAAAAAAAAAAAAAAAAAAPAGE")
        .await
        .unwrap();

    // Title as h1
    assert!(
        md.starts_with("# My Test Page\n\n"),
        "should start with h1 title"
    );
    // Block content present
    assert!(md.contains("First block\n"), "should contain first block");
    // Markdown formatting preserved
    assert!(
        md.contains("Second block with **bold**\n"),
        "should preserve markdown formatting"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_page_markdown_resolves_tag_ulids() {
    let (pool, _dir) = test_pool().await;

    // Create a tag block
    insert_block(
        &pool,
        "01TAG00000000000000000TAG1",
        "tag",
        "rust",
        None,
        Some(1),
    )
    .await;

    // Create a page with a content block that references the tag
    insert_block(
        &pool,
        "01AAAAAAAAAAAAAAAAAAAAPAGE",
        "page",
        "Tagged Page",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "01AAAAAAAAAAAAAAAAAAAABLK1",
        "content",
        "Learning #[01TAG00000000000000000TAG1] today",
        Some("01AAAAAAAAAAAAAAAAAAAAPAGE"),
        Some(1),
    )
    .await;
    crate::cache::rebuild_page_ids(&pool).await.unwrap();

    let md = export_page_markdown_inner(&pool, "01AAAAAAAAAAAAAAAAAAAAPAGE")
        .await
        .unwrap();

    assert!(
        md.contains("Learning #rust today"),
        "tag ULID should be replaced with #tagname, got: {md}"
    );
    assert!(
        !md.contains("01TAG00000000000000000TAG1"),
        "raw ULID should not appear in output"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_page_markdown_resolves_page_link_ulids() {
    let (pool, _dir) = test_pool().await;

    // Create a target page
    insert_block(
        &pool,
        "01LINKPAGE000000000000LNK1",
        "page",
        "Linked Page",
        None,
        Some(1),
    )
    .await;

    // Create the main page with a content block that links to the target
    insert_block(
        &pool,
        "01AAAAAAAAAAAAAAAAAAAAPAGE",
        "page",
        "Source Page",
        None,
        Some(2),
    )
    .await;
    insert_block(
        &pool,
        "01AAAAAAAAAAAAAAAAAAAABLK1",
        "content",
        "See also [[01LINKPAGE000000000000LNK1]] for details",
        Some("01AAAAAAAAAAAAAAAAAAAAPAGE"),
        Some(1),
    )
    .await;
    crate::cache::rebuild_page_ids(&pool).await.unwrap();

    let md = export_page_markdown_inner(&pool, "01AAAAAAAAAAAAAAAAAAAAPAGE")
        .await
        .unwrap();

    assert!(
        md.contains("See also [[Linked Page]] for details"),
        "page link ULID should be replaced with [[Page Title]], got: {md}"
    );
    assert!(
        !md.contains("01LINKPAGE000000000000LNK1"),
        "raw ULID should not appear in output"
    );
}

// ======================================================================
// M-27 — descendant pagination & batched ref-resolution
// ======================================================================
//
// Pre-fix `export_page_markdown_inner` walked direct children only with
// a hard `limit = 1000` cap (silent truncation beyond that) and full-
// scanned every non-deleted tag and page block in the vault to build
// the resolver maps.  The post-fix walk paginates via cursor over the
// `(position, id)` keyset on `blocks.page_id` until exhaustion (page
// size 200) and resolves references through one `json_each(?)` query.
//
// The three tests below pin down:
//   1. multi-page cursor traversal returns every descendant (no cap)
//   2. mixed `#[ULID]` and `[[ULID]]` references resolve correctly
//   3. unreferenced tags / pages don't perturb the export — the new
//      code path only fetches the referenced blocks, but the assertion
//      here is just functional success, not row count.

/// Force the fixture row count above the production
/// `DESCENDANT_PAGE_SIZE` (200) so the cursor loop has to iterate at
/// least twice. Pre-fix the same scenario silently dropped descendants
/// past the first 1000 (and any non-direct-children always).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_page_markdown_walks_full_subtree_with_pagination() {
    let (pool, _dir) = test_pool().await;

    // Page + 125 direct children + 125 grandchildren = 250 descendants,
    // forcing two cursor fetches at page size 200.
    let page_id = "01EXP0RTPAGE0000000000PAGE";
    insert_block(&pool, page_id, "page", "Big Page", None, Some(1)).await;

    for i in 0..125 {
        let child_id = format!("01CHILD{i:019}");
        insert_block(
            &pool,
            &child_id,
            "content",
            &format!("child-{i}"),
            Some(page_id),
            Some(i64::from(i + 1)),
        )
        .await;
        let grand_id = format!("01GRAND{i:019}");
        insert_block(
            &pool,
            &grand_id,
            "content",
            &format!("grand-{i}"),
            Some(&child_id),
            Some(i64::from(i + 1)),
        )
        .await;
    }
    crate::cache::rebuild_page_ids(&pool).await.unwrap();

    let md = export_page_markdown_inner(&pool, page_id).await.unwrap();

    // Every descendant line must appear — direct children AND
    // grandchildren. Pre-fix the grandchildren never appeared (direct-
    // children-only filter); even the direct children would have been
    // capped at 1000 if the fixture grew that large.
    for i in 0..125 {
        let child_line = format!("child-{i}\n");
        assert!(
            md.contains(&child_line),
            "expected direct-child line {child_line:?} in export"
        );
        let grand_line = format!("grand-{i}\n");
        assert!(
            md.contains(&grand_line),
            "expected grandchild line {grand_line:?} in export"
        );
    }
}

/// Pin the new `json_each(?)` batch resolve against regression: a page
/// that mixes several `#[ULID]` and `[[ULID]]` tokens must still
/// produce the exact same `#tagname` / `[[Page Title]]` substitutions
/// the pre-fix full-scan path produced.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_page_markdown_batch_resolves_mixed_references() {
    let (pool, _dir) = test_pool().await;

    // Two tag blocks and two page blocks acting as reference targets.
    insert_block(
        &pool,
        "01TAGAAAAAAAAAAAAAAAAATAGA",
        "tag",
        "alpha",
        None,
        None,
    )
    .await;
    insert_block(
        &pool,
        "01TAGBBBBBBBBBBBBBBBBBTAGB",
        "tag",
        "beta",
        None,
        None,
    )
    .await;
    insert_block(
        &pool,
        "01PAGEXXXXXXXXXXXXXXXXXPGX",
        "page",
        "Project X",
        None,
        Some(10),
    )
    .await;
    insert_block(
        &pool,
        "01PAGEYYYYYYYYYYYYYYYYYPGY",
        "page",
        "Project Y",
        None,
        Some(11),
    )
    .await;

    let page_id = "01EXP0RTPAGEM1XED000000PAG";
    insert_block(&pool, page_id, "page", "Mixed Refs", None, Some(1)).await;
    insert_block(
        &pool,
        "01BLKMIXED000000000000BLK1",
        "content",
        "Tags: #[01TAGAAAAAAAAAAAAAAAAATAGA] and #[01TAGBBBBBBBBBBBBBBBBBTAGB]",
        Some(page_id),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "01BLKMIXED000000000000BLK2",
        "content",
        "Pages: [[01PAGEXXXXXXXXXXXXXXXXXPGX]] / [[01PAGEYYYYYYYYYYYYYYYYYPGY]]",
        Some(page_id),
        Some(2),
    )
    .await;
    insert_block(
        &pool,
        "01BLKMIXED000000000000BLK3",
        "content",
        "Mixed: #[01TAGAAAAAAAAAAAAAAAAATAGA] -> [[01PAGEYYYYYYYYYYYYYYYYYPGY]]",
        Some(page_id),
        Some(3),
    )
    .await;
    crate::cache::rebuild_page_ids(&pool).await.unwrap();

    let md = export_page_markdown_inner(&pool, page_id).await.unwrap();

    assert!(
        md.contains("Tags: #alpha and #beta"),
        "tag refs should resolve to #name, got: {md}"
    );
    assert!(
        md.contains("Pages: [[Project X]] / [[Project Y]]"),
        "page refs should resolve to [[Title]], got: {md}"
    );
    assert!(
        md.contains("Mixed: #alpha -> [[Project Y]]"),
        "mixed refs in the same line should resolve, got: {md}"
    );
    // Raw ULIDs must not leak through the resolver.
    assert!(
        !md.contains("01TAGAAAAAAAAAAAAAAAAATAGA"),
        "raw tag ULID should not appear in output"
    );
    assert!(
        !md.contains("01PAGEYYYYYYYYYYYYYYYYYPGY"),
        "raw page ULID should not appear in output"
    );
}

/// Cardinality regression: 50 unrelated tag blocks must NOT cost
/// anything in the export of a tiny page that only references two of
/// them. Pre-fix the function loaded all 50 (full scan); post-fix the
/// `json_each(?)` query is bound by the size of the deduped reference
/// set, not the vault. The assertion here is the function still works
/// — counting rows fetched would require query instrumentation; the
/// observable contract is "exported markdown contains the two
/// referenced names and no leaked ULIDs".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_page_markdown_handles_many_unrelated_tags() {
    let (pool, _dir) = test_pool().await;

    // 50 unrelated tag blocks — none referenced by the page below.
    for i in 0..50 {
        let id = format!("01UNRELATEDTAG{i:012}");
        insert_block(&pool, &id, "tag", &format!("noise-{i}"), None, None).await;
    }
    // The two tag blocks the page actually references.
    insert_block(
        &pool,
        "01REFTAG0000000000000RTAG1",
        "tag",
        "kept-1",
        None,
        None,
    )
    .await;
    insert_block(
        &pool,
        "01REFTAG0000000000000RTAG2",
        "tag",
        "kept-2",
        None,
        None,
    )
    .await;

    let page_id = "01EXP0RTSPARSE000000000PAG";
    insert_block(&pool, page_id, "page", "Sparse Page", None, Some(1)).await;
    insert_block(
        &pool,
        "01BLKSPARSE0000000000BLK1",
        "content",
        "Refs only #[01REFTAG0000000000000RTAG1] and #[01REFTAG0000000000000RTAG2]",
        Some(page_id),
        Some(1),
    )
    .await;
    crate::cache::rebuild_page_ids(&pool).await.unwrap();

    let md = export_page_markdown_inner(&pool, page_id).await.unwrap();

    assert!(
        md.contains("Refs only #kept-1 and #kept-2"),
        "referenced tag names should appear, got: {md}"
    );
    // The 50 unrelated tag names must not have leaked into the export
    // — there is no syntactic path for them to (the page's content
    // never names them), but the assertion guards against any future
    // refactor that re-introduces a full-table fan-out.
    for i in 0..50 {
        let noise = format!("noise-{i}");
        assert!(
            !md.contains(&noise),
            "unreferenced tag name {noise:?} should NOT appear in export"
        );
    }
}

// ======================================================================
// export_page_markdown — error paths (REVIEW-LATER TEST-11)
// ======================================================================
//
// TEST-11 — Pre-fix `export_page_markdown_inner` had 6 happy-path tests
// (above) and zero error coverage.  Per AGENTS.md "Backend test
// patterns": every command needs at least nonexistent-id → NotFound
// and invalid-input → Validation pins so a refactor cannot silently
// reshape the error surface.  The three tests below close that gap by
// pinning each variant via `matches!()` (no `.contains("not found")`
// strings — a refactor that swaps `NotFound` for `Validation` while
// preserving the message would slip past a substring check).
//
// Two of the three pins surface production findings that the parent
// agent should triage as TEST-11 follow-ups (each is documented
// inline, in the test it shows up in):
//   1. Soft-deleted pages export as `# title\n\n` (Ok), not NotFound —
//      `get_block_inner` does not filter `deleted_at`, and there is no
//      explicit check inside `export_page_markdown_inner` either.
//      RESOLVED via M-98: `export_page_markdown_inner` now calls
//      `get_active_block_inner`, which filters `deleted_at IS NULL`,
//      so soft-deleted pages surface as `Err(NotFound)`. The test
//      below was flipped to assert the new contract.
//   2. Malformed page IDs (e.g. `"not-a-ulid"`) hit the
//      `WHERE id = ?` path verbatim and fall through to NotFound,
//      because the function never invokes `BlockId::from_string` to
//      reject the input as Validation up front.

/// TEST-11 — Pin the NotFound variant when the page id is absent.
/// `export_page_markdown_inner` calls `get_active_block_inner` first
/// (M-98), which returns `AppError::NotFound` for a `WHERE id = ? AND
/// deleted_at IS NULL` miss; if a future refactor swaps that for an
/// `Internal` (e.g. by ignoring the result and falling through to the
/// markdown builder), this test fails.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_page_markdown_inner_with_nonexistent_id_returns_not_found() {
    let (pool, _dir) = test_pool().await;

    // Valid ULID format that is guaranteed not to exist in the DB.
    let result = export_page_markdown_inner(&pool, "01ZZZZZZZZZZZZZZZZZZZZZZZZ").await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "nonexistent page id must return AppError::NotFound, got: {result:?}"
    );
}

/// TEST-11 — Pin the variant when the supplied id refers to a
/// non-page block (e.g. a `content` row).  The production code's
/// explicit `if page.block_type != "page"` branch returns
/// `AppError::Validation("not a page".into())`; pinning the variant
/// guards against a refactor that drops or reshapes that guard (for
/// instance, a future signature that relaxes the page-only contract
/// would surface as a passing `Ok(_)` here, not a silent regression).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_page_markdown_inner_with_non_page_block_returns_validation() {
    let (pool, _dir) = test_pool().await;

    // Insert a `content` block — explicitly NOT a page.  The export
    // function's `block_type != "page"` branch must reject it.
    insert_block(
        &pool,
        "01C0NTENTBKK00000000000001",
        "content",
        "not a page",
        None,
        Some(0),
    )
    .await;

    let result = export_page_markdown_inner(&pool, "01C0NTENTBKK00000000000001").await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "non-page block id must return AppError::Validation, got: {result:?}"
    );
}

/// TEST-11 / M-98 — Pin that a soft-deleted page is no longer
/// exportable. Pre-fix, `export_page_markdown_inner` called
/// `get_block_inner` (no `deleted_at` filter) so a soft-deleted page
/// exported as `# Title\n\n` with no descendants — title-only
/// content because the descendant walk *did* filter `deleted_at IS
/// NULL`. M-98 switched the page-row fetch to
/// `get_active_block_inner`, which adds the same predicate, so the
/// export now surfaces as `Err(NotFound)`. This test pins the new
/// contract so a future regression that re-introduces the leak is
/// caught.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_page_markdown_inner_with_soft_deleted_page_returns_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a page and a child block via the canonical command path
    // so `delete_block_inner` cascades correctly.
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Doomed Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let _child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child block".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Soft-delete the page (sets `deleted_at IS NOT NULL` on the page
    // row and cascades to the child).
    delete_block_inner(&pool, DEV, &mat, page.id.clone())
        .await
        .unwrap();
    settle(&mat).await;

    let result = export_page_markdown_inner(&pool, &page.id).await;

    // M-98 — soft-deleted pages must surface as NotFound, not as a
    // partial title-only export.
    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "soft-deleted page export must return AppError::NotFound (M-98), got: {result:?}"
    );
}

/// L-136 — Pin the variant returned for a malformed page id.
/// `export_page_markdown_inner` now validates ULID format upfront via
/// `BlockId::from_string(page_id)?`, so malformed inputs surface as
/// `AppError::Ulid` (precise) rather than `AppError::NotFound` (imprecise,
/// which used to come from the SQL `WHERE id = ?` lookup missing every
/// row). Same fix applied to `get_page_inner`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_page_markdown_inner_with_malformed_id_returns_ulid_error() {
    let (pool, _dir) = test_pool().await;

    // Not a ULID — `BlockId::from_string("not-a-ulid")` rejects with
    // `AppError::Ulid` upfront, before any SQL query runs.
    let result = export_page_markdown_inner(&pool, "not-a-ulid").await;

    assert!(
        matches!(result, Err(AppError::Ulid(_))),
        "malformed page id must surface as Ulid (L-136 upfront validation) — got: {result:?}"
    );
}

// ======================================================================
// import_markdown — Logseq/Markdown import (#660)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_creates_page_and_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let content = "- Block 1\n  - Child 1\n  - Child 2\n- Block 2";
    let result =
        import_markdown_inner(&pool, DEV, &mat, content.into(), Some("TestPage.md".into()))
            .await
            .unwrap();

    assert_eq!(
        result.page_title, "TestPage",
        "page title should match filename"
    );
    assert_eq!(
        result.blocks_created, 4,
        "should create 4 blocks from markdown"
    );
    assert!(
        result.warnings.is_empty(),
        "import should produce no warnings"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_handles_properties() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // BUG-20: values must be in the seeded options:
    //   priority: ["1","2","3"]; status: ["active","paused","done","archived"]
    let content = "- Task\n  priority:: 1\n  status:: done";
    let result = import_markdown_inner(&pool, DEV, &mat, content.into(), Some("Props.md".into()))
        .await
        .unwrap();

    assert_eq!(
        result.blocks_created, 1,
        "should create 1 block with properties"
    );
    assert_eq!(result.properties_set, 2, "should set 2 properties");

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_strips_block_refs() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let content = "- See ((abc-123-def)) for details";
    let result = import_markdown_inner(&pool, DEV, &mat, content.into(), None)
        .await
        .unwrap();

    assert_eq!(
        result.blocks_created, 1,
        "should create 1 block after stripping refs"
    );
    assert_eq!(
        result.page_title, "Imported Page",
        "default page title should be used"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_empty_content() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let result = import_markdown_inner(&pool, DEV, &mat, "".into(), Some("Empty.md".into()))
        .await
        .unwrap();

    assert_eq!(
        result.page_title, "Empty",
        "page title should derive from filename"
    );
    assert_eq!(
        result.blocks_created, 0,
        "empty content should create no blocks"
    );

    mat.shutdown();
}

/// P-19: Verify that `import_markdown_inner` runs all block + property
/// writes inside a single transaction by checking that:
/// 1. All blocks are present in the DB after a successful import.
/// 2. All properties are persisted correctly.
/// 3. The op_log contains the expected number of entries.
/// 4. Parent-child hierarchy is correct.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_single_transaction() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // BUG-20: values must be in the seeded options:
    //   priority: ["1","2","3"]; status: ["active","paused","done","archived"]
    let content = "- Parent block\n  priority:: 1\n  status:: active\n  - Child A\n  - Child B\n    - Grandchild";
    let result = import_markdown_inner(&pool, DEV, &mat, content.into(), Some("TxTest.md".into()))
        .await
        .unwrap();

    // Basic import stats
    assert_eq!(result.page_title, "TxTest");
    assert_eq!(result.blocks_created, 4, "should create 4 blocks");
    assert_eq!(result.properties_set, 2, "should set 2 properties");
    assert!(result.warnings.is_empty(), "should have no warnings");

    // Verify page exists
    let page: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date, scheduled_date, page_id FROM blocks WHERE block_type = 'page' AND content = 'TxTest'"#
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(page.is_some(), "page block must exist");
    let page = page.unwrap();

    // Verify all content blocks exist under the page hierarchy
    let all_blocks: Vec<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date, scheduled_date, page_id FROM blocks WHERE block_type = 'content' ORDER BY position"#
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(all_blocks.len(), 4, "should have 4 content blocks in DB");

    // Verify parent-child: "Parent block" is child of page
    let parent_block = all_blocks
        .iter()
        .find(|b| b.content.as_deref() == Some("Parent block"))
        .expect("Parent block must exist");
    assert_eq!(
        parent_block.parent_id.as_deref(),
        Some(page.id.as_str()),
        "Parent block should be child of the page"
    );

    // Verify child: "Child A" has parent = "Parent block"
    let child_a = all_blocks
        .iter()
        .find(|b| b.content.as_deref() == Some("Child A"))
        .expect("Child A must exist");
    assert_eq!(
        child_a.parent_id.as_deref(),
        Some(parent_block.id.as_str()),
        "Child A should be child of Parent block"
    );

    // Verify grandchild: "Grandchild" has parent = "Child B"
    let child_b = all_blocks
        .iter()
        .find(|b| b.content.as_deref() == Some("Child B"))
        .expect("Child B must exist");
    let grandchild = all_blocks
        .iter()
        .find(|b| b.content.as_deref() == Some("Grandchild"))
        .expect("Grandchild must exist");
    assert_eq!(
        grandchild.parent_id.as_deref(),
        Some(child_b.id.as_str()),
        "Grandchild should be child of Child B"
    );

    // Verify properties were persisted
    // "priority" is a reserved key stored in blocks.priority column
    let refreshed_parent: BlockRow = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date, scheduled_date, page_id FROM blocks WHERE id = ?"#,
        parent_block.id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        refreshed_parent.priority.as_deref(),
        Some("1"),
        "priority reserved property should be in blocks.priority"
    );

    // "status" is a custom property stored in block_properties
    let props: Vec<(String, String)> = sqlx::query_as(
        "SELECT key, value_text FROM block_properties WHERE block_id = ? ORDER BY key",
    )
    .bind(&parent_block.id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(props.len(), 1, "parent block should have 1 custom property");
    assert_eq!(props[0].0, "status");
    assert_eq!(props[0].1, "active");

    // Verify op_log entries: 1 page + 4 blocks + 2 properties = 7 ops
    let op_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM op_log WHERE device_id = ?")
        .bind(DEV)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        op_count.0, 7,
        "op_log should have 7 entries (1 page + 4 blocks + 2 properties)"
    );

    mat.shutdown();
}

/// L-30: a per-property validation error mid-import must abort the
/// whole transaction. No page, no blocks, no properties, no op_log
/// entries should land in the DB. The import returns `Err(...)` rather
/// than swallowing the failure into `result.warnings`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_aborts_on_first_validation_error_l30() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Baseline: clean DB. Capture counts so the post-error assertions
    // tolerate any seed rows the test fixture may have added.
    let blocks_before: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    let props_before: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_properties")
        .fetch_one(&pool)
        .await
        .unwrap();
    let ops_before: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM op_log WHERE device_id = ?")
        .bind(DEV)
        .fetch_one(&pool)
        .await
        .unwrap();

    // `priority` is a select-type property whose seeded options are
    // ["1","2","3"] (migration 0014). `priority:: 99` therefore fails
    // `set_property_in_tx`'s options-membership check on the second
    // block, after the first block + page have already been written
    // inside the open transaction.
    let content = "- Block 1\n- Block 2\n  priority:: 99\n- Block 3";
    let result = import_markdown_inner(
        &pool,
        DEV,
        &mat,
        content.into(),
        Some("AbortTest.md".into()),
    )
    .await;

    assert!(
        result.is_err(),
        "import must surface the per-property validation error as Err, got: {result:?}"
    );

    // All-or-nothing: rollback restored the DB to its pre-import state.
    let blocks_after: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        blocks_after.0, blocks_before.0,
        "no block rows should survive a rolled-back import"
    );

    let props_after: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_properties")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        props_after.0, props_before.0,
        "no block_properties rows should survive a rolled-back import"
    );

    let ops_after: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM op_log WHERE device_id = ?")
        .bind(DEV)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        ops_after.0, ops_before.0,
        "no op_log entries should survive a rolled-back import"
    );

    // The page row itself must not exist either — even though it was
    // created before the failing property write, the rollback wipes it.
    let page_exists: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM blocks WHERE block_type = 'page' AND content = ?")
            .bind("AbortTest")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        page_exists.0, 0,
        "the page block must not exist after a rolled-back import"
    );

    mat.shutdown();
}

// ======================================================================
// list_page_links (F-33)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_returns_edges_between_pages() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create 2 pages
    let p1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page One".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();
    let p2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page Two".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Create a content block under p1 that links to p2
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("see [[{}]]", p2.id),
        Some(p1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Insert block_links entry manually (content block b1 → page p2)
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b1.id)
        .bind(&p2.id)
        .execute(&pool)
        .await
        .unwrap();

    let links = list_page_links_inner(&pool, &SpaceScope::Global)
        .await
        .unwrap();

    // Should have at least one link: p1 → p2 (rolled up from b1 → p2)
    let p1_to_p2 = links
        .iter()
        .find(|l| l.source_id == p1.id && l.target_id == p2.id);
    assert!(
        p1_to_p2.is_some(),
        "should find link from page 1 to page 2 (rolled up from content block)"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_excludes_deleted_pages() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let p1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page One".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();
    let p2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page Two".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("link [[{}]]", p2.id),
        Some(p1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Insert block_links entry manually
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b1.id)
        .bind(&p2.id)
        .execute(&pool)
        .await
        .unwrap();

    // Delete p2
    delete_block_inner(&pool, DEV, &mat, p2.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let links = list_page_links_inner(&pool, &SpaceScope::Global)
        .await
        .unwrap();
    let has_deleted = links.iter().any(|l| l.target_id == p2.id);
    assert!(!has_deleted, "should not include links to deleted pages");

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_excludes_self_links() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let p1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Create a block under p1 that links back to p1 itself
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("self [[{}]]", p1.id),
        Some(p1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Insert self-referential block_links entry
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b1.id)
        .bind(&p1.id)
        .execute(&pool)
        .await
        .unwrap();

    let links = list_page_links_inner(&pool, &SpaceScope::Global)
        .await
        .unwrap();
    let self_link = links.iter().find(|l| l.source_id == l.target_id);
    assert!(
        self_link.is_none(),
        "should not include self-referential links"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_empty_when_no_links() {
    let (pool, _dir) = test_pool().await;
    let links = list_page_links_inner(&pool, &SpaceScope::Global)
        .await
        .unwrap();
    assert!(links.is_empty(), "should return empty when no links exist");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_deduplicates_multiple_content_links() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create 2 pages
    let p1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Source Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();
    let p2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target Page".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Create 2 content blocks under p1, both linking to p2
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("first [[{}]]", p2.id),
        Some(p1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("second [[{}]]", p2.id),
        Some(p1.id.clone()),
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Insert block_links entries for both content blocks → p2
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b1.id)
        .bind(&p2.id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b2.id)
        .bind(&p2.id)
        .execute(&pool)
        .await
        .unwrap();

    let links = list_page_links_inner(&pool, &SpaceScope::Global)
        .await
        .unwrap();

    // Both b1 and b2 roll up to p1 → p2; GROUP BY should collapse to 1 edge
    let p1_to_p2_count = links
        .iter()
        .filter(|l| l.source_id == p1.id && l.target_id == p2.id)
        .count();
    assert_eq!(
        p1_to_p2_count, 1,
        "GROUP BY should deduplicate multiple content blocks linking to the same target page"
    );

    let edge = links
        .iter()
        .find(|l| l.source_id == p1.id && l.target_id == p2.id)
        .unwrap();
    assert_eq!(
        edge.ref_count, 2,
        "ref_count should be 2 for two content blocks linking to the same target page"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_single_link_has_ref_count_one() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let p1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page A".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();
    let p2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page B".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("link [[{}]]", p2.id),
        Some(p1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b1.id)
        .bind(&p2.id)
        .execute(&pool)
        .await
        .unwrap();

    let links = list_page_links_inner(&pool, &SpaceScope::Global)
        .await
        .unwrap();
    let edge = links
        .iter()
        .find(|l| l.source_id == p1.id && l.target_id == p2.id)
        .unwrap();
    assert_eq!(
        edge.ref_count, 1,
        "single content block link should have ref_count 1"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_excludes_links_with_deleted_parent_page() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create 2 pages
    let p1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Source Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();
    let p2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target Page".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Create a content block under p1 that links to p2
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("link [[{}]]", p2.id),
        Some(p1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Insert block_links entry
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b1.id)
        .bind(&p2.id)
        .execute(&pool)
        .await
        .unwrap();

    // Verify link exists before deletion
    let links_before = list_page_links_inner(&pool, &SpaceScope::Global)
        .await
        .unwrap();
    let has_link = links_before
        .iter()
        .any(|l| l.source_id == p1.id && l.target_id == p2.id);
    assert!(has_link, "link should exist before deleting source page");

    // Soft-delete the SOURCE page (p1)
    delete_block_inner(&pool, DEV, &mat, p1.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let links_after = list_page_links_inner(&pool, &SpaceScope::Global)
        .await
        .unwrap();
    let has_deleted_source = links_after.iter().any(|l| l.source_id == p1.id);
    assert!(
        !has_deleted_source,
        "should not include links from a deleted parent page"
    );

    mat.shutdown();
}

// ======================================================================
// CTE oracle: verify optimized list_page_links query matches the original
// ======================================================================

/// Original (pre-P-15) query preserved as a correctness oracle.
/// Runs the old SQL and returns sorted results for comparison.
async fn list_page_links_oracle(pool: &SqlitePool) -> Vec<PageLink> {
    let mut rows = sqlx::query_as::<_, PageLink>(
        "SELECT
            COALESCE(sb.parent_id, bl.source_id) AS source_id,
            bl.target_id AS target_id,
            COUNT(*) AS ref_count
         FROM block_links bl
         JOIN blocks sb ON sb.id = bl.source_id AND sb.deleted_at IS NULL
         JOIN blocks tb ON tb.id = bl.target_id AND tb.deleted_at IS NULL AND tb.block_type = 'page'
         LEFT JOIN blocks pb ON pb.id = sb.parent_id
         WHERE COALESCE(sb.parent_id, bl.source_id) != bl.target_id
         AND (sb.parent_id IS NULL OR (pb.deleted_at IS NULL AND pb.block_type = 'page'))
         GROUP BY 1, 2",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    rows.sort();
    rows
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_optimized_matches_oracle() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // -- Set up a non-trivial graph covering all edge-case branches --

    // 3 pages
    let p1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page Alpha".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let p2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page Beta".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let p3 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Page Gamma".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Content blocks under p1
    let b1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("link to beta [[{}]]", p2.id),
        Some(p1.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let b2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("link to gamma [[{}]]", p3.id),
        Some(p1.id.clone()),
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Content block under p2 linking to p3
    let b3 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("cross link [[{}]]", p3.id),
        Some(p2.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Self-link: content under p1 linking back to p1 (should be excluded)
    let b4 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("self [[{}]]", p1.id),
        Some(p1.id.clone()),
        Some(3),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Duplicate content blocks linking to same target (tests DISTINCT)
    let b5 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("also beta [[{}]]", p2.id),
        Some(p1.id.clone()),
        Some(4),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Direct page-to-page link (source is itself a page, no parent rollup)
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&p2.id)
        .bind(&p1.id)
        .execute(&pool)
        .await
        .unwrap();

    // Insert all content block links
    for (src, tgt) in [
        (&b1.id, &p2.id),
        (&b2.id, &p3.id),
        (&b3.id, &p3.id),
        (&b4.id, &p1.id),
        (&b5.id, &p2.id),
    ] {
        sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(src)
            .bind(tgt)
            .execute(&pool)
            .await
            .unwrap();
    }

    // -- Compare optimized vs oracle --
    let mut optimized = list_page_links_inner(&pool, &SpaceScope::Global)
        .await
        .unwrap();
    optimized.sort();

    let oracle = list_page_links_oracle(&pool).await;

    assert_eq!(
        optimized, oracle,
        "P-15 optimized query must match original oracle.\n  optimized: {optimized:?}\n  oracle:    {oracle:?}"
    );

    // Sanity: we should have some links
    assert!(
        !optimized.is_empty(),
        "test should produce at least one page link"
    );

    mat.shutdown();
}

// PEND-18 Phase 2 — parity test: `&SpaceScope::Global` reproduces the
// pre-migration `space_id: None` behaviour bit-for-bit. Fixtures span
// two spaces with intra-space and cross-space links; the global query
// must surface every edge regardless of where its endpoints live, which
// is exactly the behaviour the old `None` parameter produced. The
// `as_filter_param()` adapter returns `None` for `Global`, so the
// `(?1 IS NULL OR ...)` short-circuit on the SQL side is identical.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_inner_global_matches_legacy_none_pend18() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    // Two source pages and two target pages, one per space.
    insert_block(&pool, "LPL_PSA", "page", "Source A", None, None).await;
    insert_block(&pool, "LPL_PSB", "page", "Source B", None, None).await;
    insert_block(&pool, "LPL_PTA", "page", "Target A", None, None).await;
    insert_block(&pool, "LPL_PTB", "page", "Target B", None, None).await;
    assign_to_space(&pool, "LPL_PSA", TEST_SPACE_ID).await;
    assign_to_space(&pool, "LPL_PTA", TEST_SPACE_ID).await;
    assign_to_space(&pool, "LPL_PSB", TEST_SPACE_B_ID).await;
    assign_to_space(&pool, "LPL_PTB", TEST_SPACE_B_ID).await;

    // Two within-space edges + two cross-space edges. The global view
    // must surface ALL four — that's exactly what the legacy
    // `space_id: None` did before the migration.
    for (src, tgt) in [
        ("LPL_PSA", "LPL_PTA"),
        ("LPL_PSA", "LPL_PTB"),
        ("LPL_PSB", "LPL_PTA"),
        ("LPL_PSB", "LPL_PTB"),
    ] {
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(src)
            .bind(tgt)
            .execute(&pool)
            .await
            .unwrap();
    }

    let global = list_page_links_inner(&pool, &SpaceScope::Global)
        .await
        .unwrap();
    let global_edges: std::collections::HashSet<(String, String)> = global
        .iter()
        .map(|l| (l.source_id.clone().into(), l.target_id.clone().into()))
        .collect();
    assert_eq!(
        global_edges.len(),
        4,
        "Global must surface all four edges (two within-space + two \
         cross-space); confirms `as_filter_param()` on Global produces \
         the same `NULL` SQL bind as legacy `None`"
    );

    // Confirm the active-space partition is strictly tighter — Global
    // is a superset that includes the cross-space edges Active() drops.
    let scope_a = list_page_links_inner(
        &pool,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
    )
    .await
    .unwrap();
    let scope_b = list_page_links_inner(
        &pool,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_B_ID)),
    )
    .await
    .unwrap();
    assert_eq!(scope_a.len(), 1, "Active(A) keeps the within-A edge only");
    assert_eq!(scope_b.len(), 1, "Active(B) keeps the within-B edge only");
}

// ======================================================================
// page_id tests (FEAT-1)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_sets_page_id_self_for_page() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "My Page".into(),
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        page.page_id.as_deref(),
        Some(page.id.as_str()),
        "page block's page_id should be its own id"
    );

    // Verify via direct DB read
    let fetched = get_block_inner(&pool, page.id.clone()).await.unwrap();
    assert_eq!(fetched.page_id.as_deref(), Some(page.id.as_str()));

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_block_sets_page_id_for_content_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Parent Page".into(),
        None,
        None,
    )
    .await
    .unwrap();
    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child block".into(),
        Some(page.id.clone()),
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        child.page_id.as_deref(),
        Some(page.id.as_str()),
        "content block's page_id should be the parent page's id"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_updates_page_id() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page_a = create_block_inner(&pool, DEV, &mat, "page".into(), "Page A".into(), None, None)
        .await
        .unwrap();
    let page_b = create_block_inner(&pool, DEV, &mat, "page".into(), "Page B".into(), None, None)
        .await
        .unwrap();
    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "movable".into(),
        Some(page_a.id.clone()),
        None,
    )
    .await
    .unwrap();

    assert_eq!(child.page_id.as_deref(), Some(page_a.id.as_str()));

    // Move child to page_b
    move_block_inner(
        &pool,
        DEV,
        &mat,
        child.id.clone(),
        Some(page_b.id.clone()),
        1,
    )
    .await
    .unwrap();

    let fetched = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(
        fetched.page_id.as_deref(),
        Some(page_b.id.as_str()),
        "page_id should update after move"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_block_updates_descendants_page_id() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page_a = create_block_inner(&pool, DEV, &mat, "page".into(), "Page A".into(), None, None)
        .await
        .unwrap();
    let page_b = create_block_inner(&pool, DEV, &mat, "page".into(), "Page B".into(), None, None)
        .await
        .unwrap();
    let parent = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "parent".into(),
        Some(page_a.id.clone()),
        None,
    )
    .await
    .unwrap();
    let grandchild = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "grandchild".into(),
        Some(parent.id.clone()),
        None,
    )
    .await
    .unwrap();

    assert_eq!(grandchild.page_id.as_deref(), Some(page_a.id.as_str()));

    // Move parent to page_b
    move_block_inner(
        &pool,
        DEV,
        &mat,
        parent.id.clone(),
        Some(page_b.id.clone()),
        1,
    )
    .await
    .unwrap();

    let fetched_grandchild = get_block_inner(&pool, grandchild.id.clone()).await.unwrap();
    assert_eq!(
        fetched_grandchild.page_id.as_deref(),
        Some(page_b.id.as_str()),
        "descendants' page_id should update after move"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rebuild_page_ids_restores_correct_values() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "RebuildTest".into(),
        None,
        None,
    )
    .await
    .unwrap();
    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(page.id.clone()),
        None,
    )
    .await
    .unwrap();

    // Corrupt page_id by setting it to NULL
    sqlx::query("UPDATE blocks SET page_id = NULL")
        .execute(&pool)
        .await
        .unwrap();

    // Run rebuild
    crate::cache::rebuild_page_ids(&pool).await.unwrap();

    let fetched_page = get_block_inner(&pool, page.id.clone()).await.unwrap();
    assert_eq!(fetched_page.page_id.as_deref(), Some(page.id.as_str()));

    let fetched_child = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(fetched_child.page_id.as_deref(), Some(page.id.as_str()));

    mat.shutdown();
}

// ======================================================================
// PEND-18 Phase 2 — SpaceScope parity test
// ======================================================================
//
// Asserts that `list_page_aliases_by_prefix_inner` honours the
// `&SpaceScope` boundary: `Global` returns the union across spaces,
// `Active(SpaceId)` returns only the named space's subset.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pend18_list_page_aliases_by_prefix_scope_parity() {
    let (pool, _dir) = test_pool().await;

    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;
    insert_block(&pool, "P18_PG_A", "page", "Page A", None, Some(0)).await;
    insert_block(&pool, "P18_PG_B", "page", "Page B", None, Some(1)).await;
    set_page_aliases_inner(&pool, "P18_PG_A", vec!["p18-alias-a".into()])
        .await
        .unwrap();
    set_page_aliases_inner(&pool, "P18_PG_B", vec!["p18-alias-b".into()])
        .await
        .unwrap();
    assign_to_space(&pool, "P18_PG_A", TEST_SPACE_ID).await;
    assign_to_space(&pool, "P18_PG_B", TEST_SPACE_B_ID).await;

    let global = list_page_aliases_by_prefix_inner(&pool, "p18-alias-", None, &SpaceScope::Global)
        .await
        .unwrap();
    assert_eq!(
        global.len(),
        2,
        "Global must surface both spaces' aliases; got {global:?}"
    );

    let active_a = list_page_aliases_by_prefix_inner(
        &pool,
        "p18-alias-",
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
    )
    .await
    .unwrap();
    assert_eq!(
        active_a.len(),
        1,
        "Active(TEST_SPACE_ID) must surface only space A's alias; got {active_a:?}"
    );
    assert_eq!(active_a[0].0, "P18_PG_A");
}
