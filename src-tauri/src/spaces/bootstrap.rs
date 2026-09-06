//! Boot-time bootstrap for the two seeded spaces + migration of existing
//! pages into the Personal space.
//!
//! Runs once per boot (fast-path short-circuit when both space blocks
//! already exist with `is_space = "true"`). Each step inside the
//! transaction is individually idempotent so a partial/crashed bootstrap
//! can be retried safely on the next boot.
//!
//! #2621 THE INVERSION: the neutral, transaction-scoped inner core (the
//! seeded-block / `is_space` / `accent_color` writers, the batched
//! page-space backfill, and the orphan-tag majority-space assignment) moved
//! DOWN into [`agaric_engine::spaces`] so it depends *down* on the
//! block-write core and the store with no upward `spaces → commands` edge.
//! This module keeps the `CommandTx` / `Materializer` orchestrator
//! (`bootstrap_spaces`) app-side behind an unchanged shim: it opens the
//! transaction, forwards `&mut sqlx::Transaction` to the engine helpers,
//! drains the returned op records into the tx's pending queue, and drives
//! commit + post-commit materializer dispatch exactly as before.
//!
//! #3282: the one-shot Personal→Work migration that used to live here
//! (`migrate_personal_pages_to_work`, plus the engine-side
//! `migration_marker_set` / `pages_to_migrate` / `MIGRATION_THRESHOLD_ULID`
//! helpers) is gone. Its own doc block said to delete it once `0.3.0` was
//! cut; the removal landed at 0.9.8 instead. It was marker-gated, so it had
//! long since been a no-op on every device that booted any release since.

use sqlx::SqlitePool;

use crate::db::CommandTx;
use crate::materializer::{MaterializeTask, Materializer};
use agaric_core::error::AppError;
use agaric_store::op_log::OpRecord;

// #2621 THE INVERSION: re-export the moved consts + the tag migrator at the
// old `crate::spaces::bootstrap::…` paths so every existing external call
// site (`crate::spaces::bootstrap::SPACE_PERSONAL_ULID`,
// `crate::spaces::SPACE_*`, the `spaces/mod.rs` `pub use bootstrap::{…}`
// surface, and `commands/tags.rs`'s doc references to
// `migrate_orphan_tags_to_space`) resolves unchanged.
// kept (#2897): bootstrap seeded-ULID seam — the deterministic Personal/Work
// space constants live in `agaric-engine`; this module re-exports them so the
// app-side bootstrap stays their single canonical `crate::spaces::…` entry.
pub use agaric_engine::spaces::{
    SPACE_PERSONAL_DEFAULT_ACCENT, SPACE_PERSONAL_ULID, SPACE_WORK_DEFAULT_ACCENT, SPACE_WORK_ULID,
    migrate_orphan_tags_to_space, repair_misfiled_tag_spaces,
};

// The inner-core helpers driven by the shim below now live in the engine.
use agaric_engine::spaces::{
    ensure_accent_color_property, ensure_is_space_property, ensure_space_block,
    is_bootstrap_complete, migrate_pages_to_personal_space_batched, pages_without_space,
};

/// Bootstrap the two seeded spaces and migrate existing pages into Personal.
///
/// Safe to call repeatedly. The seeded-space-block creation step is
/// fast-pathed when both space blocks already exist with
/// `is_space = "true"` (skipping it avoids re-emitting redundant
/// `is_space = "true"` `SetProperty` ops every boot). The
/// `pages_without_space` backfill, however, runs on EVERY boot so any
/// page that arrives without a `space` property — via a misbehaving
/// frontend, sync replay from a peer that bypassed the invariant, or
/// any other path — is captured and assigned to the Personal space.
///
/// The backfill is naturally idempotent: only fires for pages WITHOUT
/// a `space` property, so steady-state boots emit zero new ops. The
/// scan uses the `idx_block_properties_space` index already in place,
/// so the per-boot cost is one indexed `NOT EXISTS` lookup per page.
///
/// # Errors
///
/// Any database error is propagated. Bootstrap failure is boot-fatal: the
/// app cannot honour the "every page belongs to a space" invariant
/// without completing this step.
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
pub async fn bootstrap_spaces(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) -> Result<(), AppError> {
    // Split the seeded-block creation fast-path from
    // the `pages_without_space` backfill. The seeded-block path stays
    // gated on `is_bootstrap_complete` (so we don't re-emit `is_space`
    // / `accent_color` ops every boot); the backfill runs every boot
    // to catch any page that slipped through `create_block`'s
    // page+space invariant (legacy callsites, sync replay, etc.).
    let state = materializer.loro_state();
    let seeded_blocks_already_done = is_bootstrap_complete(pool).await?;

    // (#110) — `CommandTx` so the op records emitted below
    // are coupled to a post-commit materializer dispatch instead of
    // being discarded. Helpers append the `OpRecord`s into `records`,
    // which we drain into the tx's pending queue before commit.
    let mut tx = CommandTx::begin_immediate(pool, "bootstrap_spaces").await?;
    // #2604 — rollback-safe engine apply. The misfiled-tag repair below
    // prunes a tag out of one space's LoroDoc and hydrates it into another
    // (#2907) inside this tx; if the commit then fails, the in-memory docs
    // must be rewound so they never sit ahead of the rolled-back SQL. Same
    // arming as `move_blocks_to_space_inner`, the canonical cross-space move.
    tx.arm_engine_rollback(state);
    let mut records: Vec<OpRecord> = Vec::new();

    let (
        personal_created,
        personal_is_space_set,
        personal_accent_set,
        work_created,
        work_is_space_set,
        work_accent_set,
    ) = if seeded_blocks_already_done {
        tracing::debug!(
            "spaces bootstrap: seeded-space blocks already in place; \
             skipping is_space/accent op emission and only running pages_without_space backfill"
        );
        (false, false, false, false, false, false)
    } else {
        let personal_created = ensure_space_block(
            &mut tx,
            device_id,
            SPACE_PERSONAL_ULID,
            "Personal",
            &mut records,
        )
        .await?;
        let personal_is_space_set =
            ensure_is_space_property(&mut tx, state, device_id, SPACE_PERSONAL_ULID, &mut records)
                .await?;
        // Seed the default `accent_color` for Personal. The
        // helper short-circuits when the property already exists so a
        // re-run / partial-resume never piles up duplicate ops.
        let personal_accent_set = ensure_accent_color_property(
            &mut tx,
            state,
            device_id,
            SPACE_PERSONAL_ULID,
            SPACE_PERSONAL_DEFAULT_ACCENT,
            &mut records,
        )
        .await?;

        let work_created =
            ensure_space_block(&mut tx, device_id, SPACE_WORK_ULID, "Work", &mut records).await?;
        let work_is_space_set =
            ensure_is_space_property(&mut tx, state, device_id, SPACE_WORK_ULID, &mut records)
                .await?;
        // Seed the default `accent_color` for Work. Same
        // idempotency guard as Personal above.
        let work_accent_set = ensure_accent_color_property(
            &mut tx,
            state,
            device_id,
            SPACE_WORK_ULID,
            SPACE_WORK_DEFAULT_ACCENT,
            &mut records,
        )
        .await?;

        (
            personal_created,
            personal_is_space_set,
            personal_accent_set,
            work_created,
            work_is_space_set,
            work_accent_set,
        )
    };

    // Always run, even when the seeded-block fast-path skipped above; the
    // same pass runs after every inbound sync (#4717, `place_space_less_blocks`).
    let (migrated, tags_migrated) =
        backfill_space_less_in_tx(&mut tx, state, device_id, &mut records).await?;

    // Repair pass — move any tag an earlier, buggy run of the migration
    // above parked in the WRONG space. That version decided placement by
    // reading `block_tag_refs`, which `reindex_block_tag_refs` refuses to
    // populate for a tag that has no space yet, so every orphan tag scored
    // zero references and fell back to Personal regardless of where it was
    // used. `migrate_orphan_tags_to_space` cannot undo that itself: it only
    // considers tags with NO space, and these have one.
    //
    // Unlike its two neighbours this is gated to run ONCE per device
    // (`repair.tag_space_misfiled.v1` in `app_settings`) — see the function's
    // own doc for why. It is a genuine cross-space move, so it takes `state`
    // and applies each `SetProperty(space)` through the engine (#2907 prune +
    // hydrate), not a hand-rolled column UPDATE.
    let tags_repaired = repair_misfiled_tag_spaces(&mut tx, state, device_id, &mut records).await?;

    // (#110) — couple every emitted op record to a
    // post-commit cache rebuild. Mirrors `flush_all_drafts_inner`.
    for record in records {
        tx.enqueue_background(record);
    }
    tx.commit_and_dispatch(materializer).await?;

    enqueue_tag_ref_rebuilds(materializer, tags_migrated + tags_repaired);

    let spaces_created = i32::from(personal_created) + i32::from(work_created);
    let is_space_props_set = i32::from(personal_is_space_set) + i32::from(work_is_space_set);
    let accent_props_set = i32::from(personal_accent_set) + i32::from(work_accent_set);
    tracing::info!(
        spaces_created,
        is_space_props_set,
        accent_props_set,
        pages_migrated = migrated,
        tags_migrated,
        tags_repaired,
        seeded_blocks_already_done,
        "spaces bootstrap complete"
    );
    Ok(())
}

/// The two backfills that give a space-less block a space: pages go to
/// Personal, tags to the space that references them most (Personal when
/// nothing does). Both are idempotent — each selects `space_id IS NULL`
/// rows only, an indexed lookup that costs nothing when there are none.
///
/// Returns `(pages_placed, tags_placed)`.
async fn backfill_space_less_in_tx(
    tx: &mut CommandTx,
    state: &std::sync::Arc<agaric_engine::loro::shared::LoroState>,
    device_id: &str,
    records: &mut Vec<OpRecord>,
) -> Result<(usize, usize), AppError> {
    let pages_to_migrate = pages_without_space(tx).await?;
    let pages = pages_to_migrate.len();
    // Batched migrator (chunked INSERT OR REPLACE + cached
    // property_definitions lookup) replacing the previous per-page
    // `set_property_in_tx` loop. For a 5000-page first-boot vault this
    // collapses ~20k SQL round-trips down to ~5k op_log appends + ~30
    // chunked block_properties UPSERTs.
    migrate_pages_to_personal_space_batched(tx, device_id, &pages_to_migrate, records).await?;
    let tags = migrate_orphan_tags_to_space(tx, state, device_id, records).await?;
    Ok((pages, tags))
}

/// Placing or moving a tag only makes its references ADMISSIBLE; nothing
/// re-derives them. `SetProperty` dispatch enqueues no tag-ref work (narrow
/// by design — `invalidations_for_op`), the per-block `ReindexBlockTagRefs`
/// is keyed on the SOURCE block (the untouched blocks that carry `#[ULID]`),
/// and the boot backstop in `lib.rs` fires only when `block_tag_refs` is
/// ENTIRELY empty — one surviving row (a tag created in the space that uses
/// it) retires it for good. So without this the moved tag shows up in its
/// new space's tag list while the Tag filter, the backlink projection and
/// `tags_cache.usage_count` — all of which UNION `block_tag_refs` — keep
/// returning nothing for it. Refs first, then the tags cache: `usage_count`
/// UNIONs the refs table (ordering note on `cache::rebuild_all_caches`).
/// Both tasks are durable/retryable (`'__GLOBAL__'` retry-queue sentinel),
/// and the enqueue is best-effort like every other rebuild.
fn enqueue_tag_ref_rebuilds(materializer: &Materializer, tags_placed: usize) {
    if tags_placed == 0 {
        return;
    }
    for task in [
        MaterializeTask::RebuildBlockTagRefsCache,
        MaterializeTask::RebuildTagsCache,
    ] {
        let name = format!("{task:?}");
        if let Err(e) = materializer.try_enqueue_background(task) {
            tracing::warn!(
                error = %e,
                task = %name,
                tags_placed,
                "failed to enqueue tag-ref rebuild after tag space placement",
            );
        }
    }
}

/// #4717: place every space-less block NOW, in its own transaction.
///
/// The boot pass above catches a block that arrived without a space while
/// the app was closed; a peer on an older build can deliver one mid-session,
/// and until the next restart that tag is hidden from every space's tag
/// list, refused by `reindex_block_tag_refs` as cross-space, and rendered as
/// a raw `#[ULID]`. Running the same pass after an inbound sync closes that
/// window. Returns `(pages_placed, tags_placed)`.
///
/// The steady state is "nothing to place", so a probe on the reader pool
/// answers that before `BEGIN IMMEDIATE` takes the write lock for two SELECTs
/// that find nothing.
///
/// # Errors
///
/// Any database error is propagated; the caller logs it and the boot pass
/// remains the backstop.
pub async fn place_space_less_blocks(
    pool: &SqlitePool,
    read_pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) -> Result<(usize, usize), AppError> {
    // Same predicate as the two selectors behind `backfill_space_less_in_tx`,
    // served by `idx_blocks_space_type`; a space block is a `page` that itself
    // carries no `space_id`, hence the `is_space` exclusion on that arm only.
    let any_space_less: Option<i64> = sqlx::query_scalar!(
        r#"SELECT 1 AS "one!: i64" FROM blocks b
           WHERE b.space_id IS NULL
             AND b.deleted_at IS NULL
             AND (
                 b.block_type = 'tag'
                 OR (
                     b.block_type = 'page'
                     AND NOT EXISTS (
                         SELECT 1 FROM block_properties
                         WHERE block_id = b.id
                           AND key = 'is_space'
                           AND value_text = 'true'
                     )
                 )
             )
           LIMIT 1"#,
    )
    .fetch_optional(read_pool)
    .await?;
    if any_space_less.is_none() {
        return Ok((0, 0));
    }
    let state = materializer.loro_state();
    let mut tx = CommandTx::begin_immediate(pool, "place_space_less_blocks").await?;
    tx.arm_engine_rollback(state);
    let mut records: Vec<OpRecord> = Vec::new();
    let placed = backfill_space_less_in_tx(&mut tx, state, device_id, &mut records).await?;
    for record in records {
        tx.enqueue_background(record);
    }
    tx.commit_and_dispatch(materializer).await?;
    enqueue_tag_ref_rebuilds(materializer, placed.1);
    Ok(placed)
}

/// (#110) test helper: run [`bootstrap_spaces`] with a
/// throwaway [`Materializer`] that is shut down immediately after the
/// call. The seeded-space + page-migration tests assert on the
/// resulting DB rows / op_log, not on cache dispatch, so a transient
/// materializer (created → run → `shutdown()`) is the minimal shim that
/// satisfies the coupled-dispatch signature without leaking a worker.
#[cfg(any(test, feature = "test-util"))]
pub async fn bootstrap_spaces_for_test(pool: &SqlitePool, device_id: &str) -> Result<(), AppError> {
    let mat = Materializer::new(pool.clone());
    let result = bootstrap_spaces(pool, device_id, &mat).await;
    mat.shutdown();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    const DEV: &str = "test-device";

    /// #708: a from-scratch bootstrap must leave both seeded spaces
    /// registered in the `spaces` table — the `ensure_is_space_property`
    /// writes fire the 0089 `spaces_register_is_space` trigger — so the
    /// page/tag migrators' `space_id` stamps satisfy the rebuilt
    /// `blocks.space_id REFERENCES spaces(id)` FK in the same tx.
    #[tokio::test]
    async fn bootstrap_registers_seeded_spaces_in_registry_708() {
        let tmp = TempDir::new().unwrap();
        let db_path: PathBuf = tmp.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        bootstrap_spaces_for_test(&pool, DEV).await.unwrap();

        let registered: Vec<String> =
            sqlx::query_scalar!(r#"SELECT id as "id!: String" FROM spaces ORDER BY id"#)
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            registered,
            vec![SPACE_PERSONAL_ULID.to_string(), SPACE_WORK_ULID.to_string()],
            "bootstrap must register both seeded spaces in `spaces` (#708)"
        );

        // Idempotent across a second boot.
        bootstrap_spaces_for_test(&pool, DEV).await.unwrap();
        let count: i64 = sqlx::query_scalar!(r#"SELECT COUNT(*) as "n!: i64" FROM spaces"#)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            count, 2,
            "re-running bootstrap must not duplicate registry rows"
        );
    }

    /// #681 — a soft-deleted seeded space block makes `is_bootstrap_complete`
    /// report `false` forever (slow transactional path every boot) while
    /// `ensure_space_block`'s bare-existence check never re-creates it. The
    /// fix aligns the predicates (`deleted_at IS NULL`) and restores the
    /// tombstoned block, so bootstrap completes fast again on the next boot.
    #[tokio::test]
    async fn soft_deleted_seeded_space_is_restored_and_bootstrap_completes_681() {
        let tmp = TempDir::new().unwrap();
        let db_path: PathBuf = tmp.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        // First boot: both seeded spaces created + flagged + registered.
        bootstrap_spaces_for_test(&pool, DEV).await.unwrap();
        assert!(
            agaric_engine::spaces::is_bootstrap_complete(&pool)
                .await
                .unwrap(),
            "bootstrap must report complete after a clean first boot"
        );

        // Soft-delete the seeded Personal space block (its `is_space`
        // property and `spaces` registry row survive, mirroring the
        // user-facing delete-space flow / migration-0089 semantics).
        let now = crate::db::now_ms();
        sqlx::query!(
            "UPDATE blocks SET deleted_at = ? WHERE id = ?",
            now,
            SPACE_PERSONAL_ULID,
        )
        .execute(&pool)
        .await
        .unwrap();

        // Now the fast path correctly reports incomplete (the regression:
        // it would stay incomplete forever without the restore).
        assert!(
            !agaric_engine::spaces::is_bootstrap_complete(&pool)
                .await
                .unwrap(),
            "a soft-deleted seeded space must make bootstrap report incomplete"
        );

        // Re-boot: bootstrap must RESTORE the soft-deleted seed block.
        bootstrap_spaces_for_test(&pool, DEV).await.unwrap();

        let deleted_at: Option<i64> = sqlx::query_scalar!(
            r#"SELECT deleted_at FROM blocks WHERE id = ?"#,
            SPACE_PERSONAL_ULID,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(
            deleted_at.is_none(),
            "the soft-deleted seeded space block must be restored (deleted_at NULL)"
        );

        // And the fast path is honest again — next boot takes the cheap path.
        assert!(
            agaric_engine::spaces::is_bootstrap_complete(&pool)
                .await
                .unwrap(),
            "after restore, bootstrap must report complete (fast path)"
        );
    }

    // ----------------------------------------------------------------------
    // The tag space migration / repair, observed the way the USER sees it:
    // through the ref cache the move exists to unblock, and through the
    // per-space Loro docs a peer would import. The engine-crate tests for the
    // same functions stop at `blocks.space_id`; these do not.
    // ----------------------------------------------------------------------

    use agaric_engine::spaces::{SPACE_PERSONAL_ULID, SPACE_WORK_ULID};
    use agaric_store::pagination::PageRequest;
    use agaric_store::space::SpaceId;
    use agaric_store::tag_query::{TagExpr, eval_tag_query, list_all_tags_in_space};

    async fn boot_pool() -> (SqlitePool, Materializer, TempDir) {
        let tmp = TempDir::new().unwrap();
        let db_path: PathBuf = tmp.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        let mat = Materializer::new(pool.clone());
        (pool, mat, tmp)
    }

    /// A tag block with `space_id = tag_space` (NULL = orphan).
    async fn seed_tag(pool: &SqlitePool, name: &str, tag_space: Option<&str>) -> String {
        let tag_id = agaric_core::ulid::BlockId::new().to_string();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'tag', ?, NULL, 1, NULL, ?)",
        )
        .bind(&tag_id)
        .bind(name)
        .bind(tag_space)
        .execute(pool)
        .await
        .unwrap();
        tag_id
    }

    /// A page in `space` with one content block whose text carries the
    /// `#[tag_id]` token. Returns the content block's id.
    async fn seed_reference(pool: &SqlitePool, space: &str, tag_id: &str) -> String {
        let page_id = agaric_core::ulid::BlockId::new().to_string();
        let content_id = agaric_core::ulid::BlockId::new().to_string();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', 'Standups', NULL, 1, ?, ?)",
        )
        .bind(&page_id)
        .bind(&page_id)
        .bind(space)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'content', ?, ?, 2, ?, ?)",
        )
        .bind(&content_id)
        .bind(format!("standup #[{tag_id}] with the team"))
        .bind(&page_id)
        .bind(&page_id)
        .bind(space)
        .execute(pool)
        .await
        .unwrap();
        content_id
    }

    async fn clear_repair_marker(pool: &SqlitePool) {
        sqlx::query("DELETE FROM app_settings WHERE key = 'repair.tag_space_misfiled.v1'")
            .execute(pool)
            .await
            .unwrap();
    }

    async fn ref_row_count(pool: &SqlitePool, source_id: &str, tag_id: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM block_tag_refs WHERE source_id = ? AND tag_id = ?")
            .bind(source_id)
            .bind(tag_id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// What the user sees: the Tag filter in `space`, plus the tag list's
    /// `usage_count` for `tag_id`.
    async fn tag_filter_hits_and_usage(
        pool: &SqlitePool,
        space: &str,
        tag_id: &str,
    ) -> (Vec<String>, Option<i64>) {
        let page = eval_tag_query(
            pool,
            &TagExpr::Tag(tag_id.to_owned()),
            &PageRequest::new(None, None).unwrap(),
            false,
            Some(space),
            None,
        )
        .await
        .unwrap();
        let hits = page
            .items
            .iter()
            .map(|r| r.id.as_str().to_owned())
            .collect();
        let usage = list_all_tags_in_space(pool, space)
            .await
            .unwrap()
            .into_iter()
            .find(|t| t.tag_id == tag_id)
            .map(|t| t.usage_count);
        (hits, usage)
    }

    /// The reported vault, end to end: `meet` sits in Personal, is referenced
    /// only from Work, and `block_tag_refs` holds a row for an unrelated
    /// correctly-filed tag — so the `lib.rs` empty-table backstop would not
    /// fire either. After the repair boot the Tag filter must find the
    /// referencing block and `usage_count` must be 1. `blocks.space_id` alone
    /// was already green before the fix; the cache is what was missing.
    #[tokio::test]
    async fn repaired_tag_matches_the_tag_filter_after_boot() {
        let (pool, mat, _tmp) = boot_pool().await;
        // First boot on a vault with no tags: seeds the spaces, writes the
        // repair marker.
        bootstrap_spaces(&pool, DEV, &mat).await.unwrap();

        let meet = seed_tag(&pool, "meet", Some(SPACE_PERSONAL_ULID)).await;
        let meet_ref = seed_reference(&pool, SPACE_WORK_ULID, &meet).await;
        // `book`: created in the space that uses it, so it DOES have a ref
        // row — the one row that disables the empty-table backstop.
        let book = seed_tag(&pool, "book", Some(SPACE_WORK_ULID)).await;
        let book_ref = seed_reference(&pool, SPACE_WORK_ULID, &book).await;
        sqlx::query("INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)")
            .bind(&book_ref)
            .bind(&book)
            .execute(&pool)
            .await
            .unwrap();
        clear_repair_marker(&pool).await;

        // The boot that repairs.
        bootstrap_spaces(&pool, DEV, &mat).await.unwrap();
        mat.flush_background().await.unwrap();

        let space: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
            .bind(&meet)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(space.as_deref(), Some(SPACE_WORK_ULID), "the move itself");
        assert_eq!(
            ref_row_count(&pool, &meet_ref, &meet).await,
            1,
            "the reference the cross-space gate used to refuse must now be in block_tag_refs"
        );
        let (hits, usage) = tag_filter_hits_and_usage(&pool, SPACE_WORK_ULID, &meet).await;
        assert_eq!(
            hits,
            vec![meet_ref.clone()],
            "the Work Tag filter must find the block"
        );
        assert_eq!(
            usage,
            Some(1),
            "tags_cache.usage_count must count the reference"
        );
        // And the rebuild kept the unrelated correct row.
        assert_eq!(ref_row_count(&pool, &book_ref, &book).await, 1);

        mat.shutdown();
    }

    /// Same observation for the every-boot neighbour: an ORPHAN tag placed by
    /// `migrate_orphan_tags_to_space` has the same starved cache, and the
    /// gate is `tags_migrated + tags_repaired > 0`, so a placement alone must
    /// trigger the rebuild too.
    #[tokio::test]
    async fn placed_orphan_tag_matches_the_tag_filter_after_boot() {
        let (pool, mat, _tmp) = boot_pool().await;
        bootstrap_spaces(&pool, DEV, &mat).await.unwrap();

        let qa = seed_tag(&pool, "qa", None).await;
        let qa_ref = seed_reference(&pool, SPACE_WORK_ULID, &qa).await;

        bootstrap_spaces(&pool, DEV, &mat).await.unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(ref_row_count(&pool, &qa_ref, &qa).await, 1);
        let (hits, usage) = tag_filter_hits_and_usage(&pool, SPACE_WORK_ULID, &qa).await;
        assert_eq!(hits, vec![qa_ref]);
        assert_eq!(usage, Some(1));

        mat.shutdown();
    }

    /// #2907 for the repair: the tag must leave Personal's LoroDoc and join
    /// Work's — on this device AND on a fresh peer importing both snapshots.
    /// A hand-rolled `UPDATE blocks SET space_id` in front of the op leaves
    /// it in both docs, and the marker means nothing ever corrects that.
    #[tokio::test]
    async fn repair_prunes_the_tag_from_the_old_space_doc_2907() {
        let (pool, mat, _tmp) = boot_pool().await;
        let state = mat.loro_state();
        bootstrap_spaces(&pool, DEV, &mat).await.unwrap();

        // Put the tag in Personal through the production LOCAL path so it is
        // genuinely a member of Personal's doc — exactly how the buggy
        // migration's tags ended up there on a device whose engines were
        // replayed from the op log.
        let meet = seed_tag(&pool, "meet", None).await;
        {
            let mut tx = CommandTx::begin_immediate(&pool, "seed").await.unwrap();
            agaric_engine::block_ops::set_property_in_tx(
                &mut tx,
                state,
                DEV,
                meet.clone(),
                "space",
                None,
                None,
                None,
                Some(SPACE_PERSONAL_ULID.to_owned()),
                None,
            )
            .await
            .unwrap();
            tx.commit_without_dispatch().await.unwrap();
        }
        let personal = SpaceId::from_trusted(SPACE_PERSONAL_ULID);
        let work = SpaceId::from_trusted(SPACE_WORK_ULID);
        {
            let mut guard = state.registry.for_space(&personal, DEV).unwrap();
            assert!(
                guard.engine_mut().read_block(&meet).unwrap().is_some(),
                "precondition: the tag is in Personal's doc before the repair"
            );
        }
        seed_reference(&pool, SPACE_WORK_ULID, &meet).await;
        clear_repair_marker(&pool).await;

        bootstrap_spaces(&pool, DEV, &mat).await.unwrap();

        let personal_bytes = {
            let mut guard = state.registry.for_space(&personal, DEV).unwrap();
            let engine = guard.engine_mut();
            assert!(
                engine.read_block(&meet).unwrap().is_none(),
                "the tag must be PRUNED from the old space's doc"
            );
            engine.export_snapshot().unwrap()
        };
        let work_bytes = {
            let mut guard = state.registry.for_space(&work, DEV).unwrap();
            let engine = guard.engine_mut();
            assert_eq!(
                engine
                    .read_block(&meet)
                    .unwrap()
                    .expect("the tag must be hydrated into the new space's doc")
                    .content,
                "meet"
            );
            engine.export_snapshot().unwrap()
        };

        // A fresh peer importing each per-space snapshot: the tag must live
        // ONLY in Work — no resurrection from the Personal doc.
        let mut peer_personal =
            agaric_engine::loro::engine::LoroEngine::with_peer_id("fresh-peer").unwrap();
        peer_personal.import(&personal_bytes).unwrap();
        assert!(
            peer_personal.read_block(&meet).unwrap().is_none(),
            "a peer importing the OLD doc must not see the moved tag"
        );
        let mut peer_work =
            agaric_engine::loro::engine::LoroEngine::with_peer_id("fresh-peer").unwrap();
        peer_work.import(&work_bytes).unwrap();
        assert!(
            peer_work.read_block(&meet).unwrap().is_some(),
            "a peer importing the NEW doc must see the moved tag"
        );

        mat.shutdown();
    }
}
