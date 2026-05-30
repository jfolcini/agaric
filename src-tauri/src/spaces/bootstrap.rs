//! Boot-time bootstrap for the two seeded spaces + migration of existing
//! pages into the Personal space.
//!
//! Runs once per boot (fast-path short-circuit when both space blocks
//! already exist with `is_space = "true"`). Each step inside the
//! transaction is individually idempotent so a partial/crashed bootstrap
//! can be retried safely on the next boot.

use sqlx::SqlitePool;

use crate::commands::set_property_in_tx;
use crate::db::{CommandTx, MAX_SQL_PARAMS};
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::op::{CreateBlockPayload, OpPayload, SetPropertyPayload};
use crate::op_log::{self, OpRecord};
use crate::ulid::BlockId;

/// M-92 — chunk size for the batched `block_properties` UPSERT in
/// [`migrate_pages_to_personal_space_batched`].
///
/// `block_properties` is `(block_id, key, value_text, value_num, value_date,
/// value_ref)` — six bound params per row. SQLite caps bind parameters at
/// [`MAX_SQL_PARAMS`] (999) per statement, giving 166 rows per chunk. Mirrors
/// the chunked-INSERT convention from `cache/block_tag_refs.rs` (M-18).
const PROPERTIES_INSERT_CHUNK: usize = MAX_SQL_PARAMS / 6;

/// Reserved ULID for the seeded "Personal" space.
///
/// Crockford base32, 26 chars, uppercase only, no `I`/`L`/`O`/`U`. The
/// `seeded_ulids_parse_as_valid_ulids` test guards against typos.
pub const SPACE_PERSONAL_ULID: &str = "00000000000000000AGAR1CPER";

/// Reserved ULID for the seeded "Work" space.
pub const SPACE_WORK_ULID: &str = "00000000000000000AGAR1CWRK";

/// FEAT-3p10 — default accent color token for the seeded "Personal" space.
///
/// The value is a free-form palette token (matching `index.css`'s
/// `--accent-emerald` etc.). Stored on the space block as
/// `block_properties(key='accent_color', value_text=…)`.
pub const SPACE_PERSONAL_DEFAULT_ACCENT: &str = "accent-emerald";

/// FEAT-3p10 — default accent color token for the seeded "Work" space.
pub const SPACE_WORK_DEFAULT_ACCENT: &str = "accent-blue";

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
/// Safe to call repeatedly. The seeded-space-block creation step is
/// fast-pathed when both space blocks already exist with
/// `is_space = "true"` (skipping it avoids re-emitting redundant
/// `is_space = "true"` `SetProperty` ops every boot). The
/// `pages_without_space` backfill, however, runs on EVERY boot so any
/// page that arrives without a `space` property — via a misbehaving
/// frontend, sync replay from a peer that bypassed the invariant, or
/// any other path — is captured and assigned to the Personal space
/// (BUG-1 / L-133).
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
    // BUG-1 / L-133 — split the seeded-block creation fast-path from
    // the `pages_without_space` backfill. The seeded-block path stays
    // gated on `is_bootstrap_complete` (so we don't re-emit `is_space`
    // / `accent_color` ops every boot); the backfill runs every boot
    // to catch any page that slipped through `create_block`'s
    // page+space invariant (legacy callsites, sync replay, etc.).
    let seeded_blocks_already_done = is_bootstrap_complete(pool).await?;

    // MAINT-112 (#110) — `CommandTx` so the op records emitted below
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
            ensure_is_space_property(&mut tx, device_id, SPACE_PERSONAL_ULID, &mut records).await?;
        // FEAT-3p10 — seed the default `accent_color` for Personal. The
        // helper short-circuits when the property already exists so a
        // re-run / partial-resume never piles up duplicate ops.
        let personal_accent_set = ensure_accent_color_property(
            &mut tx,
            device_id,
            SPACE_PERSONAL_ULID,
            SPACE_PERSONAL_DEFAULT_ACCENT,
            &mut records,
        )
        .await?;

        let work_created =
            ensure_space_block(&mut tx, device_id, SPACE_WORK_ULID, "Work", &mut records).await?;
        let work_is_space_set =
            ensure_is_space_property(&mut tx, device_id, SPACE_WORK_ULID, &mut records).await?;
        // FEAT-3p10 — seed the default `accent_color` for Work. Same
        // idempotency guard as Personal above.
        let work_accent_set = ensure_accent_color_property(
            &mut tx,
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

    // BUG-1 / L-133 — always run, even when the seeded-block fast-path
    // skipped above. Naturally idempotent (only fires for pages
    // WITHOUT a `space` property). Index `idx_block_properties_space`
    // keeps the cost bounded.
    let pages_to_migrate = pages_without_space(&mut tx).await?;
    let migrated = pages_to_migrate.len();
    // M-92 — batched migrator (chunked INSERT OR REPLACE + cached
    // property_definitions lookup) replacing the previous per-page
    // `set_property_in_tx` loop. For a 5000-page first-boot vault this
    // collapses ~20k SQL round-trips down to ~5k op_log appends + ~30
    // chunked block_properties UPSERTs.
    migrate_pages_to_personal_space_batched(&mut tx, device_id, &pages_to_migrate, &mut records)
        .await?;

    // PEND-15 Phase 1 — Path A tag-space bootstrap. Assign every
    // orphan tag (no `space` property) to the space that most
    // frequently references it, or Personal as fallback. Idempotent
    // — the inner query filters to tags WITHOUT a `space` property,
    // so steady-state boots see zero candidates.
    let tags_migrated = migrate_orphan_tags_to_space(&mut tx, device_id, &mut records).await?;

    // MAINT-112 (#110) — couple every emitted op record to a
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

/// Fast-path idempotency check. Returns `true` when both seeded space
/// blocks exist AND both already carry `is_space = "true"`. Any other
/// state — missing block, missing property, partial bootstrap — returns
/// `false` so the transactional path runs and resumes.
async fn is_bootstrap_complete(pool: &SqlitePool) -> Result<bool, AppError> {
    let row = sqlx::query!(
        r#"SELECT COUNT(*) as "n!: i64" FROM blocks b
           WHERE b.id IN (?, ?)
             AND b.deleted_at IS NULL
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
    records: &mut Vec<OpRecord>,
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
    let record = op_log::append_local_op_in_tx(tx, device_id, payload, crate::db::now_ms()).await?;
    records.push(record);

    // Materialize the block row immediately so downstream steps in this
    // same transaction (ensure_is_space_property, set_property_in_tx for
    // migration) can satisfy their "block exists" TOCTOU checks. Mirrors
    // the materializer's `apply_op_tx` CreateBlock arm (INSERT OR IGNORE
    // so peer-synced rows don't collide). `page_id` is set to self to
    // match the command path's behaviour for page blocks.
    sqlx::query!(
        "INSERT OR IGNORE INTO blocks \
             (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', ?, NULL, 1, ?)",
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
    records: &mut Vec<OpRecord>,
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

    let (_block, record) = set_property_in_tx(
        tx,
        device_id,
        block_id.to_owned(),
        "is_space",
        Some("true".to_owned()),
        None,
        None,
        None,
        None,
    )
    .await?;
    records.push(record);
    Ok(true)
}

/// FEAT-3p10 — Ensure the seeded space block carries an `accent_color`
/// property pointing at the supplied default token (e.g.
/// `accent-emerald`, `accent-blue`).
///
/// Mirrors [`ensure_is_space_property`]'s idempotency contract: when
/// the block already has any `accent_color` value, this function is a
/// pure no-op and emits no op. Returns `true` when a fresh op was
/// appended, `false` when the property was already present.
///
/// User-driven recolouring via the FEAT-3p6 "Manage spaces…" UI flows
/// through `set_property` and updates the same row — this seed never
/// overwrites a user choice on a re-run.
async fn ensure_accent_color_property(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    block_id: &str,
    default_token: &str,
    records: &mut Vec<OpRecord>,
) -> Result<bool, AppError> {
    let already_set = sqlx::query_scalar!(
        r#"SELECT 1 as "v: i32" FROM block_properties
           WHERE block_id = ? AND key = 'accent_color'"#,
        block_id,
    )
    .fetch_optional(&mut **tx)
    .await?
    .is_some();
    if already_set {
        return Ok(false);
    }

    let (_block, record) = set_property_in_tx(
        tx,
        device_id,
        block_id.to_owned(),
        "accent_color",
        Some(default_token.to_owned()),
        None,
        None,
        None,
        None,
    )
    .await?;
    records.push(record);
    Ok(true)
}

/// M-92 — batched migrator that assigns `space = SPACE_PERSONAL_ULID` to
/// every page in `page_ids`.
///
/// This is the perf path for the BUG-1 / L-133 every-boot backfill: a
/// 5000-page first-boot vault used to round-trip ~20k SQL statements
/// inside one bootstrap transaction (the per-page `set_property_in_tx`
/// loop did 4 round-trips per page — definitions lookup, block existence
/// probe, op_log append, property UPSERT). The batched form collapses
/// the property-definitions read to one call and the per-row UPSERTs to
/// chunked multi-row INSERTs of [`PROPERTIES_INSERT_CHUNK`] rows each.
///
/// # Inherited invariants
///
/// - **M-1 (op log append-only).** Each page still gets its own
///   `SetProperty` op via [`op_log::append_local_op_in_tx`] because the
///   per-row hash chain (`prev_hash` advance, `parent_seqs`) is part of
///   the op_log contract. Batching the op_log writes is a separate,
///   larger refactor and is out of scope for M-92.
/// - ** predicate.** [`pages_without_space`] already
///   filters to live, non-conflict pages with `block_type = 'page'`, so
///   the per-page block-existence probe in `set_property_in_tx` is
///   redundant and is intentionally skipped here.
/// - **UPSERT semantics.** The chunked write uses `INSERT OR REPLACE`
///   to mirror `set_property_in_tx`'s row materialisation contract.
///   Steady-state runs see zero candidate pages (the
///   `pages_without_space` `NOT EXISTS` filter short-circuits) so this
///   is exercised only on the first migration boot.
/// - **Seeded property definitions.** Validates that the
///   `property_definitions` row for `'space'` is present (seeded by
///   migration `0035_spaces.sql`). A missing row indicates a
///   fundamentally broken DB and we surface it instead of silently
///   skipping validation.
async fn migrate_pages_to_personal_space_batched(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    page_ids: &[String],
    records: &mut Vec<OpRecord>,
) -> Result<(), AppError> {
    if page_ids.is_empty() {
        return Ok(());
    }

    // Step A — cache property_definitions for `space` once. The seeded
    // row from migration 0035_spaces.sql is `('space', 'ref', NULL, …)`.
    // Per-page `set_property_in_tx` reads this row inside the loop; the
    // values are constant per migration call so a single read suffices.
    // The lookup also doubles as a "is the seed migration in place"
    // sanity check — a missing row indicates a broken DB and surfaces
    // here instead of silently skipping the type validation.
    let def = sqlx::query!("SELECT value_type FROM property_definitions WHERE key = 'space'")
        .fetch_optional(&mut **tx)
        .await?;
    if def.is_none() {
        return Err(AppError::InvalidOperation(
            "property_definitions row for 'space' is missing — \
             migration 0035_spaces.sql did not land"
                .into(),
        ));
    }

    // Step B — append one `SetProperty` op per page. AGENTS.md
    // invariant #1 (op log is append-only) plus the hash-chain
    // semantics in `append_local_op_in_tx` (each op reads the previous
    // op's `seq` and computes a blake3 over `parent_seqs`) make these
    // serial calls non-batchable today. A future
    // `append_local_ops_in_tx_batch` helper would be a separate
    // op_log-API change.
    for page_id in page_ids {
        let payload = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::from_trusted(page_id),
            key: "space".to_owned(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: Some(SPACE_PERSONAL_ULID.to_owned()),
            value_bool: None,
        });
        let record =
            op_log::append_local_op_in_tx(tx, device_id, payload, crate::db::now_ms()).await?;
        records.push(record);
    }

    // Step C — chunked `INSERT OR REPLACE INTO block_properties`. The
    // multi-row VALUES form binds 6 params per row; SQLite caps bind
    // parameters at MAX_SQL_PARAMS (999) per statement so we chunk to
    // PROPERTIES_INSERT_CHUNK (= 166) rows.
    //
    // `INSERT OR REPLACE` (NOT `INSERT OR IGNORE`) matches the
    // upstream `set_property_in_tx` UPSERT semantics — if a stale
    // property row somehow exists for one of these page_ids it will be
    // overwritten with the Personal-space ref.
    for chunk in page_ids.chunks(PROPERTIES_INSERT_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?, ?, ?, ?)").collect();
        let sql = format!(
            "INSERT OR REPLACE INTO block_properties \
             (block_id, key, value_text, value_num, value_date, value_ref) \
             VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for page_id in chunk {
            q = q
                .bind(page_id)
                .bind("space")
                .bind(None::<String>)
                .bind(None::<f64>)
                .bind(None::<String>)
                .bind(SPACE_PERSONAL_ULID);
        }
        q.execute(&mut **tx).await?;
    }

    Ok(())
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
/// # Kill-date plan (MAINT-152(e))
///
/// **REMOVE AFTER `0.3.0`.** This entire function (plus
/// [`migration_marker_set`] and [`pages_to_migrate`], plus the
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
/// The associated REVIEW-LATER entry (under MAINT-152) and 08-MISC-015
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
    // Guard #1 — marker fast-path. Read the marker from outside any
    // transaction so the common (already-migrated) case skips the
    // BEGIN IMMEDIATE round-trip entirely.
    if migration_marker_set(pool).await? {
        tracing::debug!("personal_to_work_migration_v1 marker present; skipping");
        return Ok(());
    }

    // MAINT-112 (#110) — `CommandTx` so the page-rebind + marker
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

/// Marker fast-path query: does the seeded Personal space block already
/// carry `personal_to_work_migration_v1 = "true"`?
///
/// MAINT-152(f) / 08-MISC-009: parameterised on `sqlx::Executor` so the
/// same body serves both the outer pool-borrowing fast-path call and the
/// inner BEGIN IMMEDIATE second-check call (`&mut *tx` reborrows the
/// transaction's underlying connection). Replaced the
/// pool-vs-tx-duplicated `migration_marker_set` /
/// `migration_marker_set_in_tx` pair.
async fn migration_marker_set<'e, E>(executor: E) -> Result<bool, AppError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let row = sqlx::query_scalar!(
        r#"SELECT 1 as "v: i32" FROM block_properties
           WHERE block_id = ?
             AND key = 'personal_to_work_migration_v1'
             AND value_text = 'true'"#,
        SPACE_PERSONAL_ULID,
    )
    .fetch_optional(executor)
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

/// PEND-15 Phase 1 — Path A tag-space bootstrap.
///
/// Every tag block without a `space` property is assigned to the space
/// that most frequently references it (via `block_tag_refs`). Tags with
/// zero references fall back to Personal. The migration emits one
/// `SetProperty` op per orphan tag via the normal op-log pipeline,
/// preserving the append-only invariant.
///
/// This runs once on every boot (like `pages_without_space` above)
/// but is naturally idempotent: the query filters to tags WITHOUT a
/// `space` property, so steady-state boots see zero candidates.
///
/// # Path A sub-phase 1 of 3
///
/// The tag-block migration (assign every tag to a space) is the first
/// of the three Path A sub-phases enumerated in the plan body. Phases
/// 2 (enforcement wiring) and 3 (cross-space severance migration) are
/// downstream of this step.
pub async fn migrate_orphan_tags_to_space(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    records: &mut Vec<OpRecord>,
) -> Result<usize, AppError> {
    // Step 1 — find every live, non-conflict tag block that has no
    // `space` property.
    let orphan_tags = sqlx::query!(
        r#"SELECT b.id as "id!: String" FROM blocks b
           WHERE b.block_type = 'tag'
             AND b.deleted_at IS NULL
             AND NOT EXISTS (
                 SELECT 1 FROM block_properties
                 WHERE block_id = b.id AND key = 'space'
             )
           ORDER BY b.id"#,
    )
    .fetch_all(&mut **tx)
    .await?;
    if orphan_tags.is_empty() {
        return Ok(0);
    }

    // Step 2 — for each orphan tag, find the space that references it
    // most frequently. Tags with zero references go to Personal.
    //
    // The query joins block_tag_refs → source blocks → their space
    // property. A tag referenced by blocks in multiple spaces gets
    // assigned to the majority space; ties are broken in favour of
    // Personal (deterministic, matches the page-migration default).
    let mut migrated = 0;
    for row in &orphan_tags {
        let tag_id = &row.id;

        let space_counts = sqlx::query!(
            r#"SELECT p.value_ref as "space_id!: String",
                      COUNT(*) as "cnt!: i64"
               FROM block_tag_refs r
               INNER JOIN blocks b
                   ON b.id = r.source_id
                  AND b.deleted_at IS NULL
               INNER JOIN block_properties p
                   ON p.block_id = b.page_id
                  AND p.key = 'space'
                  AND p.value_ref IS NOT NULL
               WHERE r.tag_id = ?
               GROUP BY p.value_ref
               ORDER BY COUNT(*) DESC
               LIMIT 1"#,
            tag_id,
        )
        .fetch_optional(&mut **tx)
        .await?;

        let target_space = space_counts
            .as_ref()
            .map(|r| r.space_id.as_str())
            .unwrap_or(SPACE_PERSONAL_ULID);

        // Step 3 — emit a SetProperty op assigning this tag to the
        // chosen space. The op flows through the normal pipeline so
        // replay / sync / undo see it as a regular property mutation.
        let payload = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::from_trusted(tag_id),
            key: "space".to_owned(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: Some(target_space.to_owned()),
            value_bool: None,
        });
        let record =
            op_log::append_local_op_in_tx(tx, device_id, payload, crate::db::now_ms()).await?;
        records.push(record);

        // Materialize the property row immediately so downstream
        // enforcement steps in the same transaction see it.
        sqlx::query!(
            "INSERT OR REPLACE INTO block_properties \
             (block_id, key, value_text, value_num, value_date, value_ref) \
             VALUES (?, 'space', NULL, NULL, NULL, ?)",
            tag_id,
            target_space,
        )
        .execute(&mut **tx)
        .await?;

        migrated += 1;
    }

    Ok(migrated)
}

/// MAINT-112 (#110) test helper: run [`bootstrap_spaces`] with a
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

/// MAINT-112 (#110) test helper: run [`migrate_personal_pages_to_work`]
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
    use crate::ulid::BlockId;
    use std::path::PathBuf;
    use tempfile::TempDir;

    const DEV: &str = "test-device";

    async fn fresh_pool() -> (SqlitePool, TempDir) {
        let tmp = TempDir::new().unwrap();
        let db_path: PathBuf = tmp.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        // Seed the space blocks so value_ref FK constraints on
        // block_properties are satisfied.
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        for (id, name) in [(SPACE_PERSONAL_ULID, "Personal"), (SPACE_WORK_ULID, "Work")] {
            sqlx::query!(
                "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
                 VALUES (?, 'page', ?, NULL, 1, ?)",
                id,
                name,
                id,
            )
            .execute(&mut *tx)
            .await
            .unwrap();
        }
        tx.commit().await.unwrap();
        (pool, tmp)
    }

    #[tokio::test]
    async fn orphan_tag_assigned_to_personal_when_no_references() {
        let (pool, _tmp) = fresh_pool().await;
        let tag_id = BlockId::new().to_string();

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        // Seed inside the tx so FK checks see the row.
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'tag', 'lonely', NULL, 1, NULL)",
            tag_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        let migrated = migrate_orphan_tags_to_space(&mut tx, DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(migrated, 1);
        let space = sqlx::query_scalar!(
            "SELECT value_ref FROM block_properties WHERE block_id = ? AND key = 'space'",
            tag_id,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(space, Some(SPACE_PERSONAL_ULID.to_string()));
    }

    #[tokio::test]
    async fn orphan_tag_assigned_to_referencing_space() {
        let (pool, _tmp) = fresh_pool().await;
        let tag_id = BlockId::new().to_string();
        let source_id = BlockId::new().to_string();

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'tag', 'work-tag', NULL, 1, NULL)",
            tag_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', 'Test', NULL, 1, ?)",
            source_id,
            source_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO block_properties (block_id, key, value_text, value_num, value_date, value_ref) \
             VALUES (?, 'space', NULL, NULL, NULL, ?)",
            source_id,
            SPACE_WORK_ULID,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT OR IGNORE INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)",
            source_id,
            tag_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        let migrated = migrate_orphan_tags_to_space(&mut tx, DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(migrated, 1);
        let space = sqlx::query_scalar!(
            "SELECT value_ref FROM block_properties WHERE block_id = ? AND key = 'space'",
            tag_id,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(space, Some(SPACE_WORK_ULID.to_string()));
    }

    #[tokio::test]
    async fn orphan_tag_idempotent_on_second_run() {
        let (pool, _tmp) = fresh_pool().await;
        let tag_id = BlockId::new().to_string();

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'tag', 'idem', NULL, 1, NULL)",
            tag_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        let m1 = migrate_orphan_tags_to_space(&mut tx, DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(m1, 1);

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let m2 = migrate_orphan_tags_to_space(&mut tx, DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(m2, 0);
    }

    #[tokio::test]
    async fn orphan_tag_ignores_deleted_blocks() {
        let (pool, _tmp) = fresh_pool().await;
        let deleted_id = BlockId::new().to_string();

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'tag', 'del', NULL, 1, NULL)",
            deleted_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query!(
            "UPDATE blocks SET deleted_at = 1577836800000 WHERE id = ?",
            deleted_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        let migrated = migrate_orphan_tags_to_space(&mut tx, DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(migrated, 0);
    }

    #[tokio::test]
    async fn orphan_tag_assigned_via_content_block_page_id() {
        // The referencing block is a `content` block (not a `page`), so
        // the space property lives on its parent page. The query must
        // resolve via `b.page_id`.
        let (pool, _tmp) = fresh_pool().await;
        let tag_id = BlockId::new().to_string();
        let page_id = BlockId::new().to_string();
        let content_id = BlockId::new().to_string();

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'tag', 'via-content', NULL, 1, NULL)",
            tag_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', 'Page', NULL, 1, ?)",
            page_id,
            page_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO block_properties (block_id, key, value_text, value_num, value_date, value_ref) \
             VALUES (?, 'space', NULL, NULL, NULL, ?)",
            page_id, SPACE_WORK_ULID,
        )
        .execute(&mut *tx).await.unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'content', 'content', ?, 2, ?)",
            content_id,
            page_id,
            page_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT OR IGNORE INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)",
            content_id,
            tag_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        let migrated = migrate_orphan_tags_to_space(&mut tx, DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(migrated, 1);
        let space = sqlx::query_scalar!(
            "SELECT value_ref FROM block_properties WHERE block_id = ? AND key = 'space'",
            tag_id,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(space, Some(SPACE_WORK_ULID.to_string()));
    }

    #[tokio::test]
    async fn empty_table_returns_zero() {
        let (pool, _tmp) = fresh_pool().await;
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let migrated = migrate_orphan_tags_to_space(&mut tx, DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(migrated, 0);
    }
}
