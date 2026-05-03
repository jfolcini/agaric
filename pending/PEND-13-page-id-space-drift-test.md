# PEND-13 — `page_id` ↔ `space` consistency drift test

## Problem

Three denormalized fields must stay in sync to prevent the space filter from silently producing wrong results:

1. **`page_id` is correct.** Every block's `page_id` column (migration 0027) must equal its actual nearest `block_type='page'` ancestor (computed via recursive CTE on `parent_id`).
2. **The `space` property exists where it should.** Every non-space page has exactly one `block_properties` row with `key='space'`. Spaces themselves do NOT have a `space` property — they ARE the space.
3. **Transitive consistency.** A block's space (resolved through `page_id` → `block_properties`) must equal the space resolved by walking the block's `parent_id` chain to the nearest ancestor with a `space` property OR a space block.

If the materializer fails to keep `page_id` in sync (handlers in `src-tauri/src/materializer/handlers.rs`), or the `space` property gets out of sync (set via `set_property_in_tx` in `commands/mod.rs` and `spaces/bootstrap.rs`), the space filter (`COALESCE(b.page_id, b.id) IN (SELECT bp.block_id FROM block_properties bp WHERE bp.key='space' AND bp.value_ref=?)`) silently produces wrong results — blocks could appear under the wrong space. **Invisible to the user beyond "wait, why is this Work item showing in Personal."**

This pattern matches the existing CTE-oracle drift tests in `tag_inheritance` (incremental maintained table + recursive-CTE oracle + parity test in `tag_inheritance/tests.rs`).

## Why it's needed

There is currently **no test** that asserts these three invariants simultaneously across a populated fixture. The materializer's `page_id` rebuild (`cache/page_id.rs`) and the bootstrap's space assignment (`spaces/bootstrap.rs`) are correct in isolation, but no integration test catches drift when:

- A page is moved across spaces but a child still references the old `page_id`.
- The materializer's `page_id` rebuild diverges from the actual parent chain.
- A page loses its `space` property (misbehaving frontend, sync replay, set_property bug).

## Test design

Three independent assertions per block (or one composed assertion as a faster schema-level audit). For each block `b` (where `is_conflict = 0`, `deleted_at IS NULL`):

### Assertion A — `page_id` correctness

Recursive CTE: walk `b.parent_id` chain to the nearest ancestor with `block_type='page'`. Assert the ancestor's id equals `b.page_id`.

Exceptions:
- `b.block_type='page'` → `b.page_id` should be NULL OR `b.id` (verify the convention from `cache/page_id.rs` — pages may not denormalize self-reference).
- Top-level non-page orphans → both computed and stored `page_id` should be NULL.

```sql
WITH RECURSIVE ancestors(block_id, cur_id, cur_type, depth) AS (
    SELECT b.id, b.id, b.block_type, 0 FROM blocks b
    WHERE b.is_conflict = 0
    UNION ALL
    SELECT a.block_id, parent.id, parent.block_type, a.depth + 1
    FROM ancestors a
    JOIN blocks child ON child.id = a.cur_id
    JOIN blocks parent ON parent.id = child.parent_id
    WHERE a.cur_type != 'page' AND parent.is_conflict = 0 AND a.depth < 100
)
SELECT block_id, cur_id AS computed_page_id
FROM ancestors WHERE cur_type = 'page'
```

### Assertion B — space property existence

For each page `p`:
- If `is_space='true'` (or 1, post-PEND-14): zero `block_properties` rows with `key='space'`.
- Otherwise: exactly one row with `key='space'`.

### Assertion C — transitive consistency

For each non-page block `b`:
- `space_via_page_id` = `block_properties.value_ref WHERE block_id = b.page_id AND key='space'`
- `space_via_ancestor_chain` = walk `b.parent_id` chain, return the nearest space property OR space block id
- Assert these are equal.

## Implementation

### Location

`src-tauri/src/integration_tests.rs` as a dedicated end-to-end test (matches the convention in `src-tauri/tests/AGENTS.md` § Cross-module integration tests). Exercises the materializer-driven path realistically.

Test name: `page_id_space_drift_audit` (matches `tag_inheritance` parity-test naming).

### Test structure

Reviewer corrections to the fixture sketch below: `Materializer::new(pool.clone())` (sync, not `::build()`), `create_page_in_space_inner` returns `BlockId` not `BlockRow` (use `.as_str()`/`.to_string()`, not `.id`), `create_block_inner` takes 7 args not 5 (block_type, content, parent_id, position), the existing helper is `settle_bg_tasks` (or define a `settle` wrapper), and `move_block_inner` wants `i64` for position.

Two flavors (recommend implementing both, with the per-block oracle as the primary, schema-level as a fast secondary):

**Flavor 1 — per-block oracle** (slow, catches every drift):

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn page_id_space_drift_audit_per_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());           // ← :: new, not :: build
    bootstrap_spaces(&pool, DEV).await.unwrap();

    // Fixture: pages in two spaces with children + grandchildren + a cross-space move
    // create_page_in_space_inner returns BlockId, not BlockRow → use .as_str()
    let p1 = create_page_in_space_inner(&pool, DEV, &mat, None,             "P1".into(), SPACE_PERSONAL_ULID.into()).await.unwrap();
    let w1 = create_page_in_space_inner(&pool, DEV, &mat, None,             "W1".into(), SPACE_WORK_ULID.into()).await.unwrap();
    // create_block_inner takes (pool, device, mat, block_type, content, parent_id, position)
    let c_p = create_block_inner(&pool, DEV, &mat, "content".into(), "child".into(),       Some(p1.as_str().to_string()), None).await.unwrap();
    let c_w = create_block_inner(&pool, DEV, &mat, "content".into(), "child".into(),       Some(w1.as_str().to_string()), None).await.unwrap();
    let gc_p = create_block_inner(&pool, DEV, &mat, "content".into(), "grandchild".into(), Some(c_p.as_str().to_string()), None).await.unwrap();
    // Move c_p across spaces — i64 position
    move_block_inner(&pool, DEV, &mat, c_p.as_str(), Some(w1.as_str()), 1i64).await.unwrap();
    settle_bg_tasks(&mat).await;                          // ← actual helper name

    // For each block: assertions A, B, C
    let blocks = sqlx::query_as::<_, (String, String, Option<String>)>(
        "SELECT id, block_type, page_id FROM blocks WHERE is_conflict = 0 AND deleted_at IS NULL"
    ).fetch_all(&pool).await.unwrap();

    for (id, btype, page_id) in blocks {
        // A: page_id correctness
        // Convention (verified): pages set page_id = self.id (commands/blocks/crud.rs:210-211).
        // Orphans / blocks with no page ancestor have page_id = NULL.
        let computed = compute_page_id_via_cte(&pool, &id).await;
        assert_eq!(page_id, computed, "block {}: page_id mismatch", id);

        // B: space property existence (now spelled out, not a comment placeholder)
        if btype == "page" {
            let is_space: Option<String> = sqlx::query_scalar!(
                r#"SELECT value_text FROM block_properties WHERE block_id = ? AND key = 'is_space'"#,
                id
            ).fetch_optional(&pool).await.unwrap().flatten();
            let space_count: i64 = sqlx::query_scalar!(
                r#"SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'space'"#,
                id
            ).fetch_one(&pool).await.unwrap();
            if is_space.as_deref() == Some("true") {
                assert_eq!(space_count, 0, "space block {} must NOT have a 'space' property", id);
            } else {
                assert_eq!(space_count, 1, "non-space page {} must have exactly one 'space' property", id);
            }
        }

        // C: transitive consistency (skip pages — they're their own owner).
        // resolve_space_via_ancestor_chain returns the value_ref of the nearest 'space' property
        // (which IS the space block's ULID); if no property is found and an ancestor IS a space block,
        // returns that space block's ULID directly. Both forms produce a space block ULID.
        if btype != "page" {
            let via_page = resolve_space_via_page_id(&pool, &id).await;
            let via_chain = resolve_space_via_ancestor_chain(&pool, &id).await;
            assert_eq!(via_page, via_chain, "block {}: space mismatch via page_id vs ancestor chain", id);
        }
    }
}
```

### Op-type coverage (reviewer addition)

The fixture above exercises `CreateBlock` + `MoveBlock`. Reviewer flagged: also exercise `RestoreBlock`, `DeleteBlock` (soft delete), `PurgeBlock`, and `SetProperty(space=...)`. A second test variant `page_id_space_drift_audit_after_lifecycle_ops` runs the same audit after each op type, verifying drift doesn't appear in any state transition.

Specifically: include a soft-deleted block (asserted skipped), a purged block (asserted absent from `blocks`), and a block whose `space` property was changed via `set_property` (asserted picks up the new space).

**Flavor 2 — schema-level audit** (faster, returns violation rows in one query). Useful for very large fixtures or production-style runs. Implement as a single `SELECT ... UNION ALL ...` returning rows where any invariant is violated; assert empty result. Defer to second iteration.

### Helpers (small, reusable)

- `compute_page_id_via_cte(&pool, block_id) -> Option<String>`
- `resolve_space_via_page_id(&pool, block_id) -> Option<String>`
- `resolve_space_via_ancestor_chain(&pool, block_id) -> Option<String>`

Each is a small recursive-CTE wrapper.

## CI integration

Runs in `cargo nextest run` (default profile). Deterministic (no clock dependency beyond bootstrap). No network. Fast (<200ms on a ~20-block fixture).

## Coverage scope

Test catches drift at test time. Does NOT enforce the invariant via schema CHECK (that would require triggers, which Agaric explicitly avoids — see ARCHITECTURE.md). If a real drift bug ships in production data, the user could run a CLI-driven version of this audit (potential future feature) to verify their database.

## Cost (reviewer-revised)

**S (1.5-2.5h).**

| Step | Time |
|---|---|
| Helpers (compute_page_id_via_cte, resolve_space_*) | 30 min |
| Fixture setup (bootstrap + create + move) — accounting for 7-arg `create_block_inner` and `BlockId` return | 45 min |
| Three assertions + iteration | 30 min |
| Op-type coverage (RestoreBlock / DeleteBlock / PurgeBlock / SetProperty(space=...)) | 30 min |
| Edge case handling (orphans, conflict copies, archived) | 15 min |

## Impact

Closes the "page_id silently drifts and the space filter starts lying" bug class. Pairs naturally with PEND-18 (typed parameter) and PEND-12 (canonical SQL fragment) — the three together make space-scoping enforcement bulletproof at compile + runtime + schema-invariant level.

## Risk

**Low.** Test addition only. No production code change. If the test fails on first run, that's a discovery (a real drift bug existed already), not a regression.

## Open questions

1. **Are there legitimate cases where `page_id` is NULL for a non-page block?** E.g., orphaned blocks during partial sync replay. The test must handle these without false positives. **Recommendation:** read `cache/page_id.rs` first and document the convention before writing assertions. Likely "orphans get NULL" is the legitimate case, and the assertion is "computed and stored both NULL OR both non-NULL and equal."
2. **Are conflict copies excluded from the audit?** Yes — they're not active blocks; CTEs filter `is_conflict = 0`. **Verify** by including a conflict copy in the fixture and asserting it's skipped.
3. **Should the test ALSO validate the legacy migration path?** Bootstrap a fresh DB → run `migrate_pages_to_personal_space_batched` → run audit → assert zero violations. **Recommendation: add as a second test** (`page_id_space_drift_audit_post_migration`).
4. **Parameterize on fixture size?** Defer. Start with ~20 blocks. If drift only appears at scale, parameterize later.
