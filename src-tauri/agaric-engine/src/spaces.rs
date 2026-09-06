//! Spaces bootstrap core (#2621 THE INVERSION).
//!
//! The neutral, transaction-scoped inner core of the boot-time spaces
//! bootstrap, moved down from the app crate's `spaces::bootstrap` module so
//! it depends *down* on the block-write core
//! ([`crate::block_ops::set_property_in_tx`]) and the store
//! (`agaric_store::{op_log, op, db}`) with no upward app edge.
//!
//! The app crate keeps the `CommandTx` / `Materializer` orchestrator
//! (`bootstrap_spaces`) behind an unchanged shim, which opens the
//! transaction, forwards `&mut sqlx::Transaction` to these helpers, drains
//! the returned op records into the tx's pending queue, and drives commit +
//! post-commit materializer dispatch exactly as before.
//!
//! #3282: the one-shot Personal→Work migration's selector helpers
//! (`migration_marker_set`, `pages_to_migrate`, `MIGRATION_THRESHOLD_ULID`)
//! used to live here too. They were deleted with their app-side caller,
//! whose doc block had said to delete them once `0.3.0` was cut.
//!
//! Every helper here takes an already-open executor (a `&mut sqlx::Transaction`,
//! a generic `Executor`, or a `&SqlitePool`) — none of them touch `CommandTx`
//! or the `Materializer`.

use std::collections::HashMap;

use sqlx::SqlitePool;

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::db::{MAX_SQL_PARAMS, now_ms};
use agaric_store::op::{CreateBlockPayload, OpPayload, SetPropertyPayload};
use agaric_store::op_log::{self, OpRecord};

use crate::block_ops::set_property_in_tx;
use crate::loro::shared::LoroState;

/// Chunk size for the batched `block_properties` UPSERT in
/// [`migrate_pages_to_personal_space_batched`].
///
/// `block_properties` is `(block_id, key, value_text, value_num, value_date,
/// value_ref)` — six bound params per row. SQLite caps bind parameters at
/// [`MAX_SQL_PARAMS`] (999) per statement, giving 166 rows per chunk. Mirrors
/// the chunked-INSERT convention from `cache/block_tag_refs.rs`.
pub const PROPERTIES_INSERT_CHUNK: usize = MAX_SQL_PARAMS / 6;

/// Reserved ULID for the seeded "Personal" space.
///
/// Crockford base32, 26 chars, uppercase only, no `I`/`L`/`O`/`U`. The
/// `seeded_ulids_parse_as_valid_ulids` test guards against typos.
pub const SPACE_PERSONAL_ULID: &str = "00000000000000000AGAR1CPER";

/// Reserved ULID for the seeded "Work" space.
pub const SPACE_WORK_ULID: &str = "00000000000000000AGAR1CWRK";

/// Default accent color token for the seeded "Personal" space.
///
/// The value is a free-form palette token (matching `index.css`'s
/// `--accent-emerald` etc.). Stored on the space block as
/// `block_properties(key='accent_color', value_text=…)`.
pub const SPACE_PERSONAL_DEFAULT_ACCENT: &str = "accent-emerald";

/// Default accent color token for the seeded "Work" space.
pub const SPACE_WORK_DEFAULT_ACCENT: &str = "accent-blue";

/// Fast-path idempotency check. Returns `true` when both seeded space
/// blocks exist AND both already carry `is_space = "true"`. Any other
/// state — missing block, missing property, partial bootstrap — returns
/// `false` so the transactional path runs and resumes.
pub async fn is_bootstrap_complete(pool: &SqlitePool) -> Result<bool, AppError> {
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

/// Ensure the block row for a seeded space exists **and is live**. Appends
/// a `CreateBlock` op and upserts the row, clearing `deleted_at` so a
/// soft-deleted seed space is restored. Returns `true` when a fresh op was
/// appended, `false` when the block already existed (live) and the step was
/// skipped.
///
/// #681: the existence check filters `deleted_at IS NULL` to match
/// [`is_bootstrap_complete`]. A seeded Personal/Work space is undeletable
/// state — if it has been soft-deleted, bootstrap must restore it rather
/// than (a) treat bootstrap as incomplete forever (slow transactional path
/// every boot) while (b) never re-creating the block. Restoring also lets
/// the downstream `ensure_is_space_property` / `set_property_in_tx` steps
/// satisfy their "block exists and is not deleted" TOCTOU checks.
pub async fn ensure_space_block(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    block_id: &str,
    name: &str,
    records: &mut Vec<OpRecord>,
) -> Result<bool, AppError> {
    let exists = sqlx::query_scalar!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?
    .is_some();
    if exists {
        return Ok(false);
    }

    // Use the validating constructor for hand-typed ULID
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
        index: None,
        content: name.into(),
    });
    let record = op_log::append_local_op_in_tx(tx, device_id, payload, now_ms()).await?;
    records.push(record);

    // Materialize the block row immediately so downstream steps in this
    // same transaction (ensure_is_space_property, set_property_in_tx for
    // migration) can satisfy their "block exists and is not deleted"
    // TOCTOU checks. Mirrors the materializer's `apply_op_tx` CreateBlock
    // arm but as an UPSERT: #681 — when the seed block already exists but
    // was soft-deleted, clear `deleted_at` to RESTORE it (a plain
    // `INSERT OR IGNORE` would silently no-op on the existing tombstoned
    // row, leaving bootstrap stuck). The conflict target is the primary
    // key, so a fresh insert and a restore both converge to a live row.
    // `page_id` is set to self to match the command path's behaviour for
    // page blocks.
    sqlx::query!(
        "INSERT INTO blocks \
             (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', ?, NULL, 1, ?) \
         ON CONFLICT(id) DO UPDATE SET deleted_at = NULL",
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
pub async fn ensure_is_space_property(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
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
        state,
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

/// Ensure the seeded space block carries an `accent_color`
/// property pointing at the supplied default token (e.g.
/// `accent-emerald`, `accent-blue`).
///
/// Mirrors [`ensure_is_space_property`]'s idempotency contract: when
/// the block already has any `accent_color` value, this function is a
/// pure no-op and emits no op. Returns `true` when a fresh op was
/// appended, `false` when the property was already present.
///
/// User-driven recolouring via the "Manage spaces…" UI flows
/// through `set_property` and updates the same row — this seed never
/// overwrites a user choice on a re-run.
pub async fn ensure_accent_color_property(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
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
        state,
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

/// Batched migrator that assigns `space = SPACE_PERSONAL_ULID` to
/// every page in `page_ids`.
///
/// This is the perf path for the every-boot backfill: a
/// 5000-page first-boot vault used to round-trip ~20k SQL statements
/// inside one bootstrap transaction (the per-page `set_property_in_tx`
/// loop did 4 round-trips per page — definitions lookup, block existence
/// probe, op_log append, property UPSERT). The batched form collapses
/// the property-definitions read to one call and the per-row UPSERTs to
/// chunked multi-row INSERTs of [`PROPERTIES_INSERT_CHUNK`] rows each.
///
/// # Inherited invariants
///
/// - **Op log append-only.** Each page still gets its own
///   `SetProperty` op via [`op_log::append_local_op_in_tx`] because the
///   per-row hash chain (`prev_hash` advance, `parent_seqs`) is part of
///   the op_log contract. Batching the op_log writes is a separate,
///   larger refactor and is out of scope here.
/// - **`block_type` / liveness predicate.** [`pages_without_space`] already
///   filters to live pages with `block_type = 'page'`, so the per-page
///   block-existence probe in `set_property_in_tx` is redundant and is
///   intentionally skipped here. (The original heading named an
///   `is_conflict = 0` predicate; liveness is now enforced solely by
///   `deleted_at IS NULL` — the conflict-copy exclusion went with the
///   column in migration 0058.)
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
pub async fn migrate_pages_to_personal_space_batched(
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
            value_ref: Some(BlockId::from(SPACE_PERSONAL_ULID)),
            value_bool: None,
        });
        let record = op_log::append_local_op_in_tx(tx, device_id, payload, now_ms()).await?;
        records.push(record);
    }

    // Step C — chunked `UPDATE blocks SET space_id` (Phase 2: the
    // `blocks.space_id` column is the SOLE source of truth; the
    // `block_properties(key='space')` row is no longer materialized).
    // The op-log `SetProperty(space)` appends above remain the
    // append-only record; here we only project them onto the column.
    //
    // Each page's space membership covers the page block itself
    // (`id IN (chunk)`) and every block whose `page_id` points at one of
    // these pages (`page_id IN (chunk)`), matching the
    // `id=? OR page_id=?` grouping used elsewhere for space membership.
    //
    // SQLite caps bind parameters at MAX_SQL_PARAMS (999) per statement.
    // Each chunk binds the personal-space ref once plus the chunk ids
    // twice (once per `IN` list), so the bind budget per statement is
    // `1 + 2*chunk_len`. Reusing PROPERTIES_INSERT_CHUNK (= 166) keeps us
    // well under the cap (1 + 2*166 = 333 < 999).
    for chunk in page_ids.chunks(PROPERTIES_INSERT_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "?").collect();
        let placeholders = placeholders.join(", ");
        let sql = format!(
            "UPDATE blocks SET space_id = ? \
             WHERE id IN ({placeholders}) OR page_id IN ({placeholders})"
        );
        // dynamic-sql: the two `IN (...)` lists are built from the chunk
        // length at runtime, so the placeholder count varies per statement —
        // no fixed arity for the compile-checked macro to validate.
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        q = q.bind(SPACE_PERSONAL_ULID);
        // First `IN (...)` list — the page block ids themselves.
        for page_id in chunk {
            q = q.bind(page_id);
        }
        // Second `IN (...)` list — children whose `page_id` is one of them.
        for page_id in chunk {
            q = q.bind(page_id);
        }
        q.execute(&mut **tx).await?;
    }

    Ok(())
}

/// Return every live, non-conflict page that does not yet carry a
/// `space` property AND is not itself a space block. Used to migrate
/// existing-install pages into the Personal space on the first boot
/// after this feature ships.
pub async fn pages_without_space(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query!(
        // #533 Phase 2: space membership is `blocks.space_id` (the old
        // `block_properties(key='space')` rows are gone). "Without a space"
        // is now `space_id IS NULL`. `is_space` remains a property flag
        // (it marks a block AS a space; it was not migrated to a column).
        r#"SELECT id as "id!: String" FROM blocks b
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.space_id IS NULL
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

/// The space that most often references each of `tag_ids_json`.
///
/// A reference is a live, non-tag block whose `content` carries the inline
/// `#[<tag_id>]` token — evidence that exists whether or not the ref cache
/// was allowed to record it.
///
/// # Why this scans content and does not read `block_tag_refs`
///
/// Reading only `block_tag_refs` deadlocked — see the note on
/// [`migrate_orphan_tags_to_space`]. `reindex_block_tag_refs` refuses to
/// write a row whose tag is in a different space from the referencing block,
/// and a tag with NO space matches no block's space, so a tag needing
/// placement is precisely the tag guaranteed to have zero cache rows.
///
/// Nor is the cache worth UNIONing in alongside the scan: every row in it is
/// derived from exactly these tokens (`compute_desired_pairs` /
/// `reindex_block_tag_refs_in_tx` run `tag_ref_re()` over `blocks.content`),
/// so for a live source block it is a strict subset of what the scan already
/// sees. The only row it could add is a STALE one whose token has since been
/// edited out of the content — and that is a wrong vote, not an extra one.
///
/// A referencing block's space is its own `blocks.space_id` (first-class
/// since #533 / migration 0086), falling back to its owning page's when the
/// block itself is unscoped — the same `COALESCE` over a page join guarded
/// by `p.deleted_at IS NULL` that `space::resolve_block_space` and
/// `compute_desired_pairs` use, so a block on a trashed page votes exactly
/// as the cross-space gate would later judge it. Blocks that resolve to no
/// space contribute no vote rather than voting for NULL.
///
/// Ties break on the smallest `space_id`, so the answer is deterministic
/// across runs and across devices replaying the same log.
///
/// `#[` and a ULID contain no LIKE metacharacters, so the pattern needs no
/// `ESCAPE` clause. The leading `%` makes this a scan; it is bounded by the
/// caller only invoking this when at least one candidate tag exists.
async fn majority_space_by_content_refs(
    conn: &mut sqlx::SqliteConnection,
    tag_ids_json: &str,
) -> Result<Vec<(String, String)>, AppError> {
    // dynamic-sql: the arity IS fixed (one bound JSON string), but sqlx's
    // compile-time SQLite analysis cannot type a `json_each(?)` used as a
    // FROM source whose `.value` feeds a CTE — `cargo sqlx prepare` fails
    // with "no such table column: json_each.value" on this exact statement
    // — so the macro form is not available here.
    Ok(sqlx::query_as(
        r"WITH refs AS (
              SELECT t.value AS tag_id, b.id AS source_id
                FROM json_each(?1) t
                INNER JOIN blocks b
                    ON b.deleted_at IS NULL
                   AND b.block_type <> 'tag'
                   AND b.content LIKE '%#[' || t.value || ']%'
          )
          SELECT tag_id, space_id
            FROM (
                SELECT
                    r.tag_id AS tag_id,
                    COALESCE(b.space_id, p.space_id) AS space_id,
                    COUNT(*) AS cnt,
                    ROW_NUMBER() OVER (
                        PARTITION BY r.tag_id
                        ORDER BY COUNT(*) DESC, COALESCE(b.space_id, p.space_id) ASC
                    ) AS rn
                  FROM refs r
                  INNER JOIN blocks b ON b.id = r.source_id
                  LEFT JOIN blocks p ON p.id = b.page_id AND p.deleted_at IS NULL
                 WHERE COALESCE(b.space_id, p.space_id) IS NOT NULL
                 GROUP BY r.tag_id, COALESCE(b.space_id, p.space_id)
            ) ranked
           WHERE rn = 1",
    )
    .bind(tag_ids_json)
    .fetch_all(&mut *conn)
    .await?)
}

/// Phase 1 — Path A tag-space bootstrap.
///
/// Every tag block without a `space` property is assigned to the space
/// that most frequently references it. Tags with zero references fall back
/// to Personal. The migration emits one `SetProperty` op per orphan tag via
/// the normal op-log pipeline, preserving the append-only invariant.
///
/// # Why the reference count scans content rather than `block_tag_refs`
///
/// It used to read `block_tag_refs`, and that could never work: the two
/// paths deadlocked.
///
/// `reindex_block_tag_refs` refuses to write a row whose tag is in a
/// different space from the referencing block ("Phase 3 — filter out
/// cross-space tag-refs before inserting"). A tag with NO space matches no
/// source block's space, so it gets **zero** rows in `block_tag_refs`. This
/// migration then saw zero references and fell back to Personal — for every
/// orphan tag, regardless of where it was actually used. Once parked in
/// Personal, a tag referenced from Work is permanently cross-space, so the
/// gate keeps refusing the row and the tag stays broken forever: it is
/// invisible to `list_all_tags_in_space` for the space that uses it, and
/// every inline `#[ULID]` reference to it renders and filters as nothing.
///
/// Observed on a real vault: three tags (`meet`, `qa`, `pa`) created and
/// referenced only from the Work space, all sitting in Personal, with
/// `block_tag_refs` holding one row in total across 48 tag blocks.
///
/// Scanning `blocks.content` for the `#[<tag_id>]` token breaks the cycle,
/// because the token is present in the content whether or not the ref cache
/// has been allowed to record it. The scan runs only when orphan tags exist
/// (the early return above), so steady-state boots do not pay for it.
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
    state: &LoroState,
    device_id: &str,
    records: &mut Vec<OpRecord>,
) -> Result<usize, AppError> {
    // Step 1 — find every live, non-conflict tag block that has no
    // `space` property.
    let orphan_tags = sqlx::query!(
        // #533 Phase 2: an unassigned tag is `space_id IS NULL`.
        r#"SELECT b.id as "id!: String" FROM blocks b
           WHERE b.block_type = 'tag'
             AND b.deleted_at IS NULL
             AND b.space_id IS NULL
           ORDER BY b.id"#,
    )
    .fetch_all(&mut **tx)
    .await?;
    if orphan_tags.is_empty() {
        return Ok(0);
    }

    // Step 2 — compute the majority space for ALL orphan tags in one bulk
    // pass (json_each + ROW_NUMBER), so the round-trip count is independent
    // of how many orphan tags there are.
    //
    // Tags with zero references are absent from the result; the loop below
    // falls back to Personal for those (same policy as before). What changed
    // is where a "reference" is read from — see the deadlock note on this
    // function's doc comment.
    let tag_ids_json = serde_json::to_string(
        &orphan_tags
            .iter()
            .map(|r| r.id.as_str())
            .collect::<Vec<_>>(),
    )?;
    let majority_rows: Vec<(String, String)> =
        majority_space_by_content_refs(tx, &tag_ids_json).await?;

    // Build a tag_id → majority_space_id lookup.  Tags absent from the
    // result had zero references and will fall back to Personal below.
    let majority_space: HashMap<String, String> = majority_rows.into_iter().collect();

    let mut migrated = 0;
    for row in &orphan_tags {
        let tag_id = &row.id;

        let target_space = majority_space
            .get(tag_id.as_str())
            .map_or(SPACE_PERSONAL_ULID, String::as_str);

        // Step 3 — emit a SetProperty op assigning this tag to the
        // chosen space. The op flows through the normal pipeline so
        // replay / sync / undo see it as a regular property mutation.
        let payload = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::from_trusted(tag_id),
            key: "space".to_owned(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: Some(BlockId::from(target_space)),
            value_bool: None,
        });
        let record = op_log::append_local_op_in_tx(tx, device_id, payload, now_ms()).await?;

        // Applied IN this transaction through the shared projection, the way
        // the eager adoption in `commands/tags.rs` and the repair below do.
        // For the `space` key that is `apply_set_property_via_loro`: the same
        // `UPDATE blocks SET space_id … WHERE id = ? OR page_id = ?` a
        // hand-rolled column write would do, and THEN the hydrate of the tag
        // into the space's `LoroDoc`. The old UPDATE skipped the hydrate, so
        // the column said Work while Work's engine had never heard of the
        // block — invisible to a peer, and absent from a reprojection (#4743).
        // `old_space` is `None` for every candidate, so #2907's prune is a
        // no-op by construction.
        crate::apply::kernel::apply_op_projected(tx, &record, state, false).await?;
        records.push(record);

        migrated += 1;
    }

    Ok(migrated)
}

/// Tags whose current space disagrees with the ONE space every live block
/// that references them resolves to.
///
/// A reference is either kind the app knows: an inline `#[<tag_id>]` token
/// in a live block's `content`, or an explicit `block_tags` association (the
/// tag picker). Both are read from their source of truth, not from a cache.
/// The explicit arm is what makes "every live block that references it"
/// literally true: a tag inline-referenced only from Work but applied via the
/// picker to blocks in Personal is a two-space tag, and moving it to Work
/// would sever exactly the associations the unanimity rule exists to keep.
///
/// The inline arm is driven from blocks that contain a `#[` token at all,
/// so the correlated `LIKE` join runs against that subset rather than the
/// whole table. A source block's space is `COALESCE(b.space_id, p.space_id)`
/// over its owning page, joined with `p.deleted_at IS NULL` — the same
/// resolution as `space::resolve_block_space`, so a block on a trashed page
/// votes exactly as the cross-space gate would later judge it (unscoped, no
/// vote). `HAVING COUNT(DISTINCT ...) = 1` is the unanimity rule — a tag
/// referenced from two spaces is not a candidate at any margin.
///
/// Fully static SQL — no binds, no runtime-shaped arity — hence the
/// compile-checked macro form.
async fn misfiled_tag_spaces(
    conn: &mut sqlx::SqliteConnection,
) -> Result<Vec<(String, String)>, AppError> {
    let rows = sqlx::query!(
        r#"WITH tokened AS (
               SELECT
                   b.content AS content,
                   COALESCE(b.space_id, p.space_id) AS src_space
                 FROM blocks b
                 LEFT JOIN blocks p ON p.id = b.page_id AND p.deleted_at IS NULL
                WHERE b.deleted_at IS NULL
                  AND b.block_type <> 'tag'
                  AND b.content LIKE '%#[%'
           ),
           refs AS (
               SELECT t.id AS tag_id, t.space_id AS tag_space, k.src_space AS src_space
                 FROM blocks t
                 INNER JOIN tokened k
                     ON k.content LIKE '%#[' || t.id || ']%'
                WHERE t.block_type = 'tag'
                  AND t.deleted_at IS NULL
                  AND t.space_id IS NOT NULL
                  AND k.src_space IS NOT NULL
               UNION
               SELECT t.id AS tag_id, t.space_id AS tag_space,
                      COALESCE(b.space_id, p.space_id) AS src_space
                 FROM block_tags bt
                 INNER JOIN blocks t ON t.id = bt.tag_id
                 INNER JOIN blocks b ON b.id = bt.block_id
                 LEFT JOIN blocks p ON p.id = b.page_id AND p.deleted_at IS NULL
                WHERE t.block_type = 'tag'
                  AND t.deleted_at IS NULL
                  AND t.space_id IS NOT NULL
                  AND b.deleted_at IS NULL
                  AND COALESCE(b.space_id, p.space_id) IS NOT NULL
           )
           SELECT tag_id AS "tag_id!: String", MIN(src_space) AS "target_space!: String"
             FROM refs
            GROUP BY tag_id, tag_space
           HAVING COUNT(DISTINCT src_space) = 1
              AND MIN(src_space) <> tag_space
            ORDER BY tag_id"#,
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.tag_id, r.target_space))
        .collect())
}

/// `app_settings` key recording that [`repair_misfiled_tag_spaces`] has run.
///
/// Versioned so a future correction to the repair can re-arm it by bumping
/// the suffix rather than needing a way to clear the old key.
const TAG_SPACE_REPAIR_MARKER: &str = "repair.tag_space_misfiled.v1";

/// Repair pass — move a tag that is sitting in the WRONG space.
///
/// [`migrate_orphan_tags_to_space`] only ever fires for a tag with NO space,
/// so it cannot correct a tag that a previous run of the buggy version
/// already parked in the wrong one. Those tags are permanently broken
/// without this: `list_all_tags_in_space` hides them from the space that
/// actually uses them, and `reindex_block_tag_refs` refuses every reference
/// to them as cross-space, so they render as raw `#[ULID]` and match no
/// filter.
///
/// # Deliberately conservative: unanimous evidence only
///
/// A tag is moved only when **every** live block that references it — by an
/// inline `#[ULID]` token or by an explicit `block_tags` association —
/// resolves to one and the same space, and that space is not the tag's
/// current one. A tag referenced from two spaces is left exactly where it is.
///
/// The majority rule used for placing a brand-new orphan is fine when the
/// alternative is "no space at all", but it is not a good enough reason to
/// MOVE a tag the user may have deliberately filed: the minority space's
/// references would be severed by the cross-space gate as a side effect of a
/// repair the user never asked for. Unanimity means the move can only ever
/// take a tag from a space where nothing references it to the one space
/// where everything does.
///
/// # Why this one is gated to run ONCE, unlike its neighbours
///
/// `pages_without_space` and [`migrate_orphan_tags_to_space`] deliberately
/// run on every boot, because their candidate — a block with NO space — can
/// still ARRIVE later: a peer on an older build can sync one in long after
/// this device stopped producing them. Their check is also nearly free,
/// being an indexed `space_id IS NULL` test.
///
/// Neither holds here to the same degree. The population is, to a first
/// approximation, the damage this device's own earlier runs did: an old peer
/// emits a space-LESS tag (caught every boot by the cheap path above, which
/// this commit also fixes), and a current peer emits a correctly-filed one.
/// It is not perfectly closed — a peer still on the buggy build can sync in
/// a tag it already misfiled, and the every-boot path itself still mints a
/// misfiled tag when a space-less tag arrives before the content that
/// references it (zero evidence → Personal fallback). Both are small, and the
/// first heals once that peer upgrades and syncs its own repair ops. Paying a
/// full scan on every boot forever to catch them is still the wrong trade;
/// the versioned marker below is the re-arm mechanism if that ever changes.
///
/// And the check is not free. A misfiled tag looks exactly like a correctly
/// filed one until its references are counted, so there is no cheap
/// precondition to test: the pass costs a sequential scan of `blocks` to
/// collect rows containing a `#[` token, plus a `LIKE` join of those against
/// every tag. Paying that on every boot forever, to find something that can
/// only exist once, is the wrong trade — hence the marker.
///
/// The marker is written even when zero tags needed moving, so a clean vault
/// pays the scan once and never again. It is per-device (it lives in
/// `app_settings`, which is local state, not synced content), which is
/// correct: the damage was per-device too.
///
/// # This is a genuine cross-space move, so it goes through the engine
///
/// Unlike [`migrate_orphan_tags_to_space`], whose candidates have NO space
/// (so #2907's prune gate is a no-op by construction), every tag here is
/// already a member of a registered space's per-space `LoroDoc`. The
/// `SetProperty(space)` record is therefore applied through
/// `apply_set_property_via_loro` — the same projection the LOCAL
/// `move_blocks_to_space_inner` path and REMOTE sync use — which captures
/// the OLD space before the column is overwritten, purges the tag out of the
/// old space's doc, projects `blocks.space_id`, and hydrates the tag into
/// the new space's doc. A hand-rolled `UPDATE blocks SET space_id` in front
/// of that record would pre-empt the old-space capture (`old == new`, no
/// prune) and leave the tag durably a member of BOTH docs: a peer importing
/// the old doc re-stamps the old `space_id`, and with the marker already
/// written nothing ever corrects it.
///
/// # What this does NOT do: repopulate `block_tag_refs`
///
/// Moving the tag only makes its references admissible; nothing here
/// reindexes the blocks that carry them (`SetProperty` dispatch enqueues no
/// tag-ref work, by design). The caller (`bootstrap_spaces`) enqueues
/// `RebuildBlockTagRefsCache` + `RebuildTagsCache` after commit whenever
/// this or its neighbour moved a tag — that rebuild is the half of the
/// repair the user actually sees (tag filter, backlinks, `usage_count`).
///
/// Returns the number of tags moved.
pub async fn repair_misfiled_tag_spaces(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
    records: &mut Vec<OpRecord>,
) -> Result<usize, AppError> {
    // One indexed primary-key lookup — the whole cost of this function on
    // every boot after the first.
    let done: Option<String> = sqlx::query_scalar!(
        "SELECT value FROM app_settings WHERE key = ?",
        TAG_SPACE_REPAIR_MARKER,
    )
    .fetch_optional(&mut **tx)
    .await?;
    if done.is_some() {
        return Ok(0);
    }

    let misfiled: Vec<(String, String)> = misfiled_tag_spaces(tx).await?;

    let mut repaired = 0;
    for (tag_id, target_space) in &misfiled {
        // A SetProperty op through the normal pipeline (so replay / sync /
        // undo see a regular property mutation) …
        let payload = OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::from_trusted(tag_id),
            key: "space".to_owned(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: Some(BlockId::from(target_space.as_str())),
            value_bool: None,
        });
        let record = op_log::append_local_op_in_tx(tx, device_id, payload, now_ms()).await?;

        // … applied IN this transaction through the collapsed LOCAL
        // projection (`advance_cursor = false`, #1257 — exactly what
        // `set_property_in_tx_with_declaration` does at its step 4). For the
        // `space` key that is `apply_set_property_via_loro`: old-space capture
        // → column fan-out → #2907 prune from the old doc → hydrate into the
        // new one. NOT a hand-rolled `UPDATE blocks SET space_id`: see the
        // "genuine cross-space move" section of the doc comment. The
        // validating wrapper is deliberately not used here — its R17 /
        // registration checks reject with a Validation error, which at this
        // call site would be boot-fatal, and every candidate already satisfies
        // them by construction (live tag, target read from a `space_id` that
        // is FK-bound to `spaces`).
        crate::apply::kernel::apply_op_projected(tx, &record, state, false).await?;
        records.push(record);

        repaired += 1;
    }

    // Written unconditionally, including on a vault that had nothing to
    // repair: the point of the marker is to retire the SCAN, not to record
    // that work happened.
    let now = now_ms();
    let repaired_count = repaired.to_string();
    sqlx::query!(
        "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
        TAG_SPACE_REPAIR_MARKER,
        repaired_count,
        now,
    )
    .execute(&mut **tx)
    .await?;

    Ok(repaired)
}

#[cfg(test)]
mod tests {
    use super::*;
    use agaric_core::ulid::BlockId;
    use tempfile::TempDir;

    const DEV: &str = "test-device";

    /// Create a fresh migrated pool with the two seeded space blocks in
    /// place (flagged `is_space = "true"` so the 0089
    /// `spaces_register_is_space` trigger registers them in the `spaces`
    /// table — required by the `blocks.space_id REFERENCES spaces(id)` FK
    /// the migrators stamp).
    async fn fresh_pool() -> (SqlitePool, TempDir) {
        let (pool, tmp) = agaric_store::test_support::test_pool().await;
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
            // #708: flag the seeded blocks as spaces, exactly as the
            // production bootstrap does. The `is_space` INSERT fires the
            // 0089 `spaces_register_is_space` trigger, registering them in
            // the `spaces` table — required by the rebuilt
            // `blocks.space_id REFERENCES spaces(id)` FK that the
            // migrators below stamp.
            sqlx::query!(
                "INSERT OR IGNORE INTO block_properties (block_id, key, value_text) \
                 VALUES (?, 'is_space', 'true')",
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
        let migrated =
            migrate_orphan_tags_to_space(&mut tx, &LoroState::new(), DEV, &mut Vec::new())
                .await
                .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(migrated, 1);
        let space = sqlx::query_scalar!("SELECT space_id FROM blocks WHERE id = ?", tag_id,)
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
        // The reference is the `#[ULID]` token in the page's content — the
        // input production actually has. (This fixture used to hand the
        // migration a `block_tag_refs` row instead, i.e. a derived row the
        // production gate refuses to create for a space-less tag.)
        let body = format!("Test #[{tag_id}]");

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
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', ?, NULL, 1, ?, ?)",
            source_id,
            body,
            source_id,
            SPACE_WORK_ULID,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        let state = LoroState::new();
        let migrated = migrate_orphan_tags_to_space(&mut tx, &state, DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(migrated, 1);
        let space = sqlx::query_scalar!("SELECT space_id FROM blocks WHERE id = ?", tag_id,)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(space, Some(SPACE_WORK_ULID.to_string()));
        // #4743 — the column saying Work is half of it: Work's engine must
        // hold the block too, or a peer never learns the tag is there and a
        // reprojection from Loro loses it.
        let mut work = state
            .registry
            .for_space(
                &agaric_store::space::SpaceId::from_trusted(SPACE_WORK_ULID),
                DEV,
            )
            .unwrap();
        assert!(
            work.engine_mut().contains_block(&tag_id),
            "the placed tag must be hydrated into its space's LoroDoc"
        );
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
        let m1 = migrate_orphan_tags_to_space(&mut tx, &LoroState::new(), DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(m1, 1);

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let m2 = migrate_orphan_tags_to_space(&mut tx, &LoroState::new(), DEV, &mut Vec::new())
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
        let migrated =
            migrate_orphan_tags_to_space(&mut tx, &LoroState::new(), DEV, &mut Vec::new())
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
        // Seed the input (the token), not the cache — see
        // `orphan_tag_assigned_to_referencing_space`.
        let body = format!("content #[{tag_id}]");

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
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', 'Page', NULL, 1, ?, ?)",
            page_id,
            page_id,
            SPACE_WORK_ULID,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        // The content block carries NO `space_id` of its own, so the query
        // has to resolve its space through `b.page_id` — the property this
        // test exists to pin.
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'content', ?, ?, 2, ?)",
            content_id,
            body,
            page_id,
            page_id,
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        let migrated =
            migrate_orphan_tags_to_space(&mut tx, &LoroState::new(), DEV, &mut Vec::new())
                .await
                .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(migrated, 1);
        let space = sqlx::query_scalar!("SELECT space_id FROM blocks WHERE id = ?", tag_id,)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(space, Some(SPACE_WORK_ULID.to_string()));
    }

    #[tokio::test]
    async fn orphan_tag_placed_from_content_token_when_ref_cache_is_empty() {
        // THE DEADLOCK CASE, and the one every other fixture here misses:
        // `block_tag_refs` is EMPTY, exactly as it is in reality for a tag
        // that still needs placing.
        //
        // `reindex_block_tag_refs` refuses to record a ref whose tag is in a
        // different space from the source block ("Phase 3 — filter out
        // cross-space tag-refs"). A tag with NO space matches nothing, so it
        // can never earn a cache row *before* it has been placed — and the
        // placement used to be decided by reading that very cache. Every
        // orphan tag therefore scored zero references and fell back to
        // Personal, no matter where it was actually used; once parked there,
        // a Work-space reference stayed permanently cross-space and the ref
        // was dropped forever.
        //
        // Seeding `block_tag_refs` (as the sibling tests do) hides this
        // completely: the fixture hands the migration the very row the
        // production gate would have refused. So this test seeds ONLY the
        // `#[ULID]` token in the content, which is what the vault actually
        // contains, and asserts the tag lands in Work rather than Personal.
        let (pool, _tmp) = fresh_pool().await;
        let tag_id = BlockId::new().to_string();
        let page_id = BlockId::new().to_string();
        let content_id = BlockId::new().to_string();
        let body = format!("standup #[{tag_id}] with the team");

        // Runtime queries (not the `sqlx::query!` macro) because the block
        // content is BOUND here rather than a literal — the token has to
        // carry the generated `tag_id` — so there is no .sqlx cache entry to
        // hit and none worth adding for a fixture.
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'tag', 'meet', NULL, 1, NULL)",
        )
        .bind(&tag_id)
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', 'Standups', NULL, 1, ?, ?)",
        )
        .bind(&page_id)
        .bind(&page_id)
        .bind(SPACE_WORK_ULID)
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'content', ?, ?, 2, ?, ?)",
        )
        .bind(&content_id)
        .bind(&body)
        .bind(&page_id)
        .bind(&page_id)
        .bind(SPACE_WORK_ULID)
        .execute(&mut *tx)
        .await
        .unwrap();

        // The point of the test: nothing in the ref cache.
        let cached: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM block_tag_refs")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(cached, 0, "fixture must not pre-seed the ref cache");

        let migrated =
            migrate_orphan_tags_to_space(&mut tx, &LoroState::new(), DEV, &mut Vec::new())
                .await
                .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(migrated, 1);
        let space: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
            .bind(&tag_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            space,
            Some(SPACE_WORK_ULID.to_string()),
            "a tag referenced only from Work must land in Work, not fall back to Personal"
        );
    }

    /// Seed a tag block, a page in `page_space`, and a content block on that
    /// page whose text carries the `#[tag_id]` token. Returns the tag id.
    async fn seed_tag_referenced_from(
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        tag_name: &str,
        tag_space: Option<&str>,
        page_space: &str,
    ) -> String {
        let tag_id = BlockId::new().to_string();
        let page_id = BlockId::new().to_string();
        let content_id = BlockId::new().to_string();
        let body = format!("note #[{tag_id}] here");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'tag', ?, NULL, 1, NULL, ?)",
        )
        .bind(&tag_id)
        .bind(tag_name)
        .bind(tag_space)
        .execute(&mut **tx)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', 'P', NULL, 1, ?, ?)",
        )
        .bind(&page_id)
        .bind(&page_id)
        .bind(page_space)
        .execute(&mut **tx)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'content', ?, ?, 2, ?, ?)",
        )
        .bind(&content_id)
        .bind(&body)
        .bind(&page_id)
        .bind(&page_id)
        .bind(page_space)
        .execute(&mut **tx)
        .await
        .unwrap();
        tag_id
    }

    #[tokio::test]
    async fn misfiled_tag_moves_to_the_only_space_that_references_it() {
        // The shape found on a real vault: `meet`, `qa` and `pa` were created
        // and used exclusively in Work, and all three sat in Personal because
        // the old placement logic read an empty `block_tag_refs`. They are
        // invisible to the Work tag list and every reference to them is
        // dropped as cross-space, so they can never recover on their own.
        let (pool, _tmp) = fresh_pool().await;
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let tag_id =
            seed_tag_referenced_from(&mut tx, "meet", Some(SPACE_PERSONAL_ULID), SPACE_WORK_ULID)
                .await;

        let repaired = repair_misfiled_tag_spaces(&mut tx, &LoroState::new(), DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(repaired, 1);
        let space: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
            .bind(&tag_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(space, Some(SPACE_WORK_ULID.to_string()));

        // Idempotent ON ITS OWN TERMS. The marker would make a second call
        // return 0 whatever the repair does, so asserting "second run is 0"
        // without clearing it first would be an assertion that passes for two
        // different reasons — and the one we care about (the tag now agrees
        // with its references, so it is no longer a candidate) would be the
        // one not being tested. Clear the marker to actually re-run the scan.
        sqlx::query("DELETE FROM app_settings WHERE key = ?")
            .bind(TAG_SPACE_REPAIR_MARKER)
            .execute(&pool)
            .await
            .unwrap();
        let mut tx2 = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let again = repair_misfiled_tag_spaces(&mut tx2, &LoroState::new(), DEV, &mut Vec::new())
            .await
            .unwrap();
        tx2.commit().await.unwrap();
        assert_eq!(
            again, 0,
            "re-running the scan must find nothing: the tag now agrees with its references"
        );
    }

    #[tokio::test]
    async fn marker_retires_the_scan_even_when_nothing_was_repaired() {
        // The marker exists to retire the SCAN, not to record that work
        // happened, so a vault with nothing to fix must still write it —
        // otherwise every clean vault pays a full `blocks` scan on every boot
        // forever, looking for a condition that can no longer arise.
        let (pool, _tmp) = fresh_pool().await;
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let repaired = repair_misfiled_tag_spaces(&mut tx, &LoroState::new(), DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(repaired, 0);

        let marker: Option<String> =
            sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?")
                .bind(TAG_SPACE_REPAIR_MARKER)
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert_eq!(
            marker.as_deref(),
            Some("0"),
            "marker must be written anyway"
        );
    }

    #[tokio::test]
    async fn marker_stops_a_second_pass_from_moving_anything() {
        // A tag misfiled AFTER the marker was set is deliberately left alone:
        // the population this repair addresses is closed (a peer can only
        // deliver a space-LESS tag, which the every-boot path handles), so
        // paying the scan forever is the wrong trade. This pins that the gate
        // is what stops the second pass — if the marker check is ever dropped,
        // this test starts failing rather than silently costing every boot.
        let (pool, _tmp) = fresh_pool().await;
        let mut tx0 = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        repair_misfiled_tag_spaces(&mut tx0, &LoroState::new(), DEV, &mut Vec::new())
            .await
            .unwrap();
        tx0.commit().await.unwrap();

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let tag_id =
            seed_tag_referenced_from(&mut tx, "late", Some(SPACE_PERSONAL_ULID), SPACE_WORK_ULID)
                .await;
        let repaired = repair_misfiled_tag_spaces(&mut tx, &LoroState::new(), DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(repaired, 0, "the marker must short-circuit the scan");
        let space: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
            .bind(&tag_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(space, Some(SPACE_PERSONAL_ULID.to_string()));
    }

    #[tokio::test]
    async fn tag_already_in_the_referencing_space_is_left_alone() {
        let (pool, _tmp) = fresh_pool().await;
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let tag_id =
            seed_tag_referenced_from(&mut tx, "book", Some(SPACE_WORK_ULID), SPACE_WORK_ULID).await;
        let repaired = repair_misfiled_tag_spaces(&mut tx, &LoroState::new(), DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(repaired, 0);
        let space: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
            .bind(&tag_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(space, Some(SPACE_WORK_ULID.to_string()));
    }

    #[tokio::test]
    async fn tag_referenced_from_two_spaces_is_never_moved() {
        // The unanimity guard. A majority rule would move this tag to
        // whichever space referenced it more, and the cross-space gate would
        // then sever the other space's references — damage caused BY the
        // repair. Leaving it put is the only choice that cannot lose a
        // reference the user still has.
        let (pool, _tmp) = fresh_pool().await;
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();

        // One tag in Personal, referenced from a Work page AND a Personal
        // page — seeded by hand so both references point at the same tag.
        let tag_id = BlockId::new().to_string();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'tag', 'shared', NULL, 1, NULL, ?)",
        )
        .bind(&tag_id)
        .bind(SPACE_PERSONAL_ULID)
        .execute(&mut *tx)
        .await
        .unwrap();
        for space in [SPACE_WORK_ULID, SPACE_WORK_ULID, SPACE_PERSONAL_ULID] {
            let page_id = BlockId::new().to_string();
            let content_id = BlockId::new().to_string();
            let body = format!("x #[{tag_id}] y");
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
                 VALUES (?, 'page', 'P', NULL, 1, ?, ?)",
            )
            .bind(&page_id)
            .bind(&page_id)
            .bind(space)
            .execute(&mut *tx)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
                 VALUES (?, 'content', ?, ?, 2, ?, ?)",
            )
            .bind(&content_id)
            .bind(&body)
            .bind(&page_id)
            .bind(&page_id)
            .bind(space)
            .execute(&mut *tx)
            .await
            .unwrap();
        }

        let repaired = repair_misfiled_tag_spaces(&mut tx, &LoroState::new(), DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(
            repaired, 0,
            "a tag referenced from two spaces must stay where the user put it, \
             even though Work is the majority"
        );
        let space: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
            .bind(&tag_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(space, Some(SPACE_PERSONAL_ULID.to_string()));
    }

    /// Seed a page in `page_space` (optionally already trashed) and a live
    /// content block on it carrying `body`. The content block gets NO
    /// `space_id` of its own, so its space resolves only through the page —
    /// which is what makes the page's liveness matter. Returns the content
    /// block's id.
    async fn seed_page_with_content(
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        page_space: &str,
        page_deleted_at: Option<i64>,
        body: &str,
    ) -> String {
        let page_id = BlockId::new().to_string();
        let content_id = BlockId::new().to_string();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id, deleted_at) \
             VALUES (?, 'page', 'P', NULL, 1, ?, ?, ?)",
        )
        .bind(&page_id)
        .bind(&page_id)
        .bind(page_space)
        .bind(page_deleted_at)
        .execute(&mut **tx)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'content', ?, ?, 2, ?)",
        )
        .bind(&content_id)
        .bind(body)
        .bind(&page_id)
        .bind(&page_id)
        .execute(&mut **tx)
        .await
        .unwrap();
        content_id
    }

    #[tokio::test]
    async fn stale_ref_cache_row_does_not_place_an_orphan_tag() {
        // `block_tag_refs` is derived from the `#[ULID]` tokens in content,
        // so a row whose token has since been edited OUT of the content is
        // the only thing the cache can say that the content scan does not —
        // and it is wrong. Placement must read the input, not the cache: a
        // stale row pointing at Work must not put this tag in Work.
        let (pool, _tmp) = fresh_pool().await;
        let tag_id = BlockId::new().to_string();

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'tag', 'stale', NULL, 1, NULL)",
        )
        .bind(&tag_id)
        .execute(&mut *tx)
        .await
        .unwrap();
        let content_id =
            seed_page_with_content(&mut tx, SPACE_WORK_ULID, None, "the token is gone").await;
        sqlx::query("INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)")
            .bind(&content_id)
            .bind(&tag_id)
            .execute(&mut *tx)
            .await
            .unwrap();

        let migrated =
            migrate_orphan_tags_to_space(&mut tx, &LoroState::new(), DEV, &mut Vec::new())
                .await
                .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(migrated, 1);
        let space: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
            .bind(&tag_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            space,
            Some(SPACE_PERSONAL_ULID.to_string()),
            "a stale cache row is not a reference; with no token anywhere the tag falls back to Personal"
        );
    }

    #[tokio::test]
    async fn orphan_tag_ignores_a_reference_from_a_block_on_a_trashed_page() {
        // A live block whose only space comes from its owning page, when that
        // page is trashed, resolves to NO space in `space::resolve_block_space`
        // (the page join carries `p.deleted_at IS NULL`) — and that resolver
        // is what the cross-space gate uses. Placement must agree with it:
        // such a block casts no vote, so the tag falls back to Personal.
        let (pool, _tmp) = fresh_pool().await;
        let tag_id = BlockId::new().to_string();
        let body = format!("orphaned #[{tag_id}]");

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'tag', 'trashed-ref', NULL, 1, NULL)",
        )
        .bind(&tag_id)
        .execute(&mut *tx)
        .await
        .unwrap();
        seed_page_with_content(&mut tx, SPACE_WORK_ULID, Some(1_577_836_800_000), &body).await;

        let migrated =
            migrate_orphan_tags_to_space(&mut tx, &LoroState::new(), DEV, &mut Vec::new())
                .await
                .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(migrated, 1);
        let space: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
            .bind(&tag_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            space,
            Some(SPACE_PERSONAL_ULID.to_string()),
            "a block on a trashed page is unscoped to the resolver and must not vote for that page's space"
        );
    }

    #[tokio::test]
    async fn misfiled_tag_ignores_a_reference_from_a_block_on_a_trashed_page() {
        // Same resolver agreement as above, for the repair: the only
        // reference to this Personal tag is a live block on a TRASHED Work
        // page. The resolver calls that block unscoped, so there is no
        // unanimous Work evidence and the tag must stay put.
        let (pool, _tmp) = fresh_pool().await;
        let tag_id = BlockId::new().to_string();
        let body = format!("orphaned #[{tag_id}]");

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'tag', 'trashed-ref', NULL, 1, NULL, ?)",
        )
        .bind(&tag_id)
        .bind(SPACE_PERSONAL_ULID)
        .execute(&mut *tx)
        .await
        .unwrap();
        seed_page_with_content(&mut tx, SPACE_WORK_ULID, Some(1_577_836_800_000), &body).await;

        let repaired = repair_misfiled_tag_spaces(&mut tx, &LoroState::new(), DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(
            repaired, 0,
            "a reference from a block on a trashed page is not evidence the tag belongs to that space"
        );
        let space: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
            .bind(&tag_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(space, Some(SPACE_PERSONAL_ULID.to_string()));
    }

    #[tokio::test]
    async fn explicit_block_tags_association_counts_toward_unanimity() {
        // A tag misfiled into Personal, inline-referenced from ONE Work block
        // — and applied via the tag picker (a `block_tags` row, no token in
        // any content) to a Personal block. The picker path is exactly what
        // a misfiled-into-Personal tag is available for, so this shape is
        // ordinary. Reading only inline tokens would see a unanimous Work
        // vote and move the tag, silently orphaning the Personal association
        // — the severance the unanimity rule exists to prevent.
        let (pool, _tmp) = fresh_pool().await;
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let tag_id =
            seed_tag_referenced_from(&mut tx, "meet", Some(SPACE_PERSONAL_ULID), SPACE_WORK_ULID)
                .await;
        let tagged_id =
            seed_page_with_content(&mut tx, SPACE_PERSONAL_ULID, None, "picked from the picker")
                .await;
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(&tagged_id)
            .bind(&tag_id)
            .execute(&mut *tx)
            .await
            .unwrap();

        let repaired = repair_misfiled_tag_spaces(&mut tx, &LoroState::new(), DEV, &mut Vec::new())
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(
            repaired, 0,
            "an explicit association from a Personal block makes this a two-space tag; it must not move"
        );
        let space: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
            .bind(&tag_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(space, Some(SPACE_PERSONAL_ULID.to_string()));
    }

    #[tokio::test]
    async fn empty_table_returns_zero() {
        let (pool, _tmp) = fresh_pool().await;
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let migrated =
            migrate_orphan_tags_to_space(&mut tx, &LoroState::new(), DEV, &mut Vec::new())
                .await
                .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(migrated, 0);
    }
}
