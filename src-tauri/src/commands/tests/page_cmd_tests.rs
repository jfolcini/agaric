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
    let resolved = resolve_page_by_alias_inner(&pool, "Old1", &SpaceScope::Global)
        .await
        .unwrap();
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
        let r = resolve_page_by_alias_inner(&pool, old, &SpaceScope::Global)
            .await
            .unwrap();
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
        let r = resolve_page_by_alias_inner(&pool, leaked, &SpaceScope::Global)
            .await
            .unwrap();
        assert!(
            r.is_none(),
            "alias '{leaked}' must not be resolvable after rollback"
        );
    }
}

// #661 — the page-exists probe in `set_page_aliases_inner` must run
// INSIDE the `BEGIN IMMEDIATE` transaction (the F01/F02/F03
// sibling-command pattern). Pre-fix the probe ran on the pool BEFORE the
// tx opened, so a concurrent `delete_block` between the probe and the
// write lock left aliases attached to a tombstoned page (TOCTOU). The
// two tests below pin the in-tx behaviour:
//   1. a non-existent page id is rejected as NotFound with no aliases
//      written;
//   2. a soft-deleted (tombstoned) page is rejected as NotFound — the
//      in-tx probe sees `deleted_at IS NOT NULL` and aborts before the
//      DELETE/INSERT, so no aliases survive against the dead page.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_rejects_nonexistent_page() {
    let (pool, _dir) = test_pool().await;

    // No block with this id exists. The in-tx existence probe must
    // reject it before any DELETE/INSERT runs.
    let result = set_page_aliases_inner(&pool, "PAGE-NONE-1", vec!["X".into(), "Y".into()]).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "aliases on a non-existent page must return NotFound, got: {result:?}"
    );

    // And no aliases must have been written for the phantom page.
    let aliases = get_page_aliases_inner(&pool, "PAGE-NONE-1").await.unwrap();
    assert!(
        aliases.is_empty(),
        "no aliases may be attached to a non-existent page, got: {aliases:?}"
    );
    for a in ["X", "Y"] {
        let r = resolve_page_by_alias_inner(&pool, a, &SpaceScope::Global)
            .await
            .unwrap();
        assert!(
            r.is_none(),
            "alias '{a}' must not resolve to a phantom page"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_rejects_tombstoned_page() {
    // #661 — a page that has been soft-deleted (its `deleted_at` is set)
    // must be rejected by the in-tx existence probe. This models the
    // TOCTOU race the fix closes: pre-fix the probe ran outside the tx,
    // so a delete that landed after the probe but before the write lock
    // would still attach aliases to the now-tombstoned page. With the
    // probe inside the IMMEDIATE tx, the deleted page is never a valid
    // target and no aliases are written.
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE-TOMB-1", "page", "Doomed", None, Some(0)).await;

    // Seed a prior alias set so we can prove the DELETE never runs either
    // (the probe aborts the tx before touching `page_aliases`).
    set_page_aliases_inner(&pool, "PAGE-TOMB-1", vec!["before".into()])
        .await
        .unwrap();

    // Tombstone the page.
    sqlx::query("UPDATE blocks SET deleted_at = 1778284800000 WHERE id = 'PAGE-TOMB-1'")
        .execute(&pool)
        .await
        .unwrap();

    // Attempt to replace aliases on the now-deleted page.
    let result = set_page_aliases_inner(&pool, "PAGE-TOMB-1", vec!["after".into()]).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "aliases on a tombstoned page must return NotFound, got: {result:?}"
    );

    // The replacement alias must not have been attached.
    let r = resolve_page_by_alias_inner(&pool, "after", &SpaceScope::Global)
        .await
        .unwrap();
    assert!(
        r.is_none(),
        "no alias may be attached to a tombstoned page (TOCTOU window closed)"
    );
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
    let r1 = resolve_page_by_alias_inner(&pool, "MyAlias", &SpaceScope::Global)
        .await
        .unwrap();
    assert!(r1.is_some(), "exact alias should resolve");
    let (pid, title) = r1.unwrap();
    assert_eq!(pid, "PAGE-5", "resolved page id should match");
    assert_eq!(
        title.as_deref(),
        Some("Page Five"),
        "resolved page title should match"
    );

    // Different case
    let r2 = resolve_page_by_alias_inner(&pool, "myalias", &SpaceScope::Global)
        .await
        .unwrap();
    assert!(r2.is_some(), "lowercase alias should resolve");
    assert_eq!(
        r2.unwrap().0,
        "PAGE-5",
        "lowercase should resolve to same page"
    );

    let r3 = resolve_page_by_alias_inner(&pool, "MYALIAS", &SpaceScope::Global)
        .await
        .unwrap();
    assert!(r3.is_some(), "uppercase alias should resolve");
    assert_eq!(
        r3.unwrap().0,
        "PAGE-5",
        "uppercase should resolve to same page"
    );

    // Non-existent alias
    let r4 = resolve_page_by_alias_inner(&pool, "NoSuchAlias", &SpaceScope::Global)
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

/// R1 (#347): an out-of-range `limit` must surface as
/// `AppError::Validation`, matching the `list_blocks` / `list_trash`
/// contract — not be silently passed to SQLite. `None` and an in-range
/// value still succeed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_aliases_by_prefix_inner_rejects_out_of_range_limit_r1() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "PAGE_R1", "page", "R1", None, Some(0)).await;
    set_page_aliases_inner(&pool, "PAGE_R1", vec!["r1-alias".into()])
        .await
        .unwrap();

    // Zero is below the [1, MAX] range.
    let zero = list_page_aliases_by_prefix_inner(&pool, "r1-", Some(0), &SpaceScope::Global).await;
    assert!(
        matches!(zero, Err(crate::error::AppError::Validation(_))),
        "limit=0 must be rejected as Validation, got {zero:?}"
    );

    // A huge value (above MAX_PAGE_ALIASES_PREFIX = 50) is rejected too.
    let huge =
        list_page_aliases_by_prefix_inner(&pool, "r1-", Some(10_000), &SpaceScope::Global).await;
    assert!(
        matches!(huge, Err(crate::error::AppError::Validation(_))),
        "limit=10000 must be rejected as Validation, got {huge:?}"
    );

    // None and an in-range value still succeed.
    let ok_none = list_page_aliases_by_prefix_inner(&pool, "r1-", None, &SpaceScope::Global)
        .await
        .expect("None limit must succeed");
    assert_eq!(ok_none.len(), 1);
    let ok_in_range =
        list_page_aliases_by_prefix_inner(&pool, "r1-", Some(10), &SpaceScope::Global)
            .await
            .expect("in-range limit must succeed");
    assert_eq!(ok_in_range.len(), 1);
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
async fn list_page_aliases_by_prefix_inner_matches_substring() {
    // Picker parity (this commit) — alias matching uses LIKE '%q%' so a
    // non-prefix substring query surfaces the alias the same way FTS
    // surfaces a page whose title contains the query. Without this, a
    // user with an alias `personal-projects` who types `[[proj` sees the
    // page "Personal Projects" (via FTS title match) but not the alias.
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE_PP", "page", "Personal Projects", None, Some(0)).await;
    insert_block(&pool, "PAGE_X", "page", "Unrelated", None, Some(0)).await;

    set_page_aliases_inner(&pool, "PAGE_PP", vec!["personal-projects".into()])
        .await
        .unwrap();
    set_page_aliases_inner(&pool, "PAGE_X", vec!["other".into()])
        .await
        .unwrap();

    let result = list_page_aliases_by_prefix_inner(&pool, "proj", None, &SpaceScope::Global)
        .await
        .unwrap();

    assert_eq!(
        result.len(),
        1,
        "substring query must match middle-of-alias"
    );
    assert_eq!(result[0].0, "PAGE_PP");
    assert_eq!(result[0].1, "personal-projects");

    // Case-insensitive substring match parity — `PROJ` matches the same
    // way as `proj`.
    let upper = list_page_aliases_by_prefix_inner(&pool, "PROJ", None, &SpaceScope::Global)
        .await
        .unwrap();
    assert_eq!(upper.len(), 1);
    assert_eq!(upper[0].1, "personal-projects");
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

/// #660 — the keyset descendant walk must run inside ONE read
/// transaction so the whole multi-page export observes a single,
/// consistent WAL snapshot. Pre-fix each `fetch_all(pool)` page of the
/// keyset took its own snapshot, so a concurrent writer reshuffling
/// `position` between two pages could make a block straddle the cursor
/// boundary and appear *twice* (or get skipped) in the output.
///
/// This test forces > `DESCENDANT_PAGE_SIZE` (200) descendants and then,
/// while repeatedly exporting, hammers the page with concurrent
/// `position` churn from a background task. With the single-snapshot fix
/// every export is internally consistent: no content line ever appears
/// more than once. (Pre-fix, the position churn straddling a keyset
/// boundary produced duplicate lines.)
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn export_page_markdown_single_snapshot_no_dup_under_concurrent_reorder() {
    let (pool, _dir) = test_pool().await;

    // 300 direct children — comfortably above the 200-row page size, so
    // the keyset loop iterates at least twice and a concurrent reorder
    // can land between two pages.
    const N: i64 = 300;
    let page_id = "01SNAPSH0TPAGE00000000PAG1";
    insert_block(&pool, page_id, "page", "Snapshot Page", None, Some(0)).await;
    for i in 0..N {
        let child_id = format!("01SNAPCHILD{i:015}");
        insert_block(
            &pool,
            &child_id,
            "content",
            &format!("snap-line-{i}"),
            Some(page_id),
            Some(i + 1),
        )
        .await;
    }
    crate::cache::rebuild_page_ids(&pool).await.unwrap();

    // Background writer: continuously reshuffle child positions so that
    // rows cross the keyset cursor boundary mid-export. Pre-fix this is
    // exactly what causes a row to be read twice (once near the tail of
    // page K under its old position, once near the head of page K+1
    // under its new position).
    let writer_pool = pool.clone();
    let writer = tokio::spawn(async move {
        for round in 0..40i64 {
            // Rotate every child's position by a round-dependent offset.
            // `position = ((position + round) % N) + 1` keeps values in
            // [1, N] while churning the global order each round.
            sqlx::query(
                "UPDATE blocks SET position = ((position + ?1) % ?2) + 1 \
                 WHERE page_id = ?3 AND id != ?3 AND deleted_at IS NULL",
            )
            .bind(round)
            .bind(N)
            .bind(page_id)
            .execute(&writer_pool)
            .await
            .unwrap();
            tokio::task::yield_now().await;
        }
    });

    // Export repeatedly while the writer churns positions. Each export
    // must be internally consistent: every `snap-line-K` content line
    // appears AT MOST once. A duplicate would be the pre-fix
    // cross-snapshot read-twice bug.
    for _ in 0..40 {
        let md = export_page_markdown_inner(&pool, page_id).await.unwrap();
        for i in 0..N {
            let needle = format!("snap-line-{i}\n");
            let count = md.matches(&needle).count();
            assert!(
                count <= 1,
                "line {needle:?} appeared {count} times — a multi-snapshot \
                 read duplicated a row across the keyset boundary (#660)"
            );
        }
        tokio::task::yield_now().await;
    }

    writer.await.unwrap();

    // Final settle: once positions stop changing, the export must be
    // COMPLETE — every child line present exactly once. This guards the
    // skip half of the bug (a row falling between two snapshots and
    // never being read).
    let md = export_page_markdown_inner(&pool, page_id).await.unwrap();
    for i in 0..N {
        let needle = format!("snap-line-{i}\n");
        let count = md.matches(&needle).count();
        assert_eq!(
            count, 1,
            "after the writer stops, line {needle:?} must appear exactly \
             once (present + not duplicated); got {count}"
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

/// #384 regression: exported frontmatter must
///   (a) EXCLUDE internal/system-managed keys (space, is_space, template,
///       created_at, repeat-*, …), and
///   (b) RENDER value_ref (resolved to the referenced page's title) and
///       value_num (the number) instead of dropping them to empty — the
///       old query only projected value_text + value_date.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_page_markdown_frontmatter_filters_internal_and_renders_ref_num() {
    let (pool, _dir) = test_pool().await;

    const PAGE: &str = "01AAAAAAAAAAAAAAAAAAAAPAGE";
    const REF_TARGET: &str = "01AAAAAAAAAAAAAAAAAAATARGT";

    // The exported page.
    insert_block(&pool, PAGE, "page", "Props Page", None, Some(1)).await;
    // The page a value_ref property points at.
    insert_block(&pool, REF_TARGET, "page", "Linked Page", None, Some(1)).await;
    crate::cache::rebuild_page_ids(&pool).await.unwrap();

    // Seed a mix of properties on the page block.
    let seed = |key: &'static str, col: &'static str, val: &'static str| {
        let pool = pool.clone();
        async move {
            let sql =
                format!("INSERT INTO block_properties (block_id, key, {col}) VALUES (?, ?, ?)");
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(PAGE)
                .bind(key)
                .bind(val)
                .execute(&pool)
                .await
                .unwrap();
        }
    };
    // User-visible text + date properties (must survive).
    seed("status", "value_text", "active").await;
    seed("due", "value_date", "2026-01-15").await;
    // Numeric property (must render the number, not empty).
    sqlx::query("INSERT INTO block_properties (block_id, key, value_num) VALUES (?, 'effort', 3)")
        .bind(PAGE)
        .execute(&pool)
        .await
        .unwrap();
    // Ref property (must render the target page title, not empty / ULID).
    sqlx::query("INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'parent', ?)")
        .bind(PAGE)
        .bind(REF_TARGET)
        .execute(&pool)
        .await
        .unwrap();
    // Internal keys (must NOT leak into frontmatter). #534: `space` is
    // column-backed on `blocks` (the single source of truth) and is now
    // CHECK-forbidden as a `block_properties` row, so it can never reach
    // the frontmatter query — the `space:` / `SPACEVAL` absence assertions
    // below therefore hold by construction; no seed row is inserted for it.
    seed("is_space", "value_text", "true").await;
    seed("template", "value_text", "weekly").await;
    seed("created_at", "value_text", "2020-01-01").await;
    seed("repeat", "value_text", "daily").await;

    let md = export_page_markdown_inner(&pool, PAGE).await.unwrap();

    // Internal keys absent.
    for internal in ["space:", "is_space:", "template:", "created_at:", "repeat:"] {
        assert!(
            !md.contains(internal),
            "internal key {internal:?} must NOT appear in frontmatter, got:\n{md}"
        );
    }
    assert!(
        !md.contains("SPACEVAL"),
        "internal 'space' value must not leak, got:\n{md}"
    );

    // User properties present, with non-empty values.
    assert!(
        md.contains("status: active"),
        "text prop missing, got:\n{md}"
    );
    assert!(
        md.contains("due: 2026-01-15"),
        "date prop missing, got:\n{md}"
    );
    // Numeric renders the number (not empty, no trailing .0).
    assert!(
        md.contains("effort: 3\n"),
        "numeric prop must render, got:\n{md}"
    );
    // Ref resolves to the target page title (non-empty).
    assert!(
        md.contains("parent: Linked Page"),
        "value_ref must resolve to the referenced page title, got:\n{md}"
    );
}

/// #472 — `value_bool` properties must appear in the YAML frontmatter export.
/// Pre-fix, `FrontmatterRow` omitted `value_bool` entirely, so boolean
/// properties silently vanished from the output.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_page_markdown_frontmatter_renders_bool_properties() {
    let (pool, _dir) = test_pool().await;

    const PAGE: &str = "01AAAAAAAAAAAAAAAAAAAAPAGE";
    insert_block(&pool, PAGE, "page", "Bool Page", None, Some(1)).await;
    crate::cache::rebuild_page_ids(&pool).await.unwrap();

    // Insert a true boolean property (value_bool = 1).
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_bool) VALUES (?, 'published', 1)",
    )
    .bind(PAGE)
    .execute(&pool)
    .await
    .unwrap();

    // Insert a false boolean property (value_bool = 0).
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_bool) VALUES (?, 'archived', 0)",
    )
    .bind(PAGE)
    .execute(&pool)
    .await
    .unwrap();

    let md = export_page_markdown_inner(&pool, PAGE).await.unwrap();

    assert!(
        md.contains("published: true"),
        "value_bool = 1 must render as 'true', got:\n{md}"
    );
    assert!(
        md.contains("archived: false"),
        "value_bool = 0 must render as 'false', got:\n{md}"
    );
}

// ======================================================================
// export_page_markdown — error paths (TEST-11)
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

    let result = export_page_markdown_inner(&pool, page.id.as_str()).await;

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
    // PEND-35 Tier 1.1 — `import_markdown_inner` now requires a valid
    // space_id. Seed the synthetic test space and stamp `is_space=true`.
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    let content = "- Block 1\n  - Child 1\n  - Child 2\n- Block 2";
    let result = import_markdown_inner(
        &pool,
        DEV,
        &mat,
        content.into(),
        Some("TestPage.md".into()),
        TEST_SPACE_ID.into(),
    )
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
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    // BUG-20: values must be in the seeded options:
    //   priority: ["1","2","3"]; status: ["active","paused","done","archived"]
    let content = "- Task\n  priority:: 1\n  status:: done";
    let result = import_markdown_inner(
        &pool,
        DEV,
        &mat,
        content.into(),
        Some("Props.md".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();

    assert_eq!(
        result.blocks_created, 1,
        "should create 1 block with properties"
    );
    assert_eq!(result.properties_set, 2, "should set 2 properties");

    mat.shutdown();
}

/// #623 — a Logseq line `due_date:: 2026-01-01` must import as a date on
/// `blocks.due_date`, not abort the whole all-or-nothing import. Before the
/// fix the importer passed the value as `value_text`, which
/// `validate_property_value` rejects for the date reserved keys.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_due_date_stores_as_date() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    let content = "- Pay rent\n  due_date:: 2026-01-01\n  scheduled_date:: 2026-02-02";
    let result = import_markdown_inner(
        &pool,
        DEV,
        &mat,
        content.into(),
        Some("Dated.md".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .expect("a due_date:: line must NOT abort the whole import (#623)");

    assert_eq!(result.blocks_created, 1, "should create the dated block");
    assert_eq!(result.properties_set, 2, "due_date + scheduled_date");

    // The content block (not the page) carries the dates on its native
    // columns. Match on content so we skip the page block.
    let (due, scheduled): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT due_date, scheduled_date FROM blocks WHERE content = 'Pay rent'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        due,
        Some("2026-01-01".into()),
        "due_date must land on blocks.due_date as a date"
    );
    assert_eq!(
        scheduled,
        Some("2026-02-02".into()),
        "scheduled_date must land on blocks.scheduled_date as a date"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_strips_block_refs() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    let content = "- See ((abc-123-def)) for details";
    let result =
        import_markdown_inner(&pool, DEV, &mat, content.into(), None, TEST_SPACE_ID.into())
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
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    let result = import_markdown_inner(
        &pool,
        DEV,
        &mat,
        "".into(),
        Some("Empty.md".into()),
        TEST_SPACE_ID.into(),
    )
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

// ======================================================================
// #128 (PEND-38 / PEND-06 Tier 3) — import progress streaming
// ======================================================================

/// Test recorder for [`ImportProgressUpdate`] events, mirroring
/// `sync_events::RecordingEventSink`. Captures the emitted stream so a
/// test can assert the `Started` → `Progress`* → `Complete` contract
/// without a Tauri `Channel`.
#[derive(Default)]
struct RecordingImportSink(std::sync::Mutex<Vec<crate::import::ImportProgressUpdate>>);

impl crate::import::ImportProgressSink for RecordingImportSink {
    fn emit(&self, update: crate::import::ImportProgressUpdate) {
        self.0.lock().unwrap().push(update);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_emits_started_progress_complete() {
    use crate::import::ImportProgressUpdate as U;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    let sink = RecordingImportSink::default();
    // 4 blocks: Block 1, Child 1, Child 2, Block 2 (matches the
    // happy-path test above).
    let content = "- Block 1\n  - Child 1\n  - Child 2\n- Block 2";
    let result = import_markdown_with_progress(
        &pool,
        DEV,
        &mat,
        content.into(),
        Some("Streamed.md".into()),
        TEST_SPACE_ID.into(),
        Some(&sink),
    )
    .await
    .unwrap();
    assert_eq!(result.blocks_created, 4);

    let events = sink.0.lock().unwrap().clone();
    // 1 Started + 4 Progress + 1 Complete = 6 events.
    assert_eq!(events.len(), 6, "expected Started + 4 Progress + Complete");

    match &events[0] {
        U::Started {
            page_title,
            blocks_total,
        } => {
            assert_eq!(page_title, "Streamed");
            assert_eq!(*blocks_total, 4, "Started carries the parser block count");
        }
        other => panic!("first event must be Started, got {other:?}"),
    }

    // The four middle events count up 1..=4, all carrying blocks_total=4.
    for (i, ev) in events[1..5].iter().enumerate() {
        match ev {
            U::Progress {
                blocks_done,
                blocks_total,
            } => {
                assert_eq!(*blocks_done, (i + 1) as u64, "Progress counts up");
                assert_eq!(*blocks_total, 4);
            }
            other => panic!("event {} must be Progress, got {other:?}", i + 1),
        }
    }

    match events.last().unwrap() {
        U::Complete {
            page_title,
            blocks_created,
            properties_set,
        } => {
            assert_eq!(page_title, "Streamed");
            assert_eq!(*blocks_created, 4, "Complete mirrors ImportResult counts");
            assert_eq!(*properties_set, 0);
        }
        other => panic!("last event must be Complete, got {other:?}"),
    }

    mat.shutdown();
}

/// Empty content: exactly one `Started` (blocks_total=0), zero `Progress`,
/// and one `Complete`. The UI must still get a terminal event so it can
/// dismiss the progress bar even when nothing was imported.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_progress_empty_file_started_then_complete() {
    use crate::import::ImportProgressUpdate as U;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    let sink = RecordingImportSink::default();
    import_markdown_with_progress(
        &pool,
        DEV,
        &mat,
        "".into(),
        Some("Empty.md".into()),
        TEST_SPACE_ID.into(),
        Some(&sink),
    )
    .await
    .unwrap();

    let events = sink.0.lock().unwrap().clone();
    assert_eq!(events.len(), 2, "Started + Complete, no Progress");
    assert!(
        matches!(
            &events[0],
            U::Started {
                blocks_total: 0,
                ..
            }
        ),
        "Started must report blocks_total=0 for an empty file, got {:?}",
        events[0]
    );
    assert!(
        matches!(
            &events[1],
            U::Complete {
                blocks_created: 0,
                ..
            }
        ),
        "Complete must report blocks_created=0, got {:?}",
        events[1]
    );

    mat.shutdown();
}

/// A failed import (unknown space) emits NO events at all because the
/// space validation happens *before* the `Started` emit... actually
/// `Started` is emitted before the tx opens, so a space-validation
/// failure still yields `Started` but never `Complete`. Assert that
/// contract: a consumer that sees `Started` without a trailing `Complete`
/// must treat the import as failed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_progress_failure_emits_no_complete() {
    use crate::import::ImportProgressUpdate as U;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    // Deliberately do NOT mark any block as a space, so the in-tx
    // `is_space='true'` validation fails and the import rolls back.
    ensure_test_space(&pool).await;

    let sink = RecordingImportSink::default();
    let res = import_markdown_with_progress(
        &pool,
        DEV,
        &mat,
        "- Block 1\n- Block 2".into(),
        Some("Fails.md".into()),
        TEST_SPACE_ID.into(),
        Some(&sink),
    )
    .await;
    assert!(res.is_err(), "import into a non-space must fail");

    let events = sink.0.lock().unwrap().clone();
    // `Started` fires before the tx opens; the failure happens at the
    // in-tx space check, so no `Progress` and no `Complete`.
    assert_eq!(
        events.len(),
        1,
        "only Started before the validation failure"
    );
    assert!(
        matches!(&events[0], U::Started { .. }),
        "the single event must be Started, got {:?}",
        events[0]
    );
    assert!(
        !events.iter().any(|e| matches!(e, U::Complete { .. })),
        "a failed import must never emit Complete"
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
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    // BUG-20: values must be in the seeded options:
    //   priority: ["1","2","3"]; status: ["active","paused","done","archived"]
    let content = "- Parent block\n  priority:: 1\n  status:: active\n  - Child A\n  - Child B\n    - Grandchild";
    let result = import_markdown_inner(
        &pool,
        DEV,
        &mat,
        content.into(),
        Some("TxTest.md".into()),
        TEST_SPACE_ID.into(),
    )
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
        r#"SELECT id as "id!: crate::ulid::BlockId", block_type, content, parent_id as "parent_id: crate::ulid::BlockId", position, deleted_at, todo_state, priority, due_date, scheduled_date, page_id as "page_id: crate::ulid::BlockId" FROM blocks WHERE block_type = 'page' AND content = 'TxTest'"#
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(page.is_some(), "page block must exist");
    let page = page.unwrap();

    // Verify all content blocks exist under the page hierarchy
    let all_blocks: Vec<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id as "id!: crate::ulid::BlockId", block_type, content, parent_id as "parent_id: crate::ulid::BlockId", position, deleted_at, todo_state, priority, due_date, scheduled_date, page_id as "page_id: crate::ulid::BlockId" FROM blocks WHERE block_type = 'content' ORDER BY position"#
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
        parent_block
            .parent_id
            .as_ref()
            .map(crate::ulid::BlockId::as_str),
        Some(page.id.as_str()),
        "Parent block should be child of the page"
    );

    // Verify child: "Child A" has parent = "Parent block"
    let child_a = all_blocks
        .iter()
        .find(|b| b.content.as_deref() == Some("Child A"))
        .expect("Child A must exist");
    assert_eq!(
        child_a.parent_id.as_ref().map(crate::ulid::BlockId::as_str),
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
        grandchild
            .parent_id
            .as_ref()
            .map(crate::ulid::BlockId::as_str),
        Some(child_b.id.as_str()),
        "Grandchild should be child of Child B"
    );

    // Verify properties were persisted
    // "priority" is a reserved key stored in blocks.priority column
    let refreshed_parent: BlockRow = sqlx::query_as!(
        BlockRow,
        r#"SELECT id as "id!: crate::ulid::BlockId", block_type, content, parent_id as "parent_id: crate::ulid::BlockId", position, deleted_at, todo_state, priority, due_date, scheduled_date, page_id as "page_id: crate::ulid::BlockId" FROM blocks WHERE id = ?"#,
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

    // Verify op_log entries: 1 page + 1 set_property(space) for the
    // page (PEND-35 Tier 1.1) + 4 blocks + 2 properties = 8 ops
    let op_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM op_log WHERE device_id = ?")
        .bind(DEV)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        op_count.0, 8,
        "op_log should have 8 entries (1 page + 1 set_property(space) + 4 blocks + 2 properties)"
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
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    // Baseline: post-seed snapshot. Includes the seeded space block +
    // its `is_space = true` property row, so the post-error assertions
    // compare against the seeded state rather than a strictly empty DB.
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
        TEST_SPACE_ID.into(),
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
// #662 — chunked import releases the writer lock between chunks
// ======================================================================

/// Build a Logseq-style markdown string with `n` top-level (depth-0)
/// content blocks, one per line. Each is its own single-block subtree, so
/// the import can flush a chunk at any of these boundaries.
fn flat_markdown(n: usize) -> String {
    let mut s = String::with_capacity(n * 12);
    for i in 0..n {
        s.push_str(&format!("- Block {i}\n"));
    }
    s
}

/// #662 — a multi-chunk import must produce the *same* tree as the
/// single-chunk (small) path: same page, same number of content blocks,
/// all parented to the page, all in the right space. This is the
/// "correctness unchanged after chunking" guard — the chunk boundary is
/// purely a lock-release point, never a data-shape change.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_multi_chunk_tree_matches_single_chunk() {
    use crate::commands::pages::markdown::IMPORT_CHUNK_BLOCKS;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    // 2.5 chunks' worth of flat top-level blocks → at least 3 chunks, so
    // the import commits + releases the writer lock at least twice mid-way.
    let n = IMPORT_CHUNK_BLOCKS * 2 + IMPORT_CHUNK_BLOCKS / 2;
    let n_i64 = i64::try_from(n).unwrap();
    let content = flat_markdown(n);

    let result = import_markdown_inner(
        &pool,
        DEV,
        &mat,
        content,
        Some("BigFlat.md".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();

    assert_eq!(result.page_title, "BigFlat");
    assert_eq!(
        result.blocks_created, n_i64,
        "all blocks must be created across chunks"
    );
    assert!(result.warnings.is_empty());

    // The page exists once.
    let page: BlockRow = sqlx::query_as!(
        BlockRow,
        r#"SELECT id as "id!: crate::ulid::BlockId", block_type, content, parent_id as "parent_id: crate::ulid::BlockId", position, deleted_at, todo_state, priority, due_date, scheduled_date, page_id as "page_id: crate::ulid::BlockId" FROM blocks WHERE block_type = 'page' AND content = 'BigFlat'"#
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    // Every content block landed, all parented to the page (depth-0), and
    // all carry the page's `page_id` — identical shape to the single-chunk
    // path, just committed across several transactions.
    let content_blocks: Vec<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id as "id!: crate::ulid::BlockId", block_type, content, parent_id as "parent_id: crate::ulid::BlockId", position, deleted_at, todo_state, priority, due_date, scheduled_date, page_id as "page_id: crate::ulid::BlockId" FROM blocks WHERE block_type = 'content' ORDER BY position, id"#
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        content_blocks.len(),
        n,
        "every content block must be present after a multi-chunk import"
    );
    for b in &content_blocks {
        assert_eq!(
            b.parent_id.as_ref().map(crate::ulid::BlockId::as_str),
            Some(page.id.as_str()),
            "every depth-0 block must be a direct child of the page across chunk boundaries"
        );
        assert_eq!(
            b.page_id.as_ref().map(crate::ulid::BlockId::as_str),
            Some(page.id.as_str()),
            "every block must carry the page's page_id regardless of which chunk wrote it"
        );
    }

    // op_log: 1 page + 1 set_property(space) + n block creates = n + 2.
    let op_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM op_log WHERE device_id = ?")
        .bind(DEV)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        op_count.0,
        n_i64 + 2,
        "op_log must hold every op across chunks (1 page + 1 space prop + n blocks)"
    );

    mat.shutdown();
}

/// #662 — the core lock-release guard. A progress sink performs ONE read
/// of the committed content-block count from a *separate pool connection*,
/// taken at the first `Progress` tick after the first chunk boundary
/// should have flushed. Under the old single-transaction import the writer
/// holds an uncommitted transaction for the whole run, so a separate
/// connection sees ZERO content blocks until the final commit. Under the
/// chunked import the first chunk has already committed (releasing the
/// writer lock) by that tick, so the separate reader observes a strictly-
/// positive, strictly-partial count — proving the lock was released and a
/// chunk became durable before the import finished.
///
/// The read is gated to fire exactly once (an `AtomicBool`) rather than on
/// every one of the ~`n` ticks: a nested `block_on` read per tick starves
/// the connection pool (`PoolTimedOut`) and makes the test slow + flaky.
/// One read at the right moment is both deterministic and cheap.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn import_markdown_commits_chunks_visible_to_separate_reader_662() {
    use crate::commands::pages::markdown::IMPORT_CHUNK_BLOCKS;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    // 1.5 chunks → exactly two chunks. Chunk 1 commits `IMPORT_CHUNK_BLOCKS`
    // blocks partway through; chunk 2 (the rest) commits only at the very
    // end. So for the *entire* span chunk 2 is being written, the committed
    // content-block count sits at exactly `IMPORT_CHUNK_BLOCKS` — a stable,
    // strictly-partial value a separate reader is guaranteed to observe.
    // (Kept at the minimum that proves ≥2 chunks — the per-block
    // O(siblings) cache recompute on the import path makes larger flat
    // imports slow.)
    let n = IMPORT_CHUNK_BLOCKS + IMPORT_CHUNK_BLOCKS / 2;
    let n_i64 = i64::try_from(n).unwrap();
    let chunk_i64 = i64::try_from(IMPORT_CHUNK_BLOCKS).unwrap();
    let content = flat_markdown(n);

    // A concurrent poller on a *separate, dedicated* connection (acquired
    // up front so it never competes with the import's pool connections for
    // acquisition mid-run — the prior `block_in_place`-per-tick design
    // starved the pool under parallel test load → flaky `PoolTimedOut`).
    // It records the max committed `content` count it observes *strictly
    // below* the total `n`, i.e. while the import has not yet finished. The
    // poller stops once the import signals completion.
    let done = std::sync::Arc::new(tokio::sync::Notify::new());
    let poller_pool = pool.clone();
    let poller_done = done.clone();
    let poller = tokio::spawn(async move {
        let mut conn = poller_pool
            .acquire()
            .await
            .expect("dedicated reader connection should be available");
        let mut max_partial: i64 = 0;
        loop {
            let visible: i64 = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM blocks WHERE block_type = 'content'",
            )
            .fetch_one(&mut *conn)
            .await
            .expect("reader count query should succeed");
            // Only count observations made *before* the import finished
            // (committed count still < n). Once the final chunk commits the
            // count reaches n; that is the completed state, not a mid-import
            // window.
            if visible > 0 && visible < n_i64 && visible > max_partial {
                max_partial = visible;
            }
            // Stop promptly once the import signals it is done, after one
            // last read above.
            tokio::select! {
                () = poller_done.notified() => break,
                () = tokio::task::yield_now() => {}
            }
        }
        max_partial
    });

    let result = import_markdown_with_progress(
        &pool,
        DEV,
        &mat,
        content,
        Some("LockRelease.md".into()),
        TEST_SPACE_ID.into(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.blocks_created, n_i64);

    // Signal the poller and collect the max partial count it observed.
    done.notify_one();
    let max_partial = poller.await.expect("poller task should not panic");

    // The separate reader observed a whole committed chunk while the
    // import was still mid-flight: at least one full chunk's worth of
    // blocks, strictly fewer than the total. Under the old
    // single-transaction import nothing commits until the very end, so a
    // separate connection would have seen only 0 then jumped straight to
    // `n` — `max_partial` would have stayed 0.
    assert!(
        max_partial >= chunk_i64,
        "a separate reader must observe at least the first committed chunk ({chunk_i64} blocks) mid-import — proving the writer lock was released between chunks; saw {max_partial} of {n}"
    );
    assert!(
        max_partial < n_i64,
        "the observed mid-import count must be strictly partial (chunking, not a whole-import commit); saw {max_partial} of {n}"
    );

    // Final state is still complete and correct.
    let final_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM blocks WHERE block_type = 'content'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        final_count.0, n_i64,
        "all blocks present once the import completes"
    );

    mat.shutdown();
}

// ======================================================================
// PEND-35 Tier 1.1 — `import_markdown_inner` stamps `space` property
// ======================================================================
//
// Pre-PEND-35, `import_markdown_inner` created a page block but never
// appended a `SetProperty(key='space', value_ref=<space>)` op. Imported
// pages were therefore invisible to space-scoped reads
// (`list_blocks_inner`, `get_page_inner`) and broke the FEAT-3 invariant
// "nothing outside of spaces". The fix mirrors `create_page_in_space_inner`:
// validate `space_id` upfront inside the same `BEGIN IMMEDIATE` tx, then
// append the `SetProperty(space=...)` op right after the `CreateBlock` so
// the page never lands without its space.

/// PEND-35 Tier 1.1 — happy path: imported page must carry `space =
/// ?space_id` in `block_properties`. Without the fix, the page would
/// land with no `space` property at all.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_stamps_space_property() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    let content = "- A simple block";
    let result = import_markdown_inner(
        &pool,
        DEV,
        &mat,
        content.into(),
        Some("StampTest.md".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .expect("happy-path import must succeed");
    assert_eq!(result.page_title, "StampTest");

    // Look up the imported page by content (filename-derived title) and
    // verify its space membership points to the requested space. Phase 2
    // (#533): membership lives in `blocks.space_id` (the sole source of
    // truth; the `block_properties(key='space')` row was retired in
    // migration 0087).
    let page_id: String = sqlx::query_scalar(
        "SELECT id FROM blocks WHERE block_type = 'page' AND content = 'StampTest'",
    )
    .fetch_one(&pool)
    .await
    .expect("imported page must exist");

    let space_ref: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
        .bind(&page_id)
        .fetch_one(&pool)
        .await
        .expect("imported page row must exist");
    assert_eq!(
        space_ref.as_deref(),
        Some(TEST_SPACE_ID),
        "imported page's `space_id` must point to the requested space \
         (PEND-35 Tier 1.1: orphan-page fix)"
    );

    mat.shutdown();
}

/// PEND-35 Tier 1.1 — invalid space rejection: passing a ULID that does
/// not refer to a live block carrying `is_space = 'true'` must surface as
/// `AppError::Validation` and leave the DB unchanged. Mirrors
/// `create_page_in_space_rejects_nonexistent_space` in spaces.rs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_rejects_invalid_space() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    // Intentionally do NOT seed a space — the validator must reject the
    // bogus ULID before any block lands.

    // Capture baseline so the assertion tolerates any seed rows the
    // fixture (migrations, default property defs, …) may have added.
    let blocks_before: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    let ops_before: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM op_log WHERE device_id = ?")
        .bind(DEV)
        .fetch_one(&pool)
        .await
        .unwrap();

    let bogus = "01JXXXX0000000000000000000".to_string();
    let result = import_markdown_inner(
        &pool,
        DEV,
        &mat,
        "- Block 1".into(),
        Some("RejectTest.md".into()),
        bogus,
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "unknown space_id must yield AppError::Validation, got {result:?}"
    );

    // Atomicity: the validation failure must roll back the whole tx — no
    // page row, no op_log row.
    let blocks_after: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        blocks_after.0, blocks_before.0,
        "no block rows should land when space validation fails"
    );
    let ops_after: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM op_log WHERE device_id = ?")
        .bind(DEV)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        ops_after.0, ops_before.0,
        "no op_log entries should land when space validation fails"
    );

    mat.shutdown();
}

// ======================================================================
// PEND-35 Tier 1.2 — `resolve_page_by_alias_inner` SpaceScope
// ======================================================================
//
// Pre-PEND-35, the inner took only `alias: &str` and the SQL had no
// `space` predicate, so an alias matching a foreign-space page would
// surface in the active space's UI (cross-space leak in SearchPanel /
// PageBrowser). The fix takes a `&SpaceScope` and applies the same
// `(?N IS NULL OR pa.page_id IN (SELECT bp.block_id ...))` short-circuit
// `list_page_aliases_by_prefix_inner` already uses.

/// PEND-35 Tier 1.2 — two pages in two spaces share a single alias. A
/// scoped resolve must surface only the page belonging to that scope;
/// the unscoped (Global) resolve still returns one match (the page that
/// won the `INSERT OR IGNORE` race for the alias row).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resolve_page_by_alias_active_scope_excludes_other_spaces() {
    let (pool, _dir) = test_pool().await;

    // Seed two spaces (A and B) and a page in each.
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;
    insert_block(&pool, "PAGE_A_ALIAS", "page", "Page in A", None, Some(0)).await;
    insert_block(&pool, "PAGE_B_ALIAS", "page", "Page in B", None, Some(0)).await;
    assign_to_space(&pool, "PAGE_A_ALIAS", TEST_SPACE_ID).await;
    assign_to_space(&pool, "PAGE_B_ALIAS", TEST_SPACE_B_ID).await;

    // Both pages claim the same alias text. `INSERT OR IGNORE` on the
    // unique `page_aliases.alias` column means only the first writer
    // lands — that's enough for this test: the scope filter must surface
    // the matching alias's page only when it belongs to that space.
    // (For the Active(B) branch we also write the alias under PAGE_B
    // directly so there's a row to match — bypass `set_page_aliases_inner`'s
    // first-writer-wins behaviour by inserting both alias rows here.)
    sqlx::query("INSERT INTO page_aliases (page_id, alias) VALUES (?, ?)")
        .bind("PAGE_A_ALIAS")
        .bind("shared-alias-A")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO page_aliases (page_id, alias) VALUES (?, ?)")
        .bind("PAGE_B_ALIAS")
        .bind("shared-alias-B")
        .execute(&pool)
        .await
        .unwrap();

    // Scoped to A: alias of A surfaces, alias of B does not.
    let in_a = resolve_page_by_alias_inner(
        &pool,
        "shared-alias-A",
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
    )
    .await
    .unwrap();
    assert_eq!(
        in_a.as_ref().map(|t| t.0.as_str()),
        Some("PAGE_A_ALIAS"),
        "Active(A) must surface the page that lives in A"
    );

    let b_from_a = resolve_page_by_alias_inner(
        &pool,
        "shared-alias-B",
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
    )
    .await
    .unwrap();
    assert!(
        b_from_a.is_none(),
        "Active(A) MUST NOT surface a page that lives in B \
         (PEND-35 Tier 1.2: cross-space leak fix)"
    );

    // Scoped to B: mirror image — only B's alias surfaces.
    let in_b = resolve_page_by_alias_inner(
        &pool,
        "shared-alias-B",
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_B_ID)),
    )
    .await
    .unwrap();
    assert_eq!(
        in_b.as_ref().map(|t| t.0.as_str()),
        Some("PAGE_B_ALIAS"),
        "Active(B) must surface the page that lives in B"
    );

    let a_from_b = resolve_page_by_alias_inner(
        &pool,
        "shared-alias-A",
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_B_ID)),
    )
    .await
    .unwrap();
    assert!(
        a_from_b.is_none(),
        "Active(B) MUST NOT surface a page that lives in A \
         (PEND-35 Tier 1.2: cross-space leak fix)"
    );

    // SpaceScope::Global: the unscoped path keeps pre-PEND-35 behaviour
    // — both aliases still resolve, regardless of which space the page
    // lives in. Confirms the filter is opt-in and does not regress the
    // MCP / agent paths that span every space.
    let global_a = resolve_page_by_alias_inner(&pool, "shared-alias-A", &SpaceScope::Global)
        .await
        .unwrap();
    assert_eq!(
        global_a.as_ref().map(|t| t.0.as_str()),
        Some("PAGE_A_ALIAS"),
        "Global must still resolve A's alias"
    );
    let global_b = resolve_page_by_alias_inner(&pool, "shared-alias-B", &SpaceScope::Global)
        .await
        .unwrap();
    assert_eq!(
        global_b.as_ref().map(|t| t.0.as_str()),
        Some("PAGE_B_ALIAS"),
        "Global must still resolve B's alias"
    );
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

    let links = list_page_links_inner(&pool, &SpaceScope::Global, None)
        .await
        .unwrap();

    // Should have at least one link: p1 → p2 (rolled up from b1 → p2)
    let p1_to_p2 = links
        .iter()
        .find(|l| l.source_id == p1.id.as_str() && l.target_id == p2.id.as_str());
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

    let links = list_page_links_inner(&pool, &SpaceScope::Global, None)
        .await
        .unwrap();
    let has_deleted = links.iter().any(|l| l.target_id == p2.id.as_str());
    assert!(!has_deleted, "should not include links to deleted pages");

    mat.shutdown();
}

/// SQL/C1 (#341): an upgrading user who opens the graph/backlinks view
/// before any edit has an empty `page_link_cache` but a populated
/// `block_links` table (migration 0065 creates the cache empty with no
/// backfill). The lazy rebuild that fires in that state is a
/// DELETE+INSERT, so it MUST run on the write pool — driving it through
/// the `query_only=ON` read pool produced "attempt to write a readonly
/// database". This test reproduces the exact upgrade state against a
/// real split pool (`init_pools` → `query_only` reader) and asserts the
/// read both succeeds AND backfills the rolled-up edge.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_split_lazy_rebuild_on_readonly_pool_c1() {
    use crate::db::init_pools;

    let dir = tempfile::TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let pools = init_pools(&db_path).await.unwrap();
    let write = pools.write.clone();
    let read = pools.read.clone();

    // Two pages + a content block under p1 linking to p2 — written via
    // the write pool (the read pool is query_only).
    insert_block(&write, "PAGE-AAAA", "page", "Page A", None, Some(0)).await;
    insert_block(&write, "PAGE-BBBB", "page", "Page B", None, Some(1)).await;
    insert_block(
        &write,
        "BLCK-AAAA",
        "content",
        "see [[PAGE-BBBB]]",
        Some("PAGE-AAAA"),
        Some(0),
    )
    .await;

    // Populate `block_links` directly (mimicking a backfilled-but-cache-
    // empty upgrade window) and leave `page_link_cache` empty.
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind("BLCK-AAAA")
        .bind("PAGE-BBBB")
        .execute(&write)
        .await
        .unwrap();

    // Sanity: cache is empty before the read.
    let cache_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_link_cache")
        .fetch_one(&read)
        .await
        .unwrap();
    assert_eq!(cache_rows, 0, "page_link_cache must start empty");

    // The read drives the lazy rebuild. Pre-fix this returned
    // "attempt to write a readonly database"; post-fix the rebuild lands
    // on the write pool and the call succeeds.
    let links =
        crate::commands::list_page_links_inner_split(&write, &read, &SpaceScope::Global, None)
            .await
            .expect("split read must not write through the read pool");

    let edge = links
        .iter()
        .find(|l| l.source_id == "PAGE-AAAA" && l.target_id == "PAGE-BBBB");
    assert!(
        edge.is_some(),
        "rolled-up p1→p2 edge must be present after the lazy rebuild"
    );

    // The rebuild must have committed to the cache via the write pool.
    let cache_rows_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_link_cache")
        .fetch_one(&read)
        .await
        .unwrap();
    assert_eq!(
        cache_rows_after, 1,
        "lazy rebuild must persist the edge to page_link_cache"
    );
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

    let links = list_page_links_inner(&pool, &SpaceScope::Global, None)
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
    let links = list_page_links_inner(&pool, &SpaceScope::Global, None)
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

    let links = list_page_links_inner(&pool, &SpaceScope::Global, None)
        .await
        .unwrap();

    // Both b1 and b2 roll up to p1 → p2; GROUP BY should collapse to 1 edge
    let p1_to_p2_count = links
        .iter()
        .filter(|l| l.source_id == p1.id.as_str() && l.target_id == p2.id.as_str())
        .count();
    assert_eq!(
        p1_to_p2_count, 1,
        "GROUP BY should deduplicate multiple content blocks linking to the same target page"
    );

    let edge = links
        .iter()
        .find(|l| l.source_id == p1.id.as_str() && l.target_id == p2.id.as_str())
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

    let links = list_page_links_inner(&pool, &SpaceScope::Global, None)
        .await
        .unwrap();
    let edge = links
        .iter()
        .find(|l| l.source_id == p1.id.as_str() && l.target_id == p2.id.as_str())
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
    let links_before = list_page_links_inner(&pool, &SpaceScope::Global, None)
        .await
        .unwrap();
    let has_link = links_before
        .iter()
        .any(|l| l.source_id == p1.id.as_str() && l.target_id == p2.id.as_str());
    assert!(has_link, "link should exist before deleting source page");

    // Soft-delete the SOURCE page (p1)
    delete_block_inner(&pool, DEV, &mat, p1.id.clone())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let links_after = list_page_links_inner(&pool, &SpaceScope::Global, None)
        .await
        .unwrap();
    let has_deleted_source = links_after.iter().any(|l| l.source_id == p1.id.as_str());
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
    let mut optimized = list_page_links_inner(&pool, &SpaceScope::Global, None)
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

    let global = list_page_links_inner(&pool, &SpaceScope::Global, None)
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
        None,
    )
    .await
    .unwrap();
    let scope_b = list_page_links_inner(
        &pool,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_B_ID)),
        None,
    )
    .await
    .unwrap();
    assert_eq!(scope_a.len(), 1, "Active(A) keeps the within-A edge only");
    assert_eq!(scope_b.len(), 1, "Active(B) keeps the within-B edge only");
}

// PEND-35 Tier 4.5 — `tag_ids` filter pushes the GraphView tag-filter
// predicate into SQL: only edges whose **target page** carries one of
// the listed tags surface. Pre-Tier-4.5 the renderer fetched every
// space-wide edge and JS-discarded any whose endpoint was not in the
// tag-filtered node set.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_filters_by_tag_ids() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Source page (carries no tag) and two target pages — one tagged
    // with TAG_A, the other with TAG_B. Source -> each target via a
    // distinct content block. With `tag_ids = [TAG_A]` only the edge
    // whose target carries TAG_A may surface.
    let p_src = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Source".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let p_a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target A".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    let p_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target B".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Two tag blocks — minted as `block_type='tag'` so the ULID is a
    // real row in `blocks`. The `block_tags` FK requires both endpoints
    // to be live blocks.
    let tag_a = create_block_inner(&pool, DEV, &mat, "tag".into(), "alpha".into(), None, None)
        .await
        .unwrap();
    let tag_b = create_block_inner(&pool, DEV, &mat, "tag".into(), "beta".into(), None, None)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Tag the target pages.
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(&p_a.id)
        .bind(&tag_a.id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(&p_b.id)
        .bind(&tag_b.id)
        .execute(&pool)
        .await
        .unwrap();

    // Two content blocks under p_src, each linking to one target page.
    let b_to_a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("see [[{}]]", p_a.id),
        Some(p_src.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    let b_to_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("see [[{}]]", p_b.id),
        Some(p_src.id.clone()),
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b_to_a.id)
        .bind(&p_a.id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b_to_b.id)
        .bind(&p_b.id)
        .execute(&pool)
        .await
        .unwrap();

    // Filter by TAG_A — only the edge to p_a should remain.
    let tag_ids = vec![tag_a.id.to_string()];
    let links = list_page_links_inner(&pool, &SpaceScope::Global, Some(&tag_ids))
        .await
        .unwrap();
    let to_a = links
        .iter()
        .filter(|l| l.target_id.as_str() == p_a.id)
        .count();
    let to_b = links
        .iter()
        .filter(|l| l.target_id.as_str() == p_b.id)
        .count();
    assert_eq!(to_a, 1, "edge to TAG_A-tagged page must surface");
    assert_eq!(
        to_b, 0,
        "edge to TAG_B-tagged page must be filtered out when tag_ids = [TAG_A]"
    );

    mat.shutdown();
}

// PEND-35 Tier 4.5 — control test: `tag_ids = None` is identical to the
// pre-Tier-4.5 behaviour (every edge surfaces). Guards against a
// regression where `None` accidentally suppresses rows via a planner
// quirk in the `(?2 IS NULL OR …)` short-circuit.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_page_links_no_tag_filter_returns_all() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let p_src = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Source".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let p_a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target A".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    let p_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Target B".into(),
        None,
        Some(3),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let b_to_a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("see [[{}]]", p_a.id),
        Some(p_src.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    let b_to_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("see [[{}]]", p_b.id),
        Some(p_src.id.clone()),
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b_to_a.id)
        .bind(&p_a.id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(&b_to_b.id)
        .bind(&p_b.id)
        .execute(&pool)
        .await
        .unwrap();

    let links_none = list_page_links_inner(&pool, &SpaceScope::Global, None)
        .await
        .unwrap();
    let links_empty = list_page_links_inner(&pool, &SpaceScope::Global, Some(&[]))
        .await
        .unwrap();

    let to_a_none = links_none
        .iter()
        .filter(|l| l.target_id.as_str() == p_a.id)
        .count();
    let to_b_none = links_none
        .iter()
        .filter(|l| l.target_id.as_str() == p_b.id)
        .count();
    assert_eq!(to_a_none, 1, "no tag filter must surface edge to A");
    assert_eq!(to_b_none, 1, "no tag filter must surface edge to B");
    // Empty slice is treated as no filter (matches FE wrapper, which
    // normalises `tagIds: []` to `null` before binding).
    assert_eq!(
        links_empty.len(),
        links_none.len(),
        "empty tag_ids slice must be equivalent to None"
    );

    mat.shutdown();
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
        page.page_id.as_ref().map(crate::ulid::BlockId::as_str),
        Some(page.id.as_str()),
        "page block's page_id should be its own id"
    );

    // Verify via direct DB read
    let fetched = get_block_inner(&pool, page.id.clone()).await.unwrap();
    assert_eq!(
        fetched.page_id.as_ref().map(crate::ulid::BlockId::as_str),
        Some(page.id.as_str())
    );

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
        child.page_id.as_ref().map(crate::ulid::BlockId::as_str),
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

    assert_eq!(
        child.page_id.as_ref().map(crate::ulid::BlockId::as_str),
        Some(page_a.id.as_str())
    );

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
        fetched.page_id.as_ref().map(crate::ulid::BlockId::as_str),
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

    assert_eq!(
        grandchild
            .page_id
            .as_ref()
            .map(crate::ulid::BlockId::as_str),
        Some(page_a.id.as_str())
    );

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
        fetched_grandchild
            .page_id
            .as_ref()
            .map(crate::ulid::BlockId::as_str),
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
    assert_eq!(
        fetched_page
            .page_id
            .as_ref()
            .map(crate::ulid::BlockId::as_str),
        Some(page.id.as_str())
    );

    let fetched_child = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(
        fetched_child
            .page_id
            .as_ref()
            .map(crate::ulid::BlockId::as_str),
        Some(page.id.as_str())
    );

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

// ======================================================================
// list_all_pages_in_space — no-pagination IPC for export / graph callers
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_all_pages_in_space_returns_every_page_in_scope() {
    let (pool, _dir) = test_pool().await;

    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    insert_block(&pool, "LAPS_A1", "page", "Alpha", None, Some(1)).await;
    insert_block(&pool, "LAPS_A2", "page", "beta", None, Some(2)).await;
    insert_block(&pool, "LAPS_B1", "page", "Other space", None, Some(3)).await;
    insert_block(&pool, "LAPS_DEL", "page", "Deleted", None, Some(4)).await;
    insert_block(&pool, "LAPS_CONT", "content", "Not a page", None, Some(5)).await;
    assign_to_space(&pool, "LAPS_A1", TEST_SPACE_ID).await;
    assign_to_space(&pool, "LAPS_A2", TEST_SPACE_ID).await;
    assign_to_space(&pool, "LAPS_B1", TEST_SPACE_B_ID).await;
    assign_to_space(&pool, "LAPS_DEL", TEST_SPACE_ID).await;
    sqlx::query("UPDATE blocks SET deleted_at = 1778284800000 WHERE id = 'LAPS_DEL'")
        .execute(&pool)
        .await
        .unwrap();

    let rows = list_all_pages_in_space_inner(&pool, TEST_SPACE_ID, None)
        .await
        .unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();

    // Both live pages in space A, ordered case-insensitively by content.
    assert_eq!(
        ids,
        vec!["LAPS_A1", "LAPS_A2"],
        "must include both live pages, sorted case-insensitively by content; \
         must exclude the soft-deleted page, the foreign-space page, and the \
         content block. got {rows:?}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_all_pages_in_space_empty_space_returns_empty() {
    let (pool, _dir) = test_pool().await;
    let rows = list_all_pages_in_space_inner(&pool, "01NOSUCHSPACE00000000000000", None)
        .await
        .unwrap();
    assert!(
        rows.is_empty(),
        "unknown space must return empty; got {rows:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_all_pages_in_space_tag_filter_or_mode() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;

    insert_block(&pool, "LAPS_TF_PA", "page", "Alpha", None, Some(1)).await;
    insert_block(&pool, "LAPS_TF_PB", "page", "Beta", None, Some(2)).await;
    insert_block(&pool, "LAPS_TF_PC", "page", "Gamma", None, Some(3)).await;
    assign_to_space(&pool, "LAPS_TF_PA", TEST_SPACE_ID).await;
    assign_to_space(&pool, "LAPS_TF_PB", TEST_SPACE_ID).await;
    assign_to_space(&pool, "LAPS_TF_PC", TEST_SPACE_ID).await;

    // Two distinct tags.  PA carries TAG_X, PB carries TAG_Y, PC carries neither.
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('LAPS_TF_TX', 'tag', 'x')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('LAPS_TF_TY', 'tag', 'y')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES ('LAPS_TF_PA', 'LAPS_TF_TX')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES ('LAPS_TF_PB', 'LAPS_TF_TY')")
        .execute(&pool)
        .await
        .unwrap();

    // Filter on TAG_X only: PA returns.
    let rows = list_all_pages_in_space_inner(&pool, TEST_SPACE_ID, Some(&["LAPS_TF_TX".into()]))
        .await
        .unwrap();
    assert_eq!(
        rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        vec!["LAPS_TF_PA"],
        "single-tag filter must surface only the tagged page; got {rows:?}",
    );

    // Filter on TAG_X OR TAG_Y: both PA + PB return; PC is excluded.
    let rows = list_all_pages_in_space_inner(
        &pool,
        TEST_SPACE_ID,
        Some(&["LAPS_TF_TX".into(), "LAPS_TF_TY".into()]),
    )
    .await
    .unwrap();
    assert_eq!(
        rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        vec!["LAPS_TF_PA", "LAPS_TF_PB"],
        "multi-tag filter must union across tags; got {rows:?}",
    );

    // Empty tag slice: behaves as if no filter passed (returns all pages).
    let rows = list_all_pages_in_space_inner(&pool, TEST_SPACE_ID, Some(&[]))
        .await
        .unwrap();
    assert_eq!(
        rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        vec!["LAPS_TF_PA", "LAPS_TF_PB", "LAPS_TF_PC"],
        "empty tag-filter slice must not exclude anything; got {rows:?}",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_all_pages_in_space_rejects_oversized_tag_filter() {
    // #1325: a `tag_ids` array longer than MAX_FILTER_TAG_IDS must be
    // rejected up-front with AppError::Validation("tag_ids.too_many")
    // BEFORE any SQL placeholder / bind is built — otherwise the dynamic
    // `IN (?, ?, …)` clause scales 1:1 with caller input and trips SQLite's
    // parameter limit (a cheap DoS). The empty space here means a DB-reaching
    // query would succeed with empty rows, so an `Err` proves the guard fired
    // before the query.
    let (pool, _dir) = test_pool().await;

    let over_cap: Vec<String> = (0..(crate::commands::tags::MAX_FILTER_TAG_IDS + 1))
        .map(|i| format!("TAG_{i:05}"))
        .collect();
    let err = list_all_pages_in_space_inner(&pool, TEST_SPACE_ID, Some(&over_cap))
        .await
        .expect_err("oversized tag_ids filter must be rejected");
    assert!(
        matches!(&err, AppError::Validation(msg) if msg == "tag_ids.too_many"),
        "expected AppError::Validation(\"tag_ids.too_many\"), got {err:?}"
    );
}

// ======================================================================
// list_template_page_ids_in_space — graph view template flagging
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_template_page_ids_in_space_returns_template_pages_only() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    insert_block(&pool, "TPL_T1", "page", "Template One", None, Some(1)).await;
    insert_block(&pool, "TPL_T2", "page", "Template Two", None, Some(2)).await;
    insert_block(&pool, "TPL_REG", "page", "Regular Page", None, Some(3)).await;
    insert_block(&pool, "TPL_DEL", "page", "Deleted Template", None, Some(4)).await;
    insert_block(
        &pool,
        "TPL_FOREIGN",
        "page",
        "Foreign Template",
        None,
        Some(5),
    )
    .await;
    assign_to_space(&pool, "TPL_T1", TEST_SPACE_ID).await;
    assign_to_space(&pool, "TPL_T2", TEST_SPACE_ID).await;
    assign_to_space(&pool, "TPL_REG", TEST_SPACE_ID).await;
    assign_to_space(&pool, "TPL_DEL", TEST_SPACE_ID).await;
    assign_to_space(&pool, "TPL_FOREIGN", TEST_SPACE_B_ID).await;

    // Stamp template=true on three pages (one live in space A, one
    // soft-deleted in space A, one in space B).
    for id in ["TPL_T1", "TPL_T2", "TPL_DEL", "TPL_FOREIGN"] {
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'template', 'true')",
        )
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    }
    // Stamp template=false on the regular page (should not surface).
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES ('TPL_REG', 'template', 'false')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE blocks SET deleted_at = 1778284800000 WHERE id = 'TPL_DEL'")
        .execute(&pool)
        .await
        .unwrap();

    let mut ids = list_template_page_ids_in_space_inner(&pool, TEST_SPACE_ID)
        .await
        .unwrap();
    ids.sort();
    assert_eq!(
        ids,
        vec!["TPL_T1".to_string(), "TPL_T2".to_string()],
        "must include only live template-true pages in the scope; \
         must exclude template=false, soft-deleted, and foreign-space pages",
    );
}

// ======================================================================
// load_page_subtree — single-SELECT page-tree loader
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn load_page_subtree_returns_active_descendants_excluding_root() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;

    insert_block(
        &pool,
        "01HZPAGE000000000000000PGE",
        "page",
        "Page",
        None,
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "01HZSCH1000000000000000001",
        "content",
        "C1",
        Some("01HZPAGE000000000000000PGE"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "01HZSCH2000000000000000002",
        "content",
        "C2",
        Some("01HZPAGE000000000000000PGE"),
        Some(2),
    )
    .await;
    insert_block(
        &pool,
        "01HZGRAND000000000000000A1",
        "content",
        "G1",
        Some("01HZSCH1000000000000000001"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "01HZDEM000000000000000DEM0",
        "content",
        "Deleted",
        Some("01HZPAGE000000000000000PGE"),
        Some(3),
    )
    .await;
    assign_to_space(&pool, "01HZPAGE000000000000000PGE", TEST_SPACE_ID).await;
    sqlx::query(
        "UPDATE blocks SET deleted_at = 1778284800000 WHERE id = '01HZDEM000000000000000DEM0'",
    )
    .execute(&pool)
    .await
    .unwrap();
    // `page_id` is materializer-maintained in production; backfill by
    // hand for the test fixture so the WHERE page_id = ? filter hits.
    crate::cache::rebuild_page_ids(&pool).await.unwrap();

    let subtree = load_page_subtree_inner(&pool, "01HZPAGE000000000000000PGE", TEST_SPACE_ID)
        .await
        .unwrap();
    let mut ids: Vec<&str> = subtree.blocks.iter().map(|r| r.id.as_str()).collect();
    ids.sort();
    assert_eq!(
        ids,
        vec![
            "01HZGRAND000000000000000A1",
            "01HZSCH1000000000000000001",
            "01HZSCH2000000000000000002",
        ],
        "must return every active descendant (children + grandchild), \
         excluding the page root and the soft-deleted block; got {subtree:?}",
    );
    // #1258 — a well-under-cap page reports the true descendant count and
    // is NOT flagged truncated.
    assert!(
        !subtree.truncated,
        "a 3-block page is nowhere near the {} cap; must not be truncated",
        crate::commands::pages::listing::PAGE_SUBTREE_MAX_BLOCKS,
    );
    assert_eq!(
        subtree.total, 3,
        "total must count exactly the 3 active descendants (excluding root + deleted)",
    );
}

/// #1258 — when a page exceeds `PAGE_SUBTREE_MAX_BLOCKS`, the loader caps
/// `blocks` at the limit but reports `truncated = true` and the TRUE total
/// descendant count, so the FE can surface a non-blocking "showing the
/// first N of M" notice instead of silently dropping blocks.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn load_page_subtree_reports_truncation_over_cap() {
    use crate::commands::pages::listing::PAGE_SUBTREE_MAX_BLOCKS;

    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;

    insert_block(
        &pool,
        "01HZPAGEB1G00000000000PGE0",
        "page",
        "Big Page",
        None,
        Some(1),
    )
    .await;
    assign_to_space(&pool, "01HZPAGEB1G00000000000PGE0", TEST_SPACE_ID).await;

    // Insert cap + 5 active descendants directly (bulk; insert_block per-row
    // would be far too slow for 10k rows). All are direct children of the
    // page root. ULIDs are sortable so positions don't matter here.
    //
    // We set `page_id` directly in the INSERT rather than calling
    // `rebuild_page_ids` afterwards: every row is a direct child of the page
    // root, so its `page_id` is exactly that root — identical to what the
    // materializer's ancestor-walk CTE would compute, but without the
    // O(N²) correlated-subquery UPDATE that would push a 10k-row rebuild
    // past the nextest timeout. `load_page_subtree` keys on `page_id`, so
    // this exercises the exact column the loader reads.
    let extra: i64 = 5;
    let count = PAGE_SUBTREE_MAX_BLOCKS + extra;
    let mut tx = pool.begin().await.unwrap();
    for i in 0..count {
        // 26-char Crockford-base32-ish ULID-shaped id, zero-padded index.
        let id = format!("01HZB1G{i:019}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, space_id, page_id)
             VALUES (?1, 'content', ?2, '01HZPAGEB1G00000000000PGE0', ?3, ?4, '01HZPAGEB1G00000000000PGE0')",
        )
        .bind(&id)
        .bind(format!("child {i}"))
        .bind(i)
        .bind(TEST_SPACE_ID)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();

    let subtree = load_page_subtree_inner(&pool, "01HZPAGEB1G00000000000PGE0", TEST_SPACE_ID)
        .await
        .unwrap();

    assert_eq!(
        i64::try_from(subtree.blocks.len()).unwrap(),
        PAGE_SUBTREE_MAX_BLOCKS,
        "blocks must be capped at PAGE_SUBTREE_MAX_BLOCKS",
    );
    assert!(
        subtree.truncated,
        "a page with {count} descendants exceeds the {PAGE_SUBTREE_MAX_BLOCKS} cap; \
         must be flagged truncated",
    );
    assert_eq!(
        subtree.total, count,
        "total must report the TRUE descendant count, independent of the cap",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn load_page_subtree_rejects_foreign_space() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    insert_block(
        &pool,
        "01HZPGFRGN000000000000000B",
        "page",
        "P",
        None,
        Some(1),
    )
    .await;
    assign_to_space(&pool, "01HZPGFRGN000000000000000B", TEST_SPACE_B_ID).await;

    let err = load_page_subtree_inner(&pool, "01HZPGFRGN000000000000000B", TEST_SPACE_ID)
        .await
        .expect_err("foreign-space request must error");
    match err {
        AppError::Validation(msg) => assert!(
            msg.contains("not in current space"),
            "validation message should explain space mismatch; got: {msg}",
        ),
        other => panic!("expected Validation error; got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn load_page_subtree_rejects_malformed_root_id() {
    let (pool, _dir) = test_pool().await;
    let err = load_page_subtree_inner(&pool, "not-a-ulid", "01TESTSPACE000000000000001")
        .await
        .expect_err("malformed ULID must error");
    assert!(
        matches!(err, AppError::Ulid(_)),
        "malformed root id must surface as Ulid, got {err:?}"
    );
}
