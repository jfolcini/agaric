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
//! page-space backfill, the orphan-tag majority-space assignment, and the
//! one-shot Personal→Work migration helpers) moved DOWN into
//! [`agaric_engine::spaces`] so it depends *down* on the block-write core
//! and the store with no upward `spaces → commands` edge. This module keeps
//! the `CommandTx` / `Materializer` orchestrators (`bootstrap_spaces` /
//! `migrate_personal_pages_to_work`) app-side behind unchanged shims: they
//! open the transaction, forward `&mut sqlx::Transaction` to the engine
//! helpers, drain the returned op records into the tx's pending queue, and
//! drive commit + post-commit materializer dispatch exactly as before.

use sqlx::SqlitePool;

use crate::db::CommandTx;
use crate::materializer::Materializer;
use agaric_core::error::AppError;
use agaric_engine::block_ops::set_property_in_tx;
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
    MIGRATION_THRESHOLD_ULID, SPACE_PERSONAL_DEFAULT_ACCENT, SPACE_PERSONAL_ULID,
    SPACE_WORK_DEFAULT_ACCENT, SPACE_WORK_ULID, migrate_orphan_tags_to_space,
};

// The inner-core helpers driven by the shims below now live in the engine.
use agaric_engine::spaces::{
    ensure_accent_color_property, ensure_is_space_property, ensure_space_block,
    is_bootstrap_complete, migrate_pages_to_personal_space_batched, migration_marker_set,
    pages_to_migrate, pages_without_space,
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
/// any other path — is captured and assigned to the Personal space
/// .
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
pub async fn bootstrap_spaces(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) -> Result<(), AppError> {
    // / split the seeded-block creation fast-path from
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

    // / always run, even when the seeded-block fast-path
    // skipped above. Naturally idempotent (only fires for pages
    // WITHOUT a `space` property). Index `idx_block_properties_space`
    // keeps the cost bounded.
    let pages_to_migrate = pages_without_space(&mut tx).await?;
    let migrated = pages_to_migrate.len();
    // Batched migrator (chunked INSERT OR REPLACE + cached
    // property_definitions lookup) replacing the previous per-page
    // `set_property_in_tx` loop. For a 5000-page first-boot vault this
    // collapses ~20k SQL round-trips down to ~5k op_log appends + ~30
    // chunked block_properties UPSERTs.
    migrate_pages_to_personal_space_batched(&mut tx, device_id, &pages_to_migrate, &mut records)
        .await?;

    // Phase 1 — Path A tag-space bootstrap. Assign every
    // orphan tag (no `space` property) to the space that most
    // frequently references it, or Personal as fallback. Idempotent
    // — the inner query filters to tags WITHOUT a `space` property,
    // so steady-state boots see zero candidates.
    let tags_migrated = migrate_orphan_tags_to_space(&mut tx, device_id, &mut records).await?;

    // (#110) — couple every emitted op record to a
    // post-commit cache rebuild. Mirrors `flush_all_drafts_inner`.
    for record in records {
        tx.enqueue_background(record);
    }
    tx.commit_and_dispatch(materializer).await?;

    let spaces_created = i32::from(personal_created) + i32::from(work_created);
    let is_space_props_set = i32::from(personal_is_space_set) + i32::from(work_is_space_set);
    let accent_props_set = i32::from(personal_accent_set) + i32::from(work_accent_set);
    tracing::info!(
        spaces_created,
        is_space_props_set,
        accent_props_set,
        pages_migrated = migrated,
        tags_migrated,
        seeded_blocks_already_done,
        "spaces bootstrap complete"
    );
    Ok(())
}

/// One-shot migration: move every pre-existing Personal page
/// into the Work space.
///
/// # Kill-date plan ((e))
///
/// **REMOVE AFTER `0.3.0`.** This entire function (plus
/// [`agaric_engine::spaces::migration_marker_set`] and
/// [`agaric_engine::spaces::pages_to_migrate`], plus the
/// [`MIGRATION_THRESHOLD_ULID`] constant)
/// is one-shot maintainer-only cruft: it exists solely to retro-fit pages
/// in the maintainer's pre-`MIGRATION_THRESHOLD_ULID` (= 2026-04-26)
/// vault into the Work space. On any device that has already booted at
/// least once after this migration shipped, the marker fast-path makes it
/// a pure no-op. Fresh installs created after the threshold cannot have
/// candidate pages and the loop body never fires either.
///
/// **Removal trigger:** when `0.3.0` is cut, delete the function and its
/// helpers in the same commit that bumps the version. Old DBs that have
/// somehow never booted into a `0.2.x` build (unlikely) will need a
/// manual schema reset (re-import from snapshot or wipe `~/.local/share/
/// com.agaric.app/notes.db`); document that in the `0.3.0` release notes.
/// The associated entry and 08-MISC-015
/// can be closed at the same time.
///
/// The version target is intentionally conservative — `0.3.0` gives every
/// active vault several minor releases to migrate naturally. If the
/// installed-base inflection point arrives sooner (e.g. by the `0.2.x`
/// series), the doc comment can be tightened then.
///
/// # Behaviour
///
/// Runs at boot AFTER `bootstrap_spaces` has finished. The migration is
/// gated by two independent guards so it is safe to call on every boot
/// and on every install scenario:
///
/// 1. **Marker fast-path.** If the seeded Personal space block already
///    carries `personal_to_work_migration_v1 = "true"`, the migration
///    has already run on this device — return immediately.
/// 2. **Time threshold.** Only pages whose `id < MIGRATION_THRESHOLD_ULID`
///    are candidates. Fresh installs after this code ships will only
///    have post-threshold ULIDs, so the loop body never fires.
///
/// For each candidate page, an op-emitting `set_property` write rebinds
/// `space` from `SPACE_PERSONAL_ULID` to `SPACE_WORK_ULID`. The
/// materializer's UPSERT on `(block_id, key)` converges the local row
/// inside the same transaction, and the op replicates to peer devices
/// via the normal sync path. The marker is set on the same transaction
/// so a single commit either wires up the entire migration or none of
/// it.
///
/// Raw SQL `UPDATE` is intentionally avoided per AGENTS.md invariant #1
/// (op log is append-only) — the bootstrap precedent (`pages_without_space`
/// → `SetProperty` ops) is the model.
///
/// # Errors
///
/// Any database error is propagated. Failure is non-fatal at the call
/// site (the maintainer's vault simply won't migrate this boot and will
/// retry on the next one), but practically it should never fail because
/// the only writes are op_log appends + property UPSERTs that are
/// already covered by `bootstrap_spaces`'s tests.
pub async fn migrate_personal_pages_to_work(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) -> Result<(), AppError> {
    let state = materializer.loro_state();
    // Guard #1 — marker fast-path. Read the marker from outside any
    // transaction so the common (already-migrated) case skips the
    // BEGIN IMMEDIATE round-trip entirely.
    if migration_marker_set(pool).await? {
        tracing::debug!("personal_to_work_migration_v1 marker present; skipping");
        return Ok(());
    }

    // (#110) — `CommandTx` so the page-rebind + marker
    // `set_property` ops are coupled to a post-commit cache dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "migrate_personal_pages_to_work").await?;

    // Re-check the marker inside the transaction. Two concurrent boots
    // can both pass the outer fast-path; BEGIN IMMEDIATE serialises
    // them and the loser sees the marker the winner committed and
    // becomes a no-op.
    if migration_marker_set(&mut **tx).await? {
        tx.rollback().await?;
        tracing::debug!(
            "personal_to_work_migration_v1 marker observed inside tx; concurrent peer won"
        );
        return Ok(());
    }

    let pages = pages_to_migrate(&mut tx).await?;
    let pages_moved = pages.len();
    for page_id in pages {
        let (_block, record) = set_property_in_tx(
            &mut tx,
            state,
            device_id,
            page_id,
            "space",
            None,
            None,
            None,
            Some(SPACE_WORK_ULID.to_owned()),
            None,
        )
        .await?;
        tx.enqueue_background(record);
    }

    // Mark complete on the seeded Personal space block. Re-uses the
    // existing `text` value type — system-internal markers are
    // advisory and do not require a `property_definitions` row (same
    // pattern as `is_space = "true"` itself).
    let (_block, marker_record) = set_property_in_tx(
        &mut tx,
        state,
        device_id,
        SPACE_PERSONAL_ULID.to_owned(),
        "personal_to_work_migration_v1",
        Some("true".to_owned()),
        None,
        None,
        None,
        None,
    )
    .await?;
    tx.enqueue_background(marker_record);

    tx.commit_and_dispatch(materializer).await?;

    tracing::info!(
        pages_moved,
        threshold = MIGRATION_THRESHOLD_ULID,
        marker_set = true,
        "personal_to_work_migration_v1 complete"
    );
    Ok(())
}

/// (#110) test helper: run [`bootstrap_spaces`] with a
/// throwaway [`Materializer`] that is shut down immediately after the
/// call. The seeded-space + page-migration tests assert on the
/// resulting DB rows / op_log, not on cache dispatch, so a transient
/// materializer (created → run → `shutdown()`) is the minimal shim that
/// satisfies the coupled-dispatch signature without leaking a worker.
#[cfg(test)]
pub(crate) async fn bootstrap_spaces_for_test(
    pool: &SqlitePool,
    device_id: &str,
) -> Result<(), AppError> {
    let mat = Materializer::new(pool.clone());
    let result = bootstrap_spaces(pool, device_id, &mat).await;
    mat.shutdown();
    result
}

/// (#110) test helper: run [`migrate_personal_pages_to_work`]
/// with a throwaway [`Materializer`]. See [`bootstrap_spaces_for_test`].
#[cfg(test)]
pub(crate) async fn migrate_personal_pages_to_work_for_test(
    pool: &SqlitePool,
    device_id: &str,
) -> Result<(), AppError> {
    let mat = Materializer::new(pool.clone());
    let result = migrate_personal_pages_to_work(pool, device_id, &mat).await;
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
}
