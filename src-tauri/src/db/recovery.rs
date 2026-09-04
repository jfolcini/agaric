use agaric_core::attachment_filename::sanitize_attachment_filename;
// #4232: the recursion-depth cap every recursive CTE in this file carries. The
// SQL still spells it `100` inline — raw-string statements cannot interpolate a
// `const`, and the #1655 drift guard greps every `descendants` recursive arm in
// this crate for that literal — exactly as `agaric_store::block_descendants`
// documents for its own macros. Importing the name here means the cap has ONE
// definition across the engine, the store and this pre-migration replay: it is
// what the truncation reports below carry as their `depth`, what the report
// names, and what the tests build their chains against, so none of those can
// drift from the bound the SQL enforces.
use agaric_store::block_descendants::DESCENDANT_DEPTH_CAP;
use sqlx::{Row, SqlitePool};

use super::now_ms;
// `reserved_key_blocks_column` moved down into `agaric_store::db` (#2621, wave
// E1); reach it via the `db` module's re-export so the replay calls below stay
// unqualified.
use super::reserved_key_blocks_column;

// ======================================================================
// Recovery helpers for corrupted databases (missing blocks table)
// ======================================================================

/// #3269: the HEAD shape of `blocks`, mirroring the rebuild in
/// `migrations/0089_spaces_registry.sql` (`_new_blocks`, renamed to `blocks` by
/// that migration). 0089 is the last migration that touches this table: nothing
/// in 0090..head `ALTER`s `blocks` or adds/removes a `blocks` index, so 0089's
/// output IS the head schema.
///
/// WHY A RUST COPY RATHER THAN A DERIVATION. The authoritative object is the
/// `blocks` table itself, and this constant is only ever used when that table is
/// GONE — there is nothing left on the damaged vault to derive from. The two
/// derivations that would work both trade a pinned copy for a worse failure
/// mode:
///
///   * Re-running 0089 is impossible. It is a *rebuild* (it copies out of an
///     existing `blocks`), it is already recorded in `_sqlx_migrations` on the
///     at-head vault this branch targets so `sqlx::migrate!` will never re-run
///     it, and migrations are immutable.
///   * Materialising a scratch database, migrating it to head, and reading the
///     DDL back out of its `sqlite_master` would derive the shape exactly — at
///     the cost of a second, unsupervised ~110-migration run (temp-file
///     placement, disk, its own failure modes) on the one code path that
///     already means "this vault is damaged". Adding a new boot-time failure
///     mode to a disaster path is a bad trade.
///
/// So the copy stays and DRIFT IS MADE LOUD INSTEAD OF SILENT:
/// `recovered_blocks_schema_matches_migrated_head_3269` boots a normally
/// migrated database, reads `blocks` and every `blocks` index straight out of
/// `sqlite_master`, then drops the table, runs this recovery, and asserts the
/// two schemas are normalisation-identical. Any future migration that changes
/// the table or its index set turns that test red instead of letting recovered
/// vaults quietly diverge from healthy ones.
const HEAD_BLOCKS_TABLE_DDL: &str = "CREATE TABLE blocks (
    id             TEXT NOT NULL PRIMARY KEY,
    block_type     TEXT NOT NULL DEFAULT 'content',
    content        TEXT,
    parent_id      TEXT REFERENCES blocks(id),
    position       INTEGER,
    deleted_at     INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0),
    todo_state     TEXT,
    priority       TEXT,
    due_date       TEXT,
    scheduled_date TEXT,
    page_id        TEXT REFERENCES blocks(id),
    space_id       TEXT REFERENCES spaces(id) ON DELETE SET NULL,
    CONSTRAINT page_id_self_for_pages CHECK (
        block_type != 'page' OR page_id = id
    ),
    CONSTRAINT block_type_valid CHECK (
        block_type IN ('content', 'tag', 'page')
    )
) STRICT";

/// #3269: the head index set for `blocks`, verbatim from
/// `migrations/0089_spaces_registry.sql`. Same single-source-of-truth argument
/// (and the same drift-detecting test) as [`HEAD_BLOCKS_TABLE_DDL`].
///
/// `IF NOT EXISTS` throughout: these are re-issued on a table that may already
/// carry them (a later rebuild migration re-creates them too), so the statements
/// must be idempotent.
const HEAD_BLOCKS_INDEXES: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS idx_blocks_deleted
    ON blocks(deleted_at, id) WHERE deleted_at IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_blocks_todo
    ON blocks(todo_state) WHERE todo_state IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_blocks_due
    ON blocks(due_date) WHERE due_date IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_blocks_scheduled
    ON blocks(scheduled_date) WHERE scheduled_date IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_blocks_page_alive
    ON blocks(id) WHERE block_type = 'page' AND deleted_at IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_blocks_parent_covering
    ON blocks(parent_id, deleted_at, position, id)",
    "CREATE INDEX IF NOT EXISTS idx_blocks_page_id
    ON blocks(page_id)",
    "CREATE INDEX IF NOT EXISTS idx_blocks_journal_date
    ON blocks(content) WHERE block_type = 'page' AND content LIKE '____-__-__'",
    "CREATE INDEX IF NOT EXISTS idx_blocks_type
    ON blocks(block_type, deleted_at, id)",
    "CREATE INDEX IF NOT EXISTS idx_blocks_space_type
    ON blocks(space_id, block_type, deleted_at, id)",
];

/// #3269: the lowest `_sqlx_migrations` stamp for which [`HEAD_BLOCKS_TABLE_DDL`]
/// is the correct table to create.
///
/// 0089 is the migration that produced the head shape, and it is also the LAST
/// migration that does any DDL on `blocks` — nothing in 0090..head `CREATE`s,
/// `DROP`s or `ALTER`s the table, and nothing adds or drops a `blocks` index.
/// (Only 0096 and 0110 mention `blocks` at all, both as read-only subqueries /
/// joins.) Two consequences, and the whole predicate rests on them:
///
///  * At or above this stamp the head DDL IS the era-correct shape, so creating
///    it is not "getting ahead of the migrations" — it is reproducing exactly
///    what the vault should already have had.
///  * No pending migration will rebuild `blocks` afterwards, so whatever this
///    recovery creates is PERMANENT for the rest of the vault's life. That is
///    why a constraint-free scaffold must not be left behind here: it is not
///    temporary, it is forever.
///
/// Below this stamp the scaffold is both correct and necessary — a pre-0080 era
/// cannot express `STRICT` + INTEGER `deleted_at`, `space_id` does not exist
/// before 0086, the `spaces` FK target does not exist before 0089, and a
/// pending rebuild migration WILL re-create the table with the era's real
/// constraints.
///
/// **If a future migration touches `blocks`, revisit this constant.** The moment
/// migration N does DDL on the table, stamps in `[89, N)` stop being at-head
/// shapes and this bound must move to N.
/// `recovered_blocks_schema_matches_migrated_head_3269` is the tripwire: it
/// compares the recovered table against the freshly-migrated one, so a changed
/// head shape fails there rather than silently shipping the wrong DDL to
/// mid-range vaults.
const HEAD_BLOCKS_SHAPE_MIN_MIGRATION: i64 = 89;

/// This bound is also load-bearing for the SCAFFOLD FALLBACK, which is not
/// obvious from either site. `rebuild_blocks_table` issues the fallback with
/// `head_indexes: head_shape_applies`, and [`HEAD_BLOCKS_INDEXES`] contains
/// `idx_blocks_space_type ON blocks(space_id, …)` — a column the scaffold only
/// creates when `has_space_id_column` (stamp >= 86) is true. The fallback is
/// therefore safe only because `head_shape_applies` implies a stamp at or above
/// this constant, which implies the 0086 era. Lowering the constant below 86
/// would silently make the head index set reference a column the fallback table
/// does not have — a `CREATE INDEX` failure on the recovery path that only
/// fires for a mid-range vault whose constrained rebuild was also rejected.
const _: () = assert!(
    HEAD_BLOCKS_SHAPE_MIN_MIGRATION >= 86,
    "HEAD_BLOCKS_INDEXES indexes blocks(space_id), which exists only from \
     migration 0086; the scaffold fallback issues those indexes whenever \
     head_shape_applies, so this floor must stay at or above 86"
);

/// #3269: which shape [`rebuild_blocks_table`] should give the replacement
/// `blocks` table's columns and constraints.
#[derive(Clone, Copy)]
enum BlocksTableShape {
    /// The real head shape: [`HEAD_BLOCKS_TABLE_DDL`] verbatim (STRICT + FKs +
    /// CHECK constraints). Carries no era switches: it is only ever chosen at a stamp
    /// ≥ [`HEAD_BLOCKS_SHAPE_MIN_MIGRATION`], which already implies
    /// `deleted_at` is INTEGER epoch-ms (0080) and `space_id` exists (0086).
    Head,
    /// The era-correct constraint-free scaffold — used below
    /// [`HEAD_BLOCKS_SHAPE_MIN_MIGRATION`], and as the fallback when the head
    /// shape refuses the recovered data.
    Scaffold {
        /// `deleted_at` is INTEGER epoch-ms (post-0080) rather than rfc3339 TEXT.
        deleted_at_is_ms: bool,
        /// The era's `blocks` carries `space_id` (post-0086).
        has_space_id_column: bool,
    },
}

impl BlocksTableShape {
    /// The `deleted_at` encoding the op-log replay must write. Head implies
    /// epoch-ms (its stamp floor is above 0080), so the era switch only ever
    /// varies on the scaffold.
    fn deleted_at_is_ms(self) -> bool {
        match self {
            Self::Head => true,
            Self::Scaffold {
                deleted_at_is_ms, ..
            } => deleted_at_is_ms,
        }
    }
}

/// #3269: the full instruction for one [`rebuild_blocks_table`] attempt.
#[derive(Clone, Copy)]
struct RecoveredBlocksShape {
    table: BlocksTableShape,
    /// Issue [`HEAD_BLOCKS_INDEXES`] after the replay.
    head_indexes: bool,
}

/// If the `blocks` table is missing (e.g. from a partial migration-73
/// DROP TABLE that was not rolled back), create a temporary table and
/// replay block-level ops from `op_log` to reconstruct it.
///
/// Dependent tables (block_properties, block_tags, …) are recovered
/// *after* migrations run via [`recover_derived_state_from_op_log`]
/// because migration 73's DROP TABLE blocks would CASCADE-delete them.
///
/// #616: returns `true` iff block recovery actually fired this boot (the
/// temp table was created and ops replayed). The caller threads this
/// positive corruption signal into [`recover_derived_state_from_op_log`],
/// which no longer infers corruption from empty derived tables alone (a
/// reserved-key-only vault legitimately keeps `block_properties` and
/// `block_tags` empty forever post-0088). For crash-retry coverage the
/// same signal is also persisted as the [`DERIVED_RECOVERY_PENDING_KEY`]
/// marker row, when the `app_settings` table (migration 0053) exists.
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
pub(crate) async fn ensure_blocks_table_exists(
    pool: &SqlitePool,
) -> Result<bool, agaric_core::error::AppError> {
    // R4 (#347): propagate probe errors with `?` rather than masking a
    // transient failure as `0`/false. A swallowed error here would skip
    // recovery entirely and let migrations run against a missing `blocks`
    // table — far worse than surfacing the boot error.
    let exists = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'blocks'"
    )
    .fetch_one(pool)
    .await?
        > 0;

    if exists {
        return Ok(false);
    }

    // Only recover if this is a corrupted database (migrations have already
    // run at least once). Fresh databases have no _sqlx_migrations yet.
    let migrations_table_exists: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'"
    )
    .fetch_one(pool)
    .await?;

    if migrations_table_exists == 0 {
        return Ok(false);
    }

    // #618: the highest applied migration version determines the era-correct
    // temp-table schema and `deleted_at` encoding below. `IFNULL(MAX(…), 0)`
    // doubles as the fresh-DB gate: 0 rows ⇒ no migration ever ran ⇒ this is
    // a fresh database, not a corrupted one — skip recovery.
    let max_applied_migration =
        sqlx::query_scalar!(r#"SELECT IFNULL(MAX(version), 0) AS "v!: i64" FROM _sqlx_migrations"#)
            .fetch_one(pool)
            .await?;

    if max_applied_migration == 0 {
        return Ok(false);
    }

    // #618: era switches — `ensure_blocks_table_exists` fires for ANY
    // missing-blocks state (every rebuild migration DROPs `blocks`, and
    // external corruption can hit a fully-migrated DB), so the temp schema
    // must match what the migrations still pending a (re-)run expect:
    //
    // * `deleted_at` flipped TEXT rfc3339 → INTEGER epoch-ms in 0080. Only
    //   0080 julianday()-converts; the later rebuilds (0085, 0089) copy the
    //   column RAW into a `STRICT` INTEGER column, and a DB with no pending
    //   `blocks` rebuild keeps the table created here as the live `blocks`,
    //   where every reader decodes i64.
    //   Writing rfc3339 TEXT on a ≥0080 DB therefore wedges boot permanently:
    //   this recovery tx commits before migrations run, so the next boot
    //   finds `blocks` present, skips recovery, and fails the same rebuild
    //   again (SQLITE_CONSTRAINT_DATATYPE).
    // * `space_id` (#605) exists iff 0086 is recorded. With 0086 applied no
    //   later migration re-adds the column, and the post-migration
    //   `set_property(space)` replay needs it ("no such column" otherwise);
    //   WITHOUT 0086 recorded, `ALTER TABLE blocks ADD COLUMN space_id`
    //   re-runs at boot and would abort with "duplicate column name" if the
    //   temp table already carried it (the exactly-0085-era sibling wedge).
    let deleted_at_is_ms = max_applied_migration >= 80;
    let has_space_id_column = max_applied_migration >= 86;

    // #3269: will any PENDING migration rebuild `blocks` after this recovery?
    // That, not "is this vault exactly at head", is what decides whether the
    // table created here is temporary or permanent.
    //
    // The predicate is a RANGE, `[HEAD_BLOCKS_SHAPE_MIN_MIGRATION, embedded
    // head]`:
    //
    //  * Lower bound (0089 — see `HEAD_BLOCKS_SHAPE_MIN_MIGRATION`): 0089 is
    //    both the migration that produced the head shape and the last one that
    //    does DDL on `blocks`. So from 0089 upward the head DDL is already the
    //    era-correct shape AND nothing pending will rebuild the table — the
    //    scaffold would be permanent. A strict `== head` here was the #3269 bug
    //    in its most likely form: a vault damaged while running an older app
    //    and upgraded afterwards is stamped somewhere in 0090..head, and got a
    //    constraint-free, zero-index table that nothing ever repairs.
    //  * Upper bound (`<=`): a vault stamped by a NEWER app version may have a
    //    `blocks` shape this binary does not know, and this binary's head DDL
    //    would be wrong for it. Fall back to the scaffold, which claims nothing
    //    about the schema. (This half of the old `==` predicate was right, and
    //    is kept.)
    let embedded_head_version = sqlx::migrate!("./migrations")
        .iter()
        .filter(|m| !m.migration_type.is_down_migration())
        .map(|m| m.version)
        .max()
        .unwrap_or(0);
    let head_shape_applies = max_applied_migration >= HEAD_BLOCKS_SHAPE_MIN_MIGRATION
        && max_applied_migration <= embedded_head_version;

    tracing::warn!(
        max_applied_migration,
        embedded_head_version,
        head_shape_applies,
        "blocks table missing — likely from a partial blocks-rebuild migration run. \
         Creating replacement table and recovering from op_log."
    );

    // #3269: when the head shape applies, TRY it first — but only try. This
    // table is fed straight from raw op-log payloads, and the pre-fix behaviour
    // (a constraint-free table) is guaranteed to accept them; the constrained
    // one is not (a STRICT type mismatch, or a deferred FK whose target table
    // was destroyed by the same external damage that took `blocks`, aborts at
    // COMMIT). Wedging boot on the disaster path would be strictly worse than
    // today's degraded-but-live table, so any failure logs loudly and falls back
    // to exactly the pre-#3269 scaffold. The head index set is issued on BOTH
    // paths: it is pure DDL that cannot reject data, so a fallback vault is
    // still index-complete even when it is constraint-incomplete.
    if head_shape_applies {
        // Pre-flight the one FK target the head DDL names outside `blocks`
        // itself. The known-reachable failure mode is external damage broad
        // enough to have taken `spaces` too; SQLite resolves FK targets at DML
        // time, not DDL time, so the `CREATE TABLE` succeeds and the whole
        // replay then aborts on the first insert with "no such table:
        // main.spaces". Checking first turns that case into ONE replay instead
        // of two (see the retry note below) — the attempt is only worth making
        // when it can plausibly succeed.
        let spaces_exists: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'spaces'"
        )
        .fetch_one(pool)
        .await?;
        if spaces_exists > 0 {
            let head_shape = RecoveredBlocksShape {
                table: BlocksTableShape::Head,
                head_indexes: true,
            };
            match rebuild_blocks_table(pool, head_shape).await {
                Ok(diagnostics) => {
                    // #3269 R5: emitted HERE, by the attempt that actually
                    // committed. The replay used to log from inside itself, so
                    // the retry below double-reported the `DISASTER RECOVERY
                    // DATA LOSS (#2504)` error and every per-op warning — a
                    // post-mortem reading the log would double-count the damage.
                    diagnostics.emit();
                    return Ok(true);
                }
                Err(err) => {
                    tracing::error!(
                        error = %err,
                        "constrained `blocks` rebuild failed — falling back to the constraint-free \
                         recovery scaffold (#3269). The recovered table gets the head indexes but \
                         NOT the STRICT / FK / CHECK constraints; run a rebuild or re-sync to \
                         restore the full schema."
                    );
                }
            }
        } else {
            tracing::error!(
                "the `spaces` table is missing too — skipping the constrained `blocks` rebuild \
                 (its `space_id REFERENCES spaces(id)` could not be created) and recovering into \
                 the constraint-free scaffold instead (#3269)."
            );
        }
    }

    // #3269 R5 (residual, documented rather than fixed): reaching here after a
    // FAILED constrained attempt replays the op_log a second time. It is not
    // avoidable without giving up the attempt itself — whether the head shape
    // accepts this vault's rows is only knowable by inserting them, and the
    // failed attempt's transaction (data included) is gone by the time we find
    // out. The cost is bounded: it is one extra O(op_count) pass on a path that
    // has already established the vault is damaged AND that the preferred
    // rebuild failed, and the pre-flight above removes the one failure mode
    // known to be reachable. The DIAGNOSTICS, which is what a post-mortem
    // reads, are no longer duplicated: the replay reports rather than logs, and
    // only the attempt that commits emits.
    let diagnostics = rebuild_blocks_table(
        pool,
        RecoveredBlocksShape {
            table: BlocksTableShape::Scaffold {
                deleted_at_is_ms,
                has_space_id_column,
            },
            head_indexes: head_shape_applies,
        },
    )
    .await?;
    diagnostics.emit();
    Ok(true)
}

/// #3269: create the replacement `blocks` table in the requested shape, replay
/// the op_log into it, and (at head) issue the head index set — all in ONE
/// transaction, so a failed attempt leaves no half-built table behind and the
/// caller can retry with a laxer shape.
///
/// Returns the replay's [`ReplayDiagnostics`] rather than logging them: this
/// function may run TWICE (constrained attempt, then scaffold fallback) and only
/// the attempt that commits should be reported. The caller emits.
async fn rebuild_blocks_table(
    pool: &SqlitePool,
    shape: RecoveredBlocksShape,
) -> Result<ReplayDiagnostics, agaric_core::error::AppError> {
    let mut tx = pool.begin().await?;

    if matches!(shape.table, BlocksTableShape::Head) {
        // The head table self-references (`parent_id` / `page_id REFERENCES
        // blocks(id)`) and the replay below cannot satisfy those row by row: it
        // NULLs dangling cross-device parents and derives `page_id` only AFTER
        // the replay loop, and it replays in `created_at` order, which is not a
        // topological order. Defer FK *checks* to COMMIT — the same mechanism
        // migration 0089 itself uses for its rebuild — so the intermediate
        // states are legal and only the final one is validated. The pragma
        // auto-resets at COMMIT/ROLLBACK.
        // dynamic-sql: a PRAGMA, which the `query!` macros cannot describe —
        // it returns no rows and is not a preparable statement they can check.
        sqlx::query("PRAGMA defer_foreign_keys = ON")
            .execute(&mut *tx)
            .await?;
        // dynamic-sql: DDL. `query!` validates a statement against the CURRENT
        // schema; this one CREATES the table being validated against, and it is
        // deliberately a `const` shared with the drift test
        // (`recovered_blocks_schema_matches_migrated_head_3269`) rather than a
        // literal at the call site.
        sqlx::query(HEAD_BLOCKS_TABLE_DDL).execute(&mut *tx).await?;
    } else {
        // Pre-#3269 scaffold: no STRICT, no FK constraints, no CHECK. Below
        // `HEAD_BLOCKS_SHAPE_MIN_MIGRATION` the pending re-run of the rebuild
        // migration that lost the table restores the proper constraints; at or
        // above it this is the fallback the constrained attempt degrades to.
        let BlocksTableShape::Scaffold {
            deleted_at_is_ms,
            has_space_id_column,
        } = shape.table
        else {
            unreachable!("the Head arm is handled above")
        };
        let deleted_at_type = if deleted_at_is_ms { "INTEGER" } else { "TEXT" };
        let space_id_column = if has_space_id_column {
            ",\n            space_id       TEXT"
        } else {
            ""
        };
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "CREATE TABLE blocks (
            id             TEXT NOT NULL PRIMARY KEY,
            block_type     TEXT NOT NULL DEFAULT 'content',
            content        TEXT,
            parent_id      TEXT,
            position       INTEGER,
            deleted_at     {deleted_at_type},
            todo_state     TEXT,
            priority       TEXT,
            due_date       TEXT,
            scheduled_date TEXT,
            page_id        TEXT{space_id_column}
        )"
        )))
        .execute(&mut *tx)
        .await?;
    }

    // Replay create / edit / move / delete / restore / purge ops into blocks.
    let diagnostics = recover_blocks_from_op_log(&mut tx, shape.table.deleted_at_is_ms()).await?;

    // #3269: restore the head index set. Without this a recovered vault whose
    // stamp is at or above `HEAD_BLOCKS_SHAPE_MIN_MIGRATION` — i.e. one no
    // pending migration will rebuild — full-scans `blocks` on every paginated
    // read (`page_id`, `parent_id`, date ranges, the journal-date lookup) for
    // the rest of its life, with no diagnostic. Issued AFTER the replay so the
    // bulk insert is not paying index maintenance per row.
    if shape.head_indexes {
        for stmt in HEAD_BLOCKS_INDEXES {
            // dynamic-sql: DDL iterated from the `HEAD_BLOCKS_INDEXES` table of
            // index statements. The macro forms take a string LITERAL and
            // cannot be driven from a slice; splitting ten `CREATE INDEX`
            // macros out of the shared constant would break the single source
            // of truth the drift test compares against `sqlite_master`.
            sqlx::query(*stmt).execute(&mut *tx).await?;
        }
    }

    // #616: persist the "derived recovery still pending" marker in the SAME
    // tx, so a crash between this commit and the post-migration derived-state
    // replay leaves a durable retry signal (the next boot sees `blocks`
    // present and would otherwise never re-run the derived recovery).
    // `app_settings` exists iff migration 0053 has run — true for every
    // rebuild-migration corruption era this recovery targets (0073+); on an
    // ancient pre-0053 DB the marker is skipped and the same-boot in-memory
    // flag alone gates the derived replay.
    let app_settings_exists: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'"
    )
    .fetch_one(&mut *tx)
    .await?;
    if app_settings_exists > 0 {
        let now = now_ms();
        sqlx::query(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, '1', ?)",
        )
        .bind(DERIVED_RECOVERY_PENDING_KEY)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(diagnostics)
}

/// #616: `app_settings` key marking that block-table recovery fired and the
/// post-migration derived-state replay has not yet completed. Written by
/// [`ensure_blocks_table_exists`] (same tx as the temp-table rebuild),
/// cleared by [`recover_attachments_from_op_log`] — the LAST pass of the
/// sequence (#3268) — in the same tx as its replay. So the whole recovery
/// retries on every boot until it lands in full, and never runs without a
/// positive corruption signal. Deliberately NOT cleared by
/// [`recover_derived_state_from_op_log`]: a crash between the two passes must
/// leave the signal armed, or the attachment replay is lost for good.
pub(crate) const DERIVED_RECOVERY_PENDING_KEY: &str = "recovery.derived_replay_pending";

/// #2920: `app_settings` key marking that the engine-first reprojection
/// ([`reproject_blocks_from_engine`]) skipped at least one space or block and is
/// therefore INCOMPLETE. Written whenever a reprojection commits with skips (or
/// every snapshot failed to decode), cleared ONLY by a fully-clean reprojection.
///
/// The boot path ([`crate::db::pool::init_pools`]) re-attempts reprojection
/// whenever this marker is present — even though the `blocks` table is present
/// again on a later boot, which makes the `blocks_recovered` gate this-boot-only
/// and would otherwise never re-fire. Without this marker a partial engine
/// recovery is silently, permanently lost (remote-authored content invisible in
/// SQL). Mirrors the [`DERIVED_RECOVERY_PENDING_KEY`] philosophy: retries on
/// every boot until the reprojection lands fully. A block that fails
/// DETERMINISTICALLY (e.g. an unrecognised `block_type` the local CHECK rejects)
/// keeps the marker armed until a re-sync or an upgrade makes it projectable —
/// one extra (idempotent) reprojection per boot, which is the correct trade for
/// never silently dropping the recovery.
pub(crate) const ENGINE_REPROJECT_PENDING_KEY: &str = "recovery.engine_reproject_pending";

/// #2920: set (`pending = true`) or clear (`pending = false`) the
/// [`ENGINE_REPROJECT_PENDING_KEY`] retry marker. Generic over the executor so
/// the caller can write it atomically inside the reprojection transaction
/// (`&mut *tx`) or standalone against the pool. `app_settings` (migration 0053)
/// always exists here — this only runs after migrations.
async fn set_engine_reproject_pending<'e, E>(
    exec: E,
    pending: bool,
) -> Result<(), agaric_core::error::AppError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    if pending {
        sqlx::query(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, '1', ?)",
        )
        .bind(ENGINE_REPROJECT_PENDING_KEY)
        .bind(now_ms())
        .execute(exec)
        .await?;
    } else {
        sqlx::query("DELETE FROM app_settings WHERE key = ?")
            .bind(ENGINE_REPROJECT_PENDING_KEY)
            .execute(exec)
            .await?;
    }
    Ok(())
}

/// #2920: is an engine-first reprojection retry pending from a prior boot that
/// skipped some spaces/blocks? Gates the boot re-attempt of
/// [`reproject_blocks_from_engine`] independently of the this-boot-only
/// `blocks_recovered` signal. Guards on `app_settings` existence so an
/// ancient/odd schema returns `false` rather than erroring the boot.
pub(crate) async fn engine_reproject_pending(
    pool: &SqlitePool,
) -> Result<bool, agaric_core::error::AppError> {
    let table_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'",
    )
    .fetch_one(pool)
    .await?;
    if table_exists == 0 {
        return Ok(false);
    }
    let pending: i64 =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM app_settings WHERE key = ?")
            .bind(ENGINE_REPROJECT_PENDING_KEY)
            .fetch_one(pool)
            .await?;
    Ok(pending > 0)
}

/// #429: read an `op_log` row's `created_at` as an rfc3339 string, for use as
/// `blocks.deleted_at` when recovery replays a `delete_block` on a pre-0080
/// database (post-0080 the column is INTEGER ms — see [`op_created_at_ms`],
/// #618).
///
/// `created_at` is INTEGER-ms post-migration 0079/0080 but original-format
/// **TEXT rfc3339** on the older databases that actually reach this recovery
/// path — a partial-migration-73 DB has NOT run 0079 yet, so its `created_at`
/// is still TEXT. **TEXT is therefore tried FIRST**: reading a TEXT rfc3339
/// value as `i64` would otherwise yield the wrong timestamp (a coercion
/// artefact / the value's leading integer), silently defeating the
/// cohort-timestamp preservation on the exact population this fixes.
///
/// Robust to both column eras: if `created_at` is TEXT we get the rfc3339
/// string directly (and, defensively, convert it if it is actually an
/// all-digit ms value); if it is INTEGER we fall through to the `i64` read and
/// render rfc3339. `fallback` (boot-time `now`) is used only if neither read
/// succeeds — it never should for a well-formed op row.
pub(crate) fn op_created_at_rfc3339(row: &sqlx::sqlite::SqliteRow, fallback: &str) -> String {
    if let Ok(s) = row.try_get::<String, _>("created_at") {
        // Defensive: a TEXT column holding an all-digit ms value (or an
        // integer coerced to text) — render rfc3339 rather than emit a bare
        // integer string as `deleted_at`.
        if let Ok(ms) = s.parse::<i64>()
            && let Some(dt) = chrono::DateTime::from_timestamp_millis(ms)
        {
            return dt.to_rfc3339();
        }
        if !s.is_empty() {
            return s;
        }
    }
    if let Ok(ms) = row.try_get::<i64, _>("created_at")
        && let Some(dt) = chrono::DateTime::from_timestamp_millis(ms)
    {
        return dt.to_rfc3339();
    }
    fallback.to_string()
}

/// #618: read an `op_log` row's `created_at` as epoch-ms, for use as
/// `blocks.deleted_at` when recovery replays a `delete_block` on a database
/// where migration 0080 has already run (`deleted_at` is INTEGER ms there,
/// and no later migration converts — the 0085/0089 rebuild re-runs copy the
/// column RAW into a `STRICT` INTEGER column).
///
/// On that population `created_at` is INTEGER ms (0080 applied ⇒ 0079
/// applied), but a TEXT read is still tried (first, mirroring
/// [`op_created_at_rfc3339`]) so the helper is robust to either column era.
/// sqlx's `try_get` type-checks the stored value, so each read either
/// matches its era exactly or fails cleanly — an `i64` read of a TEXT value
/// errors (`ColumnDecode` mismatch) rather than coercing through the value's
/// leading integer, and vice versa. `fallback_ms` (boot-time `now_ms()`) is
/// used only if neither read succeeds — it never should for a well-formed
/// op row.
pub(crate) fn op_created_at_ms(row: &sqlx::sqlite::SqliteRow, fallback_ms: i64) -> i64 {
    if let Ok(s) = row.try_get::<String, _>("created_at") {
        // Defensive: a TEXT column holding an all-digit ms value.
        if let Ok(ms) = s.parse::<i64>() {
            return ms;
        }
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&s) {
            return dt.timestamp_millis();
        }
    }
    if let Ok(ms) = row.try_get::<i64, _>("created_at") {
        return ms;
    }
    fallback_ms
}

/// #2504: count the per-space Loro engine snapshots persisted in
/// `loro_doc_state`. Returns `0` when the table is absent (an ancient pre-0052
/// database) or empty.
///
/// This is the signal the op-log rebuild ([`recover_blocks_from_op_log`]) uses
/// to decide whether it is about to silently drop remote-authored content. The
/// op_log is strictly device-local (remote ops never land in it post-#490-M1),
/// so a full-log replay reconstructs **only** locally-authored blocks. A
/// non-empty `loro_doc_state` means the device has synced: the engine holds the
/// complete convergent state — including every remote-authored block, property,
/// and tag — that this rebuild cannot see. The count is emitted as a loud log so
/// the disaster is not silent (issue #2504; the engine-first reprojection that
/// would actually recover that content is a separate rework — see #2503).
async fn persisted_engine_snapshot_count(
    executor: &mut sqlx::SqliteConnection,
) -> Result<i64, agaric_core::error::AppError> {
    let table_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'loro_doc_state'",
    )
    .fetch_one(&mut *executor)
    .await?;
    let table_exists = table_exists > 0;

    if !table_exists {
        return Ok(0);
    }

    // Only rows carrying an actual snapshot blob represent recoverable engine
    // state; a NULL/empty snapshot column holds no droppable content.
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM loro_doc_state \
         WHERE snapshot IS NOT NULL AND LENGTH(snapshot) > 0",
    )
    .fetch_one(&mut *executor)
    .await?;

    Ok(count)
}

/// #2504: engine-first disaster rebuild of the SQL primary state.
///
/// [`recover_blocks_from_op_log`] rebuilds `blocks` by replaying the strictly
/// device-local op_log (post-#490-M1 remote ops never land in it), so on a
/// device that has ever synced it reconstructs **only locally-authored content**
/// and silently drops every remote-authored block, property, and tag. The
/// complete convergent state lives instead in the per-space Loro engine
/// snapshots (`loro_doc_state`, persisted every 60s-if-dirty + at shutdown).
/// This function reprojects the SQL primary state — `blocks`, `block_properties`,
/// `block_tags`, and `blocks.deleted_at` — directly from those engines, so
/// remote-authored content survives the rebuild.
///
/// It reuses the SAME projection helpers the live inbound-sync path
/// (`sync_protocol::loro_sync::import_and_project`) runs — a throwaway
/// [`agaric_engine::loro::engine::LoroEngine`] per space imports the persisted snapshot,
/// its full live tree is enumerated parent-before-child, and each block is
/// projected through Pass A (core columns + properties), Pass B (tags), Pass C
/// (soft-delete) exactly as a sync pull would. The engine is the source of
/// truth, so this is the canonical Loro→SQL projection, not a recovery-only
/// reimplementation.
///
/// ## Ordering / fallback contract
///
/// Runs AFTER migrations (the projection helpers need the full post-migration
/// schema and `property_definitions`) and AFTER the op-log derived recovery
/// ([`recover_derived_state_from_op_log`]), gated by the caller on
/// `blocks_recovered`. Ordering rationale:
///
/// * The op-log derived pass runs first and restores device-local
///   properties/tags into the empty derived tables.
/// * This engine pass then runs authoritatively: `project_block_full_to_sql`
///   upserts every engine block (adding remote-authored blocks the op-log pass
///   never saw), and the property/tag reprojections DELETE-then-reinsert per
///   block, so the engine's complete set (local + remote) overwrites the op-log
///   pass's local-only rows. Attachments are untouched.
/// * #3268: [`recover_attachments_from_op_log`] runs AFTER this pass, not
///   before. `attachments` is NOT modelled in the Loro engine, so this pass
///   cannot restore (or repair) it — but its rows are FK-guarded on the owning
///   block, and a peer-authored owning block exists only once THIS pass has
///   reprojected it. Replaying the attachment arms before this pass silently
///   drops every attachment on a peer-authored block, permanently.
///
/// Returns `Ok(true)` iff at least one engine snapshot was reprojected. Returns
/// `Ok(false)` when `loro_doc_state` is absent/empty (a device that never
/// synced — local content is already complete via the op-log pass) or when every
/// snapshot failed to decode (the op-log pass's local content stands, and
/// [`recover_blocks_from_op_log`] has already logged the remote-content-missing
/// hazard).
///
/// Local ops authored AFTER the last engine snapshot (the ≤60s snapshot lag) are
/// not in these snapshots; they are replayed on top from the op_log tail by the
/// always-on boot replay (`recovery::replay::replay_unmaterialized_ops`), so no
/// op-log tail replay is needed here.
///
/// ## Derived caches
///
/// After the primary passes commit, the visibility-critical derived caches
/// (`blocks.page_id`, the `fts_blocks` search index, and the tag-inheritance
/// cache) are rebuilt full-table so the restored remote content is actually
/// visible to page-scoped reads / search / tag filters — the live inbound-sync
/// path rebuilds these via its post-projection materializer fan-out, which is
/// unreachable at `init_pools` time (the materializer does not exist yet). See
/// the rebuild block at the end of the function body for the rationale.
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
pub(crate) async fn reproject_blocks_from_engine(
    pool: &SqlitePool,
) -> Result<bool, agaric_core::error::AppError> {
    use agaric_engine::loro::projection::{
        project_block_full_to_sql, reproject_block_deleted_at_from_engine,
        reproject_block_properties_from_engine, reproject_block_tags_from_engine,
    };
    // #2920: `tx.begin()` on the shared transaction opens a nested SAVEPOINT so a
    // per-block projection failure rolls back only that block, not the whole
    // recovery. Requires the `Acquire` trait in scope.
    use sqlx::Acquire;

    // `loro_doc_state` may be absent on an ancient pre-0052 database.
    let table_exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'loro_doc_state'",
    )
    .fetch_one(pool)
    .await?;
    if table_exists == 0 {
        return Ok(false);
    }

    // Every space that carries a real (non-empty) engine snapshot. A NULL/empty
    // snapshot column holds no recoverable state.
    let snapshots: Vec<(String, Vec<u8>)> = sqlx::query_as(
        "SELECT space_id, snapshot FROM loro_doc_state \
         WHERE snapshot IS NOT NULL AND LENGTH(snapshot) > 0 \
         ORDER BY space_id",
    )
    .fetch_all(pool)
    .await?;
    if snapshots.is_empty() {
        return Ok(false);
    }

    // `property_definitions` drives typed-column routing for non-reserved
    // properties. Load ONCE for the whole rebuild (hoisted out of the per-block
    // loop), mirroring the live inbound-sync path. This is the identical query
    // `import_and_project` runs, so it is already in the offline `.sqlx` cache.
    let value_types: std::collections::HashMap<String, String> =
        sqlx::query!("SELECT key, value_type FROM property_definitions")
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|r| (r.key, r.value_type))
            .collect();

    let mut tx = pool.begin().await?;
    let mut spaces_reprojected = 0usize;
    let mut blocks_reprojected = 0usize;
    // #2920: per-space AND per-block failures are NON-FATAL. Every space shares
    // this ONE transaction (committed by the boot path), so a single
    // un-readable / un-projectable block must NOT `?`-abort the whole rebuild
    // and roll back the spaces and blocks that projected cleanly. Track what was
    // skipped so the retry marker can be armed below (and so a next boot
    // re-attempts) instead of the recovery being silently, permanently lost.
    let mut skipped_spaces = 0usize;
    let mut skipped_blocks_total = 0usize;

    for (space_id_str, bytes) in &snapshots {
        // Build a throwaway engine and load this space's persisted snapshot. A
        // decode failure is non-fatal: skip this space (its local content still
        // stands from the op-log pass) and keep rebuilding the rest.
        let mut engine = agaric_engine::loro::engine::LoroEngine::new();
        if let Err(e) = engine.import(bytes) {
            tracing::error!(
                space_id = %space_id_str,
                error = %e,
                "recovery (#2504): failed to load persisted Loro snapshot — remote-authored \
                 content for this space cannot be reprojected and will be missing until re-sync"
            );
            skipped_spaces += 1;
            continue;
        }

        let space_id = agaric_store::space::SpaceId::from_trusted(space_id_str);
        // Full live tree, parent-before-child (soft-deleted nodes are included,
        // so Pass C can re-stamp their tombstones). Hard-purged blocks are gone
        // from the engine index already, so there is nothing to sweep here.
        let block_ids = engine.live_blocks_preorder();
        if block_ids.is_empty() {
            spaces_reprojected += 1;
            continue;
        }
        let n = block_ids.len();
        // Per-block skip flags for THIS space. A block flagged here is excluded
        // from every later pass, so a failure in one pass can't cascade into a
        // hard error in the next (e.g. a tag edge onto a block whose core row
        // never landed).
        let mut skipped = vec![false; n];

        // Engine core read: fast O(N) bulk path, with a per-block fallback
        // (#2920). If the bulk read fails because ONE block's engine metadata is
        // corrupt, re-read block-by-block so only the bad block(s) are skipped
        // instead of aborting the entire space.
        let id_refs: Vec<&str> = block_ids
            .iter()
            .map(agaric_core::ulid::BlockId::as_str)
            .collect();
        let core = match engine.read_blocks_bulk(&id_refs) {
            Ok(core) => core,
            Err(e) => {
                tracing::warn!(
                    space_id = %space_id_str,
                    error = %e,
                    "recovery (#2920): bulk engine core-read failed; falling back to per-block \
                     reads to isolate the corrupt block(s)"
                );
                let mut v = Vec::with_capacity(n);
                for (i, block_id) in block_ids.iter().enumerate() {
                    match engine.read_block(block_id.as_str()) {
                        Ok(snap) => v.push(snap),
                        Err(e) => {
                            tracing::error!(
                                space_id = %space_id_str,
                                block_id = %block_id.as_str(),
                                error = %e,
                                "recovery (#2920): engine core-read failed for block; skipping it \
                                 (remote content for this block missing until re-sync)"
                            );
                            skipped[i] = true;
                            v.push(None);
                        }
                    }
                }
                v
            }
        };

        // Per-block engine state reads (properties / tags / deleted_at), each
        // non-fatal (#2920). Aligned with `block_ids` by index; a skipped block
        // holds `None`.
        let mut states = Vec::with_capacity(n);
        for (i, block_id) in block_ids.iter().enumerate() {
            if skipped[i] {
                states.push(None);
                continue;
            }
            let props = match engine.read_all_properties_typed(block_id.as_str()) {
                Ok(p) => p,
                Err(e) => {
                    tracing::error!(
                        space_id = %space_id_str, block_id = %block_id.as_str(), error = %e,
                        "recovery (#2920): engine property-read failed for block; skipping it"
                    );
                    skipped[i] = true;
                    states.push(None);
                    continue;
                }
            };
            let tags = match engine.read_tags(block_id.as_str()) {
                Ok(t) => t,
                Err(e) => {
                    tracing::error!(
                        space_id = %space_id_str, block_id = %block_id.as_str(), error = %e,
                        "recovery (#2920): engine tag-read failed for block; skipping it"
                    );
                    skipped[i] = true;
                    states.push(None);
                    continue;
                }
            };
            let deleted_at = match engine.read_deleted_at(block_id.as_str()) {
                Ok(d) => d,
                Err(e) => {
                    tracing::error!(
                        space_id = %space_id_str, block_id = %block_id.as_str(), error = %e,
                        "recovery (#2920): engine deleted_at-read failed for block; skipping it"
                    );
                    skipped[i] = true;
                    states.push(None);
                    continue;
                }
            };
            states.push(Some((props, tags, deleted_at)));
        }

        // Pass A — core columns + properties. FIRST upsert EVERY (non-skipped)
        // block's core row (incl. tag blocks) so all `blocks` rows a later
        // `block_tags.tag_id` FK references exist before Pass B/C. Each block
        // runs under its OWN savepoint (#2920): a failing INSERT (e.g. an
        // unrecognised `block_type` the local schema's CHECK rejects) rolls back
        // only that block and flags it skipped, leaving the shared tx intact so
        // the remaining blocks and spaces still commit.
        for (i, (block_id, snapshot)) in block_ids.iter().zip(&core).enumerate() {
            if skipped[i] {
                continue;
            }
            let mut sp = tx.begin().await?;
            match project_block_full_to_sql(&mut sp, &space_id, block_id, snapshot.as_ref()).await {
                Ok(()) => {
                    sp.commit().await?;
                }
                Err(e) => {
                    sp.rollback().await?;
                    tracing::error!(
                        space_id = %space_id_str,
                        block_id = %block_id.as_str(),
                        error = %e,
                        "recovery (#2920): SQL core-projection failed for block; skipping it and \
                         continuing (other blocks and spaces still commit)"
                    );
                    skipped[i] = true;
                }
            }
        }

        // Pass B/C/D — properties, then tags (FK-ordered after every Pass A core
        // row exists), then soft-delete state. Grouped per block under one
        // savepoint (#2920): all Pass A rows are already present, so the
        // intra-block grouping preserves the cross-block FK ordering while still
        // isolating a per-block failure.
        for (i, block_id) in block_ids.iter().enumerate() {
            if skipped[i] {
                continue;
            }
            let Some((props, tags, deleted_at)) = states[i].as_ref() else {
                continue;
            };
            let mut sp = tx.begin().await?;
            let res = async {
                reproject_block_properties_from_engine(&mut sp, block_id, props, &value_types)
                    .await?;
                reproject_block_tags_from_engine(&mut sp, block_id, tags).await?;
                reproject_block_deleted_at_from_engine(&mut sp, block_id, deleted_at.as_deref())
                    .await?;
                Ok::<(), agaric_core::error::AppError>(())
            }
            .await;
            match res {
                Ok(()) => {
                    sp.commit().await?;
                }
                Err(e) => {
                    sp.rollback().await?;
                    tracing::error!(
                        space_id = %space_id_str,
                        block_id = %block_id.as_str(),
                        error = %e,
                        "recovery (#2920): SQL derived-projection failed for block; skipping it \
                         and continuing"
                    );
                    skipped[i] = true;
                }
            }
        }

        let space_skipped = skipped.iter().filter(|&&s| s).count();
        skipped_blocks_total += space_skipped;
        spaces_reprojected += 1;
        blocks_reprojected += n - space_skipped;
    }

    let anything_skipped = skipped_spaces > 0 || skipped_blocks_total > 0;

    if spaces_reprojected == 0 {
        // Every snapshot failed to DECODE — nothing rebuilt. Roll back the
        // (empty) tx and let the op-log pass's local content stand. Arm the
        // engine-reproject retry marker (#2920) so a subsequent boot re-attempts
        // instead of the blocks-table-present gate silently skipping recovery
        // forever (the decode may succeed on a later boot, e.g. after a re-sync).
        tx.rollback().await?;
        set_engine_reproject_pending(pool, true).await?;
        tracing::error!(
            skipped_spaces,
            "recovery (#2920): every engine snapshot failed to decode — SQL primary state NOT \
             rebuilt from the engine; retry marker armed for the next boot"
        );
        return Ok(false);
    }

    // #2920: arm-or-clear the engine-reproject retry marker ATOMICALLY with the
    // reprojected content. If any space or block was skipped the reprojection is
    // INCOMPLETE, so leave the marker SET — the boot path re-attempts whenever it
    // is present, even though `blocks` is present again on the next boot (the
    // this-boot-only `blocks_recovered` gate would otherwise never re-fire,
    // permanently and silently losing the skipped remote content). Only a
    // fully-clean reprojection clears it.
    set_engine_reproject_pending(&mut *tx, anything_skipped).await?;

    tx.commit().await?;

    // #2504: the passes above restore the PRIMARY state (blocks / properties /
    // tags / deleted_at) for the remote-authored content, but NOT the derived
    // caches the live inbound-sync path rebuilds via its post-projection fan-out
    // (`Materializer::enqueue_inbound_sync_rebuilds`). That fan-out is
    // unreachable here — this runs inside `init_pools`, BEFORE the materializer
    // exists. Without it the freshly-restored remote blocks land with NULL
    // `page_id` (invisible to every `WHERE page_id = ?` page-scoped read), no
    // `fts_blocks` row (unsearchable), and no inherited-tag rows (missing from
    // tag-filtered reads) — recovered-but-invisible until an unrelated full
    // cache rebuild happens to run.
    //
    // The boot fan-out (`spawn_boot_maintenance`) enqueues an unconditional
    // full-table `RebuildPageIds`, but only rebuilds FTS when `fts_blocks` is
    // EMPTY (a stale-but-non-empty index after a partial corruption never
    // triggers it) and never rebuilds tag-inheritance unconditionally. So we
    // cannot rely on it to cover the reprojected content. Rebuild the
    // visibility-critical derived caches synchronously and deterministically
    // here instead (the disaster path is rare, so the one-shot full rebuild
    // cost is acceptable — and correctness/visibility beats deferral).
    //
    // Order: `page_id` first — the FTS and tag-inheritance rebuilds are
    // independent of it, but `page_id` is the foundation other `page_id`-scoped
    // caches (rebuilt by the boot fan-out) consume, and rebuilding it here
    // closes the NULL-`page_id` window without waiting for the background task.
    // All three are full-table, idempotent, and pool-only (no engine / space
    // bootstrap dependency), so they are safe to run at init. Best-effort:
    // a rebuild failure must NOT wedge boot — the primary content is already
    // durably committed above, every read path degrades gracefully on a stale
    // cache, and the boot fan-out + next-op incremental updates are a backstop.
    if let Err(e) = agaric_store::cache::rebuild_page_ids(pool).await {
        tracing::warn!(error = %e, "recovery (#2504): page_id rebuild after engine reproject failed (non-fatal; boot fan-out retries)");
    }
    if let Err(e) = agaric_store::fts::rebuild_fts_index(pool).await {
        tracing::warn!(error = %e, "recovery (#2504): FTS rebuild after engine reproject failed (non-fatal; reprojected content unsearchable until next rebuild)");
    }
    if let Err(e) = agaric_store::tag_inheritance::rebuild_all(pool).await {
        tracing::warn!(error = %e, "recovery (#2504): tag-inheritance rebuild after engine reproject failed (non-fatal; inherited-tag reads stale until next rebuild)");
    }

    if anything_skipped {
        // #2920: partial recovery. Good content is durably committed above, but
        // some spaces/blocks were skipped — the retry marker is armed so the
        // next boot re-attempts. Log a greppable summary of what was lost this
        // boot at error severity so the partial recovery is observable.
        tracing::error!(
            spaces_reprojected,
            blocks_reprojected,
            skipped_spaces,
            skipped_blocks = skipped_blocks_total,
            "recovery (#2920): engine reprojection committed the good content but SKIPPED some \
             spaces/blocks — reprojection INCOMPLETE; retry marker armed so the next boot \
             re-attempts (remote content for the skipped spaces/blocks is missing until then)"
        );
    } else {
        tracing::warn!(
            spaces_reprojected,
            blocks_reprojected,
            "recovery (#2504): rebuilt SQL primary state from the Loro engine snapshots — \
             remote-authored content restored (engine-first disaster recovery)"
        );
    }
    Ok(true)
}

/// #3269 R5 / #3268: what one [`recover_blocks_from_op_log`] pass observed.
///
/// The replay accumulates rather than logs, because
/// [`ensure_blocks_table_exists`] may run it twice (constrained head table,
/// then the scaffold fallback) and only the attempt that COMMITS describes what
/// the vault actually ended up with. [`ReplayDiagnostics::emit`] is called once,
/// by that attempt.
#[derive(Default, Debug)]
struct ReplayDiagnostics {
    /// `op_log` itself is absent (ancient database) — nothing could be replayed.
    op_log_missing: bool,
    /// Persisted per-space Loro snapshots in `loro_doc_state`. Non-zero means
    /// this device has synced and the op-log-only rebuild is dropping every
    /// remote-authored block (#2504).
    engine_snapshots: i64,
    /// Ops actually read and replayed.
    ops_replayed: usize,
    /// `create_block` ops whose `INSERT OR IGNORE` matched an id ALREADY in the
    /// table — the op_log carried two creates for one id, i.e. log corruption.
    duplicate_creates: Vec<String>,
    /// #3269 R4: `create_block` ops whose `INSERT OR IGNORE` inserted nothing
    /// and whose id is NOT in the table — the row was refused by a table
    /// CONSTRAINT (the head shape's `block_type_valid` / `page_id_self_for_pages`
    /// CHECK constraints, or STRICT typing), not by an id collision. A DIFFERENT event from
    /// a duplicate create, and the pre-#3269 code could not tell them apart:
    /// both landed in the duplicate warning, which would have told a
    /// post-mortem reader that a perfectly healthy op_log was corrupt — on the
    /// one path where the op_log is the only forensic artefact left.
    constraint_rejected_creates: Vec<String>,
    /// #4187: ids of blocks a replayed `move_block` parked LIVE under a
    /// TOMBSTONED ancestor and which this pass swept into that ancestor's
    /// trash cohort — the recovery-side mirror of the materializer's
    /// `sweep_move_under_tombstoned_ancestor` (#4112). One entry per swept
    /// move op, not per block: a block can appear twice only if something
    /// made it LIVE again between the two moves (a `restore_block` op
    /// carrying its cohort token), because the sweep's own live-subject
    /// guard suppresses it on a block a previous sweep already tombstoned.
    move_swept_under_tombstone: Vec<String>,
    /// #4204/#4188: ids of blocks a replayed `move_block` carried out of a
    /// deletion cohort they had only INHERITED, and whose inherited `deleted_at`
    /// this pass therefore cleared so the sweep could re-derive it from the new
    /// position. The recovery-side mirror of the materializer's
    /// `unsweep_inherited_cohort_after_move`.
    ///
    /// An entry does NOT mean the block ended up live: when the new position
    /// has a tombstoned ancestor of its own, the sweep re-stamps it at that
    /// ancestor's cohort in the same op (#4188's shape) and the block appears
    /// in `move_swept_under_tombstone` too. Only an entry here WITHOUT a
    /// matching sweep is a block that came back (#4204's shape).
    move_unswept_inherited_cohort: Vec<String>,
    /// #4232: recursive cascades that stopped at [`DESCENDANT_DEPTH_CAP`] with
    /// tree still beyond it. One entry per truncated walk, naming WHICH walk
    /// and at what depth.
    cascade_truncations: Vec<CascadeTruncation>,
    /// #4287: the heads of the subtrees a truncated `purge_block` cascade could
    /// not reach, which the replay finished purging instead of leaving for the
    /// orphan cleanup to adopt as live top-level blocks. One entry per
    /// re-anchored FRONTIER child (a row at `DESCENDANT_DEPTH_CAP + 1` relative
    /// to its own step's seed), not per removed block — see
    /// [`purge_truncated_tails`] for why the tail cannot simply be NULLed.
    ///
    /// Only heads whose step actually removed rows appear. A diagnostic that
    /// also named the seeds it skipped would send a post-mortem reader after
    /// ids that are still alive in the vault.
    purge_tails_finished: Vec<String>,
    /// #4287: how many rows those follow-up cascades removed, i.e. the size of
    /// the hard-purged content that would otherwise have been resurrected. The
    /// count and the seed list say different things (a single unreachable
    /// frontier child can carry an arbitrarily large subtree) and a post-mortem
    /// reader needs both.
    purge_tail_rows_removed: u64,
}

/// #4232: one recursive walk in this replay that hit the depth cap with more
/// tree beyond it — i.e. answered from an INCOMPLETE view of the tree.
///
/// STRUCTURAL, not semantic. An entry means "this walk was cut off", never
/// "the cut changed the answer" — the two probes below cannot tell those apart
/// without the unbounded walk this replay deliberately does not have (see
/// [`materialize_cascade_cohort`] for the two shapes that report despite a
/// provably correct result). Read an entry as "verify this subtree", not as
/// "this subtree is wrong".
///
/// The engine's R27 walks (`collect_subtree_ids_unbounded`,
/// `nearest_tombstoned_ancestor`) re-anchor past the cap and warn when they
/// cross it. This replay's cascades cannot: they run before `sqlx::migrate!`,
/// at whatever era `max_applied_migration` names, and the batched re-anchoring
/// walk is written against the head shape. Truncating is therefore the
/// behaviour that stays; being unable to TELL is not. A merged sync tree may
/// legally be deeper than any locally-enforced bound — no single device's
/// create-path guard constrains what a merge produces — so a rebuild of such a
/// vault stamps a partial cohort, and the rebuilt `blocks` silently disagrees
/// with the live one on the one code path whose whole job is to be trustworthy
/// once everything else has failed. Reported, not logged, for the same #3269 R5
/// reason as every other entry here: the replay may run twice.
///
/// # No per-entry depth (#4289)
///
/// There is deliberately no `depth` field. The depth a walk stops at is
/// [`DESCENDANT_DEPTH_CAP`] for EVERY entry — invariant by construction, not
/// merely constant in practice: the cap is the same literal in BOTH recursive
/// arms [`materialize_cascade_cohort`] can run, so two entries in the same report
/// cannot differ in it and a comparison between them could only ever be
/// trivially true. The number is still named rather than implied — once, by
/// [`ReplayDiagnostics::emit`]'s `depth_cap` field and message body, instead of
/// being copied into every record.
#[derive(Debug, PartialEq, Eq)]
struct CascadeTruncation {
    /// Which walk was cut off — one of the `CASCADE_*` names below. A report
    /// that said only "something truncated" would leave a post-mortem reader
    /// unable to tell an incomplete delete cohort (rows that should be in the
    /// trash and are not) from an incomplete purge (rows the user destroyed
    /// that are still there).
    cascade: &'static str,
    /// The op's subject block: the seed the truncated walk started from.
    block_id: String,
}

/// The `move_block` arm's upward probe for the nearest tombstoned ancestor.
/// Truncation here means the sweep may have found NO tombstone where one
/// exists further up, so a live block was left parked under a trashed ancestor.
const CASCADE_MOVE_SWEEP_ANCESTOR_PROBE: &str = "move_block ancestor probe";
/// The `move_block` arm's downward sweep into the ancestor's deletion cohort
/// (#4187). Truncation leaves the deep tail of the moved subtree live.
const CASCADE_MOVE_SWEEP: &str = "move_block sweep cascade";
/// The `move_block` arm's downward un-sweep, clearing an INHERITED cohort the
/// reparent invalidated (#4204/#4188). Truncation leaves the deep tail of the
/// moved subtree stamped at the OLD cohort — split from the head it moved with,
/// and therefore unrestorable as one unit.
const CASCADE_MOVE_UNSWEEP: &str = "move_block un-sweep cascade";
/// The `delete_block` arm's soft-delete cascade (#429). Truncation leaves the
/// deep tail live under a tombstoned ancestor.
const CASCADE_DELETE: &str = "delete_block cascade";
/// The `restore_block` arm's cohort un-delete (#613). Truncation leaves the
/// deep tail tombstoned after a restore that should have raised it.
const CASCADE_RESTORE: &str = "restore_block cascade";
/// The `purge_block` arm's hard-delete cascade (#615). Truncation leaves the
/// deep tail of user-destroyed data in the table, which the orphan cleanup
/// after the replay loop then PROMOTES to live top-level blocks.
const CASCADE_PURGE: &str = "purge_block cascade";

impl ReplayDiagnostics {
    /// Emit everything this pass observed, exactly once.
    #[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
    fn emit(&self) {
        if self.op_log_missing {
            tracing::warn!("op_log table missing — cannot recover blocks data");
            return;
        }

        // #2504: loudly surface the device-local-only limitation of this
        // rebuild. The op-log replay reconstructs only locally-authored content
        // (and, post-#3268, only ops this device authored). If the device has
        // synced, the per-space Loro engine snapshots in `loro_doc_state` hold
        // the complete convergent state — including remote-authored content
        // this replay cannot see — and it is about to be dropped. This is a
        // disaster-path last resort; it must not fail silently.
        if self.engine_snapshots > 0 {
            tracing::error!(
                engine_snapshots = self.engine_snapshots,
                "DISASTER RECOVERY DATA LOSS (#2504): rebuilding `blocks` from the device-local \
                 op_log only. This device has synced ({} Loro engine snapshot(s) in \
                 `loro_doc_state`), but the op_log holds only locally-authored ops — every \
                 remote-authored block, property, and tag WILL BE MISSING from the rebuilt table. \
                 The complete convergent state survives in `loro_doc_state`; recover it via an \
                 engine-first reprojection or a fresh re-sync from a peer.",
                self.engine_snapshots
            );
        } else {
            tracing::warn!(
                "Recovering `blocks` from the device-local op_log (#2504). No synced Loro engine \
                 state present, so local content is complete; note this replay would omit any \
                 remote-authored content if the device had synced."
            );
        }

        if self.ops_replayed == 0 {
            return;
        }
        tracing::info!(
            "Replayed {} ops into the recovered blocks table",
            self.ops_replayed
        );

        for block_id in &self.duplicate_creates {
            tracing::warn!(
                block_id,
                "duplicate create_block skipped during recovery — \
                 op_log carries two create ops for the same id \
                 (first wins); possible op_log corruption"
            );
        }

        // #3269 R4: report the CHECK-rejected cohort as its own event, and as an
        // aggregate. Silently skipping these rows is defensible — a healthy
        // vault's `blocks` could not hold them either — but misattributing them
        // to op_log corruption is not.
        if !self.constraint_rejected_creates.is_empty() {
            tracing::warn!(
                dropped = self.constraint_rejected_creates.len(),
                block_ids = %self.constraint_rejected_creates.join(","),
                "{} create_block op(s) were REJECTED by the recovered `blocks` table's \
                 constraints and dropped (#3269). These are not duplicate creates: the payloads \
                 describe rows a healthy at-head vault could not hold either (an unknown \
                 `block_type`, a page whose `page_id` is not itself, a STRICT type mismatch). \
                 The surrounding ops still replayed.",
                self.constraint_rejected_creates.len()
            );
        }

        // #4187: a cross-device reconciliation, not a user action — the same
        // reason the materializer's sweep (#4112) and R9's snapshot-import
        // sweep both warn. Reported here rather than logged at the site so the
        // twice-run replay (#3269 R5) cannot double-report it.
        if !self.move_swept_under_tombstone.is_empty() {
            tracing::warn!(
                swept = self.move_swept_under_tombstone.len(),
                block_ids = %self.move_swept_under_tombstone.join(","),
                "{} replayed move_block op(s) landed a LIVE block under a TOMBSTONED ancestor \
                 (the concurrent delete-vs-move merge) and were swept into that ancestor's \
                 deletion cohort (#4187), which is what the live materializer's \
                 `sweep_move_under_tombstoned_ancestor` (#4112) produces for the same op set. \
                 Leaving them live would have rebuilt an invisible orphan: absent from the tree \
                 (its ancestor is trashed) and absent from the trash (it is not).",
                self.move_swept_under_tombstone.len()
            );
        }

        // #4204/#4188: the sweep's mirror image, and reported separately
        // because it is the louder of the two — a block whose new position has
        // no tombstoned ancestor comes BACK, visible again on a device where
        // the user had watched it go into the trash with its old parent. Same
        // twice-run-replay reason as every other entry: reported, not logged at
        // the site.
        if !self.move_unswept_inherited_cohort.is_empty() {
            tracing::warn!(
                unswept = self.move_unswept_inherited_cohort.len(),
                block_ids = %self.move_unswept_inherited_cohort.join(","),
                "{} replayed move_block op(s) carried a subtree OUT of a deletion cohort it had \
                 only INHERITED, so the inherited `deleted_at` was cleared and re-derived from \
                 the new position (#4204/#4188) — matching what the live materializer's \
                 `unsweep_inherited_cohort_after_move` produces for the same op set. A block \
                 also listed as swept was re-stamped into its new ancestor's cohort; one listed \
                 ONLY here is live again, which is the converged answer for a delete of a \
                 parent racing a move out onto a live one.",
                self.move_unswept_inherited_cohort.len()
            );
        }

        // #4232: a walk that ran out of rope answered from a PARTIAL view of
        // the tree, so the rebuilt table may be wrong and no longer merely
        // noisy — hence an error, alongside the #2504 data-loss report, rather
        // than a warning. Before this the failure was indistinguishable from
        // success, which is the worst property a recovery path can have.
        //
        // The message states what the probe actually establishes and no more.
        // The probe is STRUCTURAL (see `materialize_cascade_cohort`): it
        // proves the walk was cut off, NOT that the cut changed the answer, and
        // there are two shapes where the cut is provably harmless. Asserting
        // "the rebuilt table holds a truncated cohort" would therefore be false
        // on a correct rebuild, and telling an operator to distrust a correct
        // rebuild — on the disaster path, where the rebuild may be all they
        // have — is its own kind of wrong answer.
        //
        // The site list rides ONLY in the `sites` field, matching
        // `constraint_rejected_creates` / `move_swept_under_tombstone` above:
        // interpolating it into the message body too would carry the payload
        // twice in one record. Unlike those two it is also HEAD-BOUNDED (#4289,
        // see `format_truncation_sites`) — this vector grows per truncated OP,
        // and its documented high-frequency benign trigger floods exactly the
        // deep merged vault the record exists for.
        if !self.cascade_truncations.is_empty() {
            let sites = format_truncation_sites(&self.cascade_truncations);
            // Level is chosen by what actually truncated, not by the topic.
            // The ancestor probe's false positive is the DOCUMENTED
            // high-frequency one — on a merged tree deeper than the cap with
            // no tombstone anywhere, every `move_block` under that chain
            // reports, against a provably correct rebuild
            // (`recover_move_ancestor_probe_reports_a_deep_live_chain_with_no_tombstone`
            // pins exactly that). Logging ERROR for the common benign case is
            // how a disaster-path signal gets tuned out, so a report made up
            // ONLY of ancestor probes warns; anything touching a descendant
            // cascade — where a cut walk more often did change the rebuilt
            // rows — keeps ERROR.
            let only_ancestor_probes = self
                .cascade_truncations
                .iter()
                .all(|t| t.cascade == CASCADE_MOVE_SWEEP_ANCESTOR_PROBE);
            macro_rules! emit_truncation {
                ($level:ident) => {
                    tracing::$level!(
                        truncated = self.cascade_truncations.len(),
                        depth_cap = DESCENDANT_DEPTH_CAP,
                        sites = %sites,
                        only_ancestor_probes = only_ancestor_probes,
                        "INCOMPLETE RECOVERY CASCADE (#4232): {} recursive walk(s) stopped at the \
                         depth-{} runaway cap with tree still beyond it, so each answered from a \
                         PARTIAL view; `sites` names which walk, on which seed. A merged sync tree can \
                         legally be deeper than any locally-enforced bound, so this is reachable on a \
                         healthy vault. Where the cut mattered, the rebuilt `blocks` table disagrees \
                         with the live one below that depth: deep descendants left live under a \
                         tombstoned ancestor (delete / move sweep), left tombstoned after a restore, \
                         or a move sweep that never fired at all because the ancestor probe could not \
                         see the tombstone above the cap. The purge arm is the exception: its \
                         unreached tail is re-anchored and finished off before the orphan cleanup \
                         (#4287), so a truncated purge no longer resurrects user-destroyed data — see \
                         the `purge_tail_rows_removed` report. The probe is structural: it proves the \
                         walk was cut off, not that the \
                         cut changed the answer — a deep tail that was already tombstoned, outside the \
                         restored cohort, or under no tombstoned ancestor at all reports here despite \
                         a correct rebuild. Verify the named subtrees against a peer or \
                         `loro_doc_state` before trusting this rebuild below the cap.",
                        self.cascade_truncations.len(),
                        DESCENDANT_DEPTH_CAP
                    );
                };
            }
            if only_ancestor_probes {
                emit_truncation!(warn);
            } else {
                emit_truncation!(error);
            }
        }

        // #4287: the repair, reported separately from the truncation that
        // caused it. A truncated purge used to end with its unreached tail
        // adopted by the orphan cleanup as a live, FTS-indexed top-level block
        // — hard-purged content the user could neither find in the outline nor
        // re-delete from the trash. It is now finished off instead, and a
        // post-mortem reader is told how much went, because "recovery deleted
        // rows nothing in the op_log names" must never be silent even when it
        // is the correct thing to have done.
        if !self.purge_tails_finished.is_empty() {
            tracing::warn!(
                tails = self.purge_tails_finished.len(),
                rows_removed = self.purge_tail_rows_removed,
                depth_cap = DESCENDANT_DEPTH_CAP,
                block_ids = %bounded_site_list(self.purge_tails_finished.iter().map(String::as_str)),
                "TRUNCATED PURGE FINISHED (#4287): {} subtree head(s) sat one level past the \
                 depth-{} cap of a replayed `purge_block` cascade and survived it with a dangling \
                 `parent_id`. The post-replay orphan cleanup would have adopted them as LIVE \
                 TOP-LEVEL blocks — invisible to every page-scoped read, absent from the trash, and \
                 yet indexed by `rebuild_fts_index`, i.e. hard-purged content back as a searchable \
                 block the user cannot re-delete. The cascade was re-anchored past the cap instead \
                 and removed {} row(s), which is what an unbounded purge would have done.",
                self.purge_tails_finished.len(),
                DESCENDANT_DEPTH_CAP,
                self.purge_tail_rows_removed
            );
        }
    }
}

/// #4289: how many truncation sites the report names before it starts counting
/// instead of listing.
///
/// `cascade_truncations` grows per truncated OP and has a documented
/// high-frequency BENIGN trigger: on a merged tree deeper than the cap with no
/// tombstone anywhere, every `move_block` under that chain reports an ancestor
/// probe truncation, and every one of those reports is correct-but-harmless
/// (`recover_move_ancestor_probe_reports_a_deep_live_chain_with_no_tombstone`
/// pins the case). That is precisely the deep merged vault the record exists
/// for, so the field most likely to matter is the one most likely to be
/// flooded. A head-N list keeps the record readable; the TRUE total is never
/// lost — it rides in the `truncated` field, in the message body, and in this
/// list's own `…and N more` suffix.
const MAX_REPORTED_TRUNCATION_SITES: usize = 20;

/// Render `cascade_truncations` as a bounded `; `-joined site list (#4289).
///
/// Free function rather than a method so the bound itself is unit-testable
/// without capturing a `tracing` subscriber.
fn format_truncation_sites(truncations: &[CascadeTruncation]) -> String {
    bounded_site_list(
        truncations
            .iter()
            .map(|t| format!("{} at `{}`", t.cascade, t.block_id)),
    )
}

/// Join at most [`MAX_REPORTED_TRUNCATION_SITES`] entries with `; `, appending
/// `…and N more` when there were more — so the record stays bounded while still
/// reporting the true total.
fn bounded_site_list<T: std::fmt::Display>(sites: impl IntoIterator<Item = T>) -> String {
    let sites: Vec<String> = sites.into_iter().map(|s| s.to_string()).collect();
    let total = sites.len();
    let mut out = sites
        .iter()
        .take(MAX_REPORTED_TRUNCATION_SITES)
        .cloned()
        .collect::<Vec<_>>()
        .join("; ");
    if total > MAX_REPORTED_TRUNCATION_SITES {
        if !out.is_empty() {
            out.push_str("; ");
        }
        out.push_str(&format!(
            "…and {} more",
            total - MAX_REPORTED_TRUNCATION_SITES
        ));
    }
    out
}

/// #4289: the connection-local scratch table each descendant cascade
/// materialises its ONE depth-capped walk into.
///
/// Deliberately carries NO `PRIMARY KEY`/`UNIQUE` on `id`: the row set must
/// stay identical to what the recursive CTE emitted, duplicates included. A
/// corrupted `parent_id` CYCLE re-emits the same id at every depth up to the
/// cap, and that is exactly what makes the truncation probe below fire on a
/// cycle (see [`materialize_cascade_cohort`]); de-duplicating on insert would
/// keep only the id's shallowest depth and silence that report. The consumers
/// that want a SET (`id IN (SELECT id FROM …)`) de-duplicate themselves, as
/// the CTE-subquery form already did.
const CASCADE_COHORT_DDL: &str = "CREATE TEMP TABLE IF NOT EXISTS recovery_cascade_cohort ( \
     id TEXT NOT NULL, \
     depth INTEGER NOT NULL \
 )";

/// #4233: which children a cascade's walk descends INTO. This is the cascade's
/// REACH, and it is a different question from the outer `WHERE` each caller
/// puts on its own DML — the reach decides which rows are candidates at all,
/// the predicate decides which candidates are written.
#[derive(Clone, Copy)]
enum CascadeReach {
    /// Descend through EVERY child regardless of `deleted_at` — the
    /// [`descendants_cte_standard`](agaric_store::descendants_cte_standard)
    /// shape. The arms whose target rows are THEMSELVES tombstoned need the
    /// descent: `restore_block` and the move un-sweep look for cohort members
    /// below a tombstone, and `purge_block` hard-deletes a trashed subtree.
    Standard,
    /// Descend only through still-active children — the
    /// [`descendants_cte_active`](agaric_store::descendants_cte_active) shape,
    /// and the `DescendantWalkFilter::Active` one the engine's
    /// `project_delete_block_to_sql` walks. The two arms that write LIVE rows,
    /// `delete_block` and the move sweep, stop at a tombstoned child, so a live
    /// block BELOW one keeps its `NULL`.
    ///
    /// WHY the `NULL` matters, stated once for both arms and both their tests:
    /// on the disaster path `reproject_blocks_from_engine` (Pass C) drives every
    /// block through R9's live-under-tombstone sweep. A `NULL` reads there as
    /// `(sql None, ancestor Some)`, so the sweep fires and stamps the NEAREST
    /// tombstoned ancestor's cohort — the converged-tree answer of #4188/#4204,
    /// where `deleted_at` is a function of the tree and not of replay order. A
    /// row this op stamped instead reads as `(sql Some, ancestor Some)`, which
    /// the resurrection guard leaves alone. So the wider `Standard` reach did
    /// not merely over-stamp: it CEMENTED the wrong cohort past the only healer
    /// in the boot path.
    ///
    /// The two arms must also carry the SAME reach as each other. They are the
    /// two replay orders of one op pair — `{Move(B → P), Delete(P)}` lands in
    /// the delete arm, `{Delete(P), Move(B → P)}` in the sweep — so a split
    /// between them is exactly the replay-order divergence #4187 exists to
    /// remove.
    Active,
}

/// #4232/#4289: run the cascades' depth-capped descendant walk ONCE, and answer
/// from it both "which rows does the cascade touch" and "was the walk cut off
/// with tree still beyond it".
///
/// Before #4289 those were two statements: a probe that walked the whole
/// depth-100 subtree for an `EXISTS`, and then the cascade's own DML which
/// walked it again. The two recursive arms were kept byte-identical so they
/// could not answer different questions, but "textually identical" is a
/// property a future edit can break silently. Materialising the walk into
/// [`CASCADE_COHORT_DDL`]'s temp table and reading BOTH answers off those rows
/// makes divergence structurally impossible — and halves the work on every
/// `delete_block` / `restore_block` / `purge_block` / swept `move_block`,
/// including the overwhelming majority of vaults nowhere near the cap.
///
/// Returns whether the walk was TRUNCATED: does a row it reached at exactly
/// the cap still have a child? That child sits at `DESCENDANT_DEPTH_CAP + 1`,
/// i.e. is a descendant the cascade provably did not touch, so the answer is
/// the same as walking one level deeper. Asking it in a follow-up query over
/// the materialised rows — rather than in a second, one-level-deeper recursive
/// arm — is also what keeps the #1655 drift guard
/// (`every_descendants_cte_keeps_depth_cap`, agaric-store) satisfied without
/// loosening it. Since #4233 both walks come from the store's
/// `descendants_cte_*!()` macros, so the literal `d.depth < 100` lives — and is
/// pinned — there rather than here; an interpolated `{cap} + 1` arm written
/// into this file would fail that guard, correctly, since such an arm is by
/// construction not the cascades' walk.
///
/// Era-agnostic by construction, like the cascades' own statements: it reads
/// `id`, `parent_id` and (under [`CascadeReach::Active`]) `deleted_at IS NULL`,
/// binds no timestamp, and all three behave the same in every era this
/// pre-migration pass can run at — the #618 TEXT/INTEGER split is about the
/// STAMP, not about nullness. That is why it does not call
/// `agaric_store::block_descendants::cascade_depth_saturated`, which is
/// additionally deliberately conservative (`>= CAP - 1`, so it fires on a tree
/// sitting exactly AT the cap that was not truncated at all) — a false
/// truncation report on the disaster path is its own kind of silence.
///
/// A corrupted `parent_id` CYCLE saturates any bound and so reports here too.
/// That is correct: the cascade's answer is equally untrustworthy either way,
/// and the cycle is not hypothetical — this replay carries no cycle probe
/// (#2894), so a corrupt op_log can close one.
///
/// # What the truncation flag does NOT establish
///
/// It answers the STRUCTURAL question — "is there tree the walk could not
/// reach" — and not the semantic one, "did not reaching it change the row set
/// the cascade wrote". Those differ because each caller narrows the cohort with
/// its OWN outer predicate, which this flag deliberately does not mirror
/// (mirroring it would still be inexact: the deep tail can be arbitrarily far
/// past `DESCENDANT_DEPTH_CAP + 1`, so only an unbounded walk could decide it).
/// It DOES mirror the `reach`, because that is part of the walk: an `Active`
/// walk stopping at a tombstoned child did not fail to reach anything.
/// Two reachable shapes therefore report a truncation on a rebuild that is
/// byte-identical to the uncapped one:
///
/// * `restore_block`, when the deep tail is not a member of the restored
///   cohort (e.g. a peer created it under the trashed frontier after the
///   delete), so `deleted_at = ?ref` excludes it.
/// * the `move_block` arm's UPWARD probe, on a deep chain carrying no
///   tombstoned ancestor at ANY depth — the sweep was right not to fire.
///
/// This is the accepted trade: a "verify this subtree" false positive on a very
/// deep tree costs a post-mortem read, whereas the false NEGATIVE it replaces
/// is #4232 itself. [`ReplayDiagnostics::emit`] states the distinction in the
/// report rather than letting the reader infer a certainty that is not there.
///
/// `purge_block` is the one arm where the flag is not merely advisory — see
/// [`purge_truncated_tails`] (#4287).
async fn materialize_cascade_cohort(
    executor: &mut sqlx::SqliteConnection,
    seed: &str,
    reach: CascadeReach,
) -> Result<bool, sqlx::Error> {
    // `IF NOT EXISTS`, re-issued on EVERY cascade op rather than once per
    // replay. Hoisting it to the top of `recover_blocks_from_op_log` was
    // considered and not taken: it would make every cascade arm depend on a
    // setup step that runs far away from it, for one no-op DDL round trip on a
    // path that only runs during recovery. The self-contained form is what lets
    // this function be called from any arm — and from a test — with no
    // precondition.
    // dynamic-sql: DDL, which the `query!` family cannot express at all.
    sqlx::query(CASCADE_COHORT_DDL)
        .execute(&mut *executor)
        .await?;
    // dynamic-sql: a TEMP table this module owns; `query!`'s compile-time
    // check has no schema for it.
    sqlx::query("DELETE FROM recovery_cascade_cohort")
        .execute(&mut *executor)
        .await?;
    // dynamic-sql: the cascades' recursive CTE, at the pre-migration era where
    // `query!`'s head-shaped check must not be assumed (same reason as the
    // cascade statements below). Both arms read `id` / `parent_id` /
    // `deleted_at IS NULL` and bind no timestamp, so both stay era-agnostic —
    // the #618 TEXT/INTEGER split is about the STAMP, not the walk.
    // depth<100: DESCENDANT_DEPTH_CAP, see block_descendants
    // #4233: the CTE bodies come from the store's macros rather than being
    // copied, so recovery's reach cannot drift from the shape the engine
    // walks — the parity this function exists to hold is structural, not
    // maintained by review. The macros expand to string literals precisely so
    // a `sqlx::query(…)` site can `concat!()` them (`block_descendants.rs`).
    const STANDARD_WALK: &str = concat!(
        "INSERT INTO recovery_cascade_cohort(id, depth) ",
        agaric_store::descendants_cte_standard!(),
        "SELECT id, depth FROM descendants"
    );
    const ACTIVE_WALK: &str = concat!(
        "INSERT INTO recovery_cascade_cohort(id, depth) ",
        agaric_store::descendants_cte_active!(),
        "SELECT id, depth FROM descendants"
    );
    sqlx::query(match reach {
        CascadeReach::Standard => STANDARD_WALK,
        CascadeReach::Active => ACTIVE_WALK,
    })
    .bind(seed)
    .execute(&mut *executor)
    .await?;
    // dynamic-sql: reads the TEMP table above plus the era-varying `blocks`.
    // The probe mirrors the WALK's own filter: under `Active` a tombstoned
    // frontier child is not tree the walk failed to reach, it is tree the walk
    // would have stopped at anyway.
    const STANDARD_PROBE: &str = "SELECT EXISTS ( \
             SELECT 1 FROM blocks c \
               JOIN recovery_cascade_cohort d ON c.parent_id = d.id \
              WHERE d.depth = 100 \
         )";
    const ACTIVE_PROBE: &str = "SELECT EXISTS ( \
             SELECT 1 FROM blocks c \
               JOIN recovery_cascade_cohort d ON c.parent_id = d.id \
              WHERE c.deleted_at IS NULL AND d.depth = 100 \
         )";
    sqlx::query_scalar::<_, bool>(match reach {
        CascadeReach::Standard => STANDARD_PROBE,
        CascadeReach::Active => ACTIVE_PROBE,
    })
    .fetch_one(executor)
    .await
}

/// #4287: the ids one level past the cap that the walk just materialised could
/// not reach — the frontier rows' children.
///
/// Only meaningful straight after a [`materialize_cascade_cohort`] call that
/// returned `true`, and only BEFORE the cascade's own DML has run (the purge
/// arm deletes the very rows this joins through). Rows that are themselves in
/// the cohort — which a `parent_id` cycle produces — are NOT filtered out here.
/// [`purge_truncated_tails`] absorbs them without a guard of its own: the
/// cascade that named such an id has already deleted it, so re-seeding from it
/// materialises an empty cohort, its step removes no rows, and the
/// `step.rows_removed == 0` skip drops it before it can be recorded as a
/// finished head or contribute successors. (The retired `still_orphaned` guard
/// is what used to do this in the post-loop version — see that function's
/// "Why this runs INSIDE the replay loop" for why it went.)
async fn cascade_cohort_unreached_children(
    executor: &mut sqlx::SqliteConnection,
) -> Result<Vec<String>, sqlx::Error> {
    // dynamic-sql: as `materialize_cascade_cohort` above.
    sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT c.id FROM blocks c \
           JOIN recovery_cascade_cohort d ON c.parent_id = d.id \
          WHERE d.depth = 100",
    )
    .fetch_all(executor)
    .await
}

/// One `purge_block` cascade step: materialise the walk, take the frontier it
/// could not reach, hard-delete the cohort.
///
/// Factored out so the replay arm (#615) and the post-loop finisher
/// ([`purge_truncated_tails`], #4287) drive the SAME `DELETE FROM blocks`
/// statement — one purge cascade in this file, not two that could drift.
struct PurgeCascadeStep {
    /// Did this step's walk stop at the cap with tree still beyond it (#4232)?
    truncated: bool,
    /// The unreached frontier children, if so — the seeds the next step needs.
    unreached: Vec<String>,
    /// Rows this step hard-deleted.
    rows_removed: u64,
}

async fn purge_cascade_step(
    executor: &mut sqlx::SqliteConnection,
    seed: &str,
) -> Result<PurgeCascadeStep, sqlx::Error> {
    let truncated =
        materialize_cascade_cohort(&mut *executor, seed, CascadeReach::Standard).await?;
    // Read the frontier BEFORE the DELETE: afterwards the rows it joins
    // through are gone and the answer would always be empty.
    let unreached = if truncated {
        cascade_cohort_unreached_children(&mut *executor).await?
    } else {
        Vec::new()
    };
    // dynamic-sql: era-varying `blocks` at the pre-migration era, keyed on the
    // TEMP cohort materialised above.
    let rows_removed =
        sqlx::query("DELETE FROM blocks WHERE id IN (SELECT id FROM recovery_cascade_cohort)")
            .execute(&mut *executor)
            .await?
            .rows_affected();
    Ok(PurgeCascadeStep {
        truncated,
        unreached,
        rows_removed,
    })
}

/// What [`purge_truncated_tails`] actually did, as opposed to what it was asked
/// to do. The two differ whenever a seed no longer exists by the time its step
/// runs, and a diagnostic that conflated them would name ids the reader can
/// still find in the vault (#4287 review).
#[derive(Debug, Default, PartialEq, Eq)]
struct PurgeTailRepair {
    /// The frontier heads this REALLY re-anchored from and purged — never a
    /// seed whose step removed nothing.
    heads: Vec<String>,
    /// Rows those follow-up cascades removed. The count and [`Self::heads`] say
    /// different things — a single unreachable frontier child can carry an
    /// arbitrarily large subtree — and a post-mortem reader needs both.
    rows_removed: u64,
}

/// First occurrence wins, order preserved.
///
/// The cohort table keeps duplicate rows by design, so one frontier child can
/// be named more than once by a single walk; re-running a step for an id
/// already purged would be wasted work and, worse, would report the same head
/// twice.
fn dedup_preserving_order(ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    ids.into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

/// #4287: finish the purge the depth cap cut short, instead of letting the
/// orphan cleanup adopt its survivors.
///
/// A `purge_block` whose subtree is deeper than the cap deletes rows 0..=CAP
/// and leaves the row at `CAP + 1` — plus everything under it — in the table,
/// pointing at a parent that no longer exists. `HEAD_BLOCKS_TABLE_DDL` declares
/// `parent_id TEXT REFERENCES blocks(id)` with no `ON DELETE` action, and
/// `rebuild_blocks_table` runs the head-shaped attempt under
/// `PRAGMA defer_foreign_keys = ON`, so that dangling reference does not abort
/// the statement; the blanket orphan cleanup after the replay loop then NULLs
/// it, the deferred check passes at COMMIT, and the surviving tail commits as a
/// LIVE, TOP-LEVEL block. Which is worse than it sounds: `parent_id IS NULL` +
/// `block_type = 'content'` leaves `page_id` NULL, so it is invisible to every
/// page-scoped read AND absent from the trash (`deleted_at IS NULL`) — but
/// `rebuild_fts_index` indexes `WHERE deleted_at IS NULL AND content IS NOT
/// NULL` with no tree filter at all, so hard-purged content comes back as a
/// live, SEARCHABLE block the user can neither find in the outline nor
/// re-delete. Purge is the one operation whose entire contract is that the data
/// is gone.
///
/// So the cleanup must not adopt them. Deleting is what an unbounded cascade
/// would have done — a block whose ancestor was purged follows it — and it is
/// the only outcome that keeps the purge's contract: leaving the dangling
/// `parent_id` in place would instead fail the deferred FK check at COMMIT,
/// dropping the whole head-shaped rebuild into the #3269 scaffold fallback,
/// which has no FK constraints at all and resurrects the tail unconditionally.
///
/// Each step re-anchors `DESCENDANT_DEPTH_CAP` levels further down, so a
/// subtree of any depth is finished in `ceil(depth / CAP)` steps rather than
/// needing the unbounded walk this pre-migration pass deliberately does not
/// have. Termination: a seed that still exists costs at least its own row, and
/// a seed that does not yields an empty cohort and hence no successors, so the
/// row count strictly decreases while `pending` is non-empty. A `parent_id`
/// cycle terminates for the same reason — its members are inside the cohort and
/// are deleted by the step that named them.
///
/// # Why this runs INSIDE the replay loop (#4287 review)
///
/// It must observe the tree as the purge left it, not as the end of the replay
/// left it. Deferring the frontier to a post-loop pass was wrong in BOTH
/// directions, because `create_block` (`INSERT OR IGNORE`, no parent-existence
/// check) and `move_block` (an unconditional `UPDATE`) both accept a
/// `parent_id` that does not exist, so ops replayed after the purge can still
/// restructure the surviving tail:
///
/// * **Over-delete.** A later op parking a live block `X` under the surviving
///   tail made `X` — and its whole subtree — part of the re-anchored cascade,
///   hard-deleting content that was never purged and that an unbounded cascade
///   would have left alone (it would have been orphaned at purge time and then
///   adopted by the cleanup).
/// * **Under-delete.** A later op moving a row OUT of the tail let it escape
///   the cascade entirely, leaving hard-purged content live and FTS-indexed —
///   the exact resurrection this function exists to prevent. Under an unbounded
///   cascade that row was already gone, and the later op would have matched no
///   rows at all.
///
/// Running here, immediately after the arm's own cascade, both holes close by
/// construction: nothing has happened in between. It also retires the
/// `still_orphaned` guard the post-loop version needed — a frontier child at
/// `CAP + 1` is necessarily orphaned the instant the cascade above it commits,
/// so the guard could only ever have been trivially true, or wrongly false
/// after some later op had already corrupted the answer.
///
/// Reports rather than logs, like every other [`ReplayDiagnostics`] entry: the
/// replay may run twice (#3269 R5).
async fn purge_truncated_tails(
    executor: &mut sqlx::SqliteConnection,
    frontier: &[String],
) -> Result<PurgeTailRepair, sqlx::Error> {
    let mut repair = PurgeTailRepair::default();
    let mut pending = dedup_preserving_order(frontier.iter().cloned());
    while !pending.is_empty() {
        let mut next: Vec<String> = Vec::new();
        // One `purge_cascade_step` — four statements — per seed, so a WIDE
        // frontier costs 4xN round trips per level. Batching was considered and
        // deliberately not taken: seeding the cohort from a whole round at once
        // (`SELECT id, 0 FROM blocks WHERE id IN (…)`) would collapse each level
        // to a single step, but it also merges the per-seed answers this loop
        // reads apart — `rows_removed == 0` is what distinguishes a seed that
        // was really purged from one already gone, and `heads` names seeds
        // individually. Recovery replay is rare and runs once per boot at worst,
        // so the clearer per-seed shape wins over the round-trip saving.
        for seed in pending {
            let step = purge_cascade_step(&mut *executor, &seed).await?;
            // A seed that no longer exists yields an empty cohort. Reporting it
            // as "finished" would name an id a post-mortem reader could still
            // find alive, so only seeds this actually purged are recorded.
            if step.rows_removed == 0 {
                continue;
            }
            repair.rows_removed += step.rows_removed;
            repair.heads.push(seed);
            next.extend(step.unreached);
        }
        pending = dedup_preserving_order(next);
    }
    Ok(repair)
}

/// Replay block-level ops from `op_log` into an existing (temporary)
/// `blocks` table.  Called by [`ensure_blocks_table_exists`] inside a
/// transaction so the rebuild is atomic.
///
/// `deleted_at_is_ms` (#618) selects the era-correct encoding the delete arm
/// writes into `deleted_at`: INTEGER epoch-ms once `_sqlx_migrations` shows
/// 0080 applied (nothing converts after 0080 — the 0085/0089 rebuilds copy
/// RAW into a STRICT INTEGER column), rfc3339 TEXT before that (0080's
/// julianday() backfill is the designated converter).
///
/// **Device-local recovery caveat (#2504).** This rebuild replays the op_log,
/// and replays only the LOCALLY-AUTHORED rows in it (#3268: post-#2481-phase-1
/// the log is no longer strictly device-local — the sync puller lands foreign
/// audit records stamped `is_replicated = 1`, which migration 0099 defines as
/// inert for state). On a device that has ever synced it therefore reconstructs
/// **only locally-authored content** and silently omits every remote-authored
/// block, property, and tag. The complete convergent state lives in the
/// per-space Loro engine snapshots (`loro_doc_state`); when those are present
/// the returned diagnostics say loudly that remote content is being dropped
/// (see [`ReplayDiagnostics::emit`]). The complete content is
/// restored by [`reproject_blocks_from_engine`] (the engine-first rebuild, #2504),
/// which the caller runs after migrations; this op-log replay remains the
/// device-local scaffold that gives migration 73's rebuild a target table and
/// the last-resort fallback when the engine snapshots are themselves unreadable.
///
/// **Reports, does not log (#3269 R5).** `ensure_blocks_table_exists` may run
/// this replay twice — once into the constrained head table, once into the
/// scaffold fallback — so logging from in here double-reported the
/// `DISASTER RECOVERY DATA LOSS (#2504)` error and every per-op warning to a
/// post-mortem reader. Everything worth saying is accumulated into
/// [`ReplayDiagnostics`] and emitted by the caller, for the attempt that
/// actually committed.
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
async fn recover_blocks_from_op_log(
    executor: &mut sqlx::SqliteConnection,
    deleted_at_is_ms: bool,
) -> Result<ReplayDiagnostics, agaric_core::error::AppError> {
    // Guard: op_log might not exist on ancient databases.
    // R4 (#347): propagate with `?` — a transient probe failure must not
    // silently skip block recovery.
    let op_log_exists = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'op_log'"
    )
    .fetch_one(&mut *executor)
    .await?
        > 0;

    let mut diagnostics = ReplayDiagnostics::default();

    if !op_log_exists {
        diagnostics.op_log_missing = true;
        return Ok(diagnostics);
    }

    // #2504: the device-local-only limitation of this rebuild. Recorded here,
    // reported by `ReplayDiagnostics::emit` on the attempt that commits.
    // (Engine-first reprojection that would recover the missing remote content
    // is a separate rework: #2503 / #2504.)
    diagnostics.engine_snapshots = persisted_engine_snapshot_count(&mut *executor).await?;

    // C8 (#345): replay in ascending `(created_at, device_id, seq)` order —
    // this function's own deterministic last-writer-wins convention.
    // Replaying in `(device_id, seq)` order alone would let the
    // lexically-largest `device_id` win regardless of wall-clock time;
    // replaying ascending by `created_at` and letting each later write
    // overwrite an earlier one reproduces `created_at DESC` last-writer-wins
    // semantics without a second pass. `created_at` is an indexed
    // INTEGER-ms column post-migration 0079/0080; `(device_id, seq)` is the
    // deterministic tiebreaker for ops sharing a millisecond. (This is NOT
    // the canonical `(created_at, seq, device_id)` order that
    // `agaric_store::op_log::BlockEditScan`, `commands::history`, and every
    // `reverse::*` scan use — a pre-existing divergence, unrelated to and
    // not widened by #4402.)
    // #3268: replay LOCALLY-AUTHORED ops only. Post-#2481-phase-1 the op_log is
    // no longer strictly device-local: the sync puller lands foreign audit
    // records through `dag::insert_replicated_op`, stamped `is_replicated = 1`.
    // Migration 0099 makes the filter the isolation boundary — "Boot replay and
    // the apply-cursor bookkeeping filter on `is_replicated = 0` so a replicated
    // audit row can never be enqueued onto the materializer … that filter is
    // what keeps replicated records provably inert for state" — and every other
    // consumer honours it (`recovery::replay`, all of `reverse::*`). This read
    // did not, so a rebuild replayed a PEER's create/edit/move/delete ops into
    // this device's `blocks`.
    //
    // The column-existence probe is required, not defensive: unlike the derived
    // pass below, this function runs BEFORE `sqlx::migrate!`, at whatever era
    // `max_applied_migration` names. On a pre-0099 vault the column does not
    // exist yet and the filtered statement would fail to prepare ("no such
    // column: is_replicated"), turning a recoverable vault into a boot failure.
    // Filtering is also unnecessary there: 0099's own note records that before
    // phase 1 "no op_log ever held a foreign device's ops".
    // dynamic-sql: a `pragma_table_info` probe. This function runs BEFORE
    // `sqlx::migrate!`, so it must ask the LIVE database what era it is in; the
    // macro form would check the query against head's schema, which is exactly
    // the assumption the probe exists to avoid making.
    let has_is_replicated: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('op_log') WHERE name = 'is_replicated'",
    )
    .fetch_one(&mut *executor)
    .await?;
    let ops_sql: &'static str = if has_is_replicated > 0 {
        "SELECT op_type, payload, created_at FROM op_log WHERE is_replicated = 0 \
         ORDER BY created_at, device_id, seq"
    } else {
        "SELECT op_type, payload, created_at FROM op_log ORDER BY created_at, device_id, seq"
    };
    // dynamic-sql: `ops_sql` is genuinely selected at runtime — the filtered
    // form is only legal on a vault whose `op_log` already carries 0099's
    // `is_replicated` column, and this pass runs before migrations. A macro
    // would have to pick one of the two at build time.
    let ops = sqlx::query(ops_sql).fetch_all(&mut *executor).await?;

    if ops.is_empty() {
        return Ok(diagnostics);
    }

    diagnostics.ops_replayed = ops.len();

    // #429: fallbacks only — used when an op's own `created_at` cannot be
    // read/converted (it never should). The delete arm stamps the op's OWN
    // timestamp so each delete cohort keeps a distinct `(seed, deleted_at)`
    // identity that `list_trash` / `restore_block` group on; a shared
    // boot-time `now` would collapse every recovered deletion into one cohort.
    let now_rfc3339 = chrono::Utc::now().to_rfc3339();
    let now_ms_fallback = now_ms();

    for row in ops {
        let op_type: String = row.try_get("op_type")?;
        let payload_str: String = row.try_get("payload")?;

        let payload: serde_json::Value =
            serde_json::from_str(&payload_str).map_err(agaric_core::error::AppError::Json)?;

        match op_type.as_str() {
            "create_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                let block_type = payload["block_type"].as_str().unwrap_or("content");
                let content = payload
                    .get("content")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let parent_id = payload.get("parent_id").and_then(serde_json::Value::as_str);
                // #1252: a new-scheme (#400/#603) `create_block` carries a
                // 0-based `index` and OMITS the legacy sparse `position`
                // (`CreateBlockPayload.position` is
                // `skip_serializing_if = "Option::is_none"`). Reading only
                // `position` here wrote `blocks.position = NULL` for every
                // such block, collapsing recovered siblings to ULID order.
                // Mirror the SQL-only materializer fallback
                // (`apply_create_block_sql_only`): prefer the legacy
                // `position`, else derive a 1-based provisional position from
                // `index` via `index_to_provisional_position`.
                let position = payload
                    .get("position")
                    .and_then(serde_json::Value::as_i64)
                    .or_else(|| {
                        payload
                            .get("index")
                            .and_then(serde_json::Value::as_i64)
                            .map(agaric_store::pagination::index_to_provisional_position)
                    });

                // #1536: keep `OR IGNORE` so recovery is idempotent (a re-run,
                // or a row already materialized by an earlier op in this same
                // replay, must not abort). But unlike the keyed UPDATE/DELETE
                // arms, a silently-ignored create is invisible: ULIDs make a
                // real id collision impossible, so `rows_affected == 0` means
                // the op_log carried two `create_block` ops for the same id —
                // i.e. corruption. The first create wins and is preserved
                // (success behaviour unchanged); we only surface the drop so a
                // corrupted log is observable rather than silently flattened.
                // #3269: `page_id` stays NULL here even under the head-shaped
                // recovery table (`CONSTRAINT page_id_self_for_pages CHECK
                // (block_type != 'page' OR page_id = id)`). A SQLite CHECK
                // rejects only a FALSE result, and for a page row the
                // expression evaluates to `false OR (NULL = id)` = NULL, which
                // passes; the post-loop `UPDATE ... SET page_id = id WHERE
                // block_type = 'page'` then makes it TRUE before COMMIT.
                let result = sqlx::query(
                    "INSERT OR IGNORE INTO blocks \
                     (id, block_type, content, parent_id, position, deleted_at, \
                      todo_state, priority, due_date, scheduled_date, page_id) \
                     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)",
                )
                .bind(block_id)
                .bind(block_type)
                .bind(content)
                .bind(parent_id)
                .bind(position)
                .execute(&mut *executor)
                .await?;
                if result.rows_affected() == 0 {
                    // #3269 R4: `rows_affected() == 0` now has TWO causes, and
                    // reporting the wrong one is worse than reporting nothing.
                    //
                    //  * The id is already in the table → the op_log really did
                    //    carry two creates for one id (ULIDs make a genuine
                    //    collision impossible), i.e. log corruption. The
                    //    pre-existing diagnostic.
                    //  * The id is NOT in the table → the head-shaped table
                    //    REFUSED the row (`block_type_valid` /
                    //    `page_id_self_for_pages` CHECK, STRICT typing) and
                    //    `OR IGNORE` swallowed the violation. Before the head
                    //    CHECK constraints existed this was unreachable; with them live it
                    //    is routine, and calling it "possible op_log corruption"
                    //    would slander a healthy log on the one path where that
                    //    log is the only forensic artefact left.
                    //
                    // One extra probe, only on the (rare) zero-row branch.
                    // The compile-checked macro: `blocks.id` is the one column
                    // every era of this table has, so checking the probe against
                    // head's schema is sound even though the table it runs on may
                    // be the scaffold.
                    let already_present: i64 =
                        sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", block_id)
                            .fetch_one(&mut *executor)
                            .await?;
                    if already_present > 0 {
                        diagnostics.duplicate_creates.push(block_id.to_owned());
                    } else {
                        diagnostics
                            .constraint_rejected_creates
                            .push(block_id.to_owned());
                    }
                }
            }
            "edit_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                if let Some(to_text) = payload.get("to_text").and_then(serde_json::Value::as_str) {
                    // #2043: route the content UPDATE through the shared
                    // projection (`project_edit_block_to_sql`) so its shape
                    // (`SET content = ? WHERE id = ? AND deleted_at IS NULL`)
                    // cannot drift from the engine/sql-only arms. The added
                    // `deleted_at IS NULL` guard is inert here: recovery replays
                    // in `created_at` order, so an `edit_block` always precedes
                    // its block's later `delete_block` — the target row is never
                    // yet soft-deleted when the edit lands. The recovered
                    // `blocks` table's `content` column is `TEXT` under BOTH
                    // shapes — plain TEXT in the scaffold, `TEXT` in a STRICT
                    // table under the head shape (#3269) — and the projection
                    // binds a Rust `String`, which is exactly what STRICT `TEXT`
                    // accepts, so the macro-checked query runs unchanged against
                    // either. We
                    // synthesize the `BlockSnapshot` the projection expects from
                    // the op payload; only `content` + `block_id` are read (the
                    // other fields are inert placeholders), exactly as
                    // `apply_edit_block_sql_only` does.
                    let snapshot = agaric_engine::loro::engine::BlockSnapshot {
                        block_id: block_id.to_owned(),
                        block_type: String::new(),
                        content: to_text.to_owned(),
                        parent_id: None,
                        position: 0,
                    };
                    agaric_engine::loro::projection::project_edit_block_to_sql(
                        &mut *executor,
                        &snapshot,
                    )
                    .await?;
                }
            }
            "move_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                let new_parent_id = payload
                    .get("new_parent_id")
                    .and_then(serde_json::Value::as_str);
                // #1252: prefer the new-scheme 0-based `new_index` (as a
                // 1-based provisional position) when present, else the legacy
                // `new_position`. Mirrors `apply_move_block_sql_only`. The
                // `move_block` arm was less broken than `create_block`
                // (`MoveBlockPayload.new_position` is always serialized and
                // mirrors `new_index`), but routing on `new_index` keeps
                // recovery consistent with the live materializer.
                let new_position = payload
                    .get("new_index")
                    .and_then(serde_json::Value::as_i64)
                    .map(agaric_store::pagination::index_to_provisional_position)
                    .or_else(|| {
                        payload
                            .get("new_position")
                            .and_then(serde_json::Value::as_i64)
                    });

                // #2894: this arm shares the byte-identical UPDATE shape with the
                // shared projection (`project_move_block_to_sql`:
                // `UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?`),
                // but is INTENTIONALLY left inline rather than routed through it.
                // The projection binds `snapshot.position: i64` (a concrete rank —
                // the engine read-back is never NULL); this recovery replay reads
                // a raw op-log payload and binds `new_position: Option<i64>`,
                // preserving a defensive `position = NULL` write for the
                // (well-formed ops never hit it, but corruption-path) case where
                // BOTH `new_index` and `new_position` are absent from the JSON.
                // Converging would force that NULL corner onto the projection's
                // non-nullable `i64` — there is no move-side sentinel mapping to
                // fall back on (unlike the *create* path, where
                // `apply_create_block_sql_only` folds an absent position into the
                // `i64::MAX` NULL_POSITION_SENTINEL; `MoveBlockPayload.new_position`
                // is a non-optional `i64`, so `apply_move_block_sql_only` never
                // synthesizes that sentinel and `index_to_provisional_position`
                // caps strictly below it). Converging is therefore an observable
                // change in exactly the malformed-op-log corner this recovery
                // exists to survive, and inconsistent with the `create_block`
                // arm's NULL convention. The convergence is the UPDATE *shape*
                // (which already matches), not the bind: leaving it inline is
                // behaviour-preserving. The projection also has no cycle probe
                // here (unlike the engine-less `apply_move_block_sql_only`
                // fallback, which runs the shared `move_would_cycle` probe), so
                // recovery's cycle-probe-free behaviour is likewise unchanged.
                // #4204/#4188: classify the subject's tombstone BEFORE the
                // reparent. An INHERITED tombstone (the subject is a cascade
                // member of its parent's cohort, not a cohort ROOT) is a fact
                // about the OLD parent, and one `SET parent_id` from now that
                // parent is unrecoverable — `move_block`'s payload does not
                // carry it. Returns the OLD PARENT's id, which the un-sweep
                // below uses as the era-agnostic handle on the cohort's
                // timestamp: the subject's own `deleted_at` is about to be
                // cleared, but the old parent's copy of the same value stays
                // put (it is an ancestor, never a member of the subject's
                // descendant cohort).
                //
                // dynamic-sql: era-varying `blocks` at the pre-migration era
                // (`query_scalar!` would check it against HEAD). The whole
                // probe is an EQUALITY between two stored `deleted_at` values,
                // so it never moves the column through Rust and holds in both
                // the pre-0080 rfc3339-TEXT era and the at-head INTEGER one —
                // the same era-agnostic-by-construction argument the sweep's
                // statements below make.
                let inherited_from_parent: Option<String> = sqlx::query_scalar::<_, String>(
                    "SELECT b.parent_id FROM blocks b \
                       JOIN blocks parent ON parent.id = b.parent_id \
                      WHERE b.id = ?1 \
                        AND b.deleted_at IS NOT NULL \
                        AND parent.deleted_at IS NOT NULL \
                        AND parent.deleted_at = b.deleted_at",
                )
                .bind(block_id)
                .fetch_optional(&mut *executor)
                .await?;

                sqlx::query("UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?")
                    .bind(new_parent_id)
                    .bind(new_position)
                    .bind(block_id)
                    .execute(&mut *executor)
                    .await?;

                // #4187: the UPDATE above may have parked a LIVE block under a
                // TOMBSTONED ancestor — the ordinary concurrent
                // `{Delete(P), Move(B → P)}` pair, replayed delete-first
                // because this loop orders by `created_at`. That rebuilds an
                // invisible orphan: `B` is absent from the tree (its ancestor
                // is trashed) and absent from the trash (it is not). The live
                // materializer's two arms stopped producing that state in
                // #4112; this is the third interpreter of the same op (#2894)
                // and it must agree with them, or the rebuild diverges from the
                // table it is supposed to reconstruct. Nothing downstream heals
                // it either: `reproject_block_deleted_at_from_engine`'s R9
                // sweep resolves the same merge, but only over a sync import's
                // changed set, so a block nobody touches again stays orphaned.
                //
                // The rule (cascade-soft-delete the moved subtree at the
                // nearest tombstoned ancestor's `deleted_at`) is R9's and
                // #4112's. Since #4233 the downward REACH of the two walks it
                // is built from agrees; what still differs is the DEPTH bound
                // (R27 re-anchors past the cap, this replay stops at it and
                // REPORTS the truncation, #4232) — see
                // `sweep_move_under_tombstoned_ancestor`'s doc comment for why
                // sweeping is the only candidate behaviour that CONVERGES with
                // the move-first replay order, and why a move whose SUBJECT is
                // already tombstoned must be applied unswept (that is the
                // ordinary trash shape, and both orders already agree on it).
                //
                // That helper cannot be CALLED from here, for three independent
                // reasons, so this arm hand-rolls the same rule the way the
                // `delete_block` arm below hand-rolls the same cascade (#2043):
                //
                //  1. It is `pub(crate)` to `agaric-engine`; the app crate's
                //     `materializer::handlers::sql_only` re-export cannot see
                //     it. Widening it is a change to the shared item, not a
                //     reuse of it.
                //  2. It is i64-only end to end — `nearest_tombstoned_ancestor`
                //     decodes `deleted_at` as `i64` and
                //     `project_delete_block_to_sql` BINDS an `i64`. This pass
                //     runs before `sqlx::migrate!`, at whatever era
                //     `max_applied_migration` names, and pre-0080 `deleted_at`
                //     is rfc3339 TEXT (#618) — the decode would fail outright
                //     and the stamp would be the wrong era. The two statements
                //     below never move `deleted_at` through Rust at all (the
                //     probe only tests `IS NOT NULL`; the cascade copies the
                //     ancestor's stored value with a subquery), so they are
                //     era-agnostic by construction — strictly better than the
                //     delete arm's era switch, since the cohort is stamped with
                //     the ancestor's OWN bytes.
                //  3. Its tail runs `tag_inheritance::remove_subtree_inherited`
                //     against a head-shaped `block_tags`. Recovery does no tag
                //     maintenance at all — the `delete_block` arm's cascade
                //     does not either — because the tables it would touch are
                //     at pre-migration era here and the derived pass rebuilds
                //     that cache later.
                //
                // Runs on every move, including a same-parent reorder: like the
                // materializer's sweep, it doubles as a repair pass for a
                // subtree that was ALREADY an orphan in the log's own history.
                //
                // dynamic-sql: a recursive ancestor CTE. `query_scalar!` would
                // check it against HEAD's `blocks`, which is exactly the
                // assumption this pre-migration pass must not make (see the
                // `pragma_table_info` probe above); the columns it reads
                // (`id` / `parent_id` / `deleted_at`) exist in every era, but
                // their TYPES do not, which is the whole point of reason 2.
                // The seed's `deleted_at IS NULL` WAS the live-subject guard: a
                // move whose subject is already tombstoned yielded no seed row,
                // hence no sweep. #4204 widens it by exactly one case — the
                // subject whose tombstone is INHERITED (`?2`), which the
                // un-sweep below MAY clear, in which case it is a live subject
                // one statement from now and the sweep must be able to
                // re-derive its cohort from the new position. A tombstoned
                // subject that is a cohort ROOT still yields no seed row and is
                // still never swept
                // (`recover_move_of_an_already_tombstoned_block_keeps_its_original_cohort`).
                //
                // MAY, not WILL: the un-sweep short-circuits when the new
                // position already implies the same cohort, and then the
                // subject is STILL tombstoned when the sweep runs. So this
                // probe answering `Some` no longer means "safe to sweep", and
                // the live-subject guard moved to where the answer is CONSUMED
                // — see the re-read below the un-sweep.
                // depth<100: DESCENDANT_DEPTH_CAP, mirroring
                // the `delete_block` arm's bound (a corrupt `parent_id` cycle
                // terminates at the cap rather than re-anchoring past it the
                // way `nearest_tombstoned_ancestor` does).
                //
                // #4289: the climb's TRUNCATION answer rides in the same
                // statement, off the same CTE. `ancestors` is a recursive CTE,
                // which SQLite materialises once, so both subqueries below read
                // one walk — where #4232's separate `ancestor_probe_truncated`
                // (deleted by #4289; named here only as the shape this
                // replaced) climbed the whole chain a second time, and the two
                // answers were only textually guaranteed to agree. The extra
                // level is
                // asked for in the outer query, exactly as the descendant
                // cohort asks it (see [`materialize_cascade_cohort`]): does the
                // ancestor at exactly the cap still have a parent? That parent
                // is the `DESCENDANT_DEPTH_CAP + 1`-th, the first one this
                // probe could not see. Structural, not semantic: a block moved
                // anywhere under a chain deeper than the cap reports here even
                // when the vault holds no tombstone at all — see
                // `recover_move_ancestor_probe_reports_a_deep_live_chain_with_no_tombstone`.
                let (tombstoned_ancestor, ancestor_climb_truncated): (Option<String>, bool) =
                    sqlx::query_as::<_, (Option<String>, bool)>(
                        "WITH RECURSIVE ancestors(id, depth) AS ( \
                             SELECT parent_id, 1 FROM blocks \
                              WHERE id = ?1 AND (deleted_at IS NULL OR ?2) \
                                AND parent_id IS NOT NULL \
                             UNION ALL \
                             SELECT b.parent_id, a.depth + 1 FROM blocks b \
                               JOIN ancestors a ON b.id = a.id \
                              WHERE b.parent_id IS NOT NULL AND a.depth < 100 \
                         ) \
                         SELECT ( \
                             SELECT a.id FROM ancestors a JOIN blocks b ON b.id = a.id \
                              WHERE b.deleted_at IS NOT NULL \
                              ORDER BY a.depth LIMIT 1 \
                         ), EXISTS ( \
                             SELECT 1 FROM blocks b JOIN ancestors a ON b.id = a.id \
                              WHERE a.depth = 100 AND b.parent_id IS NOT NULL \
                         )",
                    )
                    .bind(block_id)
                    .bind(inherited_from_parent.is_some())
                    .fetch_one(&mut *executor)
                    .await?;

                // #4232: only when the probe found NOTHING. A tombstone found
                // within the cap is by construction the nearest one
                // (`ORDER BY a.depth LIMIT 1`), so anything above the cap could
                // not have changed the answer and reporting it would be noise.
                // With no hit, though, "no tombstoned ancestor" and "ran out of
                // rope at depth 100" are the same empty result — and only one
                // of them means the sweep was correct to stay quiet. That
                // suppression rule is pinned by
                // `recover_move_ancestor_probe_suppressed_when_a_tombstone_was_found_within_the_cap`.
                if tombstoned_ancestor.is_none() && ancestor_climb_truncated {
                    diagnostics.cascade_truncations.push(CascadeTruncation {
                        cascade: CASCADE_MOVE_SWEEP_ANCESTOR_PROBE,
                        block_id: block_id.to_owned(),
                    });
                }

                // #4204/#4188: the un-sweep, the sweep's mirror image. An
                // INHERITED tombstone is POSITIONAL — it says "my parent's
                // cohort swallowed me" — so the reparent above invalidated it.
                // Clear it and let the sweep below re-derive the cohort from
                // the new position; see
                // `agaric_engine::apply::sql_only::unsweep_inherited_cohort_after_move`
                // for the rule and its order-independence argument, which this
                // arm implements rather than restates. Recovery is the third
                // interpreter of the same op (#2894), so leaving it out would
                // let a boot rebuild reintroduce exactly the divergence the
                // materializer just stopped producing.
                //
                // The short-circuit (the ancestor at the NEW position already
                // carries the subject's own cohort ts) covers the same-parent
                // reorder and the move within one cohort, and is expressed as
                // an equality between two stored `deleted_at` values, so it is
                // era-agnostic for the same reason the probe above is.
                //
                // #4390 — the engine mirror is OUT OF SCOPE here, decided
                // explicitly rather than left implicit. #4390 made the
                // materializer's un-sweep durable by threading the ids it
                // cleared out to a post-commit engine fan-out
                // (`materializer::handlers::apply::dispatch_unswept_cohort`),
                // so the SQL re-derivation survives a snapshot import. This arm
                // has no such fan-out and cannot have one: it runs BEFORE
                // `sqlx::migrate!`, at whatever era `max_applied_migration`
                // names, on a raw `executor` — there is no `LoroState`, no
                // per-space engine registry and no `SpaceId` in scope at this
                // point in boot, and reaching for one would import the
                // head-shaped, i64-only engine API into a pass whose whole
                // premise is that the schema is NOT at head (see reasons 2 and
                // 3 above).
                //
                // The residue, stated plainly: a vault whose `blocks` table is
                // rebuilt by this pass gets the correct SQL answer, while its
                // per-space engine keeps whatever `deleted_at` register its
                // persisted snapshot holds — so a snapshot import after such a
                // rebuild can still re-trash the subtree, exactly as the whole
                // op path did before #4390. It is narrower than what #4390
                // closed (that was every remote move; this is only a move
                // replayed by a corrupt-DB rebuild) and it is not made worse by
                // #4390. Widening the derived pass to cover it means giving
                // recovery an engine handle after migration, which is a change
                // to the boot sequence, not to this arm.
                if let Some(old_parent_id) = inherited_from_parent {
                    let same_cohort_at_new_position = match tombstoned_ancestor.as_deref() {
                        None => false,
                        Some(ancestor_id) => {
                            // dynamic-sql: era-varying `blocks` at the
                            // pre-migration era; a stored-value equality that
                            // never decodes the column, so it holds in both the
                            // pre-0080 rfc3339-TEXT era and the at-head INTEGER
                            // one. `query_scalar!` would pin the statement to
                            // the HEAD schema this replay is precisely NOT
                            // running against.
                            sqlx::query_scalar::<_, bool>(
                                "SELECT EXISTS ( \
                                 SELECT 1 FROM blocks subject, blocks ancestor \
                                  WHERE subject.id = ?1 AND ancestor.id = ?2 \
                                    AND subject.deleted_at = ancestor.deleted_at \
                             )",
                            )
                            .bind(block_id)
                            .bind(ancestor_id)
                            .fetch_one(&mut *executor)
                            .await?
                        }
                    };
                    if !same_cohort_at_new_position {
                        // The cohort to clear is recovery's own FLAT
                        // `(subtree, deleted_at)` shape — the `restore_block`
                        // arm's, not the projection's connected-cohort walk,
                        // for the #2043 reason that arm states: recovery
                        // deliberately keeps one cascade shape across its arms
                        // rather than importing the head-shaped one.
                        //
                        // #4204 — the residual third-interpreter disagreement,
                        // stated rather than left to be rediscovered. The
                        // materializer's `unsweep_inherited_cohort_after_move`
                        // routes through `clear_cohort_deleted_at_downward`,
                        // whose walk is `DescendantWalkFilter::Cohort(ts)` —
                        // CONTIGUOUS, so it stops descending at a child whose
                        // `deleted_at` is not `ts`. This walk is the standard
                        // flat subtree, filtered afterwards. They part on one
                        // shape: `B(t1) > X(live) > Y(t1)`, where `Y` carries
                        // the cohort ts but is not connected to `B` through it.
                        // Recovery clears `Y`; the materializer leaves it
                        // trashed.
                        //
                        // Left as-is deliberately: this arm clears rows that
                        // are TOMBSTONED, so it shares the `restore_block`
                        // arm's flat `(subtree, deleted_at)` shape and its
                        // standard walk (the members it looks for sit below a
                        // tombstone by construction). Importing the contiguous
                        // one HERE would make recovery disagree with ITSELF —
                        // a `RestoreBlock` on the cleared cohort would cover
                        // rows this un-sweep would not — which is the
                        // self-consistency #4187 exists to keep. Closing it
                        // means changing this arm and `restore_block`
                        // together, not this one alone. (#4233 aligned the two
                        // arms that write LIVE rows, `delete_block` and the
                        // move sweep; this pair is the other axis and stays
                        // pinned.) Reaching it also needs a pre-existing
                        // `deleted_at`-equal-but-disconnected row, which only a
                        // #4188/#4204-shaped history produces.
                        if materialize_cascade_cohort(
                            &mut *executor,
                            block_id,
                            CascadeReach::Standard,
                        )
                        .await?
                        {
                            diagnostics.cascade_truncations.push(CascadeTruncation {
                                cascade: CASCADE_MOVE_UNSWEEP,
                                block_id: block_id.to_owned(),
                            });
                        }
                        // dynamic-sql: era-varying `blocks`, keyed on the TEMP
                        // cohort materialised above and on the OLD PARENT's
                        // stored `deleted_at` — the subject's own copy is one
                        // of the values this statement NULLs, so keying on it
                        // would be self-referential. `id <> ?1` keeps the
                        // subquery's row out of the updated set even in the
                        // corrupt case where a `parent_id` cycle put the old
                        // parent inside the subject's own subtree (this arm
                        // has no cycle probe, by design — see the UPDATE
                        // above).
                        sqlx::query(
                            "UPDATE blocks SET deleted_at = NULL \
                              WHERE id IN (SELECT id FROM recovery_cascade_cohort) \
                                AND id <> ?1 \
                                AND deleted_at IS NOT NULL \
                                AND deleted_at = (SELECT deleted_at FROM blocks WHERE id = ?1)",
                        )
                        .bind(&old_parent_id)
                        .execute(&mut *executor)
                        .await?;
                        diagnostics
                            .move_unswept_inherited_cohort
                            .push(block_id.to_owned());
                    }
                }

                // #4204: the sweep's OWN live-subject guard, re-read AFTER the
                // un-sweep has had its chance to run. It is the exact mirror of
                // `sweep_move_under_tombstoned_ancestor`'s
                // `matches!(own_deleted_at, Some(None))` early return, and it
                // exists because the probe above no longer carries that
                // guarantee: `?2` widened the seed's `deleted_at IS NULL` so an
                // INHERITED-tombstone subject would still get an ancestor
                // answer to re-derive its cohort FROM. That widening is only
                // sound when the un-sweep then CLEARS — and it does not clear
                // in the short-circuit case (the new position implies the same
                // cohort), which leaves a `Some(ancestor)` in hand for a
                // subject that is still tombstoned. Consuming it there ran the
                // cascade below over the moved subtree and stamped every LIVE
                // descendant into the ancestor's cohort — a pre-existing live
                // orphan (a peer's child of a concurrently deleted block)
                // silently moved into the trash by a boot repair, in exactly
                // the materializer-vs-recovery lockstep the un-sweep exists to
                // preserve.
                //
                // Phrased as a re-read of the subject's own row rather than as
                // "did the un-sweep branch fire", for two reasons: it is
                // literally the materializer's condition, so the two cannot
                // drift; and it answers from the state the cascade is about to
                // read rather than from a Rust-side belief about what the
                // UPDATE did. The three cases it separates:
                //
                //  * subject live all along (`?2` false) — unchanged, sweeps;
                //  * subject inherited-tombstoned and UN-SWEPT — now live,
                //    sweeps, which is #4188's re-stamp to the target cohort;
                //  * subject inherited-tombstoned and SHORT-CIRCUITED — still
                //    tombstoned, declines. (A cohort-ROOT tombstone never got
                //    an ancestor out of the probe in the first place, so it
                //    declines one step earlier, as before.)
                //
                // Costs one PK lookup, and only on a move that actually found a
                // tombstoned ancestor — the same price the materializer pays.
                // Pinned by `recover_move_within_one_cohort_leaves_a_live_orphan_alone_4188`
                // (the recovery mirror of the materializer's
                // `unsweep_short_circuits_a_move_within_one_cohort_4188`), and
                // by the `move_swept_under_tombstone` half of
                // `recover_move_within_one_cohort_does_not_unsweep_4188`.
                let sweep_ancestor = match tombstoned_ancestor {
                    None => None,
                    Some(ancestor_id) => {
                        // dynamic-sql: era-varying `blocks` at the
                        // pre-migration era; an `IS NULL` test that never
                        // decodes the column, so it holds in both the pre-0080
                        // rfc3339-TEXT era and the at-head INTEGER one, for the
                        // same reason the probe above does. `query_scalar!`
                        // would pin the statement to the HEAD schema this
                        // replay is precisely NOT running against.
                        let subject_is_live = sqlx::query_scalar::<_, bool>(
                            "SELECT EXISTS ( \
                                 SELECT 1 FROM blocks WHERE id = ?1 AND deleted_at IS NULL \
                             )",
                        )
                        .bind(block_id)
                        .fetch_one(&mut *executor)
                        .await?;
                        subject_is_live.then_some(ancestor_id)
                    }
                };

                if let Some(ancestor_id) = sweep_ancestor {
                    // The `delete_block` arm's cascade shape, keyed on the
                    // ancestor's own stored `deleted_at` (era-agnostic, and
                    // byte-identical to the cohort a delete-last replay would
                    // have produced, which is what makes the result restorable
                    // as one unit — `RestoreBlock` groups on the shared
                    // timestamp). The `deleted_at IS NULL` guard preserves an
                    // already-trashed descendant's original cohort, exactly as
                    // it does there.
                    //
                    // REACH (#4233): `CascadeReach::Active` — see the variant's
                    // doc for why, and why this arm and the `delete_block` arm
                    // below must carry the SAME reach. The residual gap to the
                    // engine is depth only: its walk is unbounded (R27
                    // re-anchoring), this one stops at the depth-100 cap and
                    // REPORTS the truncation (#4232).
                    // #4232/#4289: the sweep's own reach, answered off the
                    // SAME walk the UPDATE below is keyed on — one enumeration
                    // per swept move, not two.
                    if materialize_cascade_cohort(&mut *executor, block_id, CascadeReach::Active)
                        .await?
                    {
                        diagnostics.cascade_truncations.push(CascadeTruncation {
                            cascade: CASCADE_MOVE_SWEEP,
                            block_id: block_id.to_owned(),
                        });
                    }
                    // dynamic-sql: era-varying `blocks` at the pre-migration
                    // era, keyed on the TEMP cohort materialised above.
                    sqlx::query(
                        "UPDATE blocks \
                            SET deleted_at = (SELECT deleted_at FROM blocks WHERE id = ?1) \
                          WHERE deleted_at IS NULL \
                            AND id IN (SELECT id FROM recovery_cascade_cohort)",
                    )
                    .bind(&ancestor_id)
                    .execute(&mut *executor)
                    .await?;
                    diagnostics
                        .move_swept_under_tombstone
                        .push(block_id.to_owned());
                }
            }
            "delete_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                // #429: a `delete_block` op encodes ONLY the root, but the
                // production path (`delete_block_inner`) soft-deletes the whole
                // active subtree and stamps every member with the op's single
                // timestamp. Recovery must do the same or descendants reappear
                // live under a tombstoned ancestor, and the deletion cohort is
                // lost. Stamp the op's OWN `created_at` (not boot-time `now`)
                // so distinct delete ops keep distinct cohorts, and cascade
                // through the temp `blocks` tree (depth-bounded, same shape as
                // production). The `deleted_at IS NULL` guard preserves an
                // already-deleted descendant's original cohort timestamp.
                //
                // REACH (#4233): `CascadeReach::Active` — see the variant's doc.
                // The `deleted_at IS NULL` guard above was not enough on its
                // own: it prunes the WRITE, while the walk kept descending, so
                // a LIVE block under a tombstoned child was still reached and
                // stamped. The move sweep above carries the same reach, and the
                // two move together (#4187).
                //
                // #618: encode per era — INTEGER epoch-ms once 0080 has run
                // (any later rebuild re-run copies `deleted_at` RAW into a
                // STRICT INTEGER column, so rfc3339 TEXT wedges 0085/0089 and
                // corrupts at-head i64 reads), rfc3339 TEXT before that
                // (0080's julianday() backfill converts it).
                //
                // #2043: this arm is INTENTIONALLY left inline, not routed
                // through `project_delete_block_to_sql`. The reach is now the
                // same, but that projection is i64-only (`deleted_at` INTEGER):
                // the era-switched TEXT/INTEGER stamp above cannot be expressed
                // through it, so unifying would mis-stamp the pre-0080 (TEXT)
                // era. The walk FILTER carries no timestamp, which is why the
                // reach could be aligned while the stamp stayed hand-rolled.
                // #4232: a truncated delete cohort leaves the subtree's deep
                // tail LIVE under a tombstoned ancestor — the invisible orphan
                // this arm exists to prevent, below depth 100.
                if materialize_cascade_cohort(&mut *executor, block_id, CascadeReach::Active)
                    .await?
                {
                    diagnostics.cascade_truncations.push(CascadeTruncation {
                        cascade: CASCADE_DELETE,
                        block_id: block_id.to_owned(),
                    });
                }
                // dynamic-sql: era-varying `deleted_at` stamp (#618) against
                // the pre-migration `blocks`, keyed on the TEMP cohort
                // materialised above (#4289).
                let query = sqlx::query(
                    "UPDATE blocks SET deleted_at = ?1 \
                     WHERE deleted_at IS NULL \
                       AND id IN (SELECT id FROM recovery_cascade_cohort)",
                );
                let query = if deleted_at_is_ms {
                    query.bind(op_created_at_ms(&row, now_ms_fallback))
                } else {
                    query.bind(op_created_at_rfc3339(&row, &now_rfc3339))
                };
                query.execute(&mut *executor).await?;
            }
            "restore_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                // #613: a `restore_block` op encodes ONLY the root. This arm
                // un-deletes a FLAT subtree cohort keyed on the originating
                // delete op's `deleted_at_ref`, by design.
                //
                // #2043: this is INTENTIONALLY DIVERGENT from the projection
                // (`project_restore_block_to_sql` / `collect_restore_cohort`)
                // and MUST NOT be unified with it. The projection uses the
                // stricter connected-cohort walk (#1055) plus upward ancestor
                // restore (#1884/#2017); routing recovery through it would
                // CHANGE which blocks get un-deleted (the exact
                // orphan-promotion / RestoreBlock regression class #2043
                // cites). Recovery deliberately keeps the flat
                // `(seed, deleted_at_ref)` cohort + no ancestor restore.
                //
                // The previous root-only UPDATE left every descendant
                // tombstoned after a delete(root)+restore(root) replay, and
                // ignored the cohort token entirely (a root deleted
                // independently earlier would get resurrected by a later
                // unrelated restore op).
                //
                // Use the #429 delete-arm cascade shape, keyed on the cohort
                // timestamp: `deleted_at_ref` is the originating delete op's
                // `created_at` in epoch-ms — exactly what the delete arm
                // above stamped into `deleted_at` (per era, #618). Pre-0080
                // (TEXT era) the delete arm stored rfc3339, so the guard
                // compares via the same julianday()→ms conversion migration
                // 0079/0080 use; this is the deliberate TEXT-era exception
                // to the "no julianday on INTEGER columns" rule.
                //
                // A legacy payload missing `deleted_at_ref` (pre-cohort
                // producers) falls back to un-deleting the whole subtree
                // unconditionally — the legacy restore semantics.
                let deleted_at_ref = payload
                    .get("deleted_at_ref")
                    .and_then(serde_json::Value::as_i64);
                // #4232: the mirror-image truncation — a restore that stops at
                // the cap leaves the deep tail TOMBSTONED, orphaned from the
                // cohort it was raised with. Probed before the UPDATE for
                // symmetry; the walk is the standard one, so the answer does
                // not depend on that.
                if materialize_cascade_cohort(&mut *executor, block_id, CascadeReach::Standard)
                    .await?
                {
                    diagnostics.cascade_truncations.push(CascadeTruncation {
                        cascade: CASCADE_RESTORE,
                        block_id: block_id.to_owned(),
                    });
                }
                // #4289: keyed on the TEMP cohort the probe above materialised,
                // so the un-delete and the truncation answer come from one walk.
                const RESTORE_CASCADE_PREFIX: &str = "UPDATE blocks SET deleted_at = NULL \
                     WHERE id IN (SELECT id FROM recovery_cascade_cohort)";
                match deleted_at_ref {
                    Some(ref_ms) if deleted_at_is_ms => {
                        sqlx::query(sqlx::AssertSqlSafe(format!(
                            "{RESTORE_CASCADE_PREFIX} AND deleted_at = ?1"
                        )))
                        .bind(ref_ms)
                        .execute(&mut *executor)
                        .await?;
                    }
                    Some(ref_ms) => {
                        // TEXT era: `deleted_at` is rfc3339 (possibly the op
                        // row's original string formatting), so compare on
                        // the parsed ms value rather than string equality.
                        sqlx::query(sqlx::AssertSqlSafe(format!(
                            "{RESTORE_CASCADE_PREFIX} \
                             AND deleted_at IS NOT NULL \
                             AND CAST(ROUND((julianday(deleted_at) - 2440587.5) * 86400000.0) \
                                 AS INTEGER) = ?1"
                        )))
                        .bind(ref_ms)
                        .execute(&mut *executor)
                        .await?;
                    }
                    None => {
                        sqlx::query(sqlx::AssertSqlSafe(format!(
                            "{RESTORE_CASCADE_PREFIX} AND deleted_at IS NOT NULL"
                        )))
                        .execute(&mut *executor)
                        .await?;
                    }
                }
            }
            "purge_block" => {
                let block_id = payload["block_id"].as_str().unwrap_or("");
                // #615: production purge (`apply_purge_block_*`) hard-deletes
                // the whole subtree, but the temp recovery table has no FK
                // cascade (created constraint-free above), so a root-only
                // DELETE left every purged descendant alive — and the orphan
                // cleanup after this loop then PROMOTED them to live
                // top-level blocks (`parent_id = NULL`), resurrecting
                // user-destroyed data. Cascade with the same depth-bounded
                // recursive CTE shape as the delete arm.
                //
                // #4232: the walk is materialised BEFORE the DELETE — unlike
                // the soft-delete arms, this one removes the very rows it
                // walks, so afterwards there is nothing left to ask.
                // Truncation here is the worst of the four descendant walks:
                // the unreached tail survives the purge with a dangling
                // `parent_id`.
                //
                // #4287: which is why this arm does not just report it. The
                // frontier the walk could not reach is finished off by
                // [`purge_truncated_tails`] right here, so the blanket orphan
                // cleanup after this loop never NULLs a `parent_id` whose
                // ancestor was purged in this same replay — the promotion that
                // turned user-destroyed data back into a live, searchable
                // top-level block. Right here, and not after the loop, because
                // ops replayed later can still move rows into or out of the
                // surviving tail; see that function's doc.
                let step = purge_cascade_step(&mut *executor, block_id).await?;
                if step.truncated {
                    diagnostics.cascade_truncations.push(CascadeTruncation {
                        cascade: CASCADE_PURGE,
                        block_id: block_id.to_owned(),
                    });
                }
                // #4287: finish the tail NOW, while the tree still looks the
                // way this purge left it. See [`purge_truncated_tails`] for why
                // a post-loop pass was wrong in both directions.
                let repair = purge_truncated_tails(&mut *executor, &step.unreached).await?;
                diagnostics.purge_tail_rows_removed += repair.rows_removed;
                diagnostics.purge_tails_finished.extend(repair.heads);
            }
            _ => {
                // set_property / delete_property / add_tag are handled
                // post-migration so they survive migration 73's DROP TABLE.
            }
        }
    }

    // #4287: the truncated purges were already finished in the loop above, each
    // one immediately after its own cascade. That ordering matters: the cleanup
    // below cannot tell "orphaned by a truncated purge" from "orphaned by
    // legitimate historical damage" — it sees only a dangling `parent_id` — and
    // adopting the first kind resurrects hard-purged content as a live,
    // FTS-indexed, untrashable top-level block. By the time control reaches
    // here there is no such orphan left for it to adopt.

    // Clean up orphaned parent_ids so migration 73's INSERT into _new_blocks
    // doesn't fail on dangling FK references (e.g. parent created on another
    // device and not present in the local op_log).
    sqlx::query(
        "UPDATE blocks SET parent_id = NULL \
         WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM blocks)",
    )
    .execute(&mut *executor)
    .await?;

    // Compute page_id: pages self-reference, content blocks inherit from
    // nearest page ancestor, tags stay NULL.
    sqlx::query("UPDATE blocks SET page_id = id WHERE block_type = 'page'")
        .execute(&mut *executor)
        .await?;

    loop {
        let rows = sqlx::query(
            "UPDATE blocks SET page_id = (
                SELECT CASE WHEN block_type = 'page' THEN id ELSE page_id END
                FROM blocks AS parent WHERE parent.id = blocks.parent_id
            )
            WHERE block_type = 'content' AND page_id IS NULL AND parent_id IS NOT NULL
              AND EXISTS (
                  SELECT 1 FROM blocks AS parent
                  WHERE parent.id = blocks.parent_id AND parent.page_id IS NOT NULL
              )",
        )
        .execute(&mut *executor)
        .await?
        .rows_affected();

        if rows == 0 {
            break;
        }
    }

    // #4287 review: the cohort table is TEMP, so it dies with the connection —
    // but this connection goes back to the pool and then serves normal app
    // traffic, carrying the last cascade's rows in its temp schema for the rest
    // of the process. Drop it rather than leave recovery-scoped residue on a
    // live connection. Not correctness-critical, which is also why it is not
    // guarded against the early returns: every `?` above leaves the table
    // behind, and a later `materialize_cascade_cohort` on that connection
    // still reads exactly its own walk, because every read is preceded by a
    // `DELETE` and a re-materialise. The drop is hygiene, not an invariant, so
    // it does not need a scope guard or a `finally` shape.
    // dynamic-sql: DDL, which the `query!` family cannot express at all.
    sqlx::query("DROP TABLE IF EXISTS recovery_cascade_cohort")
        .execute(&mut *executor)
        .await?;

    Ok(diagnostics)
}

/// After migrations run, recover the dependent tables (`block_properties`,
/// `block_tags`) from `op_log` — but only when block-table
/// recovery actually fired (#616: `blocks_recovered_this_boot`, or the
/// persisted pending marker from a prior crashed attempt) AND the derived
/// tables are empty. Reserved-key properties (todo_state, priority,
/// due_date, scheduled_date, space) are replayed directly onto their
/// denormalised `blocks` columns (#534), not into `block_properties`.
///
/// #3268: this pass replays locally-authored STATE ops only. The ATTACHMENT
/// arms live in [`recover_attachments_from_op_log`], which the caller must run
/// AFTER [`reproject_blocks_from_engine`] — see that function for why the
/// ordering is load-bearing.
///
/// Returns `true` when the recovery gate opened, i.e. when the caller still owes
/// the attachment pass (which is what clears [`DERIVED_RECOVERY_PENDING_KEY`]).
/// This pass deliberately does NOT clear that marker: a crash between the two
/// passes must leave the retry signal armed.
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
pub(crate) async fn recover_derived_state_from_op_log(
    pool: &SqlitePool,
    blocks_recovered_this_boot: bool,
) -> Result<bool, agaric_core::error::AppError> {
    // Guard: skip if op_log is empty or missing.
    //
    // R4 (#347): propagate probe errors with `?` rather than masking them
    // as `0` (which would wrongly skip recovery against an already-populated
    // DB, or silently swallow a transient query failure at boot).
    //
    // #3268: count exactly the population the two replays read, no more. This
    // guard must AGREE with the replay it gates — an unfiltered count sent a
    // vault whose op_log holds nothing either pass would act on into the full
    // replay, the call-site half of the same defect. The predicate here is the
    // UNION of [`STATE_REPLAYABLE`] (this pass) and [`ATTACHMENT_REPLAYABLE`]
    // (the pass that follows the engine reprojection), which is why it gates
    // both: `(is_replicated = 0 AND NOT attachment) OR attachment` reduces to
    // exactly the predicate below. See [`recover_attachments_from_op_log`] for
    // why the attachment ops are exempt from the provenance filter.
    //
    // This pass runs AFTER `sqlx::migrate!`, so migration 0099's
    // `is_replicated` column is always present here (unlike
    // `recover_blocks_from_op_log`, which runs before migrations and has to
    // probe for it) — which is what makes the compile-checked MACRO usable, and
    // this is the one place in this file where it is. `query_scalar!` resolves
    // `is_replicated` against the real schema at build time, so a migration that
    // renamed or dropped the column would fail the build here instead of at
    // boot on a damaged vault. Its sibling in `recover_blocks_from_op_log` has
    // to probe for that very column at runtime and can never have that; giving
    // up the one checkable site to avoid a `.sqlx` cache entry would be trading
    // the guarantee for nothing.
    let op_count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log \
         WHERE is_replicated = 0 \
            OR op_type IN ('add_attachment', 'delete_attachment', 'rename_attachment')"
    )
    .fetch_one(pool)
    .await?;

    // #616: require a POSITIVE corruption signal before replaying anything.
    //
    // The old gate ("recover iff block_properties AND block_tags are both
    // empty", C9/#345) assumed the two tables never empty independently of
    // corruption. Post-0088 that premise is dead: reserved-key properties
    // (todo_state / priority / due_date / scheduled_date / space) live on
    // `blocks` columns and create NO `block_properties` rows, so a vault
    // using only TODO states/dates and no tags legitimately keeps both
    // counts at 0 forever — and the old gate re-ran the full O(op_count)
    // op-log replay (plus a scary warn) on EVERY boot.
    //
    // The positive signal is "block-table recovery fired": either this very
    // boot (`blocks_recovered_this_boot`, threaded from
    // `ensure_blocks_table_exists`) or a prior boot that crashed before this
    // replay completed (the durable `DERIVED_RECOVERY_PENDING_KEY` marker,
    // written in the recovery tx and cleared by the attachment pass that
    // follows the engine reprojection).
    let marker_pending: i64 =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM app_settings WHERE key = ?")
            .bind(DERIVED_RECOVERY_PENDING_KEY)
            .fetch_one(pool)
            .await?;

    // #3268 (review follow-up): "nothing to replay" must also RETIRE the
    // marker, not just skip. Read AFTER the marker probe so a healthy vault
    // with an empty op_log still issues no write. The filtered count reaches 0
    // on strictly MORE vaults than the old unfiltered one — an op_log holding
    // only replicated non-attachment rows now counts as empty here — and a
    // marker nothing will ever clear re-trips this probe on every boot. The
    // `prop_count > 0 || tag_count > 0` branch below already retires it in the
    // same "there is nothing left for a retry to do" situation; these two must
    // agree.
    //
    // #4020: why this retire needs NO `ENGINE_REPROJECT_PENDING_KEY` check,
    // unlike the one at the end of [`recover_attachments_from_op_log`]. That
    // one is conditional because an incomplete engine reprojection means the
    // attachment arms' `EXISTS` guard DROPPED rows a later boot could still
    // restore — there is replayable work outstanding, so the marker must stay
    // armed. Here `op_count == 0` says the replayable set is empty for BOTH
    // passes (the count is the union of `STATE_REPLAYABLE` and
    // `ATTACHMENT_REPLAYABLE`), so no boot can ever restore anything through
    // this marker, whatever the engine reprojection does or does not finish.
    // Nor does retiring it strand that reprojection: `init_pools` gates the
    // engine pass on `engine_reproject_pending(..)` independently of this
    // marker, so the engine retry survives on its own signal.
    //
    // Outside a transaction on purpose: it is one idempotent DELETE with
    // nothing to be atomic WITH — this branch performs no replay — and the
    // replay tx below has not been opened yet. Losing it to a crash costs one
    // re-probe on the next boot, the same cost the marker already trades for.
    if op_count == 0 {
        if marker_pending > 0 {
            clear_derived_recovery_marker(pool).await?;
        }
        return Ok(false);
    }

    if !blocks_recovered_this_boot && marker_pending == 0 {
        return Ok(false);
    }

    // Secondary duplicate-protection guard: only replay into EMPTY derived
    // tables — otherwise we would duplicate / clobber rows.
    //
    // R4 (#347): propagate probe errors with `?` rather than masking them
    // as `0` (which would wrongly trigger a full re-replay against an
    // already-populated DB).
    let prop_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_properties")
        .fetch_one(pool)
        .await?;

    let tag_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_tags")
        .fetch_one(pool)
        .await?;

    // C9 (#345) — the OR is intentional; a per-table gate is NOT safe here.
    // The corruption this recovery targets (a rebuild migration's
    // `DROP TABLE blocks` CASCADE) empties both tables *together*, so any
    // rows in EITHER table mean the DB is already populated and replaying
    // would duplicate.
    //
    // #3268 (the ordering fix): this returns `true`, so the ATTACHMENT pass
    // still runs — and it, not this branch, retires the marker. A populated
    // `block_properties` is exactly what a crash between the two passes leaves
    // behind, so clearing the marker here would strand the attachment replay
    // permanently. The attachment arms are idempotent against a populated
    // `attachments` (`INSERT OR IGNORE` + keyed DELETE/UPDATE in LWW order), so
    // running them here costs a re-read, never a duplicate.
    if prop_count > 0 || tag_count > 0 {
        return Ok(true);
    }

    tracing::warn!(
        "block recovery fired and derived tables are empty (op_log has {} replayable ops) — \
         recovering properties and tags (attachments follow the engine reprojection)",
        op_count
    );

    let mut tx = pool.begin().await?;

    // C8 (#345): replay derived-state ops in the same ascending
    // `(created_at, device_id, seq)` order as `recover_blocks_from_op_log`
    // (`created_at DESC` last-writer-wins semantics via ascending replay
    // with each later write overwriting an earlier one, `(device_id, seq)`
    // as the same-ms tiebreaker). See the rationale there — this is this
    // pass's own convention, not the canonical `(created_at, seq,
    // device_id)` order used elsewhere.
    //
    // #616: streamed in keyset-paginated chunks — see [`fetch_derived_replay_chunk`].
    //
    // #3268: `is_replicated = 0` — replay LOCALLY-AUTHORED ops. Migration 0099
    // makes that filter the isolation boundary that keeps replicated audit rows
    // "provably inert for state"; without it this pass replayed a PEER's
    // `set_property` / `add_tag` ops onto this device. The attachment ops are
    // excluded here entirely and handled by [`recover_attachments_from_op_log`]
    // after the engine reprojection.
    let mut cursor: Option<(i64, String, i64)> = None;
    loop {
        let chunk = fetch_derived_replay_chunk(&mut tx, STATE_REPLAYABLE, cursor.as_ref()).await?;
        if chunk.is_empty() {
            break;
        }

        for row in chunk {
            let op_type: String = row.try_get("op_type")?;
            let payload_str: String = row.try_get("payload")?;
            cursor = Some((
                row.try_get("created_at")?,
                row.try_get("device_id")?,
                row.try_get("seq")?,
            ));
            let payload: serde_json::Value =
                serde_json::from_str(&payload_str).map_err(agaric_core::error::AppError::Json)?;

            match op_type.as_str() {
                "set_property" => {
                    let block_id = payload["block_id"].as_str().unwrap_or("");
                    let key = payload["key"].as_str().unwrap_or("");
                    let value_text = payload
                        .get("value_text")
                        .and_then(serde_json::Value::as_str);
                    let value_num = payload.get("value_num").and_then(serde_json::Value::as_f64);
                    let value_date = payload
                        .get("value_date")
                        .and_then(serde_json::Value::as_str);
                    let value_ref = payload.get("value_ref").and_then(serde_json::Value::as_str);
                    let value_bool = payload
                        .get("value_bool")
                        .and_then(serde_json::Value::as_bool)
                        .map(i64::from);

                    // A `SetProperty` with NO value set is an explicit *clear*
                    // (value = None) — the live projection represents a cleared
                    // property as row-absent, never an all-NULL row. Inserting
                    // the all-NULL row here would violate the `exactly_one_value`
                    // CHECK (migration 0062, which requires exactly one value
                    // column non-NULL) and abort startup with a (275) panic.
                    // Replay it as a DELETE so the LWW order is preserved: a
                    // clear removes any prior value for this (block_id, key).
                    let value_count = i32::from(value_text.is_some())
                        + i32::from(value_num.is_some())
                        + i32::from(value_date.is_some())
                        + i32::from(value_ref.is_some())
                        + i32::from(value_bool.is_some());
                    if value_count == 0 {
                        // #534: reserved keys are column-backed on `blocks` (the
                        // single source of truth); a clear is replayed as nulling
                        // the column, never a `block_properties` DELETE (which is
                        // now CHECK-forbidden for these keys anyway).
                        if let Some(col) = reserved_key_blocks_column(key) {
                            // `col` is a fixed internal literal from the allowlist
                            // in `reserved_key_blocks_column`, never user input.
                            // `space` fans out to the whole owning-page group, like
                            // `project_delete_property_to_sql`; the others are 1:1.
                            let q = if col == "space_id" {
                                sqlx::query(sqlx::AssertSqlSafe(format!(
                                    "UPDATE blocks SET {col} = NULL WHERE id = ? OR page_id = ?"
                                )))
                                .bind(block_id)
                                .bind(block_id)
                            } else {
                                sqlx::query(sqlx::AssertSqlSafe(format!(
                                    "UPDATE blocks SET {col} = NULL WHERE id = ?"
                                )))
                                .bind(block_id)
                            };
                            q.execute(&mut *tx).await?;
                            continue;
                        }
                        sqlx::query("DELETE FROM block_properties WHERE block_id = ? AND key = ?")
                            .bind(block_id)
                            .bind(key)
                            .execute(&mut *tx)
                            .await?;
                        continue;
                    }

                    // #534: reserved keys (`todo_state` / `priority` / `due_date` /
                    // `scheduled_date` / `space`) are column-backed on `blocks` and
                    // are FORBIDDEN in `block_properties` by the migration-0088
                    // CHECK constraint. Route the set to the dedicated `blocks` column
                    // (the same reserved-key→column mapping the projection uses)
                    // instead of inserting a (now-rejected) property row.
                    //
                    // #2043: this arm is INTENTIONALLY left inline, not routed
                    // through `project_set_property_to_sql`. Recovery adds
                    // FK-existence guards the projection LACKS — it skips the op if
                    // the owning block is absent (purged / never reached this
                    // device, below) and skips a dangling `space` ref (#605/#708) —
                    // because recovery runs with `foreign_keys=ON` on every boot, so
                    // a dangling write would trip FK 787 and PERMANENTLY wedge boot.
                    // Dropping those guards to share the projection is unsafe.
                    if let Some(col) = reserved_key_blocks_column(key) {
                        // `space` is value_ref-typed; the date/text keys carry their
                        // value in value_date / value_text respectively. Pick the
                        // payload field that matches the column's storage.
                        let col_value: Option<&str> = match key {
                            "due_date" | "scheduled_date" => value_date,
                            agaric_store::op::SPACE_PROPERTY_KEY => value_ref,
                            _ => value_text,
                        };
                        if key == agaric_store::op::SPACE_PROPERTY_KEY {
                            // #605: `blocks.space_id` carries an FK and recovery
                            // runs with `foreign_keys=ON`, so an op whose target
                            // is absent (purged locally, or created on another
                            // device and never present in the local op_log) would
                            // trip FK 787 — and because recovery re-runs on every
                            // boot until it succeeds, that single dangling ref
                            // becomes a PERMANENT boot failure. Skip the op
                            // instead, exactly like the generic value_ref branch
                            // below: a dead ref means the assignment is dead.
                            // #708: the FK target is now `spaces(id)` (migration
                            // 0089), so the guard checks the registry — a target
                            // that exists as a block but was never flagged
                            // `is_space` (the #612 mis-stamp class) is skipped
                            // too. Replay order keeps legitimate targets
                            // registered before they are referenced: the
                            // `SetProperty(is_space)` op precedes any
                            // `SetProperty(space)` pointing at it, and its
                            // `block_properties` INSERT fires the 0089
                            // `spaces_register_is_space` trigger.
                            // The block keeps its prior (NULL/unchanged) space_id;
                            // a later import / rebuild reconciles once the space
                            // block exists (same degrade contract as
                            // `project_block_full_to_sql`'s subquery stamp).
                            if let Some(target) = col_value {
                                let target_exists: i64 = sqlx::query_scalar(
                                    "SELECT EXISTS(SELECT 1 FROM spaces WHERE id = ?)",
                                )
                                .bind(target)
                                .fetch_one(&mut *tx)
                                .await?;
                                if target_exists == 0 {
                                    tracing::warn!(
                                        block_id,
                                        space_id = target,
                                        "recovery: set_property(space) references a block that \
                                     is not a registered space — skipping (dangling or \
                                     mis-stamped value_ref, #605/#708)"
                                    );
                                    continue;
                                }
                            }
                            // `space` fans out to the whole owning-page group, like
                            // the live projection (`blocks.space_id`).
                            // `col` is a fixed internal literal from the allowlist
                            // in `reserved_key_blocks_column`, never user input.
                            let sql =
                                format!("UPDATE blocks SET {col} = ? WHERE id = ? OR page_id = ?");
                            sqlx::query(sqlx::AssertSqlSafe(sql))
                                .bind(col_value)
                                .bind(block_id)
                                .bind(block_id)
                                .execute(&mut *tx)
                                .await?;
                        } else {
                            // `col` is a fixed internal literal from the allowlist
                            // in `reserved_key_blocks_column`, never user input.
                            let sql = format!("UPDATE blocks SET {col} = ? WHERE id = ?");
                            sqlx::query(sqlx::AssertSqlSafe(sql))
                                .bind(col_value)
                                .bind(block_id)
                                .execute(&mut *tx)
                                .await?;
                        }
                        continue;
                    }

                    // #4020: this `EXISTS` skip now also fires on a
                    // LOCALLY-authored op whose target block is PEER-authored.
                    // `recover_blocks_from_op_log` filters `is_replicated = 0`,
                    // so peer-authored blocks are still absent from `blocks`
                    // while this pass runs — the identical drop that forced the
                    // attachment arms into their own post-reprojection pass
                    // (#3268). It is safe HERE, and only here, because
                    // `reproject_blocks_from_engine` runs next and
                    // DELETE-then-reinserts `block_properties` (and
                    // `block_tags`) per block straight from the engine, which
                    // holds local and peer state alike — so anything this guard
                    // skipped is rewritten from the authoritative source
                    // moments later. `attachments` has no such downstream
                    // repair (it is not Loro-modelled — `pool.rs` states this
                    // for attachments and nothing stated it here), and THAT
                    // asymmetry, not a difference in the guards, is the whole
                    // reason only the attachment arms moved. Do not "fix" this
                    // by moving the property/tag arms after the reprojection
                    // too: they would then be overwritten by it and the local
                    // op-log pass would stop contributing anything.
                    //
                    // Guard the two FK columns (block_id, value_ref → blocks(id)).
                    // An op may reference a block that was purged or created on
                    // another device and is absent from the local op_log, so
                    // inserting blindly would trip FOREIGN KEY constraint failed
                    // (787) and abort startup. Skip the row entirely if its owning
                    // block is gone, or if a non-null value_ref dangles: under the
                    // exactly-one-value invariant (migration 0062) value_ref is the
                    // row's sole value, and its FK is ON DELETE CASCADE, so a dead
                    // ref means the whole property is dead — nulling it would just
                    // trade FK 787 for a CHECK violation on the now all-NULL row.
                    sqlx::query(
                        "INSERT OR REPLACE INTO block_properties \
                     (block_id, key, value_text, value_num, value_date, value_ref, value_bool) \
                     SELECT ?, ?, ?, ?, ?, ?, ? \
                     WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?) \
                       AND (? IS NULL OR EXISTS (SELECT 1 FROM blocks WHERE id = ?))",
                    )
                    .bind(block_id)
                    .bind(key)
                    .bind(value_text)
                    .bind(value_num)
                    .bind(value_date)
                    .bind(value_ref)
                    .bind(value_bool)
                    .bind(block_id)
                    .bind(value_ref)
                    .bind(value_ref)
                    .execute(&mut *tx)
                    .await?;
                }
                "delete_property" => {
                    let block_id = payload["block_id"].as_str().unwrap_or("");
                    let key = payload["key"].as_str().unwrap_or("");

                    // #2043: route through the shared projection
                    // (`project_delete_property_to_sql`) instead of re-hand-rolling
                    // the per-key fan-out. It is genuinely equivalent: reserved
                    // keys clear the dedicated `blocks` column (single source of
                    // truth); `space` clears `space_id` for the whole owning-page
                    // group; non-reserved keys DELETE the `block_properties` row —
                    // the same `reserved_key_blocks_column` / `is_reserved_property_key`
                    // dispatch. This arm runs post-migration against the REAL
                    // schema, and a clear-to-NULL / row DELETE cannot trip FK 787,
                    // so there is no FK-guard concern (unlike `set_property` /
                    // `add_tag`, which keep their guards inline). All branches are
                    // idempotent (0-row UPDATE/DELETE no-ops).
                    agaric_engine::loro::projection::project_delete_property_to_sql(
                        &mut tx, block_id, key,
                    )
                    .await?;
                }
                "add_tag" => {
                    let block_id = payload["block_id"].as_str().unwrap_or("");
                    let tag_id = payload["tag_id"].as_str().unwrap_or("");

                    // Both columns are FKs to blocks(id): skip the tag if either
                    // the tagged block or the tag block is absent (purged, or
                    // never created in the local op_log) to avoid FK 787 panic.
                    // #4020: as on the `set_property` arm above, that "absent"
                    // set now includes PEER-authored blocks, which
                    // `recover_blocks_from_op_log`'s `is_replicated = 0` filter
                    // leaves out of `blocks` until the engine reprojection runs.
                    // Safe for the same reason and only that reason:
                    // `reproject_blocks_from_engine` DELETE-then-reinserts
                    // `block_tags` per block from the engine right after this
                    // pass. `attachments` is the exception with no downstream
                    // repair — see the `set_property` arm for the full argument
                    // and for why the fix must not be applied in reverse here.
                    sqlx::query(
                        "INSERT OR IGNORE INTO block_tags (block_id, tag_id) \
                     SELECT ?, ? \
                     WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?) \
                       AND EXISTS (SELECT 1 FROM blocks WHERE id = ?)",
                    )
                    .bind(block_id)
                    .bind(tag_id)
                    .bind(block_id)
                    .bind(tag_id)
                    .execute(&mut *tx)
                    .await?;
                }
                // #614: a later `remove_tag` must win over its earlier `add_tag`
                // (LWW replay order) — the exact analogue of the #374
                // `delete_attachment` arm below. Without this arm every tag the
                // user added and later removed resurrected after a recovery.
                "remove_tag" => {
                    let block_id = payload["block_id"].as_str().unwrap_or("");
                    let tag_id = payload["tag_id"].as_str().unwrap_or("");

                    // #2894: route the `block_tags` delete through the shared
                    // projection (`project_remove_tag_to_sql`) — the exact fn the
                    // engine arm (`apply_remove_tag_via_loro`) and the SQL-only
                    // fallback (`apply_remove_tag_sql_only`) both run — so the
                    // `DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?`
                    // shape lives in ONE place and cannot drift between the three
                    // paths. This is the exact analogue of the already-converged
                    // `delete_property` arm above (#2043): a keyed DELETE cannot
                    // trip FK 787 (it removes a child row), is idempotent (0-row
                    // no-op when the pair is absent), and reads only `block_id` /
                    // `tag_id` straight from the payload — so unlike the `add_tag`
                    // / `set_property` arms it needs NO recovery-only FK-existence
                    // guard, and routing it through the projection is
                    // byte-for-byte equivalent. The inherited-tag cleanup that the
                    // command/sql_only wrappers run AFTER the projection
                    // (`remove_inherited_tag`) is deliberately NOT invoked here:
                    // this replay rebuilds only `block_tags`, exactly as the old
                    // inline DELETE did (the `block_tag_inherited` view is
                    // reconstructed by its own recompute path, not this loop).
                    agaric_engine::loro::projection::project_remove_tag_to_sql(
                        &mut tx, block_id, tag_id,
                    )
                    .await?;
                }
                _ => {}
            }
        }
    }

    // #534: the denormalised reserved-key columns (`todo_state` / `priority`
    // / `due_date` / `scheduled_date` / `space_id`) are written directly in
    // the replay loop above — they are the single source of truth and no
    // longer have backing `block_properties` rows (migration-0088 forbids
    // them), so there is nothing to backfill from `block_properties` here.

    // #3268: the pending marker is NOT cleared here. It is retired by
    // [`recover_attachments_from_op_log`], the second half of this recovery,
    // so a crash between the two passes still leaves the retry signal armed.
    tx.commit().await?;
    Ok(true)
}

/// #616 (the marker's retire path): drop [`DERIVED_RECOVERY_PENDING_KEY`].
/// Standalone (not on the replay tx) for the "nothing left to replay" early
/// returns; the replay path uses the transaction-bound form inline.
async fn clear_derived_recovery_marker(
    pool: &SqlitePool,
) -> Result<(), agaric_core::error::AppError> {
    sqlx::query("DELETE FROM app_settings WHERE key = ?")
        .bind(DERIVED_RECOVERY_PENDING_KEY)
        .execute(pool)
        .await?;
    Ok(())
}

/// #3268: the op-log rows [`recover_derived_state_from_op_log`] replays —
/// LOCALLY-AUTHORED state ops. The attachment op types are excluded because
/// they are replayed by [`recover_attachments_from_op_log`] in a later pass,
/// and replaying them twice in one boot would run them out of LWW order
/// relative to each other.
const STATE_REPLAYABLE: &str = "is_replicated = 0 \
     AND op_type NOT IN ('add_attachment', 'delete_attachment', 'rename_attachment')";

/// #3268: the op-log rows [`recover_attachments_from_op_log`] replays — every
/// attachment op, BOTH provenances (the `add_attachment` arm gates a replicated
/// op on blob possession instead; see that function).
const ATTACHMENT_REPLAYABLE: &str =
    "op_type IN ('add_attachment', 'delete_attachment', 'rename_attachment')";

/// One keyset-paginated chunk of the derived replay, in the same ascending
/// `(created_at, device_id, seq)` last-writer-wins order as
/// `recover_blocks_from_op_log` (see the rationale there).
///
/// #616: the replay streams in chunks instead of one unbounded `fetch_all` — at
/// the 100k-op target a whole-log buffer inside a write tx is a multi-second,
/// multi-MB boot stall. The row-value comparison
/// `(created_at, device_id, seq) > (?, ?, ?)` continues exactly where the
/// previous chunk ended under the same total order; the caller's surrounding tx
/// gives a stable snapshot, so the iteration is consistent.
///
/// #374: `created_at` is selected so the `add_attachment` arm can restore
/// `attachments.created_at` (a NOT NULL column) from the originating op's
/// timestamp — the same value the live `apply_add_attachment_tx` writes.
///
/// Shared by both passes so the paginated and first-chunk forms — and the two
/// passes' column lists — cannot drift apart.
async fn fetch_derived_replay_chunk(
    conn: &mut sqlx::SqliteConnection,
    predicate: &'static str,
    cursor: Option<&(i64, String, i64)>,
) -> Result<Vec<sqlx::sqlite::SqliteRow>, agaric_core::error::AppError> {
    const DERIVED_REPLAY_CHUNK: i64 = 500;
    let rows = match cursor {
        None => {
            // dynamic-sql: the SELECT list and ORDER BY are fixed; the only
            // interpolation is `predicate`, an internal `&'static str` that is
            // one of the two `*_REPLAYABLE` constants above. The macro forms
            // cannot express that sharing.
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "SELECT op_type, payload, created_at, device_id, seq, is_replicated \
                 FROM op_log WHERE {predicate} \
                 ORDER BY created_at, device_id, seq LIMIT ?"
            )))
            .bind(DERIVED_REPLAY_CHUNK)
            .fetch_all(&mut *conn)
            .await?
        }
        Some((ca, dev, seq)) => {
            // dynamic-sql: see the first-chunk query above — same fixed shape,
            // same caller-supplied internal predicate, plus the keyset
            // continuation. All values are bound.
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "SELECT op_type, payload, created_at, device_id, seq, is_replicated \
                 FROM op_log WHERE {predicate} \
                   AND (created_at, device_id, seq) > (?, ?, ?) \
                 ORDER BY created_at, device_id, seq LIMIT ?"
            )))
            .bind(ca)
            .bind(dev)
            .bind(seq)
            .bind(DERIVED_REPLAY_CHUNK)
            .fetch_all(&mut *conn)
            .await?
        }
    };
    Ok(rows)
}

/// The second half of the derived recovery: replay the `attachments` ops.
///
/// **Run this AFTER [`reproject_blocks_from_engine`]** — the caller
/// ([`crate::db::pool::init_pools`] / [`crate::db::init_pool`]) does, and the
/// ordering is the whole point of this function existing separately.
///
/// #3268: every arm here writes through `attachments.block_id REFERENCES
/// blocks(id)`, so the `add_attachment` arm has to guard on the owning block
/// existing (an FK 787 abort at boot is worse than a missing row). But `blocks`
/// is rebuilt in TWO stages: [`recover_blocks_from_op_log`] replays only
/// DEVICE-LOCAL ops (0099's isolation boundary — a peer-authored block's
/// `create_block` is an inert `is_replicated = 1` audit row), and
/// [`reproject_blocks_from_engine`] is the pass that restores everything
/// peer-authored, from the Loro snapshots. Replaying the attachment arms in the
/// first stage's transaction therefore drops EVERY attachment on a
/// peer-authored block — the peer's own and this device's alike — because the
/// owning block does not exist yet. That loss is permanent: `attachments` is
/// the one table `reproject_blocks_from_engine` explicitly cannot repair
/// (pool.rs), the bytes stay orphaned on disk, and the pending marker would
/// have been cleared in the same transaction, so no later boot retries.
///
/// The provenance rules, unchanged from the single-pass version:
///
/// * `attachments` is NOT Loro-modelled, so unlike `block_properties` /
///   `block_tags` a wrong row here can never be corrected downstream — and
///   neither can a dropped one be rebuilt.
/// * `attachments.block_id ... ON DELETE CASCADE` (0081) with `foreign_keys=ON`
///   means the `DROP TABLE blocks` that triggers this recovery deletes EVERY
///   attachment row, including peer-authored ones this device legitimately
///   received via snapshot restore (agaric-sync/src/snapshot/restore.rs).
///   `attachment_blobs` carries no FK (0094), so the BYTES survive on disk. A
///   blanket `is_replicated = 0` filter would orphan them permanently.
/// * So the discriminator is POSSESSION, not authorship: a replicated
///   `add_attachment` is replayed iff this device's content-addressed blob store
///   still holds the file it names. Replicated `delete_attachment` /
///   `rename_attachment` replay unconditionally: they are keyed, idempotent,
///   and in LWW order they are what stops a restored peer row from resurrecting
///   an attachment the peer removed or reverting one it renamed.
///
/// Every arm is idempotent (`INSERT OR IGNORE`, keyed DELETE/UPDATE), so a
/// re-run against an already-populated `attachments` re-reads and changes
/// nothing — which is what lets the gate be "the recovery fired" alone.
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
pub(crate) async fn recover_attachments_from_op_log(
    pool: &SqlitePool,
) -> Result<(), agaric_core::error::AppError> {
    let mut tx = pool.begin().await?;

    let mut cursor: Option<(i64, String, i64)> = None;
    loop {
        let chunk =
            fetch_derived_replay_chunk(&mut tx, ATTACHMENT_REPLAYABLE, cursor.as_ref()).await?;
        if chunk.is_empty() {
            break;
        }

        for row in chunk {
            let op_type: String = row.try_get("op_type")?;
            let payload_str: String = row.try_get("payload")?;
            cursor = Some((
                row.try_get("created_at")?,
                row.try_get("device_id")?,
                row.try_get("seq")?,
            ));
            let payload: serde_json::Value =
                serde_json::from_str(&payload_str).map_err(agaric_core::error::AppError::Json)?;

            match op_type.as_str() {
                // #374: `attachments` is the one AUTHORITATIVE child of `blocks`
                // (its rows are the source of truth for fs_path / mime_type /
                // filename / size_bytes — NOT a derived cache). Migration 0061
                // gave `attachments.block_id` an `ON DELETE CASCADE` to
                // `blocks(id)`, so the `DROP TABLE blocks` in the 0073/0080
                // rebuilds cascade-deleted every attachment row under
                // `foreign_keys=ON`, silently destroying that metadata and
                // orphaning the on-disk files. The op-log `add_attachment`
                // payload carries every column the row needs, so replay it here
                // to restore the table (this pass runs on the same corruption
                // signal as the property/tag pass, one step later — see the
                // function docs).
                "add_attachment" => {
                    let attachment_id = payload["attachment_id"].as_str().unwrap_or("");
                    let block_id = payload["block_id"].as_str().unwrap_or("");
                    let mime_type = payload["mime_type"].as_str().unwrap_or("");
                    // #3029 (SECURITY): the filename comes from a peer's op —
                    // sanitize before it lands in `attachments.filename` so a
                    // hostile `../../evil.sh` can never be replayed into a
                    // traversal-shaped name. Sanitize (never reject): a reject
                    // here would wedge the entire recovery replay on one op.
                    let raw_filename = payload["filename"].as_str().unwrap_or("");
                    let filename = sanitize_attachment_filename(raw_filename);
                    if filename != raw_filename {
                        tracing::warn!(
                            attachment_id,
                            original = raw_filename,
                            sanitized = %filename,
                            "sanitized traversal-unsafe peer attachment filename on recovery replay (add_attachment)"
                        );
                    }
                    let size_bytes = payload["size_bytes"].as_i64().unwrap_or(0);
                    // #3370 (SECURITY): same argument as the filename above, but
                    // for a value that actually reaches the filesystem. Parse the
                    // peer's `fs_path` into the confined canonical form; a value
                    // that cannot be made safe becomes this device's own
                    // `attachments/<attachment_id>` path. Coerce, never reject —
                    // rejecting would wedge the recovery replay.
                    let raw_fs_path = payload["fs_path"].as_str().unwrap_or("");
                    let fs_path = agaric_core::attachment_path::AttachmentFsPath::coerce_from_peer(
                        raw_fs_path,
                        attachment_id,
                    );
                    let fs_path = fs_path.as_str();
                    if fs_path != raw_fs_path {
                        tracing::warn!(
                            attachment_id,
                            original = raw_fs_path,
                            canonical = fs_path,
                            "rewrote unsafe or non-canonical peer attachment fs_path on recovery replay (add_attachment)"
                        );
                    }
                    let created_at: i64 = row.try_get("created_at")?;

                    // #3268: a REPLICATED `add_attachment` is restored only when
                    // this device actually holds the bytes it names. The
                    // `attachment_blobs` row is written by
                    // `register_received_blob` after a hash-verified receive
                    // (agaric-sync/src/sync_files.rs) and keyed by the canonical
                    // `on_disk_path` — the same value the received file was
                    // written to and the same value the op's coerced `fs_path`
                    // resolves to. `attachment_blobs` has no FK to `blocks`, so
                    // it survived the `DROP TABLE blocks` cascade that destroyed
                    // the `attachments` row this op describes.
                    //
                    // Present ⇒ the row was a legitimate, locally-held peer
                    // attachment and dropping it would orphan real bytes forever.
                    // Absent ⇒ the op names a file this device never received,
                    // so materialising a row for it would invent the foreign
                    // metadata #3268 is about. Locally-authored ops are never
                    // gated on this: their blob row may not exist yet (a
                    // pre-0094 vault, or before the boot-time blob backfill has
                    // run), and their provenance is not in question.
                    //
                    // Known conservative case, and it errs the safe way. #1993
                    // dedup (`maybe_link_local_blob`) can repoint an
                    // `attachments` row at ANOTHER blob's canonical file, after
                    // which the originating op's own `fs_path` is no longer a
                    // registered `on_disk_path` and this gate declines — even
                    // though byte-identical content is present under the other
                    // path. Declining costs one unrestored metadata row on the
                    // disaster path; the opposite error would be inventing the
                    // foreign row #3268 was filed about. The tighter key would
                    // be `content_hash`, which `attachment_blobs` is actually
                    // keyed by — but `AddAttachmentPayload`
                    // (agaric-store/src/op.rs) does not carry it, so the op
                    // cannot name its own blob and `fs_path` is the only link
                    // the wire format gives us.
                    let is_replicated: i64 = row.try_get("is_replicated")?;
                    if is_replicated != 0 {
                        // The compile-checked macro: this pass runs AFTER
                        // `sqlx::migrate!`, so `attachment_blobs` (0094) is
                        // always present, and its shape is the guarantee the
                        // gate rests on.
                        let blob_held: i64 = sqlx::query_scalar!(
                            "SELECT COUNT(*) FROM attachment_blobs WHERE on_disk_path = ?",
                            fs_path
                        )
                        .fetch_one(&mut *tx)
                        .await?;
                        if blob_held == 0 {
                            tracing::warn!(
                                attachment_id,
                                fs_path,
                                "skipped a replicated add_attachment on recovery replay: this \
                                 device holds no blob for its fs_path, so the row would describe \
                                 bytes that are not here (#3268)"
                            );
                            continue;
                        }
                    }

                    // Guard the `block_id` FK (→ blocks(id)): an attachment whose
                    // owning block was purged (or never reached this device) must
                    // stay deleted — restoring it would trip FK 787 and abort
                    // startup. `INSERT OR IGNORE` makes a duplicate `add_attachment`
                    // (same id) a no-op and keeps recovery idempotent across boots.
                    //
                    // #3268: this is why the pass runs after the engine
                    // reprojection. `blocks` must already be COMPLETE here —
                    // peer-authored rows included — or this guard reads "the
                    // block is gone" for a block that is merely not restored
                    // YET, and drops metadata nothing downstream can rebuild.
                    // The guard is correct; only its position was not.
                    sqlx::query(
                        "INSERT OR IGNORE INTO attachments \
                     (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
                     SELECT ?, ?, ?, ?, ?, ?, ? \
                     WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?)",
                    )
                    .bind(attachment_id)
                    .bind(block_id)
                    .bind(mime_type)
                    .bind(filename)
                    .bind(size_bytes)
                    .bind(fs_path)
                    .bind(created_at)
                    .bind(block_id)
                    .execute(&mut *tx)
                    .await?;
                }
                // #374: a later `delete_attachment` must win over its earlier
                // `add_attachment` (LWW replay order), so drop any row this op
                // removed — otherwise recovery would resurrect a deleted file.
                "delete_attachment" => {
                    let attachment_id = payload["attachment_id"].as_str().unwrap_or("");

                    sqlx::query("DELETE FROM attachments WHERE id = ?")
                        .bind(attachment_id)
                        .execute(&mut *tx)
                        .await?;
                }
                // #651: replay `rename_attachment` so a recovered attachment
                // keeps its post-rename filename instead of reverting to the
                // `add_attachment` original. LWW replay order means the last
                // rename wins, mirroring the live `apply_rename_attachment_tx`.
                // No-op if the row was never restored (owning block purged —
                // the add_attachment arm above skipped it).
                "rename_attachment" => {
                    let attachment_id = payload["attachment_id"].as_str().unwrap_or("");
                    let raw_new_filename = payload["new_filename"].as_str().unwrap_or("");

                    // Preserve the existing empty-skip (an empty rename is a
                    // no-op), but #3029: sanitize any non-empty peer filename
                    // before store so a hostile rename can't replay a
                    // traversal-shaped name onto the attachment.
                    if !raw_new_filename.is_empty() {
                        let new_filename = sanitize_attachment_filename(raw_new_filename);
                        if new_filename != raw_new_filename {
                            tracing::warn!(
                                attachment_id,
                                original = raw_new_filename,
                                sanitized = %new_filename,
                                "sanitized traversal-unsafe peer attachment filename on recovery replay (rename_attachment)"
                            );
                        }
                        sqlx::query("UPDATE attachments SET filename = ? WHERE id = ?")
                            .bind(new_filename)
                            .bind(attachment_id)
                            .execute(&mut *tx)
                            .await?;
                    }
                }
                _ => {}
            }
        }
    }

    // #616 / #3268: retire the pending marker only now — this is the LAST pass
    // of the recovery, so a crash anywhere before this commit leaves the whole
    // sequence armed for the next boot's retry.
    //
    // ...unless the engine reprojection is still incomplete. `attachments` rows
    // whose owning block lives in a space whose snapshot failed to decode are
    // still un-restorable this boot (the `EXISTS` guard drops them), and
    // `ENGINE_REPROJECT_PENDING_KEY` is precisely the "some blocks are still
    // missing" signal. Clearing the marker while it is armed would be the same
    // premature retirement this split exists to fix, one layer out. Keeping both
    // markers costs one idempotent re-replay per boot — the trade
    // `ENGINE_REPROJECT_PENDING_KEY` already documents for itself — until the
    // reprojection lands fully, at which point the next boot retires both.
    let engine_retry_pending: i64 =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM app_settings WHERE key = ?")
            .bind(ENGINE_REPROJECT_PENDING_KEY)
            .fetch_one(&mut *tx)
            .await?;
    if engine_retry_pending == 0 {
        // dynamic-sql: a fixed literal with a bound key — no interpolation and
        // no runtime-assembled fragment. Runtime rather than `query!` only
        // because it shares this file's pre-migration era, where the macro's
        // compile-time schema check cannot be relied on.
        sqlx::query("DELETE FROM app_settings WHERE key = ?")
            .bind(DERIVED_RECOVERY_PENDING_KEY)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// #618 / #851: the TEXT-era (pre-0080) `restore_block` cohort branch in
    /// [`recover_blocks_from_op_log`]. Before migration 0080, `deleted_at` was
    /// rfc3339 TEXT, so the cohort guard cannot string-compare against the
    /// epoch-ms `deleted_at_ref`; it converts the stored TEXT via
    /// `julianday()→ms` and compares on the parsed value. This drives that
    /// branch directly with `deleted_at_is_ms = false`: only the cohort whose
    /// `deleted_at` parses to `deleted_at_ref` is un-deleted; a sibling row
    /// tombstoned at a different time stays deleted, and a descendant of the
    /// restored root is resurrected with it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_text_era_restore_block_cohort_julianday_branch() {
        let (pool, _dir) = test_pool().await;

        // The migrated DB created an INTEGER-era `blocks` table; drop it and
        // recreate the pre-0080 TEXT-era shape (`deleted_at TEXT`) so the
        // recovery's julianday() branch is exercised, not the ms branch.
        sqlx::query("DROP TABLE IF EXISTS blocks")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE blocks (
                 id             TEXT NOT NULL PRIMARY KEY,
                 block_type     TEXT NOT NULL DEFAULT 'content',
                 content        TEXT,
                 parent_id      TEXT,
                 position       INTEGER,
                 deleted_at     TEXT,
                 todo_state     TEXT,
                 priority       TEXT,
                 due_date       TEXT,
                 scheduled_date TEXT,
                 page_id        TEXT
             )",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Cohort timestamps: the restore op targets the cohort deleted at
        // `ref_ms`; a sibling was deleted one second later (a DIFFERENT
        // cohort) and must NOT be resurrected.
        let ref_ms: i64 = 1_767_225_600_000; // 2026-01-01T00:00:00Z
        let ref_rfc3339 = "2026-01-01T00:00:00.000Z";
        let other_ms: i64 = ref_ms + 1000;
        let other_rfc3339 = "2026-01-01T00:00:01.000Z";

        // root + child belong to the restored cohort; sibling is a separate
        // cohort tombstoned at a different time.
        let seed = |id: &'static str, parent: Option<&'static str>, deleted_at: &'static str| {
            let pool = pool.clone();
            async move {
                sqlx::query(
                    "INSERT INTO blocks (id, block_type, content, parent_id, deleted_at) \
                     VALUES (?, 'content', '', ?, ?)",
                )
                .bind(id)
                .bind(parent)
                .bind(deleted_at)
                .execute(&pool)
                .await
                .unwrap();
            }
        };
        seed("root", None, ref_rfc3339).await;
        seed("child", Some("root"), ref_rfc3339).await;
        seed("sibling", None, other_rfc3339).await;
        let _ = other_ms; // documents the sibling's distinct cohort ms

        // A single restore_block op for `root`, carrying the cohort token in
        // epoch-ms (the era-independent payload shape).
        let payload = serde_json::json!({
            "block_id": "root",
            "deleted_at_ref": ref_ms,
        })
        .to_string();
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES ('dev', 1, NULL, 'h1', 'restore_block', ?, ?)",
        )
        .bind(&payload)
        .bind(ref_ms)
        .execute(&pool)
        .await
        .unwrap();

        // Drive recovery through the TEXT-era branch.
        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ false)
            .await
            .unwrap();
        drop(conn);

        let deleted_at = |id: &'static str| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, Option<String>>(
                    "SELECT deleted_at FROM blocks WHERE id = ?",
                )
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
            }
        };

        assert!(
            deleted_at("root").await.is_none(),
            "TEXT-era restore must un-delete the cohort root (julianday match)"
        );
        assert!(
            deleted_at("child").await.is_none(),
            "TEXT-era restore must cascade to the root's descendant"
        );
        assert!(
            deleted_at("sibling").await.is_some(),
            "TEXT-era restore must NOT resurrect a different cohort \
             (deleted_at parses to a different ms via julianday)"
        );
    }

    /// #1252: recovery must honor the new-scheme (#400/#603) `index`/`new_index`
    /// sibling-placement fields, not just the legacy `position`/`new_position`.
    ///
    /// Production `create_block` ops have carried only a 0-based `index` (with
    /// `position` OMITTED — `CreateBlockPayload.position` is
    /// `skip_serializing_if = "Option::is_none"`) since #400. The old recovery
    /// arm read only `payload["position"]`, so every recovered block got
    /// `position = NULL` and `ORDER BY position` collapsed siblings to ULID
    /// order. This seeds three siblings created in REVERSE id order at
    /// ascending `index` slots (and one moved via `new_index`), then asserts the
    /// recovered `ORDER BY position, id` matches the index order — NOT the ulid
    /// order. Fails on the pre-fix code (all positions NULL ⇒ id order).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_honors_new_scheme_index_for_sibling_order() {
        let (pool, _dir) = test_pool().await;

        // Seed a new-scheme `create_block` op carrying ONLY `index` (no
        // `position` key — exactly how production serializes #400 creates).
        let seed_create = |id: &'static str, index: i64, seq: i64| {
            let pool = pool.clone();
            async move {
                let payload = serde_json::json!({
                    "block_id": id,
                    "block_type": "content",
                    "parent_id": "parent",
                    "index": index,
                    "content": id,
                })
                .to_string();
                // Guard: the bug is that `position` is ABSENT on new-scheme ops.
                assert!(
                    !payload.contains("\"position\""),
                    "new-scheme create payload must omit the legacy position key"
                );
                sqlx::query(
                    "INSERT INTO op_log \
                     (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                     VALUES ('dev', ?, NULL, ?, 'create_block', ?, ?)",
                )
                .bind(seq)
                .bind(format!("h{seq}"))
                .bind(&payload)
                .bind(1_767_225_600_000_i64 + seq)
                .execute(&pool)
                .await
                .unwrap();
            }
        };

        // The parent itself, then three children created at slots 0,1,2 — but
        // in REVERSE id order, so an id/ULID-collapse would invert them.
        seed_create("parent", 0, 1).await;
        seed_create("ccc", 0, 2).await;
        seed_create("bbb", 1, 3).await;
        seed_create("aaa", 2, 4).await;

        // A new-scheme `move_block` carrying ONLY `new_index` (mirrors the
        // breadcrumb `new_position`, but recovery must route on `new_index`).
        // Move "aaa" to slot 0 — it should sort first after recovery.
        let move_payload = serde_json::json!({
            "block_id": "aaa",
            "new_parent_id": "parent",
            "new_position": 1, // stale breadcrumb; new_index is authoritative
            "new_index": 0,
        })
        .to_string();
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES ('dev', 5, NULL, 'h5', 'move_block', ?, ?)",
        )
        .bind(&move_payload)
        .bind(1_767_225_600_005_i64)
        .execute(&pool)
        .await
        .unwrap();

        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        // Recovered sibling order by the canonical key. Pre-fix: all positions
        // NULL ⇒ id order [aaa, bbb, ccc]. Post-fix: index order, with the
        // moved "aaa" at slot 0 ⇒ position 1, then ccc (idx0→pos1 on create but
        // unmoved), bbb (idx1→pos2)... assert the moved node sorts first and
        // the create-index order is preserved among the others.
        let order: Vec<String> = sqlx::query_scalar::<_, String>(
            "SELECT id FROM blocks WHERE parent_id = 'parent' \
             ORDER BY position ASC, id ASC",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        // Verify no sibling has a NULL position (the core defect).
        let null_positions: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM blocks WHERE parent_id = 'parent' AND position IS NULL",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            null_positions, 0,
            "recovery must derive a position from `index`/`new_index`, not write NULL (#1252)"
        );

        // "aaa" was moved to new_index 0 ⇒ provisional position 1 ⇒ sorts
        // first; this must NOT be the id-order coincidence, so also assert the
        // unmoved siblings keep their create-index order relative to each other.
        assert_eq!(
            order.first().map(String::as_str),
            Some("aaa"),
            "moved-to-slot-0 block must sort first by recovered position, got {order:?}"
        );
        let ccc = order.iter().position(|id| id == "ccc").unwrap();
        let bbb = order.iter().position(|id| id == "bbb").unwrap();
        assert!(
            ccc < bbb,
            "create-index order must be preserved (ccc@idx0 before bbb@idx1), got {order:?}"
        );
    }

    // ---------------------------------------------------------------------
    // #4187: the `move_block` arm's live-block-under-a-tombstone sweep.
    // ---------------------------------------------------------------------

    /// Seed one `op_log` row. `created_at` is doing two jobs at once and both
    /// matter to these tests: it is the replay key
    /// (`ORDER BY created_at, device_id, seq`), so the order the test writes IS
    /// the order recovery replays, and for a `delete_block` it is also the
    /// cohort timestamp the delete arm stamps into `deleted_at` (#429).
    async fn seed_replay_op(
        pool: &SqlitePool,
        seq: i64,
        op_type: &str,
        payload: &serde_json::Value,
        created_at: i64,
    ) {
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES ('dev', ?, NULL, ?, ?, ?, ?)",
        )
        .bind(seq)
        .bind(format!("h{seq}"))
        .bind(op_type)
        .bind(payload.to_string())
        .bind(created_at)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn seed_create_op(
        pool: &SqlitePool,
        seq: i64,
        id: &str,
        parent: Option<&str>,
        created_at: i64,
    ) {
        seed_replay_op(
            pool,
            seq,
            "create_block",
            &serde_json::json!({
                "block_id": id,
                "block_type": "content",
                "parent_id": parent,
                "index": 0,
                "content": id,
            }),
            created_at,
        )
        .await;
    }

    async fn seed_move_op(
        pool: &SqlitePool,
        seq: i64,
        id: &str,
        new_parent: &str,
        created_at: i64,
    ) {
        seed_replay_op(
            pool,
            seq,
            "move_block",
            &serde_json::json!({
                "block_id": id,
                "new_parent_id": new_parent,
                "new_index": 0,
            }),
            created_at,
        )
        .await;
    }

    async fn seed_delete_op(pool: &SqlitePool, seq: i64, id: &str, created_at: i64) {
        seed_replay_op(
            pool,
            seq,
            "delete_block",
            &serde_json::json!({ "block_id": id }),
            created_at,
        )
        .await;
    }

    /// Panics when the row is absent, so every caller's `Some`/`None` is about
    /// `deleted_at` and never about a missing block.
    async fn deleted_at_ms(pool: &SqlitePool, id: &str) -> Option<i64> {
        sqlx::query_scalar::<_, Option<i64>>("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn parent_of(pool: &SqlitePool, id: &str) -> Option<String> {
        sqlx::query_scalar::<_, Option<String>>("SELECT parent_id FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// #4187 (the issue's acceptance case). `{Delete(P), Move(B → P)}` with the
    /// delete's `created_at` first — the ordinary concurrent delete-vs-move
    /// pair. Recovery replays the delete, tombstoning `P`, then the move, which
    /// reparents the still-LIVE `B` under it. Pre-fix the rebuilt table held an
    /// invisible orphan: `B` absent from the tree (its ancestor is trashed) and
    /// absent from the trash (it is not) — the exact state #4112 closed on the
    /// materializer's two arms, silently reintroduced by the third interpreter
    /// of the same op.
    ///
    /// The moved block joins `P`'s cohort at `P`'s own `deleted_at`, and so
    /// does its subtree (`C`) — the same cascade the delete-last replay order
    /// would have produced, which is what makes the two orders converge.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_move_under_a_tombstoned_ancestor_joins_its_deletion_cohort() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;

        seed_create_op(&pool, 1, "P", None, T0 + 1).await;
        seed_create_op(&pool, 2, "B", None, T0 + 2).await;
        seed_create_op(&pool, 3, "C", Some("B"), T0 + 3).await;
        seed_delete_op(&pool, 4, "P", T0 + 4).await;
        seed_move_op(&pool, 5, "B", "P", T0 + 5).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        // The cohort anchor, produced by the delete arm (#429) — the value the
        // sweep has to reproduce, not a value this test wrote.
        let cohort = deleted_at_ms(&pool, "P").await;
        assert_eq!(
            cohort,
            Some(T0 + 4),
            "the delete arm stamps the op's own created_at as the cohort timestamp"
        );

        assert_eq!(
            parent_of(&pool, "B").await.as_deref(),
            Some("P"),
            "the move must still be APPLIED — sweeping the block is not the same as \
             dropping a peer's op, which would diverge from the move-first replay order"
        );
        assert_eq!(
            deleted_at_ms(&pool, "B").await,
            cohort,
            "#4187: a live block moved under a tombstoned ancestor must join that \
             ancestor's deletion cohort, not stay live under it"
        );
        assert_eq!(
            deleted_at_ms(&pool, "C").await,
            cohort,
            "#4187: the sweep is a subtree cascade, like the delete arm's — a descendant \
             of the moved block is stamped with the same cohort timestamp"
        );
        assert_eq!(
            diagnostics.move_swept_under_tombstone,
            vec!["B".to_string()],
            "the reconciliation must be reported through ReplayDiagnostics (#3269 R5: the \
             replay may run twice, so it reports rather than logs)"
        );
    }

    /// #4233, the move sweep's half of the reach pair. The sweep and the
    /// `delete_block` arm are the two ways the same op pair can be replayed
    /// (`{Delete(P), Move(B → P)}` lands here, `{Move(B → P), Delete(P)}` in
    /// the delete arm), so they must agree on REACH or recovery diverges with
    /// itself across replay orders (#4187).
    ///
    /// `B > X(tombstoned) > Y(live)`, then `Move(B → P)` with `P` tombstoned.
    /// The sweep's walk is `CascadeReach::Active`: it stops AT `X` instead of
    /// descending through it, so `Y` keeps its `NULL` and R9's Pass C sweep is
    /// still free to give it `X`'s cohort — the nearest tombstoned ancestor in
    /// the converged tree (#4188/#4204). The pre-#4233 standard walk reached
    /// `Y` and stamped it with `P`'s cohort instead, which the resurrection
    /// guard then cements.
    ///
    /// Reddens if this arm goes back to `CascadeReach::Standard`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_move_sweep_stops_at_a_tombstoned_child() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;

        seed_create_op(&pool, 1, "P", None, T0 + 1).await;
        seed_create_op(&pool, 2, "B", None, T0 + 2).await;
        seed_create_op(&pool, 3, "X", Some("B"), T0 + 3).await;
        seed_delete_op(&pool, 4, "X", T0 + 4).await;
        // Created AFTER X's delete — live under a tombstone, exactly the row
        // the two walks disagree about.
        seed_create_op(&pool, 5, "Y", Some("X"), T0 + 5).await;
        seed_delete_op(&pool, 6, "P", T0 + 6).await;
        seed_move_op(&pool, 7, "B", "P", T0 + 7).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        // The sweep DID fire — without this the `Y` assertion below would pass
        // for the wrong reason.
        assert_eq!(
            diagnostics.move_swept_under_tombstone,
            vec!["B".to_string()],
            "the live subject moved under a tombstoned ancestor is swept"
        );
        assert_eq!(
            deleted_at_ms(&pool, "B").await,
            Some(T0 + 6),
            "the swept subject joins the ancestor's cohort"
        );
        assert_eq!(
            deleted_at_ms(&pool, "X").await,
            Some(T0 + 4),
            "the already-tombstoned child keeps its OWN cohort (the write guard)"
        );
        assert_eq!(
            deleted_at_ms(&pool, "Y").await,
            None,
            "#4233: the walk STOPS at the tombstoned X, so the live block below it is not \
             in the cohort at all — stamping it with P's cohort would cement the wrong \
             answer past R9's Pass C sweep"
        );
    }

    /// The negative half of the same property: the sweep must not fire on the
    /// overwhelmingly common shape. `Move(B → P)` with `P` LIVE leaves `B`
    /// (and its subtree) live. Reddens on an over-broad sweep — e.g. one that
    /// keyed on "the move happened" rather than on an actually-tombstoned
    /// ancestor, or whose ancestor probe treated a NULL `deleted_at` as a hit.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_move_under_a_live_parent_stays_live() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;

        seed_create_op(&pool, 1, "P", None, T0 + 1).await;
        seed_create_op(&pool, 2, "B", None, T0 + 2).await;
        seed_create_op(&pool, 3, "C", Some("B"), T0 + 3).await;
        seed_move_op(&pool, 4, "B", "P", T0 + 4).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        assert_eq!(parent_of(&pool, "B").await.as_deref(), Some("P"));
        for id in ["P", "B", "C"] {
            assert_eq!(
                deleted_at_ms(&pool, id).await,
                None,
                "an ordinary move under a LIVE parent must tombstone nothing ({id})"
            );
        }
        assert!(
            diagnostics.move_swept_under_tombstone.is_empty(),
            "no reconciliation happened, so nothing may be reported: {:?}",
            diagnostics.move_swept_under_tombstone
        );
    }

    /// AGENTS.md invariant #9, on the one CTE this arm introduces: the
    /// ancestor probe's `depth < 100` bound sits in the RECURSIVE member, so a
    /// corrupted `parent_id` CYCLE terminates at the cap instead of recursing
    /// until the process dies.
    ///
    /// The cycle is not hypothetical here. This replay deliberately carries no
    /// cycle probe (#2894 — unlike `apply_move_block_sql_only`, which runs the
    /// shared `move_would_cycle`), so a corrupt op_log CAN close a loop:
    /// `Move(A → B)` where `B` is already a child of `A` gives `A → B → A`.
    /// The probe for the NEXT move then climbs it. Nothing in the loop is
    /// tombstoned, so the only correct answer is "no tombstoned ancestor" —
    /// and the replay must simply finish, which is the assertion that a bound
    /// hoisted into the seed (or dropped) would not survive.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_move_sweep_terminates_on_a_corrupt_parent_cycle() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;

        seed_create_op(&pool, 1, "A", None, T0 + 1).await;
        seed_create_op(&pool, 2, "B", Some("A"), T0 + 2).await;
        seed_create_op(&pool, 3, "C", None, T0 + 3).await;
        // Closes the loop: A's parent becomes its own child B.
        seed_move_op(&pool, 4, "A", "B", T0 + 4).await;
        // A live block moved INTO the loop, so its probe has to climb it.
        seed_move_op(&pool, 5, "C", "A", T0 + 5).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        assert_eq!(parent_of(&pool, "A").await.as_deref(), Some("B"));
        assert_eq!(parent_of(&pool, "C").await.as_deref(), Some("A"));
        for id in ["A", "B", "C"] {
            assert_eq!(
                deleted_at_ms(&pool, id).await,
                None,
                "no member of a LIVE cycle is a tombstoned ancestor, so nothing \
                 may be swept ({id})"
            );
        }
        assert!(
            diagnostics.move_swept_under_tombstone.is_empty(),
            "nothing was swept: {:?}",
            diagnostics.move_swept_under_tombstone
        );
    }

    /// The half of the local command path's guard that must NOT be mirrored
    /// here, pinned so a later "make recovery match `validate_move_in_tx`"
    /// change reddens: a move whose SUBJECT is already tombstoned is applied
    /// unchanged and keeps its ORIGINAL cohort.
    ///
    /// `{Delete(B), Delete(P), Move(B → P)}`: `B` is trashed at its own
    /// timestamp before the move, so the move is the ordinary trash shape, not
    /// an invisible orphan — and re-stamping it into `P`'s cohort would make
    /// `RestoreBlock` on `B`'s own cohort token miss it. Two guards carry that,
    /// and this test takes both:
    ///
    /// * the ancestor probe's seed `deleted_at IS NULL` (a tombstoned subject
    ///   yields no seed row, hence no sweep) — observable through `C`, which
    ///   the op log creates UNDER `B` *after* `B`'s delete (a peer adding a
    ///   child to a block another device concurrently deleted), so it is live
    ///   under a tombstone before the move ever runs. It stays untouched: this
    ///   arm mirrors the materializer sweep's `Some(Some(_))` early return, and
    ///   that pre-existing orphan is #4188/#4204 residue, not this arm's to
    ///   repair;
    /// * the cascade's own `deleted_at IS NULL`, which preserves `B`'s original
    ///   cohort exactly as the delete arm's cascade does.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_move_of_an_already_tombstoned_block_keeps_its_original_cohort() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;

        seed_create_op(&pool, 1, "P", None, T0 + 1).await;
        seed_create_op(&pool, 2, "B", None, T0 + 2).await;
        seed_delete_op(&pool, 3, "B", T0 + 3).await;
        // Created AFTER B's delete, so the cascade never saw it: live child of
        // a tombstoned parent.
        seed_create_op(&pool, 4, "C", Some("B"), T0 + 4).await;
        seed_delete_op(&pool, 5, "P", T0 + 5).await;
        seed_move_op(&pool, 6, "B", "P", T0 + 6).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        assert_eq!(
            parent_of(&pool, "B").await.as_deref(),
            Some("P"),
            "the move is applied even though both endpoints are trashed"
        );
        assert_eq!(
            deleted_at_ms(&pool, "B").await,
            Some(T0 + 3),
            "an already-tombstoned subject keeps ITS cohort token — re-stamping it into \
             the new ancestor's cohort would strand it on a RestoreBlock of its own cohort"
        );
        assert_eq!(
            deleted_at_ms(&pool, "C").await,
            None,
            "the sweep does not fire at all on a tombstoned subject (the ancestor probe's \
             seed guard), so a pre-existing orphan under it is left exactly as it was"
        );
        assert!(
            diagnostics.move_swept_under_tombstone.is_empty(),
            "nothing was swept: {:?}",
            diagnostics.move_swept_under_tombstone
        );
        assert!(
            diagnostics.move_unswept_inherited_cohort.is_empty(),
            "#4204: an INTRINSIC tombstone (B was deleted in its own right) is not \
             inherited, so the un-sweep must not fire either: {:?}",
            diagnostics.move_unswept_inherited_cohort
        );
    }

    /// #4204 in the THIRD interpreter. Recovery replays the same op log as the
    /// materializer (#2894), so an un-sweep that lives only in
    /// `apply_move_block_via_loro` / `apply_move_block_sql_only` is undone by
    /// the next boot rebuild — the divergence comes straight back.
    ///
    /// `{Delete(P1), Move(B: P1 → P2)}` with `P2` LIVE. `B`'s tombstone is
    /// INHERITED (`P1`'s cascade stamped it), and the move takes it to a
    /// position where nothing implies it, so the whole moved subtree is
    /// re-derived as live — while the sibling the move left behind keeps `P1`'s
    /// cohort, which is what distinguishes a re-derivation from undoing the
    /// delete.
    ///
    /// Deleting the un-sweep block from the `move_block` arm reddens this on
    /// `B` and `C` (both stay stamped at `P1`'s cohort).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_move_out_of_an_inherited_cohort_onto_a_live_parent_restores_it_4204() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;

        seed_create_op(&pool, 1, "P1", None, T0 + 1).await;
        seed_create_op(&pool, 2, "P2", None, T0 + 2).await;
        seed_create_op(&pool, 3, "B", Some("P1"), T0 + 3).await;
        seed_create_op(&pool, 4, "C", Some("B"), T0 + 4).await;
        seed_create_op(&pool, 5, "SIB", Some("P1"), T0 + 5).await;
        seed_delete_op(&pool, 6, "P1", T0 + 6).await;
        seed_move_op(&pool, 7, "B", "P2", T0 + 7).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        assert_eq!(
            deleted_at_ms(&pool, "P1").await,
            Some(T0 + 6),
            "precondition: the delete arm stamped P1's own cohort"
        );
        assert_eq!(
            deleted_at_ms(&pool, "P2").await,
            None,
            "precondition: the target parent is LIVE throughout — the shape in which \
             #4187's sweep has nothing to find"
        );
        assert_eq!(parent_of(&pool, "B").await.as_deref(), Some("P2"));
        assert_eq!(
            deleted_at_ms(&pool, "B").await,
            None,
            "#4204: an INHERITED tombstone is positional; the move invalidated it and \
             the new chain is entirely live"
        );
        assert_eq!(
            deleted_at_ms(&pool, "C").await,
            None,
            "#4204: the re-derivation covers the moved COHORT — a live B over a \
             trashed C would be a fresh invisible orphan"
        );
        assert_eq!(
            deleted_at_ms(&pool, "SIB").await,
            Some(T0 + 6),
            "#4204: the sibling that did NOT move stays in P1's cohort — the un-sweep \
             re-derives one subtree, it does not undo the delete"
        );
        assert_eq!(
            diagnostics.move_unswept_inherited_cohort,
            vec!["B".to_string()],
            "the reconciliation is reported through ReplayDiagnostics (#3269 R5: the \
             replay may run twice, so it reports rather than logs)"
        );
        assert!(
            diagnostics.move_swept_under_tombstone.is_empty(),
            "nothing to sweep INTO — the new ancestor chain is live: {:?}",
            diagnostics.move_swept_under_tombstone
        );
    }

    /// #4188 in the third interpreter, the neighbouring half: the target parent
    /// is trashed too, in a DIFFERENT cohort.
    ///
    /// `{Delete(P1)@t1, Delete(P2)@t2, Move(B: P1 → P2)}`. The un-sweep clears
    /// the inherited `t1` and the EXISTING #4187 sweep re-stamps `t2` in the
    /// same op, so the block stays trashed and only its restore cohort moves —
    /// to the one its final position implies. `B` is reported by BOTH
    /// diagnostics, which is the observable difference between this shape and
    /// the one above.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_move_between_two_deleted_parents_restamps_to_the_target_cohort_4188() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;

        seed_create_op(&pool, 1, "P1", None, T0 + 1).await;
        seed_create_op(&pool, 2, "P2", None, T0 + 2).await;
        seed_create_op(&pool, 3, "B", Some("P1"), T0 + 3).await;
        seed_create_op(&pool, 4, "C", Some("B"), T0 + 4).await;
        seed_create_op(&pool, 5, "SIB", Some("P1"), T0 + 5).await;
        seed_delete_op(&pool, 6, "P1", T0 + 6).await;
        seed_delete_op(&pool, 7, "P2", T0 + 7).await;
        seed_move_op(&pool, 8, "B", "P2", T0 + 8).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        assert_eq!(deleted_at_ms(&pool, "P1").await, Some(T0 + 6));
        assert_eq!(
            deleted_at_ms(&pool, "P2").await,
            Some(T0 + 7),
            "precondition: the two cohorts are DISTINGUISHABLE, or every assertion \
             below is vacuous"
        );
        assert_eq!(parent_of(&pool, "B").await.as_deref(), Some("P2"));
        for id in ["B", "C"] {
            assert_eq!(
                deleted_at_ms(&pool, id).await,
                Some(T0 + 7),
                "#4188: {id} must end in the TARGET's cohort (t2) — the cohort its \
                 final position implies, not whichever cascade caught it first"
            );
        }
        assert_eq!(
            deleted_at_ms(&pool, "SIB").await,
            Some(T0 + 6),
            "#4188: the sibling that did not move keeps t1"
        );
        assert_eq!(
            diagnostics.move_unswept_inherited_cohort,
            vec!["B".to_string()],
            "the inherited cohort was cleared"
        );
        assert_eq!(
            diagnostics.move_swept_under_tombstone,
            vec!["B".to_string()],
            "#4188: and the EXISTING #4187 sweep re-stamped it — a block in both \
             lists is a re-stamp, a block in the un-sweep list ALONE came back"
        );
    }

    /// The negative half: a move that does NOT change which cohort the new
    /// position implies must leave `deleted_at` alone.
    ///
    /// `{Delete(P), Move(B: P → SUB)}` where `SUB` is `P`'s other child, so
    /// both endpoints are in ONE cohort. Clearing and re-stamping would land on
    /// the same value, but it would churn the row (and, on the engine arm, the
    /// CRDT register) for no state change — so the short-circuit is asserted
    /// through the diagnostics, which are the only place the difference between
    /// "did nothing" and "did and undid" is visible.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_move_within_one_cohort_does_not_unsweep_4188() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;

        seed_create_op(&pool, 1, "P", None, T0 + 1).await;
        seed_create_op(&pool, 2, "B", Some("P"), T0 + 2).await;
        seed_create_op(&pool, 3, "SUB", Some("P"), T0 + 3).await;
        seed_delete_op(&pool, 4, "P", T0 + 4).await;
        seed_move_op(&pool, 5, "B", "SUB", T0 + 5).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        assert_eq!(parent_of(&pool, "B").await.as_deref(), Some("SUB"));
        for id in ["P", "SUB", "B"] {
            assert_eq!(
                deleted_at_ms(&pool, id).await,
                Some(T0 + 4),
                "a move WITHIN one cohort keeps every row at that cohort's ts ({id})"
            );
        }
        assert!(
            diagnostics.move_unswept_inherited_cohort.is_empty(),
            "#4188: the new position implies the SAME cohort, so the un-sweep must \
             short-circuit rather than clear-and-re-stamp: {:?}",
            diagnostics.move_unswept_inherited_cohort
        );
        assert!(
            diagnostics.move_swept_under_tombstone.is_empty(),
            "#4204: and the sweep must not fire either. The subject is still \
             tombstoned (the un-sweep short-circuited, so nothing cleared it), which \
             is exactly the case `sweep_move_under_tombstoned_ancestor`'s \
             live-subject guard declines — a sweep reported here is a cascade that \
             stamped rows the materializer left alone: {:?}",
            diagnostics.move_swept_under_tombstone
        );
    }

    /// The recovery MIRROR of `unsweep_short_circuits_a_move_within_one_cohort_4188`
    /// (`crate::materializer::handlers::move_convergence_tests`) — the half of
    /// that pair this arm was missing, and the absence that let #4204's widened
    /// ancestor probe trash a live block on boot repair.
    ///
    /// Same fixture as the test above plus ONE row: `G`, created under `B`
    /// AFTER `P`'s delete, so it is LIVE under a tombstone before the move ever
    /// runs (a peer adding a child to a block another device concurrently
    /// deleted). Then `Move(B → SUB)`, both endpoints in `P`'s ONE cohort.
    ///
    /// The materializer answers "`G` stays live" twice over: the un-sweep
    /// short-circuits (`SUB` already carries `t`, so `B`'s tombstone is never
    /// cleared), and `sweep_move_under_tombstoned_ancestor`'s live-subject
    /// guard then declines a subject whose own row is still tombstoned. Both
    /// guards must hold HERE too, and they are independent: the probe's `?2`
    /// widening makes `tombstoned_ancestor` `Some` for a subject the sweep must
    /// not touch, so the sweep needs its own reason to stay quiet — the
    /// un-sweep having actually CLEARED. Without that gate this cascade stamps
    /// `G` at `t` and a boot rebuild silently moves a live block into the
    /// trash, in exactly the lockstep the un-sweep exists to preserve.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_move_within_one_cohort_leaves_a_live_orphan_alone_4188() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;

        seed_create_op(&pool, 1, "P", None, T0 + 1).await;
        seed_create_op(&pool, 2, "B", Some("P"), T0 + 2).await;
        seed_create_op(&pool, 3, "SUB", Some("P"), T0 + 3).await;
        seed_delete_op(&pool, 4, "P", T0 + 4).await;
        // Created AFTER the cascade, so it never saw it: live under a tombstone.
        seed_create_op(&pool, 5, "G", Some("B"), T0 + 5).await;
        seed_move_op(&pool, 6, "B", "SUB", T0 + 6).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        assert_eq!(parent_of(&pool, "B").await.as_deref(), Some("SUB"));
        for id in ["P", "SUB", "B"] {
            assert_eq!(
                deleted_at_ms(&pool, id).await,
                Some(T0 + 4),
                "precondition: the move stays WITHIN one cohort, so every row the \
                 delete caught keeps that cohort's ts ({id})"
            );
        }
        assert_eq!(
            deleted_at_ms(&pool, "G").await,
            None,
            "#4204: the PRE-EXISTING live orphan is none of this move's business. \
             The materializer leaves it live (short-circuit, then the sweep's \
             live-subject guard); recovery is the third interpreter of the same op \
             (#2894) and must agree, or a boot rebuild puts a live block in the trash"
        );
        assert!(
            diagnostics.move_unswept_inherited_cohort.is_empty(),
            "#4188: the new position implies the SAME cohort, so the un-sweep \
             short-circuits: {:?}",
            diagnostics.move_unswept_inherited_cohort
        );
        assert!(
            diagnostics.move_swept_under_tombstone.is_empty(),
            "#4204: and with nothing cleared, the subject is still tombstoned — the \
             case the materializer's sweep declines outright: {:?}",
            diagnostics.move_swept_under_tombstone
        );
    }

    // ---------------------------------------------------------------------
    // #4232: every recursive cascade here stops dead at DESCENDANT_DEPTH_CAP.
    //
    // The engine's R27 walks re-anchor past the cap and warn; these cannot (the
    // batched walk is written against the head shape and this pass runs before
    // `sqlx::migrate!`). So the truncation stays and the SILENCE goes: each of
    // the five capped walks in this file now files a `CascadeTruncation`
    // naming itself and the depth it stopped at.
    //
    // The shape is reachable on a healthy vault: a merged sync tree may be
    // deeper than any locally-enforced bound, because no single device's
    // create-path guard constrains what a merge produces.
    //
    // Every truncation test below is paired with a boundary NEGATIVE at exactly
    // the cap, so an over-broad probe (one that fired on any deep-ish tree, or
    // was off by one) reddens rather than passing by luck.
    // ---------------------------------------------------------------------

    /// Seed `create_block` ops for one chain `<prefix>0` (root, no parent) →
    /// `<prefix>1` → … → `<prefix>{depth}`, i.e. `depth` levels BELOW the root.
    /// `created_at` tracks `seq` so the replay order is the seeding order.
    /// Returns the next free `seq`.
    async fn seed_chain(
        pool: &SqlitePool,
        prefix: &str,
        depth: usize,
        t0: i64,
        first_seq: i64,
    ) -> i64 {
        let mut seq = first_seq;
        for level in 0..=depth {
            let id = format!("{prefix}{level}");
            let parent = (level > 0).then(|| format!("{prefix}{}", level - 1));
            seed_create_op(pool, seq, &id, parent.as_deref(), t0 + seq).await;
            seq += 1;
        }
        seq
    }

    /// [`DESCENDANT_DEPTH_CAP`] as a chain length / index bound. A helper rather
    /// than an `as` cast at each site, which is a lossy-cast lint.
    fn depth_cap() -> usize {
        usize::try_from(DESCENDANT_DEPTH_CAP).expect("the depth cap is a small positive constant")
    }

    async fn block_exists(pool: &SqlitePool, id: &str) -> bool {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
            > 0
    }

    fn truncation(cascade: &'static str, block_id: &str) -> CascadeTruncation {
        CascadeTruncation {
            cascade,
            block_id: block_id.to_owned(),
        }
    }

    /// #4232 acceptance, on the `delete_block` cascade (#429). A chain one
    /// level deeper than the cap: the cascade stamps the cohort down to the
    /// frontier and stops, leaving `c{CAP+1}` LIVE under a tombstoned ancestor
    /// — an invisible orphan the rebuilt table carries and the live one does
    /// not.
    ///
    /// Pre-fix this replay returned a `ReplayDiagnostics` with nothing in it:
    /// the truncated rebuild was byte-for-byte indistinguishable from a
    /// complete one.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_delete_cascade_reports_its_depth_cap_truncation() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;
        let cap = depth_cap();

        let seq = seed_chain(&pool, "c", cap + 1, T0, 1).await;
        seed_delete_op(&pool, seq, "c0", T0 + seq).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        // The truncation is REAL, not merely announced: the cap's frontier is
        // in the cohort and the block one step past it is not.
        assert_eq!(
            deleted_at_ms(&pool, &format!("c{cap}")).await,
            Some(T0 + seq),
            "the cascade reaches exactly to the depth cap"
        );
        assert_eq!(
            deleted_at_ms(&pool, &format!("c{}", cap + 1)).await,
            None,
            "one level past the cap is left LIVE under a tombstoned ancestor — the \
             truncation this test exists to make visible"
        );

        assert_eq!(
            diagnostics.cascade_truncations,
            vec![truncation(CASCADE_DELETE, "c0")],
            "#4232: the delete cascade must REPORT which walk truncated, on which seed, \
             and at what depth — reported rather than logged (#3269 R5: the replay may \
             run twice)"
        );
    }

    /// The boundary negative for the same cascade: a chain exactly AT the cap
    /// is fully reached, so nothing may be reported. Reddens on an off-by-one
    /// probe (one bounded at the cap instead of one past it) and on any probe
    /// that fires on depth alone rather than on tree left unreached.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_delete_cascade_at_exactly_the_cap_reports_nothing() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;
        let cap = depth_cap();

        let seq = seed_chain(&pool, "c", cap, T0, 1).await;
        seed_delete_op(&pool, seq, "c0", T0 + seq).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        for level in 0..=cap {
            assert_eq!(
                deleted_at_ms(&pool, &format!("c{level}")).await,
                Some(T0 + seq),
                "a chain at exactly the cap is stamped end to end (c{level})"
            );
        }
        assert_eq!(
            diagnostics.cascade_truncations,
            vec![],
            "nothing was left unreached, so nothing may be reported"
        );
    }

    /// #4232 on the `restore_block` cascade (#613), and the harm is the mirror
    /// image: the deep tail stays TOMBSTONED after a restore that should have
    /// raised it.
    ///
    /// Two deletes at the same `created_at` put the whole `CAP + 1`-deep chain
    /// into ONE cohort (the second seeds at the frontier, so it reaches past
    /// where the first stopped; the `deleted_at IS NULL` guard leaves the
    /// already-stamped rows alone). The restore then keys on that shared token
    /// and truncates at the cap.
    ///
    /// Also pins that the report is per-WALK, not per-replay: the first delete
    /// truncates and the second does not, so the vector names two cascades, in
    /// replay order, not one aggregate "something truncated".
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_restore_cascade_reports_its_depth_cap_truncation() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;
        let cap = depth_cap();

        let seq = seed_chain(&pool, "c", cap + 1, T0, 1).await;
        let cohort = T0 + seq;
        seed_delete_op(&pool, seq, "c0", cohort).await;
        // Same cohort timestamp, seeded at the frontier: sweeps up the tail the
        // first cascade could not reach. Its own subtree is 1 deep, so THIS
        // delete does not truncate.
        seed_delete_op(&pool, seq + 1, &format!("c{cap}"), cohort).await;
        seed_replay_op(
            &pool,
            seq + 2,
            "restore_block",
            &serde_json::json!({ "block_id": "c0", "deleted_at_ref": cohort }),
            cohort + 1,
        )
        .await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        assert_eq!(
            deleted_at_ms(&pool, &format!("c{cap}")).await,
            None,
            "the restore reaches exactly to the depth cap"
        );
        assert_eq!(
            deleted_at_ms(&pool, &format!("c{}", cap + 1)).await,
            Some(cohort),
            "one level past the cap stays TRASHED after a restore of its own cohort — \
             the restore-side truncation"
        );

        assert_eq!(
            diagnostics.cascade_truncations,
            vec![
                truncation(CASCADE_DELETE, "c0"),
                truncation(CASCADE_RESTORE, "c0"),
            ],
            "#4232: one entry per truncated WALK, naming which cascade — the frontier \
             delete reached everything below it and must NOT appear"
        );
    }

    /// #4232 on the `purge_block` cascade (#615), whose truncation is the worst
    /// of the four descendant walks: the unreached tail survives the purge with
    /// a dangling `parent_id`.
    ///
    /// #4287 changed what happens next. The truncation is still REPORTED — the
    /// walk really was cut off, and that is what `cascade_truncations` records
    /// — but the tail is no longer left for the orphan cleanup to promote to a
    /// live top-level block (the resurrection #615 closed). It is finished off
    /// by [`purge_truncated_tails`] instead, and that repair is reported in its
    /// own right.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_purge_cascade_reports_its_depth_cap_truncation() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;
        let cap = depth_cap();

        let seq = seed_chain(&pool, "c", cap + 1, T0, 1).await;
        seed_replay_op(
            &pool,
            seq,
            "purge_block",
            &serde_json::json!({ "block_id": "c0" }),
            T0 + seq,
        )
        .await;

        let mut conn = pool.acquire().await.unwrap();
        // `ensure_blocks_table_exists` wraps the head-shaped attempt in a
        // transaction carrying `PRAGMA defer_foreign_keys = ON`, so the replay's
        // intermediate states (dangling `parent_id`s, `page_id` derived only
        // afterwards) are legal and only the committed state is checked; the
        // scaffold fallback has no FK constraints at all. These tests call the
        // replay directly, in autocommit, where that deferral has nothing to
        // attach to — so stand it in per-connection. Without it the truncated
        // purge (whose surviving tail still points at a deleted parent) aborts
        // on an immediate FK check and the test never reaches the behaviour it
        // is about.
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&mut *conn)
            .await
            .unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        let tail = format!("c{}", cap + 1);
        assert!(
            !block_exists(&pool, &format!("c{cap}")).await,
            "the purge's first step reaches exactly to the depth cap"
        );
        assert!(
            !block_exists(&pool, &tail).await,
            "#4287: one level past the cap survives that first step, but must NOT survive \
             the replay — the orphan cleanup would otherwise adopt it as a live top-level block"
        );

        assert_eq!(
            diagnostics.cascade_truncations,
            vec![truncation(CASCADE_PURGE, "c0")],
            "#4232: the purge cascade must name itself, so a post-mortem can tell \
             an incomplete purge from a merely incomplete trash cohort"
        );
        assert_eq!(
            diagnostics.purge_tails_finished,
            vec![tail],
            "#4287: and the repair names the frontier head it re-anchored from"
        );
        assert_eq!(
            diagnostics.purge_tail_rows_removed, 1,
            "#4287: exactly the one unreached row went with it"
        );
    }

    /// #4287 acceptance, on the path that makes the loss USER-VISIBLE.
    ///
    /// The `blocks`-table state is what makes the resurrection plausible; the
    /// SEARCH HIT is what makes it a broken deletion guarantee. A purge
    /// cascade truncated by the depth cap used to leave its tail live with a
    /// dangling `parent_id`, which the post-replay orphan cleanup NULLed —
    /// producing a block that is
    ///
    /// * invisible in the outline (`parent_id IS NULL` + `block_type =
    ///   'content'` ⇒ `page_id` stays NULL through the whole derivation loop,
    ///   so every `WHERE page_id = ?` read misses it), and
    /// * absent from the trash (`deleted_at IS NULL`, so it cannot be
    ///   re-deleted from there), and yet
    /// * fully indexed, because `rebuild_fts_index` selects
    ///   `WHERE deleted_at IS NULL AND content IS NOT NULL` with no tree
    ///   filter at all, and recovery runs that rebuild synchronously.
    ///
    /// So the test drives the real search command after the real FTS rebuild,
    /// not just a `SELECT` against `blocks`. Deeper than `CAP + 1` on purpose:
    /// the tail carries a subtree of its own, whose parent links stayed valid,
    /// so a fix that only removed the frontier row would still leave the rest
    /// of the purged content searchable.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_truncated_purge_leaves_no_searchable_survivor() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;
        // A distinctive token so the search cannot match seeded noise, and so a
        // hit names the resurrected content unambiguously.
        const MARKER: &str = "purgemarker4287";
        let cap = depth_cap();
        // Two levels past the cap: `p{CAP+1}` is the unreachable frontier and
        // `p{CAP+2}` hangs off it with an intact parent link.
        let deepest = cap + 2;

        let mut seq = 1i64;
        for level in 0..=deepest {
            let id = format!("p{level}");
            let parent = (level > 0).then(|| format!("p{}", level - 1));
            seed_replay_op(
                &pool,
                seq,
                "create_block",
                &serde_json::json!({
                    "block_id": id,
                    "block_type": "content",
                    "parent_id": parent,
                    "index": 0,
                    "content": format!("{MARKER} level {level}"),
                }),
                T0 + seq,
            )
            .await;
            seq += 1;
        }
        seed_replay_op(
            &pool,
            seq,
            "purge_block",
            &serde_json::json!({ "block_id": "p0" }),
            T0 + seq,
        )
        .await;

        let mut conn = pool.acquire().await.unwrap();
        // As `recover_purge_cascade_reports_its_depth_cap_truncation`: the
        // production caller wraps this in a transaction carrying
        // `PRAGMA defer_foreign_keys = ON`, which is precisely what turns the
        // dangling `parent_id` from an immediate abort into a silent
        // resurrection. Stand it in per-connection so the direct call reaches
        // the same behaviour.
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&mut *conn)
            .await
            .unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        assert_eq!(
            diagnostics.cascade_truncations,
            vec![truncation(CASCADE_PURGE, "p0")],
            "premise: the cascade really was cut off by the depth cap"
        );

        // The rebuild's own FTS seed, run exactly as recovery runs it.
        agaric_store::fts::rebuild_fts_index(&pool).await.unwrap();
        let hits = crate::commands::queries::search_blocks_inner(
            &pool,
            MARKER.to_string(),
            None,
            None,
            agaric_store::search_types::SearchFilter::default(),
            None,
        )
        .await
        .unwrap();
        let ids: Vec<&str> = hits.items.iter().map(|r| r.id.as_str()).collect();
        assert!(
            ids.is_empty(),
            "#4287: NOTHING the user hard-purged may come back as a searchable block; \
             search returned {ids:?}"
        );

        // The table state behind that guarantee, so a failure says which half
        // broke.
        for level in 0..=deepest {
            let id = format!("p{level}");
            assert!(
                !block_exists(&pool, &id).await,
                "#4287: `{id}` is inside the purged subtree and must be gone"
            );
        }
        assert_eq!(
            diagnostics.purge_tails_finished,
            vec![format!("p{}", cap + 1)],
            "#4287: the repair names the frontier head it re-anchored from"
        );
        assert_eq!(
            diagnostics.purge_tail_rows_removed, 2,
            "#4287: the frontier row AND the subtree hanging off it"
        );
    }

    /// #4287 review, over-delete direction: the tail repair must not sweep up
    /// blocks that were never purged.
    ///
    /// `create_block` (`INSERT OR IGNORE`) and `move_block` (an unconditional
    /// `UPDATE`) both accept a `parent_id` that does not exist, so an op
    /// replayed AFTER a truncated purge can park a live block under the
    /// surviving tail — the everyday "peer B edited under a subtree peer A
    /// purged" merge. A repair deferred to the end of the replay would then
    /// walk that block into its cascade and hard-delete it, with no trash row
    /// and no op naming it.
    ///
    /// The unbounded cascade this repair emulates would have removed the tail
    /// at purge time, leaving the later `move_block` to point `x` at an id that
    /// no longer exists — an orphan, which the blanket cleanup adopts as a live
    /// top-level block. So `x` SURVIVES, and the purged chain does not.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn truncated_purge_repair_spares_a_block_moved_under_the_tail_afterwards() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;
        let cap = depth_cap();
        let tail = format!("c{}", cap + 1);

        // The chain to be purged, plus an unrelated live block with a child.
        let mut seq = seed_chain(&pool, "c", cap + 1, T0, 1).await;
        seed_create_op(&pool, seq, "x", None, T0 + seq).await;
        seq += 1;
        seed_create_op(&pool, seq, "xkid", Some("x"), T0 + seq).await;
        seq += 1;
        seed_replay_op(
            &pool,
            seq,
            "purge_block",
            &serde_json::json!({ "block_id": "c0" }),
            T0 + seq,
        )
        .await;
        seq += 1;
        // Replayed after the purge: parks `x` under the row the cascade could
        // not reach.
        seed_replay_op(
            &pool,
            seq,
            "move_block",
            &serde_json::json!({ "block_id": "x", "new_parent_id": tail, "new_index": 0 }),
            T0 + seq,
        )
        .await;

        let mut conn = pool.acquire().await.unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&mut *conn)
            .await
            .unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        assert_eq!(
            diagnostics.cascade_truncations,
            vec![truncation(CASCADE_PURGE, "c0")],
            "premise: the cascade really was cut off by the depth cap"
        );
        assert!(
            block_exists(&pool, "x").await && block_exists(&pool, "xkid").await,
            "#4287 review: `x` was never purged — the repair must not follow a \
             parent link created after the purge and destroy it"
        );
        assert_eq!(
            parent_of(&pool, "x").await,
            None,
            "and it lands where an unbounded cascade would have left it: orphaned \
             by the vanished parent, then adopted by the blanket cleanup"
        );
        assert!(
            !block_exists(&pool, &tail).await && !block_exists(&pool, "c0").await,
            "the purged chain itself is still gone"
        );
        assert_eq!(
            diagnostics.purge_tail_rows_removed, 1,
            "exactly the one unreached row — not `x`, and not `xkid`"
        );
    }

    /// #4287 review, under-delete direction: a row moved OUT of the tail before
    /// the end of the replay must not escape the repair.
    ///
    /// Mirror of the case above, and the one that breaks #4287's own acceptance
    /// criterion. With the repair deferred to the end of the replay, the
    /// re-anchored cascade from the frontier head saw a subtree its child had
    /// already left, so hard-purged content stayed live and FTS-indexed under a
    /// surviving parent. Under an unbounded cascade that row was gone at purge
    /// time and the later `move_block` would have matched no rows at all.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn truncated_purge_repair_catches_a_row_moved_out_of_the_tail_afterwards() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;
        const MARKER: &str = "escapemarker4287";
        let cap = depth_cap();
        // Two past the cap, so the frontier head at `cap + 1` has a child of
        // its own to lose.
        let escapee = format!("c{}", cap + 2);

        let mut seq = 1i64;
        for level in 0..=(cap + 2) {
            let id = format!("c{level}");
            let parent = (level > 0).then(|| format!("c{}", level - 1));
            seed_replay_op(
                &pool,
                seq,
                "create_block",
                &serde_json::json!({
                    "block_id": id,
                    "block_type": "content",
                    "parent_id": parent,
                    "index": 0,
                    "content": format!("{MARKER} level {level}"),
                }),
                T0 + seq,
            )
            .await;
            seq += 1;
        }
        // A live block outside the purged chain, to move the escapee under.
        seed_create_op(&pool, seq, "keeper", None, T0 + seq).await;
        seq += 1;
        seed_replay_op(
            &pool,
            seq,
            "purge_block",
            &serde_json::json!({ "block_id": "c0" }),
            T0 + seq,
        )
        .await;
        seq += 1;
        seed_replay_op(
            &pool,
            seq,
            "move_block",
            &serde_json::json!({ "block_id": escapee, "new_parent_id": "keeper", "new_index": 0 }),
            T0 + seq,
        )
        .await;

        let mut conn = pool.acquire().await.unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&mut *conn)
            .await
            .unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        assert_eq!(
            diagnostics.cascade_truncations,
            vec![truncation(CASCADE_PURGE, "c0")],
            "premise: the cascade really was cut off by the depth cap"
        );
        assert!(
            !block_exists(&pool, &escapee).await,
            "#4287 review: `{escapee}` is inside the purged subtree — a later \
             `move_block` must not be able to carry it back out alive"
        );

        agaric_store::fts::rebuild_fts_index(&pool).await.unwrap();
        let hits = crate::commands::queries::search_blocks_inner(
            &pool,
            MARKER.to_string(),
            None,
            None,
            agaric_store::search_types::SearchFilter::default(),
            None,
        )
        .await
        .unwrap();
        let ids: Vec<&str> = hits.items.iter().map(|r| r.id.as_str()).collect();
        assert!(
            ids.is_empty(),
            "#4287: NOTHING the user hard-purged may come back as a searchable block; \
             search returned {ids:?}"
        );
        assert!(
            block_exists(&pool, "keeper").await,
            "the block it was moved under is untouched"
        );
    }

    /// #4289 (1): the truncation answer and the rows the cascade acts on come
    /// from ONE materialised walk, so they cannot diverge.
    ///
    /// Before this, a separate depth-100 probe walked the subtree for an
    /// `EXISTS` and the cascade's DML walked it again; the two recursive arms
    /// were kept byte-identical by hand, which is a property an edit can break
    /// silently. This asserts the structural version: after
    /// [`materialize_cascade_cohort`], the temp cohort holds exactly the rows
    /// the DML will key on, and the truncation flag plus
    /// [`cascade_cohort_unreached_children`] are read off those same rows.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cascade_cohort_answers_truncation_from_the_rows_the_cascade_acts_on() {
        let (pool, _dir) = test_pool().await;
        let cap = depth_cap();

        // Build the chain directly: this is a unit test of the walk, not of the
        // replay loop around it.
        for level in 0..=(cap + 1) {
            let parent = (level > 0).then(|| format!("w{}", level - 1));
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'content', 'w', ?, 0)",
            )
            .bind(format!("w{level}"))
            .bind(parent)
            .execute(&pool)
            .await
            .unwrap();
        }

        let mut conn = pool.acquire().await.unwrap();
        let truncated = materialize_cascade_cohort(&mut conn, "w0", CascadeReach::Standard)
            .await
            .unwrap();
        assert!(
            truncated,
            "a chain one level past the cap is truncated by construction"
        );

        let cohort: Vec<(String, i64)> =
            sqlx::query_as("SELECT id, depth FROM recovery_cascade_cohort ORDER BY depth")
                .fetch_all(&mut *conn)
                .await
                .unwrap();
        assert_eq!(
            cohort.len(),
            cap + 1,
            "the cohort IS the cascade's row set: depths 0..=CAP and nothing more"
        );
        assert_eq!(
            cohort.last().map(|(id, depth)| (id.as_str(), *depth)),
            Some((format!("w{cap}").as_str(), DESCENDANT_DEPTH_CAP)),
            "and it stops exactly at the cap"
        );
        assert_eq!(
            cascade_cohort_unreached_children(&mut conn).await.unwrap(),
            vec![format!("w{}", cap + 1)],
            "the unreached frontier is read off those same rows, not a second walk"
        );

        // The negative half: a subtree that fits reports nothing, and the
        // cohort still holds the whole thing.
        let shallow_root = format!("w{}", cap - 1);
        let truncated =
            materialize_cascade_cohort(&mut conn, &shallow_root, CascadeReach::Standard)
                .await
                .unwrap();
        assert!(
            !truncated,
            "a subtree that fits inside the cap is not truncated"
        );
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM recovery_cascade_cohort")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
        assert_eq!(
            rows, 3,
            "and the cohort still carries the full subtree the DML will act on"
        );
    }

    /// #4289 (2): the truncation site list is bounded, and still reports the
    /// true total.
    ///
    /// `cascade_truncations` grows per truncated OP and has a documented
    /// high-frequency BENIGN trigger (every `move_block` under a merged chain
    /// deeper than the cap, with no tombstone anywhere), so the record most
    /// likely to matter is the one most likely to be flooded.
    #[test]
    fn truncation_site_list_is_head_bounded_and_names_the_true_total() {
        let over = MAX_REPORTED_TRUNCATION_SITES + 7;
        let flood: Vec<CascadeTruncation> = (0..over)
            .map(|i| truncation(CASCADE_MOVE_SWEEP_ANCESTOR_PROBE, &format!("b{i}")))
            .collect();

        let sites = format_truncation_sites(&flood);
        assert_eq!(
            sites.matches(CASCADE_MOVE_SWEEP_ANCESTOR_PROBE).count(),
            MAX_REPORTED_TRUNCATION_SITES,
            "at most the head-N sites are listed, got: {sites}"
        );
        assert!(
            sites.contains(&format!("`b{}`", MAX_REPORTED_TRUNCATION_SITES - 1)),
            "the last listed site is the N-th, got: {sites}"
        );
        assert!(
            !sites.contains(&format!("`b{MAX_REPORTED_TRUNCATION_SITES}`")),
            "the N+1-th site is counted, not listed, got: {sites}"
        );
        assert!(
            sites.ends_with("…and 7 more"),
            "the suffix must report the TRUE remaining count, got: {sites}"
        );

        // Under the bound nothing is elided and no suffix appears.
        let few: Vec<CascadeTruncation> = (0..3)
            .map(|i| truncation(CASCADE_PURGE, &format!("s{i}")))
            .collect();
        let sites = format_truncation_sites(&few);
        assert!(
            !sites.contains("more"),
            "a short list must not grow a suffix, got: {sites}"
        );
        assert_eq!(
            sites.matches(CASCADE_PURGE).count(),
            3,
            "and must list every site, got: {sites}"
        );
    }

    /// #4232 on the `move_block` arm's DOWNWARD sweep (#4187). `P` is trashed,
    /// `b0` is moved under it carrying a `CAP + 1`-deep subtree; the sweep
    /// stamps the cohort to the cap and stops, so the tail stays live under a
    /// tombstone — the invisible orphan #4187 exists to remove, reintroduced
    /// below depth 100.
    ///
    /// The upward probe here is NOT truncated (`P` is the parent, depth 1), so
    /// exactly one entry appears and it names the sweep, not the probe.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_move_sweep_cascade_reports_its_depth_cap_truncation() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;
        let cap = depth_cap();

        let seq = seed_chain(&pool, "b", cap + 1, T0, 1).await;
        seed_create_op(&pool, seq, "P", None, T0 + seq).await;
        seed_delete_op(&pool, seq + 1, "P", T0 + seq + 1).await;
        seed_move_op(&pool, seq + 2, "b0", "P", T0 + seq + 2).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        let cohort = deleted_at_ms(&pool, "P").await;
        assert_eq!(cohort, Some(T0 + seq + 1), "P's own cohort anchor");
        assert_eq!(
            diagnostics.move_swept_under_tombstone,
            vec!["b0".to_string()],
            "the sweep DID fire — this test is about its reach, not its trigger"
        );
        assert_eq!(
            deleted_at_ms(&pool, &format!("b{cap}")).await,
            cohort,
            "the sweep reaches exactly to the depth cap"
        );
        assert_eq!(
            deleted_at_ms(&pool, &format!("b{}", cap + 1)).await,
            None,
            "one level past the cap is left live under a tombstoned ancestor"
        );

        assert_eq!(
            diagnostics.cascade_truncations,
            vec![truncation(CASCADE_MOVE_SWEEP, "b0")],
            "#4232: the sweep cascade truncated; its ancestor probe (P is the parent, \
             depth 1) did not, and must not be reported"
        );
    }

    /// #4232 on the fifth capped walk — the `move_block` arm's UPWARD
    /// nearest-tombstoned-ancestor probe, which the issue's list of four does
    /// not name.
    ///
    /// `c0` is trashed while childless; the chain `c1..c{CAP}` is then created
    /// UNDER it (a peer adding children to a block another device concurrently
    /// deleted — the shape
    /// `recover_move_of_an_already_tombstoned_block_keeps_its_original_cohort`
    /// already relies on), so every ancestor between `X` and the tombstone is
    /// LIVE. `c0` therefore sits at depth `CAP + 1` from `X`, one step beyond
    /// the probe, and the sweep does not fire at all.
    ///
    /// This is the truncation whose silence is most complete: no cohort is
    /// stamped, no row differs from a correct no-op, and pre-fix the returned
    /// diagnostics were empty — identical to the overwhelmingly common case of
    /// a move under a live parent.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_move_ancestor_probe_reports_its_depth_cap_truncation() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;
        let cap = depth_cap();

        seed_create_op(&pool, 1, "c0", None, T0 + 1).await;
        seed_delete_op(&pool, 2, "c0", T0 + 2).await;
        let mut seq = 3;
        for level in 1..=cap {
            seed_create_op(
                &pool,
                seq,
                &format!("c{level}"),
                Some(&format!("c{}", level - 1)),
                T0 + seq,
            )
            .await;
            seq += 1;
        }
        seed_create_op(&pool, seq, "X", None, T0 + seq).await;
        seed_move_op(&pool, seq + 1, "X", &format!("c{cap}"), T0 + seq + 1).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        assert_eq!(
            deleted_at_ms(&pool, "c0").await,
            Some(T0 + 2),
            "the tombstone the probe was supposed to find is really there"
        );
        assert_eq!(
            parent_of(&pool, "X").await,
            Some(format!("c{cap}")),
            "the move is applied regardless"
        );
        assert_eq!(
            deleted_at_ms(&pool, "X").await,
            None,
            "the probe missed the tombstone at depth CAP+1, so X is left live under a \
             trashed root — the silent wrong answer"
        );
        assert!(
            diagnostics.move_swept_under_tombstone.is_empty(),
            "no sweep fired: {:?}",
            diagnostics.move_swept_under_tombstone
        );

        assert_eq!(
            diagnostics.cascade_truncations,
            vec![truncation(CASCADE_MOVE_SWEEP_ANCESTOR_PROBE, "X")],
            "#4232: an unbounded probe would have found the tombstone, so the capped one \
             must say it ran out of rope"
        );
    }

    /// The boundary positive's mirror, one level shallower: `c0` sits at
    /// exactly depth `CAP` from `X`, the production probe reaches it, the sweep
    /// fires, and nothing is reported.
    ///
    /// What this pins is the SWEEP at the cap boundary, not the truncation
    /// probe. Because the tombstone is found, the climb's
    /// `ancestor_climb_truncated` answer is never consulted here at all, so this
    /// case is blind to both an off-by-one
    /// in that probe and to the loss of the `is_none()` suppression guard — the
    /// two shapes it reads as if it rejected. Those are pinned by
    /// `recover_move_ancestor_probe_at_exactly_the_cap_with_no_tombstone_reports_nothing`
    /// and
    /// `recover_move_ancestor_probe_suppressed_when_a_tombstone_was_found_within_the_cap`
    /// respectively.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_move_ancestor_probe_at_exactly_the_cap_reports_nothing() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;
        let cap = depth_cap();
        // `c0` is at depth `chain_len + 1` from X; we want exactly `cap`.
        let chain_len = cap - 1;

        seed_create_op(&pool, 1, "c0", None, T0 + 1).await;
        seed_delete_op(&pool, 2, "c0", T0 + 2).await;
        let mut seq = 3;
        for level in 1..=chain_len {
            seed_create_op(
                &pool,
                seq,
                &format!("c{level}"),
                Some(&format!("c{}", level - 1)),
                T0 + seq,
            )
            .await;
            seq += 1;
        }
        seed_create_op(&pool, seq, "X", None, T0 + seq).await;
        seed_move_op(&pool, seq + 1, "X", &format!("c{chain_len}"), T0 + seq + 1).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        assert_eq!(
            deleted_at_ms(&pool, "X").await,
            Some(T0 + 2),
            "the probe reaches the tombstone at exactly the cap, so X joins its cohort"
        );
        assert_eq!(
            diagnostics.move_swept_under_tombstone,
            vec!["X".to_string()],
            "the sweep fired"
        );
        assert_eq!(
            diagnostics.cascade_truncations,
            vec![],
            "the walk answered completely, so nothing may be reported"
        );
    }

    /// The upward probe's REAL boundary negative: the probe is consulted (no
    /// tombstone is found, so the `is_none()` arm runs) and the chain's top
    /// sits at exactly depth `CAP` from `X`, so the climb answered completely.
    ///
    /// Unlike
    /// `recover_move_ancestor_probe_at_exactly_the_cap_reports_nothing`, which
    /// finds a tombstone and therefore never reaches the probe, this is the
    /// case an off-by-one probe cannot pass: bounded at `CAP` instead of
    /// `CAP + 1` it would see `c0` at depth `CAP` and report a truncation on a
    /// walk that ran to the root.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_move_ancestor_probe_at_exactly_the_cap_with_no_tombstone_reports_nothing() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;
        let cap = depth_cap();
        // `c0` ends up at depth `chain_len + 1` from `X`; we want exactly `cap`.
        let chain_len = cap - 1;

        // Every block LIVE: no delete op anywhere in the log.
        let mut seq = seed_chain(&pool, "c", chain_len, T0, 1).await;
        seed_create_op(&pool, seq, "X", None, T0 + seq).await;
        seq += 1;
        seed_move_op(&pool, seq, "X", &format!("c{chain_len}"), T0 + seq).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        assert_eq!(
            parent_of(&pool, "X").await,
            Some(format!("c{chain_len}")),
            "the move is applied"
        );
        assert_eq!(
            deleted_at_ms(&pool, "X").await,
            None,
            "there is no tombstone to sweep into"
        );
        assert!(
            diagnostics.move_swept_under_tombstone.is_empty(),
            "no sweep fired: {:?}",
            diagnostics.move_swept_under_tombstone
        );
        assert_eq!(
            diagnostics.cascade_truncations,
            vec![],
            "the climb reached the root within the cap, so nothing may be reported"
        );
    }

    /// The suppression rule, which no other test reaches: a tombstone found
    /// WITHIN the cap is by construction the nearest one (`ORDER BY a.depth
    /// LIMIT 1` over ancestors 1..CAP), so the probe must stay silent even
    /// though the chain provably continues past `CAP + 1`.
    ///
    /// `c{CAP}` is tombstoned as a descendant of `delete_block(c{CAP - 1})`, so
    /// `X`'s nearest tombstoned ancestor is at depth 1 — while `c0` sits at
    /// depth `CAP + 1`, exactly the level `ancestor_climb_truncated` reports on.
    /// Dropping the `tombstoned_ancestor.is_none()` guard turns this red; with
    /// it, the answer could not have changed and the report would be noise.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_move_ancestor_probe_suppressed_when_a_tombstone_was_found_within_the_cap() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;
        let cap = depth_cap();

        let mut seq = seed_chain(&pool, "c", cap, T0, 1).await;
        // Trashes `c{cap - 1}` and its only descendant `c{cap}`.
        let cohort = T0 + seq;
        seed_delete_op(&pool, seq, &format!("c{}", cap - 1), cohort).await;
        seq += 1;
        seed_create_op(&pool, seq, "X", None, T0 + seq).await;
        seq += 1;
        seed_move_op(&pool, seq, "X", &format!("c{cap}"), T0 + seq).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        assert_eq!(
            deleted_at_ms(&pool, &format!("c{cap}")).await,
            Some(cohort),
            "the nearest tombstoned ancestor sits at depth 1 from X"
        );
        assert_eq!(
            deleted_at_ms(&pool, "X").await,
            Some(cohort),
            "so the sweep fired and X joined that cohort"
        );
        assert_eq!(
            diagnostics.move_swept_under_tombstone,
            vec!["X".to_string()],
        );
        assert_eq!(
            diagnostics.cascade_truncations,
            vec![],
            "the chain continues to `c0` at depth CAP + 1, but a nearer tombstone was already \
             found, so the unreachable part could not have changed the answer"
        );
    }

    /// #4232, the probe's known FALSE POSITIVE on the upward arm, pinned as a
    /// documented characteristic rather than left as a surprise: `X` is moved
    /// under a chain deeper than the cap that carries NO tombstone at any
    /// depth. The production probe's `None` is the right answer, the sweep is
    /// right not to fire, every row is right — and a truncation is still
    /// reported, because the probe establishes only that the climb was cut off.
    ///
    /// This is the most FREQUENT report on the very vault #4232 is about (a
    /// merged tree deeper than the cap): one per `move_block` op under the deep
    /// chain. `ReplayDiagnostics::emit` therefore says "verify", not "this is
    /// wrong"; making it exact needs the depth-unbounded re-anchoring walk,
    /// i.e. the issue's option 1.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_move_ancestor_probe_reports_a_deep_live_chain_with_no_tombstone() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;
        let cap = depth_cap();

        // One link deeper than the boundary negative above: `c0` lands at
        // depth `CAP + 1` from `X`. Still no delete op anywhere.
        let mut seq = seed_chain(&pool, "c", cap, T0, 1).await;
        seed_create_op(&pool, seq, "X", None, T0 + seq).await;
        seq += 1;
        seed_move_op(&pool, seq, "X", &format!("c{cap}"), T0 + seq).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        // The rebuild is CORRECT: nothing is tombstoned, so an unbounded climb
        // would also have found no tombstoned ancestor and also not swept.
        assert_eq!(deleted_at_ms(&pool, "X").await, None);
        assert_eq!(deleted_at_ms(&pool, "c0").await, None);
        assert!(diagnostics.move_swept_under_tombstone.is_empty());

        assert_eq!(
            diagnostics.cascade_truncations,
            vec![truncation(CASCADE_MOVE_SWEEP_ANCESTOR_PROBE, "X")],
            "structural, not semantic: the climb ran out of rope, which is all the report \
             claims — see `materialize_cascade_cohort`'s \"What the truncation flag does NOT \
             establish\""
        );
    }

    /// #4233: the DOWNWARD arm no longer has that characteristic. Everything
    /// past the cap is already tombstoned in an earlier cohort, and the delete
    /// cascade's walk is now `CascadeReach::Active` — it stops AT the tombstone
    /// rather than descending through it — so there is nothing beyond the cap
    /// the walk would have visited and NO truncation is reported.
    ///
    /// This test previously pinned the opposite (a report on a byte-identical
    /// rebuild) as the accepted downward-arm false positive. It moved with the
    /// reach, because the probe mirrors the cascade's own walk: pruning the
    /// walk makes the probe exact for this shape. A genuinely truncated delete
    /// cascade — a LIVE tail past the cap — still reports, pinned by
    /// `recover_delete_cascade_reports_its_depth_cap_truncation`. The
    /// remaining false-positive shapes are the restore cohort's and the move
    /// arm's upward probe (see `materialize_cascade_cohort`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_delete_cascade_stops_at_an_already_tombstoned_deep_tail() {
        let (pool, _dir) = test_pool().await;
        const T0: i64 = 1_767_225_600_000;
        let cap = depth_cap();
        let tail = format!("c{}", cap + 1);

        let seq = seed_chain(&pool, "c", cap + 1, T0, 1).await;
        // Trash the one node past the cap first, in a cohort of its own.
        seed_delete_op(&pool, seq, &tail, T0 + seq).await;
        seed_delete_op(&pool, seq + 1, "c0", T0 + seq + 1).await;

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        assert_eq!(
            deleted_at_ms(&pool, &tail).await,
            Some(T0 + seq),
            "the deep tail keeps its ORIGINAL cohort — which is exactly what an uncapped \
             cascade would also have left it with, since the guard skips it"
        );
        assert_eq!(
            deleted_at_ms(&pool, &format!("c{cap}")).await,
            Some(T0 + seq + 1),
            "and the reachable cohort is stamped in full"
        );

        assert!(
            diagnostics.cascade_truncations.is_empty(),
            "the Active walk stopped at the tombstoned tail, so nothing past the cap was \
             missed and nothing is reported (#4233); got {:?}",
            diagnostics.cascade_truncations
        );
    }

    /// #618 / #4187: the pre-0080 (TEXT) era. `deleted_at` is rfc3339 TEXT
    /// there, and the sweep has to stay era-correct — which is the concrete
    /// reason it cannot delegate to the materializer's
    /// `sweep_move_under_tombstoned_ancestor`, whose ancestor probe DECODES
    /// `deleted_at` as `i64` and whose cohort write BINDS an `i64`.
    ///
    /// This drives the identical op set as the acceptance test against the
    /// TEXT-era table shape and reads the result back as `String`: an epoch-ms
    /// stamp would either mismatch `P`'s rfc3339 or fail to decode outright.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_text_era_move_sweep_stamps_the_ancestors_rfc3339_cohort() {
        let (pool, _dir) = test_pool().await;

        // Replace the migrated (INTEGER-era) table with the pre-0080 shape, as
        // `recover_text_era_restore_block_cohort_julianday_branch` does.
        sqlx::query("DROP TABLE IF EXISTS blocks")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE blocks (
                 id             TEXT NOT NULL PRIMARY KEY,
                 block_type     TEXT NOT NULL DEFAULT 'content',
                 content        TEXT,
                 parent_id      TEXT,
                 position       INTEGER,
                 deleted_at     TEXT,
                 todo_state     TEXT,
                 priority       TEXT,
                 due_date       TEXT,
                 scheduled_date TEXT,
                 page_id        TEXT
             )",
        )
        .execute(&pool)
        .await
        .unwrap();

        const T0: i64 = 1_767_225_600_000;
        seed_create_op(&pool, 1, "P", None, T0 + 1).await;
        seed_create_op(&pool, 2, "B", None, T0 + 2).await;
        seed_delete_op(&pool, 3, "P", T0 + 3).await;
        seed_move_op(&pool, 4, "B", "P", T0 + 4).await;

        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ false)
            .await
            .unwrap();
        drop(conn);

        let deleted_at_text = |id: &'static str| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, Option<String>>(
                    "SELECT deleted_at FROM blocks WHERE id = ?",
                )
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
            }
        };

        let cohort = deleted_at_text("P").await;
        let cohort_text = cohort
            .clone()
            .expect("the TEXT-era delete arm must tombstone P");
        assert!(
            cohort_text.contains('T'),
            "pre-0080 the cohort stamp is rfc3339 TEXT, got {cohort_text:?}"
        );
        assert_eq!(
            deleted_at_text("B").await,
            cohort,
            "#4187: the swept block must carry the ancestor's own era-correct stamp, \
             byte for byte — an epoch-ms value here would wedge the 0080 backfill"
        );
    }

    /// The payoff of stamping the ancestor's OWN timestamp rather than merely
    /// "some tombstone": the swept block is restorable as part of the cohort it
    /// joined, and only as part of THAT cohort. Replays
    /// `{Create(P), Create(B), Delete(P), Move(B → P), Restore(P)}` twice — once
    /// with the restore carrying the delete's cohort token, once with a
    /// non-matching one — since the restore arm keys its cascade on
    /// `deleted_at = deleted_at_ref` (#613).
    ///
    /// The non-matching replay is the falsifying half: pre-fix `B` was never
    /// stamped, so it read live there too.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_swept_move_joins_a_cohort_the_restore_arm_keys_on() {
        const T0: i64 = 1_767_225_600_000;
        const COHORT: i64 = T0 + 3;

        async fn replay_with_restore_ref(restore_ref: i64) -> (Option<i64>, Option<i64>) {
            let (pool, _dir) = test_pool().await;
            seed_create_op(&pool, 1, "P", None, T0 + 1).await;
            seed_create_op(&pool, 2, "B", None, T0 + 2).await;
            seed_delete_op(&pool, 3, "P", COHORT).await;
            seed_move_op(&pool, 4, "B", "P", T0 + 4).await;
            seed_replay_op(
                &pool,
                5,
                "restore_block",
                &serde_json::json!({ "block_id": "P", "deleted_at_ref": restore_ref }),
                T0 + 5,
            )
            .await;

            let mut conn = pool.acquire().await.unwrap();
            recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
                .await
                .unwrap();
            drop(conn);
            (
                deleted_at_ms(&pool, "P").await,
                deleted_at_ms(&pool, "B").await,
            )
        }

        let (p, b) = replay_with_restore_ref(COHORT).await;
        assert_eq!(p, None, "the restore's token matches P's cohort");
        assert_eq!(
            b, None,
            "the swept block rides the same cohort token back out — it is restorable as \
             one unit with the ancestor whose trash it joined"
        );

        let (p, b) = replay_with_restore_ref(COHORT + 42).await;
        assert_eq!(
            p,
            Some(COHORT),
            "a restore carrying a different cohort token un-deletes nothing"
        );
        assert_eq!(
            b,
            Some(COHORT),
            "#4187: and the swept block stays in the cohort it joined, rather than being \
             left live as it was before the sweep existed"
        );
    }

    /// #1536: a corrupted op_log carrying two `create_block` ops for the SAME
    /// id must not silently flatten. ULIDs make a real collision impossible, so
    /// the duplicate is corruption. Recovery stays idempotent — `OR IGNORE`
    /// tolerates the second create (no abort, first row intact) — but the
    /// `rows_affected == 0` arm logs a warn so the drop is observable. This
    /// asserts the recovery completes and the FIRST create wins (its content is
    /// preserved, the colliding second is ignored).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_duplicate_create_block_keeps_first_and_does_not_abort() {
        let (pool, _dir) = test_pool().await;

        // Two create_block ops sharing id "dup", distinct content. The second
        // is the corrupting duplicate; under OR IGNORE it is dropped.
        let seed_create = |content: &'static str, seq: i64| {
            let pool = pool.clone();
            async move {
                let payload = serde_json::json!({
                    "block_id": "dup",
                    "block_type": "content",
                    "index": 0,
                    "content": content,
                })
                .to_string();
                sqlx::query(
                    "INSERT INTO op_log \
                     (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                     VALUES ('dev', ?, NULL, ?, 'create_block', ?, ?)",
                )
                .bind(seq)
                .bind(format!("h{seq}"))
                .bind(&payload)
                .bind(1_767_225_600_000_i64 + seq)
                .execute(&pool)
                .await
                .unwrap();
            }
        };
        seed_create("first-wins", 1).await;
        seed_create("second-ignored", 2).await;

        // Recovery must NOT abort on the duplicate (idempotent OR IGNORE).
        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        // Exactly one row, and the FIRST create's content is intact.
        let rows: Vec<String> =
            sqlx::query_scalar::<_, String>("SELECT content FROM blocks WHERE id = 'dup'")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            rows,
            vec!["first-wins".to_string()],
            "duplicate create_block must leave exactly the first row intact (#1536)"
        );
    }

    /// #2052(1a): the iterative `page_id` reconstruction loop in
    /// [`recover_blocks_from_op_log`] must converge for multi-level
    /// `page > content > content` nesting. A page self-references
    /// (`page_id = id`); each content block inherits its nearest page
    /// ancestor's `page_id` from its parent. Because a deep child's parent has
    /// no `page_id` yet on the first pass, the fixed-point loop has to make
    /// MULTIPLE passes (one per nesting level) before every content block
    /// resolves — a single pass would leave the grandchild NULL. This drives a
    /// page > L1 > L2 chain from an op-log and asserts BOTH content blocks land
    /// the page's id (the loop iterated to convergence, not just once).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_reconstructs_page_id_for_multi_level_nesting() {
        let (pool, _dir) = test_pool().await;
        sqlx::query("DROP TABLE IF EXISTS blocks")
            .execute(&pool)
            .await
            .unwrap();
        // Constraint-free temp recovery table (the at-head INTEGER era).
        sqlx::query(
            "CREATE TABLE blocks (
                 id TEXT NOT NULL PRIMARY KEY, block_type TEXT NOT NULL DEFAULT 'content',
                 content TEXT, parent_id TEXT, position INTEGER, deleted_at INTEGER,
                 todo_state TEXT, priority TEXT, due_date TEXT, scheduled_date TEXT, page_id TEXT
             )",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Op-log: page "pg" → content "l1" (child of pg) → content "l2" (child
        // of l1). Replay order is `created_at, device_id, seq`.
        let seed =
            |id: &'static str, block_type: &'static str, parent: Option<&'static str>, seq: i64| {
                let pool = pool.clone();
                async move {
                    let mut payload = serde_json::json!({
                        "block_id": id,
                        "block_type": block_type,
                        "index": 0,
                        "content": id,
                    });
                    if let Some(p) = parent {
                        payload["parent_id"] = serde_json::Value::String(p.to_string());
                    }
                    sqlx::query(
                        "INSERT INTO op_log \
                     (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                     VALUES ('dev', ?, NULL, ?, 'create_block', ?, ?)",
                    )
                    .bind(seq)
                    .bind(format!("h{seq}"))
                    .bind(payload.to_string())
                    .bind(1_767_225_600_000_i64 + seq)
                    .execute(&pool)
                    .await
                    .unwrap();
                }
            };
        seed("pg", "page", None, 1).await;
        seed("l1", "content", Some("pg"), 2).await;
        seed("l2", "content", Some("l1"), 3).await;

        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        let page_id = |id: &'static str| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, Option<String>>("SELECT page_id FROM blocks WHERE id = ?")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .unwrap()
            }
        };

        assert_eq!(
            page_id("pg").await.as_deref(),
            Some("pg"),
            "a page self-references its own id"
        );
        assert_eq!(
            page_id("l1").await.as_deref(),
            Some("pg"),
            "the direct child content inherits the page id (first loop pass)"
        );
        assert_eq!(
            page_id("l2").await.as_deref(),
            Some("pg"),
            "the grandchild content must ALSO resolve to the page id — the \
             iterative loop has to converge over multiple passes (#2052)"
        );
    }

    /// #2052(1b): a block whose `parent_id` points at a cross-device id absent
    /// from the local op_log is an ORPHAN. [`recover_blocks_from_op_log`] NULLs
    /// such dangling parents before computing `page_id`, so migration 0073's
    /// `INSERT INTO _new_blocks` (which re-validates the `parent_id REFERENCES
    /// blocks(id)` self-FK) does not abort. This test:
    ///   1. replays a `create_block` whose parent is an absent cross-device id,
    ///   2. asserts the recovered row's `parent_id` is NULLed, then
    ///   3. runs the REAL migration 0073 SQL (extracted from the live migrator)
    ///      against the recovered table and asserts it COMMITS — i.e. the
    ///      rebuilt `blocks` accepts the recovered rows and 0073's
    ///      `page_id_self_for_pages` CHECK is satisfied.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_nulls_cross_device_orphan_parent_and_migration_0073_accepts() {
        let (pool, _dir) = test_pool().await;
        // Reproduce the recovery temp table verbatim (the live `blocks` after a
        // partial 0073 DROP): no FK, no CHECK. We rebuild it so the orphan
        // parent can be seeded without the FK rejecting it up front.
        sqlx::query("DROP TABLE IF EXISTS blocks")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE blocks (
                 id TEXT NOT NULL PRIMARY KEY, block_type TEXT NOT NULL DEFAULT 'content',
                 content TEXT, parent_id TEXT, position INTEGER, deleted_at INTEGER,
                 todo_state TEXT, priority TEXT, due_date TEXT, scheduled_date TEXT, page_id TEXT
             )",
        )
        .execute(&pool)
        .await
        .unwrap();

        // A page present locally, plus an orphan content block whose parent
        // ("remote-parent") was created on another device and is NOT in the
        // local op_log. A self-page row keeps a page present so the 0073 CHECK
        // arm (`block_type = 'page' OR page_id = id`) is exercised on real data.
        let seed_create =
            |id: &'static str, block_type: &'static str, parent: Option<&'static str>, seq: i64| {
                let pool = pool.clone();
                async move {
                    let mut payload = serde_json::json!({
                        "block_id": id, "block_type": block_type, "index": 0, "content": id,
                    });
                    if let Some(p) = parent {
                        payload["parent_id"] = serde_json::Value::String(p.to_string());
                    }
                    sqlx::query(
                        "INSERT INTO op_log \
                         (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                         VALUES ('dev', ?, NULL, ?, 'create_block', ?, ?)",
                    )
                    .bind(seq)
                    .bind(format!("h{seq}"))
                    .bind(payload.to_string())
                    .bind(1_767_225_600_000_i64 + seq)
                    .execute(&pool)
                    .await
                    .unwrap();
                }
            };
        seed_create("pg", "page", None, 1).await;
        seed_create("orphan", "content", Some("remote-parent"), 2).await;

        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        // (2) the dangling cross-device parent is NULLed.
        let orphan_parent =
            sqlx::query_scalar::<_, Option<String>>("SELECT parent_id FROM blocks WHERE id = ?")
                .bind("orphan")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            orphan_parent, None,
            "a parent absent from the local op_log (cross-device id) must be NULLed (#2052)"
        );
        // The page row self-references (page_id = id), satisfying 0073's CHECK.
        let pg_page_id =
            sqlx::query_scalar::<_, Option<String>>("SELECT page_id FROM blocks WHERE id = ?")
                .bind("pg")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            pg_page_id.as_deref(),
            Some("pg"),
            "the page self-references"
        );

        // (3) run the REAL migration 0073 against the recovered table. Its
        // `INSERT INTO _new_blocks SELECT * FROM blocks` re-validates the
        // self-FK (NULLed orphan parents pass) and fires the
        // `page_id_self_for_pages` CHECK (the page row passes). A surviving
        // dangling parent or a `page_id != id` page would abort here.
        let migrator = sqlx::migrate!("./migrations");
        let sql_0073 = migrator
            .iter()
            .find(|m| m.version == 73 && m.migration_type.is_up_migration())
            .expect("migration 0073 exists")
            .sql
            .as_str()
            .to_owned();
        sqlx::query(sqlx::AssertSqlSafe(sql_0073))
            .execute(&pool)
            .await
            .expect(
                "migration 0073 must accept the recovered rows — the orphan parent was NULLed \
                 and every page self-references, so its self-FK re-validation and \
                 page_id_self_for_pages CHECK both pass (#2052)",
            );

        // Post-migration the rows survive in the rebuilt (CHECK-bearing) table.
        let orphan_after =
            sqlx::query_scalar::<_, Option<String>>("SELECT parent_id FROM blocks WHERE id = ?")
                .bind("orphan")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            orphan_after, None,
            "the orphan row survives the rebuild with a NULL parent"
        );
        let count: i64 = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 2, "both recovered rows survive the 0073 rebuild");
    }

    /// #1536 control: a single, non-colliding `create_block` recovers cleanly —
    /// the `rows_affected == 0` warn arm is NOT taken (the insert affects one
    /// row), and the block materializes as expected.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_single_create_block_no_duplicate_warn() {
        let (pool, _dir) = test_pool().await;

        let payload = serde_json::json!({
            "block_id": "solo",
            "block_type": "content",
            "index": 0,
            "content": "hello",
        })
        .to_string();
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES ('dev', 1, NULL, 'h1', 'create_block', ?, ?)",
        )
        .bind(&payload)
        .bind(1_767_225_600_001_i64)
        .execute(&pool)
        .await
        .unwrap();

        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        let content: String =
            sqlx::query_scalar::<_, String>("SELECT content FROM blocks WHERE id = 'solo'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(content, "hello", "single create_block must recover cleanly");
    }

    /// #2504: [`persisted_engine_snapshot_count`] counts only `loro_doc_state`
    /// rows that carry an actual snapshot blob — the recoverable engine state
    /// the op-log rebuild would drop. An absent table, an empty table, and an
    /// empty-blob row all read as "nothing to lose".
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn persisted_engine_snapshot_count_counts_only_real_snapshots_2504() {
        let (pool, _dir) = test_pool().await;

        // Empty (but migrated) table ⇒ 0.
        let mut conn = pool.acquire().await.unwrap();
        assert_eq!(
            persisted_engine_snapshot_count(&mut conn).await.unwrap(),
            0,
            "no engine snapshots ⇒ 0"
        );
        drop(conn);

        // A real snapshot row ⇒ counted; an empty-blob row ⇒ ignored.
        sqlx::query(
            "INSERT INTO loro_doc_state (space_id, snapshot, updated_at, op_count) \
             VALUES ('space-real', ?, 0, 1)",
        )
        .bind(vec![1_u8, 2, 3, 4])
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO loro_doc_state (space_id, snapshot, updated_at, op_count) \
             VALUES ('space-empty', X'', 0, 0)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let mut conn = pool.acquire().await.unwrap();
        assert_eq!(
            persisted_engine_snapshot_count(&mut conn).await.unwrap(),
            1,
            "only the non-empty snapshot row counts as recoverable engine state"
        );
    }

    /// #2504 (pins the disaster-path gap): [`recover_blocks_from_op_log`]
    /// rebuilds from the strictly device-local op_log, so it reconstructs ONLY
    /// locally-authored content. Remote-authored content lives solely in the
    /// per-space Loro engine snapshots (`loro_doc_state`) and is NOT reprojected
    /// by this replay — it is silently dropped on recovery.
    ///
    /// This test pins the CURRENT (known-incomplete) behavior: a device holds a
    /// synced engine snapshot plus one locally-authored op; after recovery the
    /// local block survives, the engine snapshot is left untouched (never
    /// consulted), and no remote-authored block is reconstructed. When the
    /// engine-first reprojection lands (#2503 / #2504), recovery should instead
    /// reproject the engine state and the "remote content survives" assertion in
    /// the issue's acceptance criteria flips — at which point this test is
    /// updated to assert survival rather than the gap.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_blocks_from_op_log_is_device_local_only_2504() {
        let (pool, _dir) = test_pool().await;

        // A synced device: the engine holds convergent state (stands in for
        // remote-authored content) in `loro_doc_state`, but the op_log carries
        // ONLY the block this device authored locally — remote ops never land in
        // the op_log (#490-M1), so there is deliberately no op for "remote-b".
        sqlx::query(
            "INSERT INTO loro_doc_state (space_id, snapshot, updated_at, op_count) \
             VALUES ('space-1', ?, 0, 7)",
        )
        .bind(vec![9_u8, 9, 9, 9])
        .execute(&pool)
        .await
        .unwrap();

        let payload = serde_json::json!({
            "block_id": "local-a",
            "block_type": "content",
            "index": 0,
            "content": "authored here",
        })
        .to_string();
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES ('this-device', 1, NULL, 'h1', 'create_block', ?, ?)",
        )
        .bind(&payload)
        .bind(1_767_225_600_000_i64)
        .execute(&pool)
        .await
        .unwrap();

        // The migrated `blocks` table is empty at boot; recovery replays into it.
        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        // Locally-authored content survives.
        let local: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = 'local-a'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(local, 1, "op-log recovery must reconstruct local content");

        // The gap: remote-authored content held only in the engine snapshot is
        // NOT reconstructed by op-log replay.
        let remote: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = 'remote-b'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            remote, 0,
            "#2504 gap: op-log rebuild cannot see remote-authored content in the engine"
        );

        // The convergent engine state is still present — untouched by this
        // rebuild — which is exactly what an engine-first reprojection would
        // consume to recover the dropped remote content.
        let engine_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM loro_doc_state WHERE space_id = 'space-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            engine_rows, 1,
            "engine snapshot survives, unread by the op-log rebuild (recoverable via #2503/#2504)"
        );
    }

    /// #2504 (acceptance): the engine-first rebuild restores remote-authored
    /// content that the device-local op-log replay drops.
    ///
    /// Setup mirrors the issue's acceptance criterion: device B holds synced
    /// content authored on device A (a real Loro snapshot in `loro_doc_state`),
    /// plus one locally-authored op in the (device-local) op_log. B's `blocks`
    /// table is corrupt/empty at boot.
    ///
    /// The test proves BOTH halves in one flow against a real engine snapshot:
    ///   1. `recover_blocks_from_op_log` (the pre-#2504 path) rebuilds ONLY the
    ///      local block — the remote block is absent (pre-fix failure).
    ///   2. `reproject_blocks_from_engine` (the fix) then reprojects the engine
    ///      state — the remote block, its property, and its tag are restored,
    ///      and the local block still survives.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_reprojects_remote_content_from_engine_2504() {
        // Canonical uppercase ULID-shaped ids so `BlockId::from_trusted`'s
        // `to_ascii_uppercase()` normalization round-trips them unchanged
        // (production ids are already uppercase Crockford base32).
        const REMOTE_PAGE: &str = "01HZ0000000000000000000P01";
        const REMOTE_B: &str = "01HZ0000000000000000000B01";
        const TAG_X: &str = "01HZ0000000000000000000T0X";
        const LOCAL_A: &str = "01HZ0000000000000000000L0A";

        let (pool, _dir) = test_pool().await;

        // Device A authors a "remote" page + a content child under it (+ a
        // property and a tag) into a real per-space Loro engine, and B persists
        // A's snapshot in `loro_doc_state`. The content child lives UNDER the
        // page so its `page_id` is derivable (a parentless block would resolve
        // to NULL and could not exercise the derived-cache rebuild). Remote ops
        // never reach B's op_log (#490-M1), so there is deliberately no op_log
        // row for the remote content.
        let snapshot = {
            let mut engine =
                agaric_engine::loro::engine::LoroEngine::with_peer_id("device-A").unwrap();
            engine
                .apply_create_block(REMOTE_PAGE, "page", "Remote Page", None, 0)
                .unwrap();
            engine
                .apply_create_block(REMOTE_B, "content", "authored on A", Some(REMOTE_PAGE), 0)
                .unwrap();
            engine
                .apply_set_property(REMOTE_B, "flavour", Some("vanilla"))
                .unwrap();
            // A tag edge needs the tag block to exist as a `blocks` row (FK), so
            // create it too; Pass A upserts every live block before Pass B.
            engine
                .apply_create_block(TAG_X, "tag", "important", None, 1)
                .unwrap();
            engine.apply_add_tag(REMOTE_B, TAG_X).unwrap();
            engine.export_snapshot().unwrap()
        };
        sqlx::query(
            "INSERT INTO loro_doc_state (space_id, snapshot, updated_at, op_count) \
             VALUES ('space-1', ?, 0, 3)",
        )
        .bind(snapshot)
        .execute(&pool)
        .await
        .unwrap();

        // One locally-authored block lives in the device-local op_log.
        let payload = serde_json::json!({
            "block_id": LOCAL_A,
            "block_type": "content",
            "index": 0,
            "content": "authored here",
        })
        .to_string();
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES ('device-B', 1, NULL, 'h1', 'create_block', ?, ?)",
        )
        .bind(&payload)
        .bind(1_767_225_600_000_i64)
        .execute(&pool)
        .await
        .unwrap();

        // Phase 1 — the pre-#2504 op-log rebuild: local survives, remote absent.
        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        let remote_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(REMOTE_B)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            remote_before, 0,
            "pre-fix: the device-local op-log rebuild cannot see remote-authored content"
        );

        // Phase 2 — the #2504 engine-first reprojection restores remote content.
        let fired = reproject_blocks_from_engine(&pool).await.unwrap();
        assert!(
            fired,
            "engine reprojection must fire when a snapshot is present"
        );

        let remote_content: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(REMOTE_B)
            .fetch_one(&pool)
            .await
            .expect("remote-authored block must be restored from the engine");
        assert_eq!(remote_content, "authored on A");

        let remote_prop: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'flavour'",
        )
        .bind(REMOTE_B)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(remote_prop, 1, "remote-authored property must be restored");

        let remote_tag: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(REMOTE_B)
                .bind(TAG_X)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(remote_tag, 1, "remote-authored tag edge must be restored");

        // The local block still survives the engine pass (engine upserts add the
        // remote content; the op-log-recovered local block is untouched).
        let local: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(LOCAL_A)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(local, 1, "locally-authored content must still survive");

        // The reprojected remote content must be VISIBLE, not just present:
        // the engine reproject rebuilds the visibility-critical derived caches
        // (page_id / FTS) inline, since the live inbound-sync materializer
        // fan-out is unreachable at init time. Without that, the restored block
        // would land with NULL page_id (invisible to page-scoped reads) and no
        // FTS row (unsearchable) — recovered-but-invisible.

        // page_id: the remote content child resolves to its remote page, so
        // every `WHERE page_id = ?` page-scoped read sees it.
        let remote_page_id: Option<String> =
            sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
                .bind(REMOTE_B)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            remote_page_id.as_deref(),
            Some(REMOTE_PAGE),
            "reprojected remote block must have its page_id backfilled (page-scoped-visible)"
        );

        // FTS: the remote block is indexed in `fts_blocks`, so it is searchable.
        let fts_indexed: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM fts_blocks WHERE block_id = ?")
                .bind(REMOTE_B)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            fts_indexed, 1,
            "reprojected remote block must be indexed in fts_blocks (searchable)"
        );
        // And it is actually returned by a trigram search on its content.
        let fts_hit: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM fts_blocks WHERE block_id = ? AND stripped MATCH 'authored'",
        )
        .bind(REMOTE_B)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            fts_hit, 1,
            "reprojected remote block must match a full-text search on its content"
        );
    }

    /// #2504: with no persisted engine snapshots (a device that never synced, or
    /// an ancient DB) the engine reprojection is a no-op returning `false`, so
    /// the caller keeps the op-log pass's local-only content — the documented
    /// fallback that is correct when local content is already complete.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reproject_blocks_from_engine_no_snapshots_is_noop_2504() {
        let (pool, _dir) = test_pool().await;
        let fired = reproject_blocks_from_engine(&pool).await.unwrap();
        assert!(
            !fired,
            "no engine snapshots ⇒ engine reprojection does nothing and the op-log path stands"
        );
    }

    // Uppercase ids so `BlockId::from_trusted`'s `to_ascii_uppercase()` round-trips
    // them unchanged (same convention as the #2504 tests above).
    async fn insert_snapshot(pool: &SqlitePool, space_id: &str, bytes: Vec<u8>) {
        sqlx::query(
            "INSERT INTO loro_doc_state (space_id, snapshot, updated_at, op_count) \
             VALUES (?, ?, 0, 1)",
        )
        .bind(space_id)
        .bind(bytes)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn marker_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM app_settings WHERE key = ?")
            .bind(ENGINE_REPROJECT_PENDING_KEY)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// #2920: a single un-projectable block must NOT `?`-abort the shared boot
    /// transaction and roll back the spaces/blocks that projected cleanly.
    ///
    /// Space-1 holds a valid page + a valid content child PLUS one block whose
    /// `block_type` the local schema's `block_type_valid` CHECK rejects — a
    /// faithful "un-projectable remote block" (an unrecognised type authored by a
    /// peer). Space-2 is fully valid. After reprojection the good page/child AND
    /// the whole other space must be committed, the bad block skipped, and the
    /// retry marker armed (so a next boot re-attempts) — the pre-fix behaviour
    /// rolled the entire boot back and then silently never retried.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn engine_reproject_tolerates_bad_block_commits_good_content_and_arms_retry_2920() {
        const PAGE: &str = "PAGE-2920";
        const GOOD_CHILD: &str = "GOODCHILD-2920";
        const BAD_BLOCK: &str = "BADBLOCK-2920";
        const OTHER_SPACE_BLK: &str = "OTHERBLK-2920";

        let (pool, _dir) = test_pool().await;

        let snap1 = {
            let mut engine =
                agaric_engine::loro::engine::LoroEngine::with_peer_id("device-A").unwrap();
            engine
                .apply_create_block(PAGE, "page", "Good Page", None, 0)
                .unwrap();
            engine
                .apply_create_block(GOOD_CHILD, "content", "good content", Some(PAGE), 0)
                .unwrap();
            // Unrecognised `block_type` ⇒ the STRICT `blocks.block_type_valid`
            // CHECK (migration 0085/0089) aborts THIS block's Pass A INSERT.
            engine
                .apply_create_block(BAD_BLOCK, "garbage", "unprojectable", None, 1)
                .unwrap();
            engine.export_snapshot().unwrap()
        };
        let snap2 = {
            let mut engine =
                agaric_engine::loro::engine::LoroEngine::with_peer_id("device-A").unwrap();
            engine
                .apply_create_block(OTHER_SPACE_BLK, "content", "other space content", None, 0)
                .unwrap();
            engine.export_snapshot().unwrap()
        };
        insert_snapshot(&pool, "space-1", snap1).await;
        insert_snapshot(&pool, "space-2", snap2).await;

        let fired = reproject_blocks_from_engine(&pool).await.unwrap();
        assert!(fired, "reprojection fires when valid snapshots are present");

        // Good content in space-1 committed despite the sibling bad block.
        let page: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(PAGE)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            page, 1,
            "the valid page must commit even though a sibling block failed"
        );
        let child: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(GOOD_CHILD)
            .fetch_one(&pool)
            .await
            .expect("the valid content child must be projected");
        assert_eq!(child, "good content");

        // The bad block is skipped — not committed — and did not abort the tx.
        let bad: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(BAD_BLOCK)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(bad, 0, "the un-projectable block is skipped, not committed");

        // A fully-valid OTHER space still commits (one bad block in space-1 must
        // not roll back the whole shared transaction).
        let other: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(OTHER_SPACE_BLK)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(other, 1, "a fully-valid OTHER space must still commit");

        // Partial failure ⇒ retry marker armed so a subsequent boot re-attempts.
        assert_eq!(
            marker_count(&pool).await,
            1,
            "a partial reprojection must ARM the engine-reproject retry marker"
        );
        assert!(
            engine_reproject_pending(&pool).await.unwrap(),
            "the boot gate must report a pending retry after a partial reprojection"
        );
    }

    /// #2920: a fully-clean reprojection CLEARS the retry marker (so the
    /// all-clean path does not retry forever). Pre-arm the marker to simulate a
    /// prior partial boot, then reproject a fully-valid snapshot.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn engine_reproject_clean_clears_retry_marker_2920() {
        const BLK: &str = "CLEANBLK-2920";
        let (pool, _dir) = test_pool().await;

        // Simulate a prior partial boot that armed the retry marker.
        set_engine_reproject_pending(&pool, true).await.unwrap();
        assert!(engine_reproject_pending(&pool).await.unwrap());

        let snap = {
            let mut engine =
                agaric_engine::loro::engine::LoroEngine::with_peer_id("device-A").unwrap();
            engine
                .apply_create_block(BLK, "content", "all good", None, 0)
                .unwrap();
            engine.export_snapshot().unwrap()
        };
        insert_snapshot(&pool, "space-1", snap).await;

        let fired = reproject_blocks_from_engine(&pool).await.unwrap();
        assert!(fired);
        let blk: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(BLK)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(blk, 1, "the valid block projects");

        assert_eq!(
            marker_count(&pool).await,
            0,
            "a fully-clean reprojection must CLEAR the retry marker"
        );
        assert!(!engine_reproject_pending(&pool).await.unwrap());
    }

    /// #2920: the existing corrupt-PER-SPACE tolerance still holds AND now arms
    /// the retry marker. Space-1 is valid, space-2's snapshot bytes are
    /// undecodable — the valid space still commits and the skipped space arms the
    /// retry.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn engine_reproject_tolerates_corrupt_space_and_arms_retry_2920() {
        const GOOD: &str = "GOODSPACE-2920";
        let (pool, _dir) = test_pool().await;

        let snap = {
            let mut engine =
                agaric_engine::loro::engine::LoroEngine::with_peer_id("device-A").unwrap();
            engine
                .apply_create_block(GOOD, "content", "survives", None, 0)
                .unwrap();
            engine.export_snapshot().unwrap()
        };
        insert_snapshot(&pool, "space-1", snap).await;
        // Undecodable snapshot bytes for space-2.
        insert_snapshot(&pool, "space-2", vec![0xDE, 0xAD, 0xBE, 0xEF]).await;

        let fired = reproject_blocks_from_engine(&pool).await.unwrap();
        assert!(
            fired,
            "the valid space still reprojects despite the corrupt sibling snapshot"
        );
        let good: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(GOOD)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            good, 1,
            "the valid space's content commits despite a corrupt-per-space snapshot"
        );
        assert_eq!(
            marker_count(&pool).await,
            1,
            "a skipped corrupt space must ARM the retry marker"
        );
    }

    /// #2920: when EVERY snapshot fails to decode the reprojection returns
    /// `Ok(false)` (op-log local content stands) but STILL arms the retry marker
    /// — the pre-fix silent-permanent-loss trap re-attempted nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn engine_reproject_all_snapshots_corrupt_returns_false_and_arms_retry_2920() {
        let (pool, _dir) = test_pool().await;
        insert_snapshot(&pool, "space-1", vec![0x00, 0x01, 0x02]).await;

        let fired = reproject_blocks_from_engine(&pool).await.unwrap();
        assert!(
            !fired,
            "all snapshots undecodable ⇒ Ok(false); the op-log pass's local content stands"
        );
        assert_eq!(
            marker_count(&pool).await,
            1,
            "an all-decode-failure must still arm the retry marker (no silent permanent loss)"
        );
    }

    // ==================================================================
    // #3268 — op-log recovery must replay LOCALLY-AUTHORED ops only
    // ==================================================================

    /// The post-migration half of the boot recovery sequence, in the order
    /// `init_pool` / `init_pools` run it (db/pool.rs): the derived-state replay,
    /// then the engine reprojection, then the attachment replay. #3268: the
    /// attachment arms MUST run after the reprojection — a peer-authored block
    /// exists in `blocks` only once the engine snapshots have been reprojected,
    /// and the arms are FK-guarded on the owning block. Tests that drive
    /// `recover_derived_state_from_op_log` alone cannot see that ordering.
    async fn boot_recovery(pool: &SqlitePool, blocks_recovered: bool) {
        let attachments_pending = recover_derived_state_from_op_log(pool, blocks_recovered)
            .await
            .unwrap();
        if blocks_recovered || attachments_pending || engine_reproject_pending(pool).await.unwrap()
        {
            reproject_blocks_from_engine(pool).await.unwrap();
        }
        if attachments_pending {
            recover_attachments_from_op_log(pool).await.unwrap();
        }
    }

    /// Seed one `op_log` row with an explicit `is_replicated` provenance flag.
    /// `is_replicated = 1` is exactly what `dag::insert_replicated_op` stamps on
    /// every foreign audit record the sync puller lands.
    async fn seed_op(
        pool: &SqlitePool,
        seq: i64,
        op_type: &str,
        payload: &serde_json::Value,
        is_replicated: i64,
    ) {
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at, is_replicated) \
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?)",
        )
        .bind(if is_replicated == 1 {
            "peer-device"
        } else {
            "this-device"
        })
        .bind(seq)
        .bind(format!("h{seq}"))
        .bind(op_type)
        .bind(payload.to_string())
        .bind(1_767_225_600_000_i64 + seq)
        .bind(is_replicated)
        .execute(pool)
        .await
        .unwrap();
    }

    /// #3268: [`recover_blocks_from_op_log`] must skip replicated (foreign)
    /// audit rows. Device B holds device A's `create_block` audit record
    /// (`is_replicated = 1`); rebuilding B's `blocks` from the op_log must
    /// reconstruct B's own block and NOT materialise A's — state flows only
    /// through Loro, and migration 0099 makes `is_replicated = 0` the isolation
    /// boundary that keeps replicated rows inert for state.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_blocks_skips_replicated_ops_3268() {
        let (pool, _dir) = test_pool().await;

        seed_op(
            &pool,
            1,
            "create_block",
            &serde_json::json!({
                "block_id": "local-a", "block_type": "content", "index": 0,
                "content": "authored here",
            }),
            0,
        )
        .await;
        seed_op(
            &pool,
            2,
            "create_block",
            &serde_json::json!({
                "block_id": "foreign-b", "block_type": "content", "index": 1,
                "content": "authored on the peer",
            }),
            1,
        )
        .await;

        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM blocks ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(
            ids,
            vec!["local-a".to_owned()],
            "#3268: only the locally-authored op may materialise — a replicated \
             audit row must never be replayed into `blocks`"
        );
    }

    /// #3268 (the pre-0099 era guard): [`recover_blocks_from_op_log`] runs
    /// BEFORE `sqlx::migrate!`, so on a vault whose highest applied migration
    /// predates 0099 the `is_replicated` column does not exist yet. The filter
    /// must be probed for, not assumed: an unconditional `WHERE is_replicated =
    /// 0` fails to prepare there ("no such column"), converting a recoverable
    /// vault into a permanent boot failure. Filtering is also unnecessary in
    /// that era — 0099 records that before it "no op_log ever held a foreign
    /// device's ops".
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_blocks_tolerates_pre_0099_op_log_without_is_replicated_3268() {
        let (pool, _dir) = test_pool().await;

        // Reproduce a pre-0099 `op_log`: same columns the replay reads, minus
        // the provenance flag 0099 added.
        sqlx::query("DROP TABLE op_log")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE op_log (
                 id          INTEGER PRIMARY KEY AUTOINCREMENT,
                 device_id   TEXT NOT NULL,
                 seq         INTEGER NOT NULL,
                 parent_seqs TEXT,
                 hash        TEXT NOT NULL,
                 op_type     TEXT NOT NULL,
                 payload     TEXT NOT NULL,
                 created_at  INTEGER NOT NULL
             )",
        )
        .execute(&pool)
        .await
        .unwrap();
        let has_column: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('op_log') WHERE name = 'is_replicated'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(has_column, 0, "fixture precondition: pre-0099 op_log shape");

        let payload = serde_json::json!({
            "block_id": "legacy-a", "block_type": "content", "index": 0, "content": "old",
        })
        .to_string();
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES ('dev', 1, NULL, 'h1', 'create_block', ?, 1767225600001)",
        )
        .bind(&payload)
        .execute(&pool)
        .await
        .unwrap();

        let mut conn = pool.acquire().await.unwrap();
        recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .expect(
                "a pre-0099 op_log must still be replayable — the filter is probed, not assumed",
            );
        drop(conn);

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = 'legacy-a'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "the pre-0099 op must still replay");
    }

    /// #3268 (the durable half): [`recover_derived_state_from_op_log`] must not
    /// invent an `attachments` row for a PEER's `add_attachment` naming bytes
    /// this device does not hold. `attachments` is engine-independent, so the
    /// `reproject_blocks_from_engine` pass that follows cannot correct a foreign
    /// row — and the arm's only structural guard
    /// (`WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?)`) is satisfied by the
    /// replay itself, so it cannot discriminate.
    ///
    /// No `attachment_blobs` row is seeded here, so neither peer op has bytes
    /// behind it. See `replicated_attachment_restored_only_when_blob_is_held_3268`
    /// for the other half: a peer op whose blob IS held must come back.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recover_derived_state_skips_replicated_attachment_3268() {
        let (pool, _dir) = test_pool().await;

        // Both owning blocks exist (the peer's block reached this device via
        // Loro sync, which is exactly why the attachment arm's EXISTS guard
        // cannot discriminate).
        for id in ["local-a", "foreign-b"] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, position) VALUES (?, 'content', '', 1)",
            )
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        }

        seed_op(
            &pool,
            1,
            "add_attachment",
            &serde_json::json!({
                "attachment_id": "att-local", "block_id": "local-a",
                "mime_type": "image/png", "filename": "mine.png",
                "size_bytes": 10, "fs_path": "attachments/att-local",
            }),
            0,
        )
        .await;
        seed_op(
            &pool,
            2,
            "add_attachment",
            &serde_json::json!({
                "attachment_id": "att-foreign", "block_id": "foreign-b",
                "mime_type": "image/png", "filename": "theirs.png",
                "size_bytes": 20, "fs_path": "attachments/att-foreign",
            }),
            1,
        )
        .await;

        boot_recovery(&pool, /* blocks_recovered */ true).await;

        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM attachments ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(
            ids,
            vec!["att-local".to_owned()],
            "#3268: a replicated `add_attachment` must not materialise an \
             `attachments` row — nothing downstream can undo it"
        );
    }

    /// #3268 (the call site of the same filter): the `op_count == 0` early
    /// return that GATES the replay must be computed from the same
    /// locally-authored population the replay reads. A vault whose op_log holds
    /// nothing but foreign audit rows has nothing to replay and must return
    /// before opening the write transaction.
    ///
    /// It must also RETIRE the pending marker rather than strand it (review
    /// follow-up on the filter): this early return is now reachable on strictly
    /// MORE vaults than the old unfiltered count was — an op_log holding only
    /// replicated non-attachment rows is "empty" for this pass — and nothing
    /// else ever clears the marker on that path, so it would re-trip the probe
    /// on every boot forever. The `prop_count > 0 || tag_count > 0` branch
    /// already retires the marker in the same "nothing left to replay"
    /// situation; the two must agree.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn derived_replay_op_count_guard_ignores_replicated_ops_3268() {
        let (pool, _dir) = test_pool().await;

        seed_op(
            &pool,
            1,
            "add_tag",
            &serde_json::json!({"block_id": "foreign-b", "tag_id": "t1"}),
            1,
        )
        .await;

        sqlx::query("INSERT INTO app_settings (key, value, updated_at) VALUES (?, '1', 0)")
            .bind(DERIVED_RECOVERY_PENDING_KEY)
            .execute(&pool)
            .await
            .unwrap();

        let attachments_pending =
            recover_derived_state_from_op_log(&pool, /* blocks_recovered_this_boot */ false)
                .await
                .unwrap();
        assert!(
            !attachments_pending,
            "there is nothing for the attachment pass to do either"
        );

        let replayed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM block_tags")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            replayed, 0,
            "#3268: an op_log holding ONLY replicated rows must take the \
             `op_count == 0` early return, not enter the full replay"
        );

        let marker: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_settings WHERE key = ?")
            .bind(DERIVED_RECOVERY_PENDING_KEY)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            marker, 0,
            "…and it must RETIRE the pending marker on the way out. A marker \
             nothing will ever clear re-trips this probe on every boot for the \
             life of the vault"
        );
    }

    /// #3268 (the marker lifecycle across the split): splitting the replay in
    /// two creates a window between them, and a crash in that window must not
    /// lose the attachment restore. So the STATE pass may not retire
    /// [`DERIVED_RECOVERY_PENDING_KEY`] — the attachment pass does — and the
    /// next boot must still finish the job even though `block_properties` is
    /// now non-empty (the branch that used to clear the marker and return).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn attachment_replay_survives_a_crash_between_the_two_passes_3268() {
        let (pool, _dir) = test_pool().await;

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position) VALUES ('local-a', 'content', '', 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO app_settings (key, value, updated_at) VALUES (?, '1', 0)")
            .bind(DERIVED_RECOVERY_PENDING_KEY)
            .execute(&pool)
            .await
            .unwrap();

        seed_op(
            &pool,
            1,
            "set_property",
            &serde_json::json!({
                "block_id": "local-a", "key": "flavour", "value_text": "vanilla",
            }),
            0,
        )
        .await;
        seed_op(
            &pool,
            2,
            "add_attachment",
            &serde_json::json!({
                "attachment_id": "att-local", "block_id": "local-a",
                "mime_type": "image/png", "filename": "mine.png",
                "size_bytes": 10, "fs_path": "attachments/att-local",
            }),
            0,
        )
        .await;

        // Boot 1 crashes right after the state pass commits.
        let attachments_pending =
            recover_derived_state_from_op_log(&pool, /* blocks_recovered_this_boot */ true)
                .await
                .unwrap();
        assert!(attachments_pending, "the attachment pass is still owed");
        let props: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM block_properties")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(props, 1, "the state pass did land");
        let marker: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_settings WHERE key = ?")
            .bind(DERIVED_RECOVERY_PENDING_KEY)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            marker, 1,
            "the STATE pass must not retire the marker — the attachment replay \
             has not run yet, and clearing it here strands it forever"
        );

        // Boot 2: no this-boot signal, only the durable marker — and derived
        // tables are now POPULATED, the branch that used to clear and return.
        boot_recovery(&pool, /* blocks_recovered */ false).await;

        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM attachments ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(
            ids,
            vec!["att-local".to_owned()],
            "the retry boot must finish the attachment replay the crashed boot owed"
        );
        let props: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM block_properties")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(props, 1, "…without re-replaying (or duplicating) the state");
        let marker: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_settings WHERE key = ?")
            .bind(DERIVED_RECOVERY_PENDING_KEY)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(marker, 0, "…and now the marker is retired");
    }

    /// The same early return, on a vault with NO marker: it must not write.
    /// (The marker probe is read first precisely so a healthy boot issues no
    /// `DELETE` on the empty-op_log path.)
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn derived_replay_empty_op_log_without_marker_is_a_noop_3268() {
        let (pool, _dir) = test_pool().await;

        let attachments_pending =
            recover_derived_state_from_op_log(&pool, /* blocks_recovered_this_boot */ true)
                .await
                .unwrap();

        assert!(
            !attachments_pending,
            "an empty op_log owes the attachment pass nothing"
        );
        let marker: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_settings WHERE key = ?")
            .bind(DERIVED_RECOVERY_PENDING_KEY)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(marker, 0, "nothing to retire, nothing written");
    }

    // ==================================================================
    // #3269 — a recovered `blocks` must be schema-identical to a healthy one
    // ==================================================================

    /// The `blocks` table DDL plus every `blocks` index DDL, straight out of
    /// `sqlite_master`. The auto-index behind the TEXT PRIMARY KEY has
    /// `sql IS NULL` and is excluded.
    async fn blocks_schema_objects(pool: &SqlitePool) -> (String, Vec<String>) {
        let table: String = sqlx::query_scalar(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'blocks'",
        )
        .fetch_one(pool)
        .await
        .unwrap();
        let indexes: Vec<String> = sqlx::query_scalar(
            "SELECT sql FROM sqlite_master \
             WHERE type = 'index' AND tbl_name = 'blocks' AND sql IS NOT NULL \
             ORDER BY name",
        )
        .fetch_all(pool)
        .await
        .unwrap();
        (table, indexes)
    }

    /// Compare DDL modulo formatting: `ALTER TABLE ... RENAME` rewrites the
    /// stored text (identifiers become quoted), and the migration carries inline
    /// `--` comments the Rust constant does not. Strip line comments, quotes and
    /// all whitespace; what is left is the schema itself.
    fn normalize_ddl(sql: &str) -> String {
        sql.lines()
            .map(|line| match line.find("--") {
                Some(i) => &line[..i],
                None => line,
            })
            .collect::<String>()
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '"')
            .collect()
    }

    /// #3269 (acceptance + the anti-drift guard for [`HEAD_BLOCKS_TABLE_DDL`]):
    /// when `blocks` goes missing on an at-head vault (external corruption, a
    /// `.recover` pass, a tool-issued DROP) `sqlx::migrate!` is a no-op, so
    /// whatever recovery creates is the live table forever. It must therefore be
    /// schema-identical to the table a healthy vault carries — STRICT, both
    /// named CHECK constraints, the parent/page self-FKs, the `spaces` FK, and all ten
    /// indexes.
    ///
    /// The expectation is READ FROM the migrated database rather than restated
    /// here, so a future migration that changes `blocks` fails this test instead
    /// of silently desynchronising the Rust copy.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recovered_blocks_schema_matches_migrated_head_3269() {
        let (pool, _dir) = test_pool().await;
        let (expected_table, expected_indexes) = blocks_schema_objects(&pool).await;
        assert_eq!(
            expected_indexes.len(),
            HEAD_BLOCKS_INDEXES.len(),
            "fixture precondition: the migrated head carries the index set this \
             recovery re-issues (a mismatch means a migration changed the set)"
        );

        // External damage: the table simply disappears on an at-head vault.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();

        let recovered = ensure_blocks_table_exists(&pool).await.unwrap();
        assert!(recovered, "recovery must fire when `blocks` is missing");

        let (actual_table, actual_indexes) = blocks_schema_objects(&pool).await;
        assert_eq!(
            normalize_ddl(&actual_table),
            normalize_ddl(&expected_table),
            "#3269: the recovered `blocks` must carry the head shape (STRICT, FKs, \
             CHECK constraints), not a bare scaffold.\nrecovered: {actual_table}\nmigrated:  {expected_table}"
        );
        assert_eq!(
            actual_indexes
                .iter()
                .map(|s| normalize_ddl(s))
                .collect::<Vec<_>>(),
            expected_indexes
                .iter()
                .map(|s| normalize_ddl(s))
                .collect::<Vec<_>>(),
            "#3269: the recovered `blocks` must carry the full head index set — \
             without it every paginated read full-scans the table forever"
        );
    }

    /// #3269 (the mid-range era a strict `== head` predicate leaves UNFIXED):
    /// the LIKELY real-world path is a vault damaged while running an OLDER app
    /// and then upgraded — its `_sqlx_migrations` is stamped somewhere in
    /// 0090..head, not exactly at head. Nothing in 0090..head does DDL on
    /// `blocks` (0089 is the last migration that touches the table), so
    /// `sqlx::migrate!` will never rebuild it and the scaffold created here is
    /// just as permanent as it is at head — same constraint-free, zero-index,
    /// full-scan-forever outcome, in the more common scenario.
    ///
    /// Stamps a mid-range version (100), drops `blocks`, and demands the head
    /// shape plus the full index set.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recovered_blocks_gets_head_shape_below_head_3269() {
        let (pool, _dir) = test_pool().await;
        let (expected_table, expected_indexes) = blocks_schema_objects(&pool).await;

        // Rewind the stamp to migration 100: past 0089 (the last migration that
        // touches `blocks`) but below this binary's embedded head.
        sqlx::query("DELETE FROM _sqlx_migrations WHERE version > 100")
            .execute(&pool)
            .await
            .unwrap();
        let stamped: i64 =
            sqlx::query_scalar("SELECT IFNULL(MAX(version), 0) FROM _sqlx_migrations")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stamped, 100, "fixture precondition: a mid-range era vault");

        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        assert!(ensure_blocks_table_exists(&pool).await.unwrap());

        let (actual_table, actual_indexes) = blocks_schema_objects(&pool).await;
        assert_eq!(
            normalize_ddl(&actual_table),
            normalize_ddl(&expected_table),
            "#3269: a vault stamped between 0089 and head must ALSO get the head \
             shape — no pending migration rebuilds `blocks`, so this table is \
             permanent.\nrecovered: {actual_table}\nmigrated:  {expected_table}"
        );
        assert_eq!(
            actual_indexes
                .iter()
                .map(|s| normalize_ddl(s))
                .collect::<Vec<_>>(),
            expected_indexes
                .iter()
                .map(|s| normalize_ddl(s))
                .collect::<Vec<_>>(),
            "#3269: …and the full head index set, for the same reason"
        );
    }

    /// #3268 (the OTHER data-loss direction): `attachments.block_id REFERENCES
    /// blocks(id) ON DELETE CASCADE` + `foreign_keys=ON` means the `DROP TABLE
    /// blocks` that triggers this recovery cascade-deletes EVERY attachment
    /// row, peer-authored ones included. `attachment_blobs` has no FK, so the
    /// BYTES survive on disk. A blanket `is_replicated = 0` filter therefore
    /// destroys the metadata of a legitimately-held peer attachment forever —
    /// `reproject_blocks_from_engine` cannot repair `attachments`.
    ///
    /// The discriminator is possession of the bytes: restore a replicated
    /// `add_attachment` iff this device's blob store still holds the file it
    /// names, and drop it otherwise.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn replicated_attachment_restored_only_when_blob_is_held_3268() {
        let (pool, _dir) = test_pool().await;

        for id in ["local-a", "peer-held", "peer-unheld"] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, position) VALUES (?, 'content', '', 1)",
            )
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        }

        // The peer attachment this device DID receive: its bytes are registered
        // in the content-addressed blob store (`register_received_blob`, and the
        // `attachments` row itself was restored by snapshot restore before the
        // cascade wiped it).
        let held_path = agaric_core::attachment_path::AttachmentFsPath::coerce_from_peer(
            "attachments/att-peer-held",
            "att-peer-held",
        );
        sqlx::query(
            "INSERT INTO attachment_blobs (content_hash, on_disk_path, size_bytes, created_at) \
             VALUES ('hash-held', ?, 20, 0)",
        )
        .bind(held_path.as_str())
        .execute(&pool)
        .await
        .unwrap();

        seed_op(
            &pool,
            1,
            "add_attachment",
            &serde_json::json!({
                "attachment_id": "att-local", "block_id": "local-a",
                "mime_type": "image/png", "filename": "mine.png",
                "size_bytes": 10, "fs_path": "attachments/att-local",
            }),
            0,
        )
        .await;
        seed_op(
            &pool,
            2,
            "add_attachment",
            &serde_json::json!({
                "attachment_id": "att-peer-held", "block_id": "peer-held",
                "mime_type": "image/png", "filename": "theirs-held.png",
                "size_bytes": 20, "fs_path": "attachments/att-peer-held",
            }),
            1,
        )
        .await;
        seed_op(
            &pool,
            3,
            "add_attachment",
            &serde_json::json!({
                "attachment_id": "att-peer-unheld", "block_id": "peer-unheld",
                "mime_type": "image/png", "filename": "theirs-unheld.png",
                "size_bytes": 30, "fs_path": "attachments/att-peer-unheld",
            }),
            1,
        )
        .await;

        boot_recovery(&pool, /* blocks_recovered */ true).await;

        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM attachments ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(
            ids,
            vec!["att-local".to_owned(), "att-peer-held".to_owned()],
            "#3268: the locally-authored row and the peer row whose bytes this \
             device still holds must both come back; the peer row with no blob \
             must not be invented"
        );
    }

    /// #3268: a peer's LATER `delete_attachment` must still win over its own
    /// earlier `add_attachment`, or restoring held peer metadata would resurrect
    /// an attachment the peer removed. The replicated delete/rename arms are
    /// replayed for the same reason the add arm is: `attachments` is the one
    /// table no downstream pass can correct.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn replicated_attachment_delete_wins_over_replicated_add_3268() {
        let (pool, _dir) = test_pool().await;

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position) VALUES ('peer-b', 'content', '', 1)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let held_path = agaric_core::attachment_path::AttachmentFsPath::coerce_from_peer(
            "attachments/att-peer",
            "att-peer",
        );
        sqlx::query(
            "INSERT INTO attachment_blobs (content_hash, on_disk_path, size_bytes, created_at) \
             VALUES ('hash-peer', ?, 20, 0)",
        )
        .bind(held_path.as_str())
        .execute(&pool)
        .await
        .unwrap();

        seed_op(
            &pool,
            1,
            "add_attachment",
            &serde_json::json!({
                "attachment_id": "att-peer", "block_id": "peer-b",
                "mime_type": "image/png", "filename": "theirs.png",
                "size_bytes": 20, "fs_path": "attachments/att-peer",
            }),
            1,
        )
        .await;
        seed_op(
            &pool,
            2,
            "delete_attachment",
            &serde_json::json!({"attachment_id": "att-peer", "fs_path": "attachments/att-peer"}),
            1,
        )
        .await;

        boot_recovery(&pool, /* blocks_recovered */ true).await;

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "#3268: the peer's later delete must win — a held blob is a reason to \
             restore metadata, never a reason to resurrect a removed attachment"
        );
    }

    /// #3269: the constrained rebuild is an ATTEMPT, and this pins that its
    /// failure branch is real and reachable. External damage that also took the
    /// `spaces` table makes the head DDL's `space_id REFERENCES spaces(id)`
    /// unsatisfiable, so the constrained attempt aborts; recovery must degrade
    /// to the pre-#3269 constraint-free scaffold (still replaying the op_log,
    /// still creating the indexes) instead of wedging boot — a boot failure
    /// would be strictly worse than a degraded-but-live table.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn constrained_rebuild_failure_falls_back_to_scaffold_3269() {
        let (pool, _dir) = test_pool().await;

        seed_op(
            &pool,
            1,
            "create_block",
            &serde_json::json!({
                "block_id": "local-a", "block_type": "content", "index": 0, "content": "kept",
            }),
            0,
        )
        .await;

        // Broader external damage: `blocks` AND its `spaces` FK target are gone.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DROP TABLE spaces")
            .execute(&pool)
            .await
            .unwrap();

        let recovered = ensure_blocks_table_exists(&pool)
            .await
            .expect("a failed constrained rebuild must degrade, never wedge boot");
        assert!(recovered, "recovery still fires");

        let (table, indexes) = blocks_schema_objects(&pool).await;
        assert!(
            !normalize_ddl(&table).contains("STRICT"),
            "the fallback is the constraint-free scaffold: {table}"
        );
        assert_eq!(
            indexes.len(),
            HEAD_BLOCKS_INDEXES.len(),
            "the fallback still gets the head index set — index DDL cannot reject data"
        );

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = 'local-a'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            count, 1,
            "the op-log replay still lands on the fallback table"
        );
    }

    /// #3269: a page block must satisfy `page_id_self_for_pages` the moment it
    /// is inserted — the constraint is a CHECK, and CHECK constraints are never deferred,
    /// so deriving `page_id` only after the replay loop would abort the whole
    /// constrained rebuild on the first page. Drives a real page + nested
    /// content through `ensure_blocks_table_exists` on an at-head vault and
    /// asserts both the head shape and the reconstructed `page_id` values.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn constrained_rebuild_replays_pages_and_nesting_3269() {
        let (pool, _dir) = test_pool().await;

        seed_op(
            &pool,
            1,
            "create_block",
            &serde_json::json!({
                "block_id": "pg", "block_type": "page", "index": 0, "content": "Page",
            }),
            0,
        )
        .await;
        seed_op(
            &pool,
            2,
            "create_block",
            &serde_json::json!({
                "block_id": "kid", "block_type": "content", "index": 0,
                "content": "child", "parent_id": "pg",
            }),
            0,
        )
        .await;

        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        ensure_blocks_table_exists(&pool).await.unwrap();

        let (table, _) = blocks_schema_objects(&pool).await;
        assert!(
            normalize_ddl(&table).contains("STRICT"),
            "the constrained rebuild must have SUCCEEDED (not fallen back) for a \
             page-bearing op_log: {table}"
        );

        let page_ids: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT id, page_id FROM blocks ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            page_ids,
            vec![
                ("kid".to_owned(), Some("pg".to_owned())),
                ("pg".to_owned(), Some("pg".to_owned())),
            ],
            "the page self-references and its child inherits, inside the head-shaped table"
        );
    }

    /// #3269 R4: `rows_affected() == 0` on the replay's `INSERT OR IGNORE` has
    /// TWO causes once the head CHECK constraints are live, and the pre-existing diagnostic
    /// claimed only one of them ("op_log carries two create ops for the same id
    /// … possible op_log corruption"). Told about a CHECK rejection, that
    /// sentence is simply false — on the one path where the op_log is the last
    /// forensic artefact left. The replay must therefore tell them apart.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn replay_distinguishes_check_rejection_from_duplicate_create_3269() {
        let (pool, _dir) = test_pool().await;

        // Two creates for ONE id: real op_log corruption (ULIDs cannot collide).
        for seq in [1, 2] {
            seed_op(
                &pool,
                seq,
                "create_block",
                &serde_json::json!({
                    "block_id": "dup", "block_type": "content", "index": 0, "content": "x",
                }),
                0,
            )
            .await;
        }
        // A payload the head `block_type_valid` CHECK refuses: NOT corruption,
        // just a row a healthy at-head vault could not hold either.
        seed_op(
            &pool,
            3,
            "create_block",
            &serde_json::json!({
                "block_id": "bogus", "block_type": "not-a-block-type", "index": 1,
                "content": "invalid",
            }),
            0,
        )
        .await;

        // Replay straight into a head-shaped table so both branches are live.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(HEAD_BLOCKS_TABLE_DDL)
            .execute(&pool)
            .await
            .unwrap();

        let mut conn = pool.acquire().await.unwrap();
        let diagnostics = recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
            .await
            .unwrap();
        drop(conn);

        assert_eq!(
            diagnostics.duplicate_creates,
            vec!["dup".to_owned()],
            "#3269 R4: only the id that was ALREADY in the table is a duplicate create"
        );
        assert_eq!(
            diagnostics.constraint_rejected_creates,
            vec!["bogus".to_owned()],
            "#3269 R4: a row the table's CHECK refused must be reported as a \
             constraint rejection with its own aggregate, never mislabelled as \
             op_log corruption"
        );
        assert_eq!(
            diagnostics.ops_replayed, 3,
            "all three ops were read; two of the three creates simply did not land"
        );
    }

    /// #3269 R5: the `DISASTER RECOVERY DATA LOSS (#2504)` banner and the
    /// per-op warnings must be emitted ONCE per boot. They used to be logged
    /// from inside the replay, which `ensure_blocks_table_exists` may run twice
    /// (constrained attempt, then scaffold fallback) — so on exactly the path a
    /// post-mortem cares about, every number in the log was doubled.
    ///
    /// Drives the fallback path (external damage that also took `spaces`, so the
    /// head shape's `space_id REFERENCES spaces(id)` is unbuildable) and counts
    /// the banner.
    ///
    /// Current-thread runtime on purpose: `set_default` installs a THREAD-local
    /// subscriber, and a multi-thread runtime could poll the future on a worker
    /// that never saw it.
    #[tokio::test]
    async fn recovery_diagnostics_are_emitted_once_per_boot_3269() {
        #[derive(Clone, Default)]
        struct LogBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for LogBuf {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
            type Writer = LogBuf;
            fn make_writer(&'a self) -> Self::Writer {
                self.clone()
            }
        }

        let (pool, _dir) = test_pool().await;
        seed_op(
            &pool,
            1,
            "create_block",
            &serde_json::json!({
                "block_id": "local-a", "block_type": "content", "index": 0, "content": "kept",
            }),
            0,
        )
        .await;
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DROP TABLE spaces")
            .execute(&pool)
            .await
            .unwrap();

        let buf = LogBuf::default();
        {
            use tracing_subscriber::layer::SubscriberExt;
            let subscriber = tracing_subscriber::registry()
                .with(tracing_subscriber::EnvFilter::new("warn"))
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_writer(buf.clone())
                        .with_ansi(false),
                );
            let _guard = tracing::subscriber::set_default(subscriber);
            ensure_blocks_table_exists(&pool).await.unwrap();
        }

        let logged = String::from_utf8_lossy(&buf.0.lock().unwrap()).into_owned();
        let banners = logged
            .matches("Recovering `blocks` from the device-local op_log (#2504)")
            .count();
        assert_eq!(
            banners, 1,
            "#3269 R5: the op-log-replay banner must appear exactly once per \
             boot — a doubled banner makes a post-mortem double-count the \
             damage.\n--- captured ---\n{logged}"
        );
    }

    /// #3269 (the behaviour change the constrained shape buys, and the reason
    /// it is safe to attempt): a `create_block` payload whose `block_type` the
    /// head `block_type_valid` CHECK rejects is DROPPED by the rebuild instead
    /// of materialising a row a healthy vault could never hold. It does not
    /// wedge the rebuild — the replay's `INSERT OR IGNORE` turns a constraint
    /// violation into a skipped row — so the constrained attempt still commits
    /// and the well-formed ops around it survive.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn constrained_rebuild_drops_ops_the_head_check_rejects_3269() {
        let (pool, _dir) = test_pool().await;

        seed_op(
            &pool,
            1,
            "create_block",
            &serde_json::json!({
                "block_id": "bogus", "block_type": "not-a-block-type", "index": 0,
                "content": "invalid",
            }),
            0,
        )
        .await;
        seed_op(
            &pool,
            2,
            "create_block",
            &serde_json::json!({
                "block_id": "good", "block_type": "content", "index": 1, "content": "fine",
            }),
            0,
        )
        .await;

        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        ensure_blocks_table_exists(&pool).await.unwrap();

        let (table, _) = blocks_schema_objects(&pool).await;
        assert!(
            normalize_ddl(&table).contains("STRICT"),
            "a CHECK-violating op must not force the fallback — `INSERT OR IGNORE` \
             skips the row and the constrained rebuild still commits: {table}"
        );

        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM blocks ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(
            ids,
            vec!["good".to_owned()],
            "the CHECK-violating row is dropped (a healthy vault could not hold it), \
             the well-formed op still recovers"
        );
    }

    /// #3268 (the ORDERING half, through the REAL boot path): an `attachments`
    /// row whose owning block is PEER-authored must survive a blocks rebuild.
    ///
    /// Every other attachment test in this module pre-`INSERT`s the owning
    /// blocks and calls [`recover_derived_state_from_op_log`] in isolation, so
    /// the arm's `WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?)` guard is
    /// satisfied by construction and cannot fail. This one boots
    /// [`crate::db::init_pool`] twice against the same file, so the ordering is
    /// production's: `ensure_blocks_table_exists` (op-log replay, LOCAL ops
    /// only) → `recover_derived_state_from_op_log` → `reproject_blocks_from_engine`
    /// (the ONLY pass that can restore a peer-authored block).
    ///
    /// The block therefore does not exist in `blocks` while the op-log replay
    /// runs, and both attachment rows on it — the peer's (blob held) and this
    /// device's own — are silently dropped by the `EXISTS` guard, permanently:
    /// `reproject_blocks_from_engine` restores the BLOCK but explicitly cannot
    /// repair `attachments`, and the replay clears
    /// [`DERIVED_RECOVERY_PENDING_KEY`], so no later boot retries.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn attachments_on_a_peer_authored_block_survive_boot_recovery_3268() {
        // Uppercase so `BlockId::from_trusted`'s `to_ascii_uppercase()`
        // round-trips them (same convention as the #2504 tests above).
        const PEER_PAGE: &str = "01HZ0000000000000000000P0G";
        const PEER_B: &str = "01HZ0000000000000000000P0B";
        const LOCAL_A: &str = "01HZ0000000000000000000L0A";

        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        // The peer's block, as this device holds it: convergent state in the
        // engine snapshot (the only place a peer-authored block lives locally)
        // plus the `is_replicated = 1` audit row the puller landed.
        let snapshot = {
            let mut engine =
                agaric_engine::loro::engine::LoroEngine::with_peer_id("device-A").unwrap();
            engine
                .apply_create_block(PEER_PAGE, "page", "Peer Page", None, 0)
                .unwrap();
            engine
                .apply_create_block(
                    PEER_B,
                    "content",
                    "authored on the peer",
                    Some(PEER_PAGE),
                    0,
                )
                .unwrap();
            engine.export_snapshot().unwrap()
        };
        sqlx::query(
            "INSERT INTO loro_doc_state (space_id, snapshot, updated_at, op_count) \
             VALUES ('space-1', ?, 0, 2)",
        )
        .bind(snapshot)
        .execute(&pool)
        .await
        .unwrap();

        // Healthy pre-corruption SQL state: both blocks present, and two
        // attachments hanging off the PEER-authored one.
        for (id, block_type) in [
            (LOCAL_A, "content"),
            (PEER_PAGE, "page"),
            (PEER_B, "content"),
        ] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, position) VALUES (?, ?, '', 1)",
            )
            .bind(id)
            .bind(block_type)
            .execute(&pool)
            .await
            .unwrap();
        }
        let peer_blob = agaric_core::attachment_path::AttachmentFsPath::coerce_from_peer(
            "attachments/att-peer",
            "att-peer",
        );
        sqlx::query(
            "INSERT INTO attachment_blobs (content_hash, on_disk_path, size_bytes, created_at) \
             VALUES ('hash-peer', ?, 20, 0)",
        )
        .bind(peer_blob.as_str())
        .execute(&pool)
        .await
        .unwrap();
        for (att_id, filename, size) in [
            ("att-peer", "theirs.png", 20_i64),
            ("att-mine", "mine.png", 10),
        ] {
            sqlx::query(
                "INSERT INTO attachments \
                 (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
                 VALUES (?, ?, 'image/png', ?, ?, ?, 0)",
            )
            .bind(att_id)
            .bind(PEER_B)
            .bind(filename)
            .bind(size)
            .bind(format!("attachments/{att_id}"))
            .execute(&pool)
            .await
            .unwrap();
        }

        // The op_log as it actually looks on this device.
        seed_op(
            &pool,
            1,
            "create_block",
            &serde_json::json!({
                "block_id": LOCAL_A, "block_type": "content", "index": 0,
                "content": "authored here",
            }),
            0,
        )
        .await;
        seed_op(
            &pool,
            2,
            "create_block",
            &serde_json::json!({
                "block_id": PEER_B, "block_type": "content", "index": 1,
                "content": "authored on the peer",
            }),
            1,
        )
        .await;
        // The PEER's attachment on the peer's block — bytes received and
        // registered, so the possession gate passes.
        seed_op(
            &pool,
            3,
            "add_attachment",
            &serde_json::json!({
                "attachment_id": "att-peer", "block_id": PEER_B,
                "mime_type": "image/png", "filename": "theirs.png",
                "size_bytes": 20, "fs_path": "attachments/att-peer",
            }),
            1,
        )
        .await;
        // THIS DEVICE's own attachment, on the same peer-authored block. Not
        // replicated, not possession-gated — its only obstacle is the `EXISTS`
        // guard, i.e. the ordering.
        seed_op(
            &pool,
            4,
            "add_attachment",
            &serde_json::json!({
                "attachment_id": "att-mine", "block_id": PEER_B,
                "mime_type": "image/png", "filename": "mine.png",
                "size_bytes": 10, "fs_path": "attachments/att-mine",
            }),
            0,
        )
        .await;

        // The corruption: a partial blocks rebuild. Under `foreign_keys = ON`
        // SQLite runs the implicit DELETE first, so `attachments.block_id`'s
        // ON DELETE CASCADE empties the table — exactly the 0073/0080 damage.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        let orphaned: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            orphaned, 0,
            "fixture precondition: the DROP must cascade the attachment rows away"
        );
        pool.close().await;

        // The boot.
        let pool = init_pool(&db_path).await.unwrap();

        let peer_block: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(PEER_B)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            peer_block, 1,
            "precondition: the engine reprojection must have restored the \
             peer-authored block (otherwise this test is not testing the ordering)"
        );

        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM attachments ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(
            ids,
            vec!["att-mine".to_owned(), "att-peer".to_owned()],
            "#3268: both attachments on a PEER-authored block must be restored. \
             The op-log replay rebuilds only device-local blocks, so the owning \
             block is absent until `reproject_blocks_from_engine` runs — the \
             attachment replay must therefore happen AFTER it, or the `EXISTS` \
             guard drops metadata that nothing downstream can rebuild"
        );

        let marker: i64 =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM app_settings WHERE key = ?")
                .bind(DERIVED_RECOVERY_PENDING_KEY)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            marker, 0,
            "a fully-completed recovery must clear the pending marker (#616)"
        );
    }
}

#[cfg(test)]
#[path = "recovery_kernel_parity_tests.rs"]
mod recovery_kernel_parity_tests;
