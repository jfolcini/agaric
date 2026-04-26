//! Boot-time bootstrap for the two seeded spaces + migration of existing
//! pages into the Personal space.
//!
//! Runs once per boot (fast-path short-circuit when both space blocks
//! already exist with `is_space = "true"`). Each step inside the
//! transaction is individually idempotent so a partial/crashed bootstrap
//! can be retried safely on the next boot.

use sqlx::SqlitePool;

use crate::commands::set_property_in_tx;
use crate::error::AppError;
use crate::now_rfc3339;
use crate::op::{CreateBlockPayload, OpPayload};
use crate::op_log;
use crate::ulid::BlockId;

/// Reserved ULID for the seeded "Personal" space.
///
/// Crockford base32, 26 chars, uppercase only, no `I`/`L`/`O`/`U`. The
/// `seeded_ulids_parse_as_valid_ulids` test guards against typos.
pub const SPACE_PERSONAL_ULID: &str = "00000000000000000AGAR1CPER";

/// Reserved ULID for the seeded "Work" space.
pub const SPACE_WORK_ULID: &str = "00000000000000000AGAR1CWRK";

/// MAINT-1 — One-shot migration threshold.
///
/// ULID corresponding to the UTC timestamp `2026-04-26T22:00:00Z`
/// (`1_777_240_800_000` ms since the Unix epoch). Computed via
/// `ulid::Ulid::from_parts(1_777_240_800_000_u64, 0).to_string()` so the
/// timestamp portion (first 10 Crockford-base32 chars) is the lowest
/// possible ULID at that instant and the random portion is all-zero —
/// this gives a deterministic lower bound that is identical on every
/// build and every device.
///
/// Pages whose `id < MIGRATION_THRESHOLD_ULID` were created BEFORE this
/// migration shipped (and so belong to the maintainer's existing vault).
/// Pages whose `id >= MIGRATION_THRESHOLD_ULID` were created AFTER —
/// fresh-install pages which must NOT be touched by the migration.
///
/// The `migration_threshold_ulid_parses_as_valid_ulid` test guards
/// against typos.
pub const MIGRATION_THRESHOLD_ULID: &str = "01KQ5WWYR00000000000000000";

/// Bootstrap the two seeded spaces and migrate existing pages into Personal.
///
/// Safe to call repeatedly — the fast-path check returns early when both
/// space blocks already exist with `is_space = "true"`. Inside the
/// transaction every step is individually idempotent so a crashed
/// bootstrap can be resumed on the next boot.
///
/// # Errors
///
/// Any database error is propagated. Bootstrap failure is boot-fatal: the
/// app cannot honour the "every page belongs to a space" invariant
/// without completing this step.
pub async fn bootstrap_spaces(pool: &SqlitePool, device_id: &str) -> Result<(), AppError> {
    // Fast-path: if both space blocks are already present in the derived
    // state AND both have `is_space = "true"`, bootstrap completed on a
    // prior boot. Any pages missing a `space` property from that point
    // onward are a bug somewhere else — not this bootstrap's concern.
    if is_bootstrap_complete(pool).await? {
        tracing::debug!("spaces bootstrap already complete; skipping");
        return Ok(());
    }

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    let personal_created =
        ensure_space_block(&mut tx, device_id, SPACE_PERSONAL_ULID, "Personal").await?;
    let personal_is_space_set =
        ensure_is_space_property(&mut tx, device_id, SPACE_PERSONAL_ULID).await?;

    let work_created = ensure_space_block(&mut tx, device_id, SPACE_WORK_ULID, "Work").await?;
    let work_is_space_set = ensure_is_space_property(&mut tx, device_id, SPACE_WORK_ULID).await?;

    let pages_to_migrate = pages_without_space(&mut tx).await?;
    let migrated = pages_to_migrate.len();
    for page_id in pages_to_migrate {
        set_property_in_tx(
            &mut tx,
            device_id,
            page_id,
            "space",
            None,
            None,
            None,
            Some(SPACE_PERSONAL_ULID.to_owned()),
        )
        .await?;
    }

    tx.commit().await?;

    let spaces_created = i32::from(personal_created) + i32::from(work_created);
    let is_space_props_set = i32::from(personal_is_space_set) + i32::from(work_is_space_set);
    tracing::info!(
        spaces_created,
        is_space_props_set,
        pages_migrated = migrated,
        "spaces bootstrap complete"
    );
    Ok(())
}

/// Fast-path idempotency check. Returns `true` when both seeded space
/// blocks exist AND both already carry `is_space = "true"`. Any other
/// state — missing block, missing property, partial bootstrap — returns
/// `false` so the transactional path runs and resumes.
async fn is_bootstrap_complete(pool: &SqlitePool) -> Result<bool, AppError> {
    let row = sqlx::query!(
        r#"SELECT COUNT(*) as "n!: i64" FROM blocks b
           WHERE b.id IN (?, ?)
             AND b.deleted_at IS NULL
             AND b.is_conflict = 0
             AND EXISTS (
                 SELECT 1 FROM block_properties p
                 WHERE p.block_id = b.id
                   AND p.key = 'is_space'
                   AND p.value_text = 'true'
             )"#,
        SPACE_PERSONAL_ULID,
        SPACE_WORK_ULID,
    )
    .fetch_one(pool)
    .await?;
    Ok(row.n == 2)
}

/// Ensure the block row for a seeded space exists. Appends a
/// `CreateBlock` op and inserts the row via `INSERT OR IGNORE` so
/// prior-sync convergence (another device already landed the block) is a
/// silent no-op. Returns `true` when a fresh op was appended, `false`
/// when the block already existed and the step was skipped.
async fn ensure_space_block(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    block_id: &str,
    name: &str,
) -> Result<bool, AppError> {
    let exists = sqlx::query_scalar!(r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ?"#, block_id)
        .fetch_optional(&mut **tx)
        .await?
        .is_some();
    if exists {
        return Ok(false);
    }

    // L-126: Use the validating constructor for hand-typed ULID
    // constants. `from_trusted` is reserved for IDs that already came
    // from a prior `BlockId::new()`; the seeded space ULIDs are
    // hand-typed string literals and a banned Crockford char (`I`,
    // `L`, `O`, `U`) would only be caught by the
    // `seeded_ulids_parse_as_valid_ulids` test in `spaces/tests.rs`.
    // The `expect` here is load-bearing — it is the runtime safety net.
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_string(block_id)
            .expect("seeded space ULID constants must validate as Crockford base32"),
        block_type: "page".into(),
        parent_id: None,
        position: Some(1),
        content: name.into(),
    });
    op_log::append_local_op_in_tx(tx, device_id, payload, now_rfc3339()).await?;

    // Materialize the block row immediately so downstream steps in this
    // same transaction (ensure_is_space_property, set_property_in_tx for
    // migration) can satisfy their "block exists" TOCTOU checks. Mirrors
    // the materializer's `apply_op_tx` CreateBlock arm (INSERT OR IGNORE
    // so peer-synced rows don't collide). `page_id` is set to self to
    // match the command path's behaviour for page blocks.
    sqlx::query!(
        "INSERT OR IGNORE INTO blocks \
             (id, block_type, content, parent_id, position, page_id, is_conflict) \
         VALUES (?, 'page', ?, NULL, 1, ?, 0)",
        block_id,
        name,
        block_id,
    )
    .execute(&mut **tx)
    .await?;

    Ok(true)
}

/// Ensure the seeded space block carries `is_space = "true"`. Skips the
/// op append + property write when the row already exists, keeping the
/// op_log quiet on idempotent re-runs. Returns `true` when a fresh op
/// was appended.
async fn ensure_is_space_property(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    block_id: &str,
) -> Result<bool, AppError> {
    let already_set = sqlx::query_scalar!(
        r#"SELECT 1 as "v: i32" FROM block_properties
           WHERE block_id = ? AND key = 'is_space' AND value_text = 'true'"#,
        block_id,
    )
    .fetch_optional(&mut **tx)
    .await?
    .is_some();
    if already_set {
        return Ok(false);
    }

    set_property_in_tx(
        tx,
        device_id,
        block_id.to_owned(),
        "is_space",
        Some("true".to_owned()),
        None,
        None,
        None,
    )
    .await?;
    Ok(true)
}

/// Return every live, non-conflict page that does not yet carry a
/// `space` property AND is not itself a space block. Used to migrate
/// existing-install pages into the Personal space on the first boot
/// after this feature ships.
async fn pages_without_space(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT id as "id!: String" FROM blocks b
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.is_conflict = 0
             AND NOT EXISTS (
                 SELECT 1 FROM block_properties
                 WHERE block_id = b.id AND key = 'space'
             )
             AND NOT EXISTS (
                 SELECT 1 FROM block_properties
                 WHERE block_id = b.id
                   AND key = 'is_space'
                   AND value_text = 'true'
             )
           ORDER BY b.id"#,
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().map(|r| r.id).collect())
}

/// MAINT-1 — One-shot migration: move every pre-existing Personal page
/// into the Work space.
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
) -> Result<(), AppError> {
    // Guard #1 — marker fast-path. Read the marker from outside any
    // transaction so the common (already-migrated) case skips the
    // BEGIN IMMEDIATE round-trip entirely.
    if migration_marker_set(pool).await? {
        tracing::debug!("personal_to_work_migration_v1 marker present; skipping");
        return Ok(());
    }

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Re-check the marker inside the transaction. Two concurrent boots
    // can both pass the outer fast-path; BEGIN IMMEDIATE serialises
    // them and the loser sees the marker the winner committed and
    // becomes a no-op.
    if migration_marker_set_in_tx(&mut tx).await? {
        tx.rollback().await?;
        tracing::debug!(
            "personal_to_work_migration_v1 marker observed inside tx; concurrent peer won"
        );
        return Ok(());
    }

    let pages = pages_to_migrate(&mut tx).await?;
    let pages_moved = pages.len();
    for page_id in pages {
        set_property_in_tx(
            &mut tx,
            device_id,
            page_id,
            "space",
            None,
            None,
            None,
            Some(SPACE_WORK_ULID.to_owned()),
        )
        .await?;
    }

    // Mark complete on the seeded Personal space block. Re-uses the
    // existing `text` value type — system-internal markers are
    // advisory and do not require a `property_definitions` row (same
    // pattern as `is_space = "true"` itself).
    set_property_in_tx(
        &mut tx,
        device_id,
        SPACE_PERSONAL_ULID.to_owned(),
        "personal_to_work_migration_v1",
        Some("true".to_owned()),
        None,
        None,
        None,
    )
    .await?;

    tx.commit().await?;

    tracing::info!(
        pages_moved,
        threshold = MIGRATION_THRESHOLD_ULID,
        marker_set = true,
        "personal_to_work_migration_v1 complete"
    );
    Ok(())
}

/// Marker fast-path query: does the seeded Personal space block already
/// carry `personal_to_work_migration_v1 = "true"`?
async fn migration_marker_set(pool: &SqlitePool) -> Result<bool, AppError> {
    let row = sqlx::query_scalar!(
        r#"SELECT 1 as "v: i32" FROM block_properties
           WHERE block_id = ?
             AND key = 'personal_to_work_migration_v1'
             AND value_text = 'true'"#,
        SPACE_PERSONAL_ULID,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// Same query as [`migration_marker_set`] but inside an existing
/// transaction. Used for the second-check pattern after BEGIN IMMEDIATE
/// so a concurrent peer that committed first turns this run into a
/// no-op.
async fn migration_marker_set_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<bool, AppError> {
    let row = sqlx::query_scalar!(
        r#"SELECT 1 as "v: i32" FROM block_properties
           WHERE block_id = ?
             AND key = 'personal_to_work_migration_v1'
             AND value_text = 'true'"#,
        SPACE_PERSONAL_ULID,
    )
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.is_some())
}

/// Return every live, non-conflict, non-space page that:
/// - has `id < MIGRATION_THRESHOLD_ULID` (created before this migration
///   shipped — protects fresh installs);
/// - currently has a `space` property pointing at `SPACE_PERSONAL_ULID`.
///
/// The `is_space != "true"` exclusion keeps a hypothetical user-created
/// space block (carrying both `is_space = "true"` and `space = Personal`)
/// from being moved. The seeded space blocks themselves do not carry a
/// `space` property and so are naturally excluded by the JOIN.
async fn pages_to_migrate(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT b.id as "id!: String" FROM blocks b
           INNER JOIN block_properties p
               ON p.block_id = b.id
              AND p.key = 'space'
              AND p.value_ref = ?
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.is_conflict = 0
             AND b.id < ?
             AND NOT EXISTS (
                 SELECT 1 FROM block_properties s
                 WHERE s.block_id = b.id
                   AND s.key = 'is_space'
                   AND s.value_text = 'true'
             )
           ORDER BY b.id"#,
        SPACE_PERSONAL_ULID,
        MIGRATION_THRESHOLD_ULID,
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().map(|r| r.id).collect())
}
