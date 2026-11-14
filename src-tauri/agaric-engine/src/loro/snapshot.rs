//! Per-space LoroDoc snapshot persistence.
//!
//! ## Why this exists
//!
//! [`LoroEngineRegistry`] is a process-local
//! `HashMap<SpaceId, LoroEngine>` that is rebuilt from scratch on
//! every process restart — engines are instantiated lazily on first
//! hit and the `LoroDoc` only contains state derived from ops applied
//! during the current process lifetime. The engine is authoritative:
//! the materializer projects from `LoroDoc` state into SQL. A
//! cold-start engine would project an empty doc on top of existing
//! SQL state, corrupting the user's workspace. We persist per-space
//! `LoroDoc` snapshots in a `loro_doc_state` SQLite table, rehydrate
//! on app boot, and periodically re-snapshot in the background.
//!
//! ## Surface
//!
//! - [`load_snapshot`] — reads back the bytes for a given `space_id`,
//!   returning `Ok(None)` if no row exists.
//! - [`load_all_space_snapshots`] — enumerate every persisted
//!   `(space_id, snapshot)` pair.  Used by the eager-load boot pass
//!   that rehydrates the registry without any synchronous-async glue
//!   in `LoroEngineRegistry::for_space` (see decision note below).
//! - [`save_all_engines`] — walk the registry, persist every dirty space in
//!   one transaction: all of them or none (#6521).
//! - [`save_engines_and_advance_cursor`] — the pass the periodic, background,
//!   exit, session-end, mobile-suspend and compaction triggers run: [`save_all_engines`],
//!   then the apply cursor moves to what it persisted, so boot dispatches index
//!   work, and a replay boot applies, only the ops after it (#5418).
//! - [`rehydrate_registry`] — boot: each engine from its snapshot and its
//!   `loro_doc_delta` rows (#6521), or from the snapshot alone for a replay
//!   boot.
//!
//! ## Boot rehydration design
//!
//! The plan offered three options for getting a snapshot into the
//! registry on first touch:
//!
//! - (a) Make `for_space` async + thread `&SqlitePool` through.
//!   Invasive — every caller of `merge::engine_apply` would need to
//!   become async.
//! - (b) `tokio::task::block_in_place` + `Handle::block_on` inside the
//!   sync `for_space`.  Hacky and risks deadlocks on single-threaded
//!   runtimes / nested tokio contexts.
//! - (c) Eager-load every persisted snapshot during app boot, into the
//!   registry, before any op-apply runs.  Pure-async path, no
//!   sync-from-async glue, and the boot cost is bounded by the number
//!   of spaces × snapshot-size.
//!
//! **Decision: option (c).**  Boot already has an async context
//! (`tauri::async_runtime::spawn` is invoked from the setup closure
//! around `lib.rs` line ~965), the snapshot table is small (one row
//! per space), and `LoroEngineRegistry` already exposes
//! [`LoroEngineRegistry::install_engine`] (added day-6) for the caller
//! to seed pre-built engines.  `for_space` stays sync and merely pulls
//! from the now-populated registry; on a space whose snapshot has not
//! been persisted yet the lazy-instantiate path still creates a fresh
//! engine, exactly as before.
//!
//! ## Failure semantics
//!
//! `load_snapshot` returns `Result<_, AppError>`.
//! The periodic scheduler ([`save_all_engines`]) is the place that
//! must NEVER abort the process: a pass that fails logs `tracing::warn!`,
//! writes nothing, and leaves its spaces dirty for the next one.

use sqlx::SqlitePool;

use crate::loro::engine::{ENGINE_FORMAT_VERSION, LoroEngine};
use crate::loro::registry::LoroEngineRegistry;
use agaric_core::error::AppError;
use agaric_store::space::SpaceId;

/// Wall-clock ms-since-Unix-epoch.  Returns `0` on the
/// (impossible-in-practice) case where the system clock is before
/// `UNIX_EPOCH`, matching `parity_sink::default_retention_cutoff_ms`'s
/// fail-soft convention.
fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// The highest locally-authored `op_log.seq`, read before a pass collects any
/// engine (#5418).
///
/// An op's engine writes, its cascade over its cohort included, commit with
/// the op, so an export taken after this read holds every op at or below it.
/// Two engine writes land after the commit instead:
///
/// * an op parked in `materializer_retry_queue`, durable on its own.
/// * draft recovery (`recovery::draft_recovery`), which runs only at boot and
///   awaits its engine write before the periodic pass is spawned, so no pass
///   reads a head between its commit and that write.
///
/// Replicated rows never reach an engine through the op log. A read error
/// fails the pass: a row stamped below what it holds is an op a replay boot
/// applies a second time (#6521).
async fn op_log_head(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
    let head = sqlx::query_scalar!(
        r#"SELECT MAX(seq) as "max_seq: i64" FROM op_log WHERE is_replicated = 0"#
    )
    .fetch_one(pool)
    .await?;
    Ok(head.unwrap_or(0))
}

/// Write one `loro_doc_state` row, replacing any existing one for `space_id`,
/// and delete the space's `loro_doc_delta` rows up to `covered_delta_id`
/// (#6521): the snapshot holds them, and a row left behind would never be
/// deleted by a later pass that finds the space clean. `conn` is the pass's
/// transaction, which makes the two one write.
///
/// `op_count` resets to 0 on every save — the column is reserved for a future
/// "snapshot every N ops" cadence and is unused by the time-driven scheduler.
async fn write_snapshot_row(
    conn: &mut sqlx::SqliteConnection,
    space_id: &SpaceId,
    bytes: Vec<u8>,
    applied_through_seq: i64,
    covered_delta_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT OR REPLACE INTO loro_doc_state \
         (space_id, snapshot, updated_at, op_count, applied_through_seq) \
         VALUES (?, ?, ?, 0, ?)",
    )
    .bind(space_id.as_str())
    .bind(bytes)
    .bind(now_ms())
    .bind(applied_through_seq)
    .execute(&mut *conn)
    .await?;
    let space = space_id.as_str();
    sqlx::query!(
        "DELETE FROM loro_doc_delta WHERE space_id = ? AND id <= ?",
        space,
        covered_delta_id,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Load the persisted snapshot bytes for `space_id`, or `Ok(None)` if
/// no row exists.  The bytes are opaque to this layer — the caller
/// passes them to [`LoroEngine::import`] to apply.
pub async fn load_snapshot(
    pool: &SqlitePool,
    space_id: &SpaceId,
) -> Result<Option<Vec<u8>>, AppError> {
    let row: Option<(Vec<u8>,)> =
        sqlx::query_as("SELECT snapshot FROM loro_doc_state WHERE space_id = ?")
            .bind(space_id.as_str())
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(b,)| b))
}

/// Enumerate every persisted snapshot.  Returns `(space_id_string,
/// snapshot_bytes)` pairs — the caller decides what to do with each
/// (usually: `LoroEngine::with_peer_id` + `import` + register).
///
/// This is the single SELECT used by the boot rehydration pass.  Bounded
/// by the user's space count (typically O(10)) so a full table scan
/// is fine.
pub async fn load_all_space_snapshots(
    pool: &SqlitePool,
) -> Result<Vec<(String, Vec<u8>)>, AppError> {
    let rows: Vec<(String, Vec<u8>)> =
        sqlx::query_as("SELECT space_id, snapshot FROM loro_doc_state")
            .fetch_all(pool)
            .await?;
    Ok(rows)
}

/// Boot-time rehydration: build every space's engine from what is saved for
/// it and install it. Called once during app setup before any op-apply runs.
///
/// With the [`boots_from_saved_rows`](crate::loro::delta::boots_from_saved_rows)
/// marker set, an engine is its snapshot with its `loro_doc_delta` rows
/// imported (#6521), and boot recovery replays no op. Without it, or when a
/// space's rows leave changes pending, the rows are deleted
/// ([`start_replay_boot`](crate::loro::delta::start_replay_boot)), the engines
/// are built from the snapshots alone, and boot recovery replays the op log
/// past them.
///
/// A snapshot or a row that will not import is an error and installs nothing
/// (#6525): a skipped space would get an empty engine on first access, and the
/// next save would replace the unreadable blob with it under the same PeerID.
/// Boot turns the error into its fatal dialog.
///
/// Every space is imported before any index is rebuilt, and one log line
/// marks the boundary, so `scripts/measure-boot.mjs` times the two passes
/// apart (#5707).
///
/// Returns the number of engines rehydrated.
pub async fn rehydrate_registry(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    device_id: &str,
) -> Result<usize, AppError> {
    let started = std::time::Instant::now();
    let from_saved_rows = if crate::loro::delta::boots_from_saved_rows(pool).await? {
        import_spaces(pool, registry, device_id, true).await?
    } else {
        None
    };
    let imported = match from_saved_rows {
        Some(imported) => imported,
        None => {
            // The snapshots are imported before the rows are deleted: one
            // that will not import stops boot with nothing deleted.
            let imported = import_spaces(pool, registry, device_id, false)
                .await?
                .ok_or_else(|| {
                    AppError::Snapshot("a saved snapshot leaves changes pending".to_owned())
                })?;
            crate::loro::delta::start_replay_boot(pool).await?;
            imported
        }
    };
    tracing::info!(
        imported_spaces = imported.len(),
        elapsed_ms = started.elapsed().as_millis(),
        "loro: imported per-space LoroDoc snapshots from loro_doc_state (index rebuild next)",
    );
    let ok = imported.len();
    for ImportedSpace {
        space_id,
        mut engine,
        needs_index,
        from_deltas,
    } in imported
    {
        if needs_index {
            // The rebuild can append the one-time sibling-order migration.
            let ((), migration) = engine.capturing_delta(LoroEngine::rebuild_index_after_import)?;
            if let Some(migration) = &migration {
                let mut conn = pool.acquire().await?;
                crate::loro::delta::insert_delta(&mut conn, &space_id, migration).await?;
            }
        }
        registry.install_engine(space_id.clone(), engine);
        if from_deltas {
            // A pass moves the stamp of every row it does not write, taking a
            // clean engine to equal its row. This one holds more than its
            // row, so the next pass must write it.
            registry.mark_dirty(&space_id);
        }
    }
    Ok(ok)
}

/// One space's engine, imported and not yet indexed or installed.
struct ImportedSpace {
    space_id: SpaceId,
    engine: LoroEngine,
    needs_index: bool,
    /// The engine holds `loro_doc_delta` rows on top of its snapshot.
    from_deltas: bool,
}

/// What is saved for one space: its `loro_doc_state` snapshot, if a pass has
/// written one, and its `loro_doc_delta` rows.
struct SavedRows {
    space_id: String,
    snapshot: Option<Vec<u8>>,
    deltas: Vec<Vec<u8>>,
}

/// Import every space's snapshot, and with `with_deltas` its `loro_doc_delta`
/// rows after it. `Ok(None)` when a space's rows leave changes pending: the
/// engines must then be built without the rows.
async fn import_spaces(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    device_id: &str,
    with_deltas: bool,
) -> Result<Option<Vec<ImportedSpace>>, AppError> {
    let mut deltas = if with_deltas {
        crate::loro::delta::load_deltas(pool).await?
    } else {
        std::collections::HashMap::new()
    };
    let mut saved: Vec<SavedRows> = load_all_space_snapshots(pool)
        .await?
        .into_iter()
        .map(|(space_id, snapshot)| SavedRows {
            deltas: deltas.remove(&space_id).unwrap_or_default(),
            space_id,
            snapshot: Some(snapshot),
        })
        .collect();
    // A space no pass has saved yet has rows and no snapshot.
    saved.extend(deltas.into_iter().map(|(space_id, deltas)| SavedRows {
        space_id,
        snapshot: None,
        deltas,
    }));

    let mut imported = Vec::with_capacity(saved.len());
    for SavedRows {
        space_id,
        snapshot,
        deltas,
    } in saved
    {
        // #792: derive the engine's PeerID from the registry's current
        // peer-id epoch (installed at boot from `app_settings`) so rehydrated
        // engines and lazily-created ones agree on the device's peer id.
        let mut engine = LoroEngine::with_peer_id_epoch(device_id, registry.peer_epoch())?;
        let rows = match engine.import_saved_rows(snapshot.as_deref(), &deltas) {
            Ok(rows) => rows,
            Err(e) => return Err(unreadable_snapshot(&space_id, &engine, &e)),
        };
        if !rows.complete {
            tracing::error!(
                space_id,
                rows = deltas.len(),
                "loro: a space's saved rows depend on engine writes no row holds (#6521)",
            );
            return Ok(None);
        }
        imported.push(ImportedSpace {
            space_id: SpaceId::from_trusted(&space_id),
            engine,
            needs_index: rows.needs_index,
            from_deltas: !deltas.is_empty(),
        });
    }
    Ok(Some(imported))
}

/// The error for a snapshot that failed to import into `engine`, worded for the
/// boot dialog: a stamp newer than this build names the fix.
fn unreadable_snapshot(space_id: &str, engine: &LoroEngine, cause: &AppError) -> AppError {
    let supported = i64::from(ENGINE_FORMAT_VERSION);
    match engine.format_version_stamp() {
        Some(found) if found > supported => AppError::Snapshot(format!(
            "This vault was last opened by a newer version of Agaric (engine format {found}; \
             this version reads up to {supported}). Install that newer version to open it."
        )),
        _ => AppError::Snapshot(format!(
            "The saved state of space {space_id} cannot be read ({cause}). Agaric stopped \
             rather than overwrite it."
        )),
    }
}

/// Held by [`save_all_engines`] from before its collect to after its last
/// write. An export collected earlier but written later would leave a row
/// older than its engine while the space reads clean, and the next pass would
/// advance that row's watermark past ops its blob lacks.
static ONE_PASS_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// What one [`save_all_engines`] pass did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SavePass {
    /// Spaces whose snapshot was written.
    pub saved: usize,
    /// The op-log head the pass read before collecting any engine, when it
    /// wrote its rows: each op at or below it is then in `loro_doc_state`.
    /// `None` when it wrote nothing: the head read, an export or a write
    /// failed, or the registry was cleared mid-pass.
    pub persisted_through: Option<i64>,
}

/// Walk the registry and persist every dirty engine's current snapshot, all
/// of them or none (`write_pass`). A pass that fails is logged and leaves
/// its spaces dirty for the next one. Passes run one at a time, whoever starts
/// them (#6521).
pub async fn save_all_engines(pool: &SqlitePool, registry: &LoroEngineRegistry) -> SavePass {
    let _pass = ONE_PASS_AT_A_TIME.lock().await;
    // Issue #153 / #2205 / #2201 — `snapshot_dirty_engines` collects the
    // per-space engine `Arc`s of ONLY the dirty spaces under the registry's
    // locks, then per space takes that engine's own lock for the O(1)
    // `LoroDoc` *handle* clone, and runs each (comparatively slow) snapshot
    // export with no lock held at all. Engine applies are therefore blocked
    // only for the O(1) handle clone of their own space, never for the
    // O(spaces x export) serialization. A `LoroDoc` clone is a reference
    // clone (shared underlying doc), so this does NOT double peak memory —
    // see `LoroEngineRegistry::snapshot_dirty_engines` for the full
    // rationale and the (unchanged) cross-space consistency contract.
    //
    // /C2: read the head BEFORE collecting any engine, so each export this
    // pass takes holds the ops at or below it (`op_log_head` lists the engine
    // writes that land later). Rows are stamped with it.
    let pass = async {
        let applied_through_seq = op_log_head(pool).await?;
        // #6521: likewise read before any engine is collected, so each export
        // holds the deltas at or below it.
        let covered = Covered {
            applied_through_seq,
            delta_id: crate::loro::delta::delta_head(pool).await?,
        };
        // #607 review: capture the clear-generation BEFORE collecting doc
        // handles; `write_pass` checks it before it commits.
        let collected = Collected::read(registry);
        let pairs = registry.snapshot_dirty_engines();
        let written = write_pass(pool, registry, collected, pairs, covered).await?;
        Ok::<_, AppError>((written, applied_through_seq))
    };
    match pass.await {
        Ok((written, applied_through_seq)) => {
            // #2201 — a space re-marked since its export was collected carries
            // a greater stamp, stays dirty and is persisted again next pass.
            for (space_id, mark_stamp) in &written {
                registry.clear_dirty_if_unchanged(space_id, *mark_stamp);
            }
            SavePass {
                saved: written.len(),
                persisted_through: Some(applied_through_seq),
            }
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                "loro:save_all_engines: the pass wrote nothing; its spaces stay dirty",
            );
            SavePass {
                saved: 0,
                persisted_through: None,
            }
        }
    }
}

/// What a pass read before it collected any engine, and so what each of its
/// exports holds: the local ops up to `applied_through_seq`, and the
/// `loro_doc_delta` rows up to `delta_id` (#6521).
#[derive(Clone, Copy)]
struct Covered {
    applied_through_seq: i64,
    delta_id: i64,
}

/// What a pass read of the registry before it collected any engine, checked
/// again before its rows commit.
#[derive(Clone, Copy)]
struct Collected {
    generation: u64,
    rewinds: u64,
}

impl Collected {
    fn read(registry: &LoroEngineRegistry) -> Self {
        Self {
            generation: registry.generation(),
            rewinds: registry.rewinds(),
        }
    }
}

/// Write one pass's rows and move every other row's stamp up to the pass's,
/// in one transaction (#6521). Returns the spaces written, each with the dirty
/// stamp its export was collected under.
///
/// A replay boot applies the local ops above the lowest stamp to every engine
/// (`recovery::replay`), and an op applied to an engine that holds it is a new
/// write, over whatever a peer wrote to the same block since. So no row may
/// hold an op above another row's stamp: a pass that cannot write one space
/// writes none, and a kill between two of its rows leaves none.
///
/// ## The rows the pass did not write (#3309)
///
/// Since #2201 only DIRTY spaces are re-encoded. A space that was edited once
/// and then went quiescent would keep its first stamp forever, and
/// `recovery::replay::heal_orphaned_apply_cursor` rewinds the apply cursor to
/// the lowest one. A space outside `pairs` was clean at the collect, so its
/// row equals its engine (a boot that built an engine from its row and delta
/// rows marks it dirty), and every row has an engine behind it: boot installs
/// one for each row or stops (#6525), and a pass writes rows only for engines.
/// That engine holds the local ops up to the pass's head, bar the writes
/// [`op_log_head`] lists, so its stamp moves with the others.
///
/// This holds for a rehydrated engine only AFTER
/// `recovery::boot::recover_at_boot` has run: between rehydration and the
/// heal+replay, an engine reflects only its own row's stamp while the op log
/// may be far ahead. Production ordering guarantees it — `lib.rs::run` calls
/// `recover_and_bootstrap` BEFORE `spawn_background_tasks` starts the periodic
/// pass, and the exit-time save runs later still — so no pass can observe that
/// window. A future change that starts a snapshot pass before boot recovery
/// would break this premise and the stamp every row records.
///
/// `updated_at` is left alone: it records when the BLOB was written.
///
/// ## The generation check (#607, #4020, #2910)
///
/// `generation` is the clear-generation the pass captured before its collect.
/// A `LoroEngineRegistry::clear` (test-only) or an
/// [`LoroEngineRegistry::evict_space`] (a purged space's engine dropped with
/// its row) since then means `pairs` may hold an engine whose row is gone, and
/// the rows may belong to a wiped or shrunk table: nothing is committed. It is
/// checked once, last, so that it also covers a pass with no dirty space,
/// which writes no row and still moves the stamps.
///
/// ## The rewind check (#6521)
///
/// An export is taken with no lock held, so it can hold the write of a
/// transaction that is still open. If that transaction rolls back, the row
/// would hold ops the engine does not, and the next write to commit reuses
/// their ids: the rewind keeps the peer id. A boot from that row and the
/// later write's delta would keep the rolled-back write and drop the committed
/// one. So a pass during which any engine was rewound commits nothing; its
/// spaces stay dirty, and the next pass exports the engines as rewound.
async fn write_pass(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    collected: Collected,
    pairs: Vec<(SpaceId, u64, Result<Vec<u8>, AppError>)>,
    covered: Covered,
) -> Result<Vec<(SpaceId, u64)>, AppError> {
    let Covered {
        applied_through_seq,
        delta_id,
    } = covered;
    // allow-raw-tx: engine persistence (`loro_doc_state`, `loro_doc_delta`); no op_log write.
    let mut tx = agaric_store::db::begin_immediate_logged(pool, "loro_snapshot_pass").await?;
    let mut written = Vec::with_capacity(pairs.len());
    for (space_id, mark_stamp, bytes) in pairs {
        write_snapshot_row(&mut tx, &space_id, bytes?, applied_through_seq, delta_id).await?;
        written.push((space_id, mark_stamp));
    }
    // `<` so a stamp is never walked back.
    sqlx::query("UPDATE loro_doc_state SET applied_through_seq = ? WHERE applied_through_seq < ?")
        .bind(applied_through_seq)
        .bind(applied_through_seq)
        .execute(&mut *tx)
        .await?;
    if registry.generation() != collected.generation {
        return Err(AppError::Snapshot(
            "the engine registry was cleared or a space evicted mid-pass (#607, #2910)".to_owned(),
        ));
    }
    if !registry.no_rewind_since(collected.rewinds).await {
        return Err(AppError::Snapshot(
            "a transaction rolled back an engine write mid-pass (#6521)".to_owned(),
        ));
    }
    tx.commit().await?;
    Ok(written)
}

/// One production snapshot pass (#5418): [`save_all_engines`], then the apply
/// cursor moves up to the op-log head the pass persisted, so the next boot
/// replays only the ops committed after it instead of the whole session.
///
/// Boot owes an op past the cursor its per-block index fan-out (FTS, links,
/// tag refs; #3298), which lives in the background queue's memory until it
/// runs, and a replay boot also owes it its engine state, which the pass has
/// just made durable (bar the late writes `op_log_head` lists). So the queue
/// is drained before the cursor stops covering those ops.
/// A pass that wrote nothing moves nothing: a space whose first write failed
/// has no row for the boot heal's `MIN(applied_through_seq)` to see, and only
/// the old cursor still replays its ops.
///
/// The rows are committed before the drain, so a kill during it, or a queue
/// that cannot drain, leaves the cursor behind them. A replay boot reads the
/// rows' stamp and applies only the ops above it (`recovery::replay`, #6521).
///
/// Returns `save_all_engines`' [`SavePass`]: compaction reads its
/// `persisted_through` before it deletes any op (#6518).
pub async fn save_engines_and_advance_cursor(
    pool: &SqlitePool,
    materializer: &crate::materializer::Materializer,
) -> SavePass {
    let pass = save_all_engines(pool, &materializer.loro_state().registry).await;
    let Some(head) = pass.persisted_through else {
        return pass;
    };
    if let Err(e) = materializer.flush_background().await {
        tracing::warn!(
            error = %e,
            "loro: background queue did not drain; apply cursor left in place (#5418)",
        );
        return pass;
    }
    let advanced = match pool.acquire().await {
        Ok(mut conn) => crate::apply::kernel::advance_apply_cursor(&mut conn, head).await,
        Err(e) => Err(e.into()),
    };
    if let Err(e) = advanced {
        tracing::warn!(
            error = %e,
            head,
            "loro: apply cursor advance failed; the next boot replays from the old cursor (#5418)",
        );
    }
    pass
}

/// Default cadence for the periodic snapshot task (5 minutes).
///
/// Restored after the parity flush task — which hosted the
/// `save_all_engines` call on its tick — was deleted, leaving snapshots
/// unpersisted (the resulting empty `loro_doc_state` + advancing apply
/// cursor wedged the materializer). The engine applies at human-typing
/// rates, so a 5-minute snapshot bounds the boot-replay tail to a
/// handful of ops while keeping the snapshot cost negligible.
pub const SNAPSHOT_INTERVAL_SECS: u64 = 300;

/// Spawn the periodic Loro snapshot task.
///
/// Every `interval_secs` it runs [`save_engines_and_advance_cursor`] over the
/// materializer's engine registry, so the next boot rehydrates without
/// replaying the full op-log. The task runs for
/// the app's lifetime and stops once `shutdown` flips. A failed pass is
/// logged inside [`save_all_engines`], so a transient SQL/Loro failure never
/// crashes the app.
/// `spawn` injects the async executor: the app passes
/// `|fut| { tauri::async_runtime::spawn(fut); }` (so `agaric-engine` stays
/// tauri-free), tests pass `|fut| { tokio::spawn(fut); }` (#2621, wave E1).
pub fn spawn_periodic_snapshot(
    pool: SqlitePool,
    shutdown: std::sync::Arc<std::sync::atomic::AtomicBool>,
    interval_secs: u64,
    materializer: crate::materializer::Materializer,
    spawn: impl FnOnce(std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>),
) {
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    // Fire-and-forget: the task lives for the process lifetime and stops
    // when `shutdown` flips. The spawned JoinHandle is intentionally discarded
    // by the caller-supplied `spawn`.
    spawn(Box::pin(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(interval_secs.max(1)));
        // Skip the immediate first tick — `tokio::time::interval` fires
        // once at construction. Boot rehydrate just ran, so there is
        // nothing new to persist yet.
        interval.tick().await;
        loop {
            interval.tick().await;
            if shutdown.load(Ordering::Relaxed) {
                break;
            }
            let saved = save_engines_and_advance_cursor(&pool, &materializer)
                .await
                .saved;
            if saved > 0 {
                tracing::debug!(spaces = saved, "loro: periodic snapshot persisted");
            }
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loro::engine::PropertyValue;
    use tempfile::TempDir;

    /// One space's save, outside `save_all_engines`' dirty tracking.
    async fn save_snapshot(
        pool: &SqlitePool,
        space_id: &SpaceId,
        engine: &LoroEngine,
    ) -> Result<(), AppError> {
        let applied_through_seq = op_log_head(pool).await?;
        let bytes = engine.export_snapshot()?;
        let mut conn = pool.acquire().await?;
        write_snapshot_row(&mut conn, space_id, bytes, applied_through_seq, 0).await?;
        Ok(())
    }

    /// A pass that read `applied_through_seq` as the op-log head and no delta.
    fn covering(applied_through_seq: i64) -> Covered {
        Covered {
            applied_through_seq,
            delta_id: 0,
        }
    }

    const SPACE_A: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const SPACE_B: &str = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
    /// Distinct space for the periodic-snapshot smoke test. The global
    /// registry is shared within a test binary, so this ULID must not
    /// collide with `SPACE_A`/`SPACE_B` above.
    const SPACE_PERIODIC: &str = "01J0PERIODICSNAP000000TEST";

    async fn fresh_pool() -> (SqlitePool, TempDir) {
        agaric_store::test_support::test_pool().await
    }

    #[tokio::test]
    async fn save_then_load_round_trips() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);
        let mut engine = LoroEngine::with_peer_id("device-1").expect("engine");
        engine
            .apply_create_block("BLOCK1", "content", "hello", None, 0)
            .expect("create");

        save_snapshot(&pool, &space, &engine).await.expect("save");

        let loaded = load_snapshot(&pool, &space)
            .await
            .expect("load")
            .expect("present");
        let expected = engine.export_snapshot().expect("export for compare");
        assert_eq!(
            loaded, expected,
            "loaded bytes must equal the engine's current snapshot bytes"
        );
    }

    #[tokio::test]
    async fn load_returns_none_for_missing_space() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);
        let loaded = load_snapshot(&pool, &space).await.expect("load");
        assert!(loaded.is_none(), "missing row must yield Ok(None)");
    }

    #[tokio::test]
    async fn save_overwrites_existing_row() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        let mut engine_v1 = LoroEngine::with_peer_id("device-1").expect("engine1");
        engine_v1
            .apply_create_block("BLOCK1", "content", "first", None, 0)
            .expect("create");
        save_snapshot(&pool, &space, &engine_v1)
            .await
            .expect("save v1");

        // Snapshot a different state.
        let mut engine_v2 = LoroEngine::with_peer_id("device-1").expect("engine2");
        engine_v2
            .apply_create_block("BLOCK1", "content", "first", None, 0)
            .expect("create");
        engine_v2
            .apply_create_block("BLOCK2", "content", "second", None, 1)
            .expect("create2");
        save_snapshot(&pool, &space, &engine_v2)
            .await
            .expect("save v2");

        let loaded = load_snapshot(&pool, &space)
            .await
            .expect("load")
            .expect("present");
        let expected = engine_v2.export_snapshot().expect("export v2");
        assert_eq!(
            loaded, expected,
            "INSERT OR REPLACE must leave only the latest row visible"
        );

        // Single-row invariant: the PRIMARY KEY on `space_id` is the
        // contract; verify exactly one row exists for this space.
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM loro_doc_state WHERE space_id = ?")
                .bind(space.as_str())
                .fetch_one(&pool)
                .await
                .expect("count");
        assert_eq!(count, 1, "PRIMARY KEY contract: one row per space_id");
    }

    #[tokio::test]
    async fn rehydrate_engine_from_snapshot_recovers_state() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);

        // Engine A: apply some ops, save its snapshot.
        let mut engine_a = LoroEngine::with_peer_id("device-1").expect("engine_a");
        engine_a
            .apply_create_block("BLOCK1", "content", "hello world", None, 0)
            .expect("create");
        engine_a
            .apply_set_property("BLOCK1", "todo_state", Some("DONE"))
            .expect("set_property");
        save_snapshot(&pool, &space, &engine_a).await.expect("save");

        // Engine B: fresh, then load + import.  Reads must match.
        let bytes = load_snapshot(&pool, &space)
            .await
            .expect("load")
            .expect("present");
        let mut engine_b = LoroEngine::with_peer_id("device-1").expect("engine_b");
        engine_b.import(&bytes).expect("import");

        let snap = engine_b
            .read_block("BLOCK1")
            .expect("read")
            .expect("present");
        assert_eq!(snap.content, "hello world");

        let prop = engine_b
            .read_property_typed("BLOCK1", "todo_state")
            .expect("read_property_typed");
        assert_eq!(prop, Some(PropertyValue::Str("DONE".to_string())));
    }

    #[tokio::test]
    async fn rehydrate_registry_seeds_engines_from_persisted_snapshots() {
        let (pool, _dir) = fresh_pool().await;

        // Seed two persisted snapshots, one per space.
        let space_a = SpaceId::from_trusted(SPACE_A);
        let space_b = SpaceId::from_trusted(SPACE_B);
        let mut engine_a = LoroEngine::with_peer_id("device-1").expect("engine_a");
        engine_a
            .apply_create_block("BLOCK_A", "content", "in A", None, 0)
            .expect("create");
        save_snapshot(&pool, &space_a, &engine_a)
            .await
            .expect("save a");

        let mut engine_b = LoroEngine::with_peer_id("device-1").expect("engine_b");
        engine_b
            .apply_create_block("BLOCK_B", "content", "in B", None, 0)
            .expect("create");
        save_snapshot(&pool, &space_b, &engine_b)
            .await
            .expect("save b");

        // Fresh registry: rehydrate.
        let registry = LoroEngineRegistry::new();
        let n = rehydrate_registry(&pool, &registry, "device-1")
            .await
            .expect("rehydrate");
        assert_eq!(n, 2, "both spaces must rehydrate");
        assert_eq!(registry.len(), 2);

        // Engines hold the seeded blocks.
        let mut g = registry.for_space(&space_a, "device-1").expect("a");
        let snap = g.engine_mut().read_block("BLOCK_A").unwrap().unwrap();
        assert_eq!(snap.content, "in A");
        drop(g);

        let mut g = registry.for_space(&space_b, "device-1").expect("b");
        let snap = g.engine_mut().read_block("BLOCK_B").unwrap().unwrap();
        assert_eq!(snap.content, "in B");
    }

    /// #5707: `scripts/measure-boot.mjs` takes the first line with this prefix
    /// as the end of the import pass, so it is logged once, after every space.
    #[test]
    fn rehydrate_registry_logs_the_import_milestone_once_after_every_space_5707() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let (n, logs) = crate::loro::engine::test_log_capture::capture_logs(|| {
            rt.block_on(async {
                let (pool, _dir) = fresh_pool().await;
                for (space, block) in [(SPACE_A, "BLOCK_A"), (SPACE_B, "BLOCK_B")] {
                    let mut engine = LoroEngine::with_peer_id("device-1").expect("engine");
                    engine
                        .apply_create_block(block, "content", "x", None, 0)
                        .expect("create");
                    save_snapshot(&pool, &SpaceId::from_trusted(space), &engine)
                        .await
                        .expect("save");
                }
                rehydrate_registry(&pool, &LoroEngineRegistry::new(), "device-1")
                    .await
                    .expect("rehydrate")
            })
        });
        assert_eq!(n, 2);
        let milestones: Vec<&str> = logs
            .lines()
            .filter(|l| l.contains("loro: imported per-space"))
            .collect();
        assert_eq!(milestones.len(), 1, "{logs}");
        assert!(milestones[0].contains("imported_spaces=2"), "{logs}");
    }

    #[tokio::test]
    async fn save_all_engines_persists_every_registered_engine() {
        let (pool, _dir) = fresh_pool().await;

        // Build a registry with two engines populated through the
        // normal lazy path — write distinct blocks into each.
        let registry = LoroEngineRegistry::new();
        let space_a = SpaceId::from_trusted(SPACE_A);
        let space_b = SpaceId::from_trusted(SPACE_B);

        {
            let mut g = registry.for_space(&space_a, "device-1").expect("a");
            g.engine_mut()
                .apply_create_block("BLOCK_A", "content", "in A", None, 0)
                .expect("create");
        }
        {
            let mut g = registry.for_space(&space_b, "device-1").expect("b");
            g.engine_mut()
                .apply_create_block("BLOCK_B", "content", "in B", None, 0)
                .expect("create");
        }

        let n = save_all_engines(&pool, &registry).await.saved;
        assert_eq!(n, 2, "both spaces must snapshot");

        // The persisted bytes must reproduce the engine's state.
        let bytes = load_snapshot(&pool, &space_a)
            .await
            .expect("load")
            .expect("present");
        let mut hydrated = LoroEngine::with_peer_id("device-1").expect("engine");
        hydrated.import(&bytes).expect("import");
        let snap = hydrated.read_block("BLOCK_A").unwrap().unwrap();
        assert_eq!(snap.content, "in A");
    }

    /// #2201 — the periodic tick re-encodes ONLY changed spaces. After both
    /// spaces are persisted once, mutating A alone must re-encode A and leave
    /// B's `loro_doc_state` row byte-for-byte untouched (proven via its
    /// `updated_at`), and the pass reports exactly one space persisted.
    #[tokio::test]
    async fn save_all_engines_persists_only_dirty_spaces_2201() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let space_a = SpaceId::from_trusted(SPACE_A);
        let space_b = SpaceId::from_trusted(SPACE_B);

        for (space, id) in [(&space_a, "BLOCK_A"), (&space_b, "BLOCK_B")] {
            let mut g = registry.for_space(space, "device-1").expect("for_space");
            g.engine_mut()
                .apply_create_block(id, "content", id, None, 0)
                .expect("create");
        }

        // First pass persists BOTH dirty spaces and clears both flags.
        let n = save_all_engines(&pool, &registry).await.saved;
        assert_eq!(n, 2, "first pass persists both dirty spaces");
        assert_eq!(registry.dirty_count(), 0, "both spaces clean after persist");

        // Capture B's row so a later rewrite would be observable.
        let b_updated_before: i64 =
            sqlx::query_scalar("SELECT updated_at FROM loro_doc_state WHERE space_id = ?")
                .bind(space_b.as_str())
                .fetch_one(&pool)
                .await
                .expect("b row");

        // `now_ms` is ms-resolution — sleep so a rewrite of B would advance it.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;

        // Mutate ONLY space A.
        {
            let mut g = registry
                .for_space(&space_a, "device-1")
                .expect("for_space a");
            g.engine_mut()
                .apply_create_block("BLOCK_A2", "content", "again", None, 1)
                .expect("create");
        }
        assert_eq!(registry.dirty_count(), 1, "only A dirty after mutating A");

        // Second pass must re-encode ONLY A.
        let n = save_all_engines(&pool, &registry).await.saved;
        assert_eq!(n, 1, "second pass persists only the dirty space (A), not B");
        assert_eq!(registry.dirty_count(), 0, "A clean after its persist");

        let b_updated_after: i64 =
            sqlx::query_scalar("SELECT updated_at FROM loro_doc_state WHERE space_id = ?")
                .bind(space_b.as_str())
                .fetch_one(&pool)
                .await
                .expect("b row after");
        assert_eq!(
            b_updated_before, b_updated_after,
            "a clean space must NOT be re-encoded — its row must be untouched"
        );

        // A's row is present and reflects the new block.
        let a_bytes = load_snapshot(&pool, &space_a)
            .await
            .expect("load a")
            .expect("a present");
        let mut probe = LoroEngine::with_peer_id("device-1").expect("probe");
        probe.import(&a_bytes).expect("import a");
        assert!(
            probe.read_block("BLOCK_A2").expect("read").is_some(),
            "A's re-encoded snapshot must contain the block mutated this tick"
        );
    }

    /// Seed a `loro_doc_state` row directly, as if it had been persisted by
    /// an earlier session.
    async fn seed_row(pool: &SqlitePool, space_id: &str, applied_through_seq: i64) {
        sqlx::query(
            "INSERT OR REPLACE INTO loro_doc_state \
             (space_id, snapshot, updated_at, op_count, applied_through_seq) \
             VALUES (?, X'00', 1767225600000, 0, ?)",
        )
        .bind(space_id)
        .bind(applied_through_seq)
        .execute(pool)
        .await
        .expect("seed loro_doc_state row");
    }

    /// Put one locally-authored row at `seq` in the op log, so a pass reads
    /// it as the op-log head (#5418).
    async fn seed_op_log_head(pool: &SqlitePool, seq: i64) {
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES ('device-1', ?, NULL, ?, 'create_block', '{}', 1767225600000)",
        )
        .bind(seq)
        .bind(format!("hash-{seq}"))
        .execute(pool)
        .await
        .expect("seed op_log head");
    }

    /// Install a CLEAN engine for `space_id`, as boot rehydration does for
    /// every persisted space. `install_engine` does not mark the space
    /// dirty, so the registry state matches "persisted earlier, untouched
    /// since" — the shape whose stamp a pass moves without writing its row.
    fn install_clean_engine(registry: &LoroEngineRegistry, space_id: &str) {
        registry.install_engine(
            SpaceId::from_trusted(space_id),
            LoroEngine::with_peer_id("device-1").expect("engine"),
        );
        assert_eq!(
            registry.dirty_count(),
            0,
            "install_engine must not mark the space dirty"
        );
    }

    async fn watermark_of(pool: &SqlitePool, space_id: &str) -> i64 {
        sqlx::query_scalar("SELECT applied_through_seq FROM loro_doc_state WHERE space_id = ?")
            .bind(space_id)
            .fetch_one(pool)
            .await
            .expect("watermark")
    }

    /// #3309 — a space that was persisted once and then went QUIESCENT must
    /// not pin `MIN(applied_through_seq)` forever.
    ///
    /// Since #2201 only dirty spaces are re-encoded, so B's row (written by
    /// a long-past session at watermark 1) used to keep that watermark for
    /// the lifetime of the vault. `heal_orphaned_apply_cursor` rewinds the
    /// global apply cursor to `MIN(applied_through_seq)`, so every boot
    /// re-drove the whole op-log tail through the foreground materializer.
    /// The pass must therefore advance the watermark of the spaces it did
    /// NOT re-encode — while still not re-encoding them (#2201).
    #[tokio::test]
    async fn save_all_engines_advances_watermark_of_quiescent_space_3309() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let space_a = SpaceId::from_trusted(SPACE_A);

        // B: edited once long ago (watermark 1), never touched since — it is
        // absent from the registry's dirty set for good, but (as in
        // production) boot rehydration DID install its engine.
        seed_row(&pool, SPACE_B, 1).await;
        install_clean_engine(&registry, SPACE_B);
        let b_blob_before: Vec<u8> =
            sqlx::query_scalar("SELECT snapshot FROM loro_doc_state WHERE space_id = ?")
                .bind(SPACE_B)
                .fetch_one(&pool)
                .await
                .expect("b blob before");
        let b_updated_before: i64 =
            sqlx::query_scalar("SELECT updated_at FROM loro_doc_state WHERE space_id = ?")
                .bind(SPACE_B)
                .fetch_one(&pool)
                .await
                .expect("b updated_at before");

        // A is the space the user actually works in; the op log has run far
        // ahead of B's frozen watermark.
        seed_op_log_head(&pool, 500).await;
        {
            let mut g = registry.for_space(&space_a, "device-1").expect("for_space");
            g.engine_mut()
                .apply_create_block("BLOCK_A", "content", "in A", None, 0)
                .expect("create");
        }

        let n = save_all_engines(&pool, &registry).await.saved;
        assert_eq!(n, 1, "only the dirty space A is re-encoded");

        assert_eq!(
            watermark_of(&pool, SPACE_A).await,
            500,
            "the re-encoded space records the head the pass read"
        );
        assert_eq!(
            watermark_of(&pool, SPACE_B).await,
            500,
            "the quiescent space's watermark must be advanced too — otherwise it \
             pins MIN(applied_through_seq) and every boot rewinds to it (#3309)"
        );

        // ...but #2201 still holds: B's BLOB is not re-encoded and its
        // blob-write timestamp is untouched.
        let b_blob_after: Vec<u8> =
            sqlx::query_scalar("SELECT snapshot FROM loro_doc_state WHERE space_id = ?")
                .bind(SPACE_B)
                .fetch_one(&pool)
                .await
                .expect("b blob after");
        assert_eq!(
            b_blob_before, b_blob_after,
            "advancing the watermark must not re-encode a clean space (#2201)"
        );
        let b_updated_after: i64 =
            sqlx::query_scalar("SELECT updated_at FROM loro_doc_state WHERE space_id = ?")
                .bind(SPACE_B)
                .fetch_one(&pool)
                .await
                .expect("b updated_at after");
        assert_eq!(
            b_updated_before, b_updated_after,
            "updated_at records when the BLOB was written; no blob was written for B"
        );
    }

    /// #4020 — a snapshot RESET racing the pass must stop it from moving the
    /// clean rows' stamps, and that must hold when the dirty set is EMPTY: the
    /// quiescent vault, where moving them is all the pass does.
    ///
    /// Driven against [`write_pass`] directly: the generation is captured
    /// INSIDE `save_all_engines`, so a clear that lands between the capture and
    /// the write cannot be scheduled from the outside. The matching positive
    /// direction — same shape, generation unchanged, row advanced — is
    /// `save_all_engines_advances_watermark_of_quiescent_space_3309`.
    #[tokio::test]
    async fn clean_watermark_refresh_bails_when_the_registry_was_cleared_4020() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();

        // The quiescent shape: one persisted space, its engine rehydrated and
        // clean, nothing dirty anywhere.
        seed_row(&pool, SPACE_B, 1).await;
        install_clean_engine(&registry, SPACE_B);
        assert_eq!(registry.dirty_count(), 0, "no dirty space in this pass");

        // What `save_all_engines` captures before its collect.
        let collected = Collected::read(&registry);

        // …and the RESET that lands before the write.
        registry.clear();
        assert_ne!(
            registry.generation(),
            collected.generation,
            "clear() must bump the generation, or this test proves nothing"
        );

        let pass = write_pass(&pool, &registry, collected, Vec::new(), covering(499)).await;

        assert!(
            matches!(pass, Err(AppError::Snapshot(_))),
            "a pass whose engines the RESET destroyed must write nothing \
             (#607/#4020): {pass:?}"
        );
        assert_eq!(
            watermark_of(&pool, SPACE_B).await,
            1,
            "the pre-reset watermark must survive: advancing it would claim a wiped \
             table's row reflects the op-log and suppress the rebuild that repairs it"
        );
    }

    /// #6521 — a pass that cannot write one space writes none. Boot replays
    /// the ops above the lowest stamp onto every engine, so a row left holding
    /// ops above another row's stamp gets them a second time, as new writes
    /// over whatever a peer wrote since.
    ///
    /// Two dirty spaces and one quiescent space (C). The trigger refuses the
    /// second row of the pass, whichever space the pass writes first.
    #[tokio::test]
    async fn a_pass_that_cannot_write_one_space_writes_none_6521() {
        const SPACE_C: &str = "01D0Z9Z0Z9Z0Z9Z0Z9Z0Z9Z0Z9";

        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let space_a = SpaceId::from_trusted(SPACE_A);
        let space_b = SpaceId::from_trusted(SPACE_B);

        seed_row(&pool, SPACE_A, 1).await;
        seed_row(&pool, SPACE_B, 1).await;
        seed_row(&pool, SPACE_C, 1).await;
        install_clean_engine(&registry, SPACE_C);
        seed_op_log_head(&pool, 500).await;

        for (space, block) in [(&space_a, "BLOCK_A0"), (&space_b, "BLOCK_B0")] {
            let mut g = registry.for_space(space, "device-1").expect("for_space");
            g.engine_mut()
                .apply_create_block(block, "content", "mutation", None, 0)
                .expect("create");
        }
        assert_eq!(registry.dirty_count(), 2, "A and B are both dirty");

        sqlx::query(
            "CREATE TRIGGER poison_the_second_row_of_a_pass \
             BEFORE INSERT ON loro_doc_state \
             WHEN EXISTS (SELECT 1 FROM loro_doc_state WHERE applied_through_seq = 500) \
             BEGIN SELECT RAISE(ABORT, 'simulated persist failure'); END",
        )
        .execute(&pool)
        .await
        .expect("create poison trigger");

        let pass = save_all_engines(&pool, &registry).await;
        assert_eq!(
            (pass.saved, pass.persisted_through),
            (0, None),
            "the pass saved nothing"
        );
        for space in [SPACE_A, SPACE_B, SPACE_C] {
            assert_eq!(
                watermark_of(&pool, space).await,
                1,
                "no row may move past another's stamp: {space}"
            );
        }
        for space in [SPACE_A, SPACE_B] {
            let blob: Vec<u8> =
                sqlx::query_scalar("SELECT snapshot FROM loro_doc_state WHERE space_id = ?")
                    .bind(space)
                    .fetch_one(&pool)
                    .await
                    .expect("blob");
            assert_eq!(blob, vec![0u8], "the row is the one it had: {space}");
        }
        assert_eq!(registry.dirty_count(), 2, "and both spaces stay dirty");

        sqlx::query("DROP TRIGGER poison_the_second_row_of_a_pass")
            .execute(&pool)
            .await
            .expect("drop poison trigger");
        let pass = save_all_engines(&pool, &registry).await;
        assert_eq!(
            (pass.saved, pass.persisted_through),
            (2, Some(500)),
            "the next pass writes both"
        );
        for space in [SPACE_A, SPACE_B, SPACE_C] {
            assert_eq!(
                watermark_of(&pool, space).await,
                500,
                "every row carries the pass's stamp: {space}"
            );
        }
    }

    /// #6521 — and so does a pass with an export that failed, whichever row
    /// comes first.
    #[tokio::test]
    async fn a_pass_with_a_failed_export_writes_none_6521() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let exported = LoroEngine::with_peer_id("device-1")
            .expect("engine")
            .export_snapshot()
            .expect("export");
        let pairs = vec![
            (SpaceId::from_trusted(SPACE_A), 1, Ok(exported)),
            (
                SpaceId::from_trusted(SPACE_B),
                2,
                Err(AppError::validation("simulated export failure".to_owned())),
            ),
        ];

        let pass = write_pass(
            &pool,
            &registry,
            Collected::read(&registry),
            pairs,
            covering(500),
        )
        .await;

        assert!(pass.is_err(), "the pass fails: {pass:?}");
        assert!(
            load_snapshot(&pool, &SpaceId::from_trusted(SPACE_A))
                .await
                .expect("load")
                .is_none(),
            "the row written before the failed export is not kept"
        );
    }

    /// #6521 — a pass that cannot read the op-log head writes nothing: a row
    /// stamped below what it holds is an op boot applies a second time.
    #[tokio::test]
    async fn a_pass_that_cannot_read_the_head_writes_nothing_6521() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let space_a = SpaceId::from_trusted(SPACE_A);
        registry
            .for_space(&space_a, "device-1")
            .expect("for_space")
            .engine_mut()
            .apply_create_block("BLOCK_A", "content", "in A", None, 0)
            .expect("create");
        sqlx::query("DROP TABLE op_log")
            .execute(&pool)
            .await
            .expect("drop table");

        let pass = save_all_engines(&pool, &registry).await;

        assert_eq!(
            (pass.saved, pass.persisted_through),
            (0, None),
            "the pass saved nothing"
        );
        assert!(
            load_snapshot(&pool, &space_a)
                .await
                .expect("load")
                .is_none(),
            "no row carries a stamp the pass did not read"
        );
        assert_eq!(registry.dirty_count(), 1, "and the space stays dirty");
    }

    /// #2201 — a per-space persist FAILURE leaves that space dirty so the
    /// next tick retries it (never silently clears a flag whose state was not
    /// persisted). The INSERT is forced to fail by dropping the target table;
    /// the in-memory export still succeeds, only the write fails.
    #[tokio::test]
    async fn save_all_engines_persist_failure_keeps_space_dirty_2201() {
        let (pool, _dir) = fresh_pool().await;
        let registry = LoroEngineRegistry::new();
        let space_a = SpaceId::from_trusted(SPACE_A);
        {
            let mut g = registry.for_space(&space_a, "device-1").expect("for_space");
            g.engine_mut()
                .apply_create_block("BLOCK_A", "content", "in A", None, 0)
                .expect("create");
        }
        assert_eq!(registry.dirty_count(), 1, "A dirty after mutation");

        // Force the INSERT OR REPLACE to fail (the watermark read targets a
        // different table, so collection + export still succeed).
        sqlx::query("DROP TABLE loro_doc_state")
            .execute(&pool)
            .await
            .expect("drop table");

        let n = save_all_engines(&pool, &registry).await.saved;
        assert_eq!(n, 0, "no space is counted persisted when the INSERT fails");
        assert_eq!(
            registry.dirty_count(),
            1,
            "a failed persist must LEAVE the space dirty for the next tick"
        );
    }

    async fn apply_cursor(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar(
            "SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1",
        )
        .fetch_one(pool)
        .await
        .expect("apply cursor")
    }

    /// Mutate `space_id`'s engine in `materializer`'s registry, marking it
    /// dirty, as an applied op does.
    fn dirty_engine(materializer: &crate::materializer::Materializer, space_id: &str) {
        let mut g = materializer
            .loro_state()
            .registry
            .for_space(&SpaceId::from_trusted(space_id), "device-1")
            .expect("for_space");
        g.engine_mut()
            .apply_create_block("BLOCK_5418", "content", "applied", None, 0)
            .expect("create");
    }

    /// #5418 — a pass that wrote every dirty engine moves the apply cursor to
    /// the op-log head it read, and stamps the row with it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_pass_advances_the_apply_cursor_to_the_op_log_head_5418() {
        let (pool, _dir) = fresh_pool().await;
        let materializer = crate::materializer::Materializer::new(pool.clone());
        seed_op_log_head(&pool, 7).await;
        dirty_engine(&materializer, SPACE_A);

        let saved = save_engines_and_advance_cursor(&pool, &materializer)
            .await
            .saved;
        materializer.shutdown();

        assert_eq!(saved, 1, "the dirty space is written");
        assert_eq!(
            watermark_of(&pool, SPACE_A).await,
            7,
            "the row is stamped with the head"
        );
        assert_eq!(
            apply_cursor(&pool).await,
            7,
            "boot replay must start after the head the pass persisted"
        );
    }

    /// #5418 — an op with no engine write (an attachment, a SQL-only fallback)
    /// leaves every engine clean. The pass still moves the cursor past it, so
    /// boot does not replay a tail of them.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn quiescent_pass_advances_the_apply_cursor_5418() {
        let (pool, _dir) = fresh_pool().await;
        let materializer = crate::materializer::Materializer::new(pool.clone());
        seed_op_log_head(&pool, 7).await;

        let saved = save_engines_and_advance_cursor(&pool, &materializer)
            .await
            .saved;
        materializer.shutdown();

        assert_eq!(saved, 0, "no engine is dirty");
        assert_eq!(
            apply_cursor(&pool).await,
            7,
            "boot replay must start after the head even when no engine was written"
        );
    }

    /// #5418 — the cursor moves only once every dirty engine is written. A
    /// space whose FIRST write fails has no row, so the boot heal's
    /// `MIN(applied_through_seq)` cannot see it; only the unmoved cursor still
    /// replays its ops. This is the crash before the snapshot commits.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn failed_snapshot_write_leaves_the_apply_cursor_5418() {
        let (pool, _dir) = fresh_pool().await;
        let materializer = crate::materializer::Materializer::new(pool.clone());
        seed_op_log_head(&pool, 7).await;
        dirty_engine(&materializer, SPACE_A);
        sqlx::query(
            "CREATE TRIGGER poison_loro_doc_state_insert \
             BEFORE INSERT ON loro_doc_state \
             BEGIN SELECT RAISE(ABORT, 'simulated persist failure'); END",
        )
        .execute(&pool)
        .await
        .expect("create poison trigger");

        let saved = save_engines_and_advance_cursor(&pool, &materializer)
            .await
            .saved;
        materializer.shutdown();

        assert_eq!(saved, 0, "the write failed");
        assert!(
            load_snapshot(&pool, &SpaceId::from_trusted(SPACE_A))
                .await
                .expect("load")
                .is_none(),
            "the space has no row for the boot heal to see"
        );
        assert_eq!(
            apply_cursor(&pool).await,
            0,
            "the cursor must not pass ops no persisted snapshot holds"
        );
    }

    /// #5418 — the cursor moves only once the background queue has drained:
    /// boot replay re-dispatches each replayed op's index fan-out (#3298), so a
    /// cursor past an op whose fan-out is still in memory would lose it to a
    /// crash. A queue that cannot drain (here: shut down) leaves the cursor,
    /// though the rows are written.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undrained_background_queue_leaves_the_apply_cursor_5418() {
        let (pool, _dir) = fresh_pool().await;
        let materializer = crate::materializer::Materializer::new(pool.clone());
        seed_op_log_head(&pool, 7).await;
        dirty_engine(&materializer, SPACE_A);
        materializer.shutdown();

        let saved = save_engines_and_advance_cursor(&pool, &materializer)
            .await
            .saved;

        assert_eq!(saved, 1, "the rows do not wait for the queue");
        assert_eq!(
            watermark_of(&pool, SPACE_A).await,
            7,
            "the row is stamped with the head"
        );
        assert_eq!(
            apply_cursor(&pool).await,
            0,
            "the cursor must not pass ops whose index fan-out may still be in memory"
        );
    }

    /// #2201 — convergence/liveness smoke test: a writer hammers space A while
    /// save passes run on a multi-thread runtime, exercising the no-deadlock
    /// guarantee (the registry never holds two of its locks at once) and
    /// confirming the system converges — after the writer joins, one final
    /// drained pass persists A's full final state and the loaded snapshot
    /// contains every block the writer created.
    ///
    /// Scope note: this does NOT by itself prove the stamp-race defense (a
    /// flag wrongly cleared mid-persist would still be masked here, because
    /// the writer's final `for_space` re-marks A dirty and Loro exports a full
    /// snapshot each pass, so the final state persists regardless). The actual
    /// "clear must not drop an unpersisted mark" contract is pinned by the two
    /// dedicated unit tests — `concurrent_remark_during_persist_keeps_space_dirty_2201`
    /// and `clear_race_does_not_drop_unpersisted_dirty_flag_2201`. The
    /// concern-1 durability case (a snapshot never written at all) is not
    /// testable at this layer: the op_log / loro_sync_inbox WAL is the durable
    /// source of truth and boot replay backfills any stale/missing snapshot.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn save_all_engines_concurrent_mutation_not_lost_2201() {
        use std::sync::Arc;

        const WRITES: usize = 100;

        let (pool, _dir) = fresh_pool().await;
        let registry = Arc::new(LoroEngineRegistry::new());
        let space_a = SpaceId::from_trusted(SPACE_A);

        // Seed + persist so A starts clean.
        {
            let mut g = registry.for_space(&space_a, "device-1").expect("seed");
            g.engine_mut()
                .apply_create_block("SEED", "content", "seed", None, 0)
                .expect("create");
        }
        save_all_engines(&pool, &registry).await;
        assert_eq!(registry.dirty_count(), 0, "A clean after seed persist");

        // Writer task: append blocks to A concurrently with the save passes.
        let writer = {
            let registry = Arc::clone(&registry);
            let space_a = space_a.clone();
            tokio::task::spawn_blocking(move || {
                for i in 0..WRITES {
                    let id = format!("W{i:03}");
                    let position = i64::try_from(i).expect("index fits i64") + 1;
                    let mut g = registry.for_space(&space_a, "device-1").expect("for_space");
                    g.engine_mut()
                        .apply_create_block(&id, "content", &id, None, position)
                        .expect("create");
                }
            })
        };

        // Interleave save passes with the writer.
        for _ in 0..20 {
            let _ = save_all_engines(&pool, &registry).await;
            tokio::task::yield_now().await;
        }
        writer.await.expect("writer task");

        // Final drained pass persists whatever remained dirty.
        let _ = save_all_engines(&pool, &registry).await;
        assert_eq!(
            registry.dirty_count(),
            0,
            "no dirty flag may linger after the final drained pass"
        );

        // The persisted snapshot must reflect the writer's FULL final state.
        let bytes = load_snapshot(&pool, &space_a)
            .await
            .expect("load")
            .expect("present");
        let mut probe = LoroEngine::with_peer_id("device-1").expect("probe");
        probe.import(&bytes).expect("import");
        assert!(
            probe.read_block("SEED").expect("read").is_some(),
            "seed block must survive"
        );
        for i in 0..WRITES {
            assert!(
                probe
                    .read_block(&format!("W{i:03}"))
                    .expect("read")
                    .is_some(),
                "the final persisted snapshot must contain every concurrently-written block",
            );
        }
    }

    /// Smoke test for the `#[cfg(test)]` `tokio::spawn` seam in
    /// [`spawn_periodic_snapshot`]. Drives the real spawned task end to
    /// end: construct a materializer, register + mutate an engine in its
    /// registry, hand that same materializer to the periodic task with a
    /// 1-second cadence, then poll `loro_doc_state` until the engine's snapshot row
    /// appears. The task skips its first `interval.tick()` and reads the
    /// materializer it was constructed with (#2249: engine state is an
    /// explicitly threaded value, not a process global), so this exercises
    /// the spawn, the tick loop, and the snapshot pass the seam exists to
    /// cover.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn spawn_periodic_snapshot_persists_engine_state() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::Duration;

        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_PERIODIC);

        // Fresh per-test state, with an engine registered in it that the
        // task will find through the materializer passed to it below. Mutate
        // it so the exported snapshot is non-trivial.
        let materializer = crate::materializer::Materializer::new(pool.clone());
        {
            let mut g = materializer
                .loro_state()
                .registry
                .for_space(&space, "device-periodic")
                .expect("for_space");
            g.engine_mut()
                .apply_create_block("BLOCK_PERIODIC", "content", "tick", None, 0)
                .expect("create");
        }

        // Spawn the periodic task (1s cadence). The first tick is skipped,
        // so the first persist lands ~1s in.
        let shutdown = Arc::new(AtomicBool::new(false));
        spawn_periodic_snapshot(
            pool.clone(),
            shutdown.clone(),
            1,
            materializer.clone(),
            |fut| {
                tokio::spawn(fut);
            },
        );

        // Poll for the row rather than sleeping a fixed interval: bounded
        // loop, ~5s total timeout, short sleeps in between. Deterministic
        // and non-flaky — succeeds as soon as the snapshot lands.
        let mut persisted = false;
        for _ in 0..50 {
            let row = load_snapshot(&pool, &space).await.expect("load");
            if row.is_some() {
                persisted = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        // Stop the task before asserting so a failure doesn't leave it
        // running against a half-torn-down pool.
        shutdown.store(true, Ordering::Relaxed);
        materializer.shutdown();

        assert!(
            persisted,
            "periodic snapshot task should persist a loro_doc_state row \
             for the space within ~5s"
        );
    }

    // -----------------------------------------------------------------
    // #2910 — purging a registered space tears down its `loro_doc_state`
    // snapshot row AND evicts its in-memory per-space engine, so the dead
    // space's LoroDoc is never rehydrated at boot nor re-persisted.
    // -----------------------------------------------------------------

    /// A soft-deleted space to purge, and a live space that must survive
    /// unscathed. Local `LoroState` per test (no global-registry sharing),
    /// but keep them distinct for readable failures. Valid Crockford base32.
    const SPACE_PURGE_2910: &str = "01J0DEADSPACE0000000000001";
    const SPACE_KEEP_2910: &str = "01J0KEEPSPACE0000000000002";
    const CHILD_PURGE_2910: &str = "01J0DEADSPACEXYZ0000000001";

    /// Seed a REGISTERED space: its own soft-deleted page block (own
    /// `space_id` NULL, exactly as production — a space carries
    /// `is_space="true"`, never `space=<self>`), a `spaces` registry row
    /// (production writes this via the `is_space` -> 0089 trigger), and one
    /// live content child that belongs to it.
    async fn seed_registered_space(pool: &SqlitePool, space: &str, child: &str) {
        sqlx::query(
            "INSERT INTO blocks \
                 (id, block_type, content, parent_id, position, page_id, deleted_at, space_id) \
             VALUES (?, 'page', 'Dead Space', NULL, 1, ?, ?, NULL)",
        )
        .bind(space)
        .bind(space)
        .bind(now_ms())
        .execute(pool)
        .await
        .expect("seed space block");
        sqlx::query("INSERT INTO spaces (id) VALUES (?)")
            .bind(space)
            .execute(pool)
            .await
            .expect("register space");
        sqlx::query(
            "INSERT INTO blocks \
                 (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'content', 'child of dead space', ?, 1, ?, ?)",
        )
        .bind(child)
        .bind(space)
        .bind(space)
        .bind(space)
        .execute(pool)
        .await
        .expect("seed child block");
    }

    /// Register a live engine for `space` (marks it dirty) and persist a
    /// `loro_doc_state` snapshot row for it. The registry engine and the
    /// persisted row are the two things #2910 must tear down.
    async fn register_engine_and_snapshot(
        pool: &SqlitePool,
        state: &crate::loro::shared::LoroState,
        space: &SpaceId,
        block: &str,
    ) {
        // `for_space` marks the space dirty; scope the (non-Send parking_lot)
        // guard so it never crosses an `.await`.
        {
            let mut g = state
                .registry
                .for_space(space, "device-1")
                .expect("for_space");
            g.engine_mut()
                .apply_create_block(block, "content", "content", None, 0)
                .expect("create block in engine");
        }
        let mut e = LoroEngine::with_peer_id("device-1").expect("engine");
        e.apply_create_block(block, "content", "content", None, 0)
            .expect("create block for snapshot");
        save_snapshot(pool, space, &e).await.expect("save snapshot");
    }

    /// Row-gone + engine-evicted. Reverting the cascade's
    /// `DELETE FROM loro_doc_state` resurrects the row (first assert fails);
    /// reverting the `registry.evict_space` call keeps the engine (second
    /// assert fails). The KEEP space proves the teardown is scoped to the
    /// purged space, not a blanket wipe.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn purge_registered_space_deletes_snapshot_and_evicts_engine_2910() {
        use crate::apply::loro_apply::apply_purge_block_via_loro;
        use agaric_core::ulid::BlockId;
        use agaric_store::op::PurgeBlockPayload;

        let (pool, _dir) = fresh_pool().await;
        let state = crate::loro::shared::LoroState::new();
        let purge = SpaceId::from_trusted(SPACE_PURGE_2910);
        let keep = SpaceId::from_trusted(SPACE_KEEP_2910);

        seed_registered_space(&pool, SPACE_PURGE_2910, CHILD_PURGE_2910).await;
        register_engine_and_snapshot(&pool, &state, &purge, "BLK_DOOMED").await;
        register_engine_and_snapshot(&pool, &state, &keep, "BLK_ALIVE").await;

        // Pre-conditions: both spaces have a persisted row and a live engine.
        assert!(
            load_snapshot(&pool, &purge).await.unwrap().is_some(),
            "seed: purged space must have a loro_doc_state row"
        );
        assert!(
            state.registry.space_ids().contains(&purge),
            "seed: purged space must have a registered engine"
        );

        // Purge the space's page block through the materialization chokepoint,
        // inside a tx so the cascade's deferred-FK behaviour matches production.
        let payload = PurgeBlockPayload {
            block_id: BlockId::from_trusted(SPACE_PURGE_2910),
        };
        let mut tx = pool.begin().await.expect("begin");
        apply_purge_block_via_loro(&mut tx, &state, "device-1", &payload, false)
            .await
            .expect("apply_purge_block_via_loro");
        tx.commit().await.expect("commit");

        // The purged space's snapshot row is GONE (only my explicit
        // `DELETE FROM loro_doc_state` can remove it — the table has no FK).
        assert!(
            load_snapshot(&pool, &purge).await.unwrap().is_none(),
            "#2910: the purged space's loro_doc_state row must be deleted by the cascade"
        );
        // The purged space's in-memory engine is EVICTED.
        assert!(
            !state.registry.space_ids().contains(&purge),
            "#2910: the purged space's engine must be evicted from the registry"
        );
        // The unrelated live space is untouched — row and engine both survive.
        assert!(
            load_snapshot(&pool, &keep).await.unwrap().is_some(),
            "#2910: an unrelated space's snapshot row must survive the purge"
        );
        assert!(
            state.registry.space_ids().contains(&keep),
            "#2910: an unrelated space's engine must survive the purge"
        );
    }

    /// #5841 — purging a space removes its property definitions and only
    /// its: they are keyed by `space_id` with no FK, so nothing else would.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn purge_registered_space_deletes_its_property_definitions_5841() {
        use crate::apply::loro_apply::apply_purge_block_via_loro;
        use agaric_core::ulid::BlockId;
        use agaric_store::op::PurgeBlockPayload;

        let (pool, _dir) = fresh_pool().await;
        let state = crate::loro::shared::LoroState::new();
        seed_registered_space(&pool, SPACE_PURGE_2910, CHILD_PURGE_2910).await;
        for space in [SPACE_PURGE_2910, SPACE_KEEP_2910] {
            sqlx::query(
                "INSERT INTO property_definitions (space_id, key, value_type, created_at) \
                 VALUES (?, 'stage', 'text', 'T')",
            )
            .bind(space)
            .execute(&pool)
            .await
            .expect("seed a definition");
        }

        let payload = PurgeBlockPayload {
            block_id: BlockId::from_trusted(SPACE_PURGE_2910),
        };
        let mut tx = pool.begin().await.expect("begin");
        apply_purge_block_via_loro(&mut tx, &state, "device-1", &payload, false)
            .await
            .expect("apply_purge_block_via_loro");
        tx.commit().await.expect("commit");

        let left: Vec<String> =
            sqlx::query_scalar("SELECT space_id FROM property_definitions ORDER BY space_id")
                .fetch_all(&pool)
                .await
                .expect("read definitions");
        assert_eq!(
            left,
            [SPACE_KEEP_2910],
            "the purged space's definitions go, another space's stay"
        );
    }

    /// Boot-residue regression guard: after purging the space, a fresh boot
    /// rehydration (`rehydrate_registry`, which reinstalls an engine for
    /// EVERY persisted `loro_doc_state` row) must NOT resurrect the dead
    /// space. If the cascade `DELETE FROM loro_doc_state` were reverted, the
    /// stale row would survive the purge and rehydrate here — this test fails.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn purged_space_is_not_rehydrated_at_next_boot_2910() {
        use crate::apply::loro_apply::apply_purge_block_via_loro;
        use agaric_core::ulid::BlockId;
        use agaric_store::op::PurgeBlockPayload;

        let (pool, _dir) = fresh_pool().await;
        let state = crate::loro::shared::LoroState::new();
        let purge = SpaceId::from_trusted(SPACE_PURGE_2910);
        let keep = SpaceId::from_trusted(SPACE_KEEP_2910);

        seed_registered_space(&pool, SPACE_PURGE_2910, CHILD_PURGE_2910).await;
        register_engine_and_snapshot(&pool, &state, &purge, "BLK_DOOMED").await;
        register_engine_and_snapshot(&pool, &state, &keep, "BLK_ALIVE").await;

        let payload = PurgeBlockPayload {
            block_id: BlockId::from_trusted(SPACE_PURGE_2910),
        };
        let mut tx = pool.begin().await.expect("begin");
        apply_purge_block_via_loro(&mut tx, &state, "device-1", &payload, false)
            .await
            .expect("apply_purge_block_via_loro");
        tx.commit().await.expect("commit");

        // Simulate a fresh process boot: rehydrate a brand-new registry
        // strictly from whatever `loro_doc_state` now holds.
        let booted = LoroEngineRegistry::new();
        let n = rehydrate_registry(&pool, &booted, "device-1")
            .await
            .expect("rehydrate");

        assert_eq!(
            n, 1,
            "#2910: only the surviving space must rehydrate at boot (the purged \
             space's row is gone)"
        );
        assert!(
            !booted.space_ids().contains(&purge),
            "#2910: the purged (dead) space must NOT be reinstalled at boot"
        );
        assert!(
            booted.space_ids().contains(&keep),
            "the surviving space must still rehydrate at boot"
        );
    }

    /// The space of every `loro_doc_delta` row, in `id` order.
    async fn delta_spaces(pool: &SqlitePool) -> Vec<String> {
        sqlx::query_scalar!("SELECT space_id FROM loro_doc_delta ORDER BY id")
            .fetch_all(pool)
            .await
            .expect("read the deltas")
    }

    async fn save_delta(pool: &SqlitePool, space_id: &str) {
        let mut conn = pool.acquire().await.expect("conn");
        crate::loro::delta::insert_delta(&mut conn, &SpaceId::from_trusted(space_id), b"delta")
            .await
            .expect("save a delta");
    }

    /// #6521 — a snapshot row takes its space's deltas up to the id the pass
    /// read with it. A later row of that space stays: its write may have
    /// landed after the export. Another space's rows stay: its snapshot is
    /// not this one.
    #[tokio::test]
    async fn a_snapshot_row_deletes_the_deltas_it_covers_and_no_others_6521() {
        let (pool, _dir) = fresh_pool().await;
        for space in [SPACE_A, SPACE_B, SPACE_A, SPACE_A] {
            save_delta(&pool, space).await;
        }
        let engine = LoroEngine::with_peer_id("device-1").expect("engine");
        let bytes = engine.export_snapshot().expect("export");

        let mut conn = pool.acquire().await.expect("conn");
        write_snapshot_row(&mut conn, &SpaceId::from_trusted(SPACE_A), bytes, 0, 3)
            .await
            .expect("write the row");
        drop(conn);

        assert_eq!(
            delta_spaces(&pool).await,
            [SPACE_B, SPACE_A],
            "space A's rows up to id 3 go; space B's row and space A's row 4 stay"
        );
    }

    /// #6521 — a pass leaves no delta for a space it saved, so the table holds
    /// only what was written since the last pass.
    #[tokio::test]
    async fn a_pass_deletes_the_deltas_of_the_spaces_it_saves_6521() {
        let (pool, _dir) = fresh_pool().await;
        let state = crate::loro::shared::LoroState::new();
        for (space, block) in [
            (SPACE_A, "BLOCK1"),
            (SPACE_B, "BLOCK1"),
            (SPACE_A, "BLOCK2"),
        ] {
            let log = crate::loro::revert::RevertLog::new();
            crate::loro::delta::write_engines(&pool, &state.registry, &log, "test_write", || {
                state
                    .registry
                    .for_space_recording(&SpaceId::from_trusted(space), "device-1", &log)
                    .expect("engine")
                    .engine_mut()
                    .apply_create_block(block, "content", block, None, 0)
                    .expect("create");
            })
            .await
            .1
            .expect("save the write");
        }
        assert_eq!(delta_spaces(&pool).await, [SPACE_A, SPACE_B, SPACE_A]);

        assert_eq!(save_all_engines(&pool, &state.registry).await.saved, 2);

        assert_eq!(
            delta_spaces(&pool).await,
            Vec::<String>::new(),
            "each saved space's deltas went with its snapshot row"
        );
        assert_eq!(
            crate::loro::delta::saved_engine_divergences(&pool, &state.registry)
                .await
                .unwrap(),
            Vec::<String>::new(),
            "the snapshot rows alone rebuild the engines"
        );
    }

    /// #6521 — the purge of a space deletes the deltas saved for it, and the
    /// transaction that purges it saves none for the engine it evicts, or the
    /// dead space would have saved state again.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn purging_a_space_leaves_no_delta_for_it_6521() {
        use crate::apply::loro_apply::apply_purge_block_via_loro;
        use agaric_core::ulid::BlockId;
        use agaric_store::op::PurgeBlockPayload;

        let (pool, _dir) = fresh_pool().await;
        let state = crate::loro::shared::LoroState::new();
        let purge = SpaceId::from_trusted(SPACE_PURGE_2910);
        let keep = SpaceId::from_trusted(SPACE_KEEP_2910);
        seed_registered_space(&pool, SPACE_PURGE_2910, CHILD_PURGE_2910).await;
        register_engine_and_snapshot(&pool, &state, &purge, "BLK_DOOMED").await;
        register_engine_and_snapshot(&pool, &state, &keep, "BLK_ALIVE").await;
        save_delta(&pool, SPACE_PURGE_2910).await;
        save_delta(&pool, SPACE_KEEP_2910).await;

        let payload = PurgeBlockPayload {
            block_id: BlockId::from_trusted(SPACE_PURGE_2910),
        };
        let mut tx = pool.begin().await.expect("begin");
        let scope = crate::loro::revert::RevertScope::arm(&state);
        // The transaction writes the space's engine before it purges the space.
        state
            .registry
            .for_space_recording(&purge, "device-1", &state.revert)
            .expect("engine")
            .engine_mut()
            .apply_create_block("BLK_LATE", "content", "late", None, 1)
            .expect("create");
        apply_purge_block_via_loro(&mut tx, &state, "device-1", &payload, false)
            .await
            .expect("apply_purge_block_via_loro");
        crate::loro::delta::commit_with_deltas(tx, &state.registry, scope.detach())
            .await
            .expect("commit");

        assert_eq!(
            delta_spaces(&pool).await,
            [SPACE_KEEP_2910],
            "the purged space has no delta; the other space keeps its own"
        );
    }

    /// #6521 — without the marker, boot builds its engines from the snapshots
    /// alone, so the deltas an earlier process saved go before any of them is
    /// written.
    #[tokio::test]
    async fn rehydrating_drops_the_deltas_an_earlier_process_saved_6521() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);
        let mut engine = LoroEngine::with_peer_id("device-1").expect("engine");
        engine
            .apply_create_block("BLOCK1", "content", "saved", None, 0)
            .expect("create");
        save_snapshot(&pool, &space, &engine).await.expect("save");
        save_delta(&pool, SPACE_A).await;

        let booted = LoroEngineRegistry::new();
        rehydrate_registry(&pool, &booted, "device-1")
            .await
            .expect("rehydrate");

        assert_eq!(
            delta_spaces(&pool).await,
            Vec::<String>::new(),
            "the earlier process's delta is gone"
        );
        assert_eq!(
            crate::loro::delta::saved_engine_divergences(&pool, &booted)
                .await
                .unwrap(),
            Vec::<String>::new(),
            "the booted engine equals its snapshot row"
        );
    }

    /// #6521 — a rehydrate that migrates a pre-#400 snapshot's sibling order
    /// writes the engine, and saves what it wrote.
    #[tokio::test]
    async fn a_rehydrate_that_migrates_sibling_order_saves_the_migration_6521() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);
        let mut legacy = LoroEngine::with_peer_id("device-1").expect("engine");
        legacy
            .apply_create_block_at("P", "page", "P", None, 0)
            .expect("page");
        for (slot, id) in ["A", "B"].into_iter().enumerate() {
            legacy
                .apply_create_block_at(id, "content", "", Some("P"), slot)
                .expect("child");
        }
        legacy.force_legacy_scheme_for_test(&[("A", 2), ("B", 1)]);
        save_snapshot(&pool, &space, &legacy).await.expect("save");

        let booted = LoroEngineRegistry::new();
        rehydrate_registry(&pool, &booted, "device-1")
            .await
            .expect("rehydrate");

        let children = booted
            .with_engine(&space, "device-1", |engine| engine.list_children_walk("P"))
            .expect("engine")
            .expect("children");
        assert_eq!(children, ["B", "A"], "the rehydrate migrated the order");
        assert_eq!(
            delta_spaces(&pool).await,
            [SPACE_A],
            "the migration's ops are saved as one delta"
        );
        assert_eq!(
            crate::loro::delta::saved_engine_divergences(&pool, &booted)
                .await
                .unwrap(),
            Vec::<String>::new(),
            "the snapshot and that delta rebuild the migrated engine"
        );
    }

    /// Create `block` in `space` through a write that saves its delta.
    async fn create_saving_its_delta(
        pool: &SqlitePool,
        state: &crate::loro::shared::LoroState,
        space: &str,
        block: &str,
    ) {
        let log = crate::loro::revert::RevertLog::new();
        crate::loro::delta::write_engines(pool, &state.registry, &log, "test_write", || {
            state
                .registry
                .for_space_recording(&SpaceId::from_trusted(space), "device-1", &log)
                .expect("engine")
                .engine_mut()
                .apply_create_block(block, "content", block, None, 0)
                .expect("create");
        })
        .await
        .1
        .expect("save the write");
    }

    /// A vault whose saved rows hold every engine write, as one that has
    /// finished a boot is.
    async fn vault_that_boots_from_saved_rows() -> (SqlitePool, TempDir) {
        let (pool, dir) = fresh_pool().await;
        crate::loro::delta::set_boots_from_saved_rows(&pool, true)
            .await
            .expect("set the marker");
        (pool, dir)
    }

    fn holds(registry: &LoroEngineRegistry, space: &str, block: &str) -> bool {
        registry
            .with_engine(&SpaceId::from_trusted(space), "device-1", |engine| {
                engine.contains_block(block)
            })
            .expect("engine")
    }

    /// #6521 — with the marker set, boot builds each engine from its snapshot
    /// and the deltas saved since, a space with no snapshot from its deltas
    /// alone. It deletes none of them, and leaves each such space dirty.
    #[tokio::test]
    async fn a_boot_from_saved_rows_builds_what_the_dead_process_held_6521() {
        let (pool, _dir) = vault_that_boots_from_saved_rows().await;
        let state = crate::loro::shared::LoroState::new();
        create_saving_its_delta(&pool, &state, SPACE_A, "IN_SNAPSHOT").await;
        assert_eq!(save_all_engines(&pool, &state.registry).await.saved, 1);
        create_saving_its_delta(&pool, &state, SPACE_A, "IN_DELTA").await;
        create_saving_its_delta(&pool, &state, SPACE_B, "NO_SNAPSHOT_YET").await;

        let booted = LoroEngineRegistry::new();
        let rehydrated = rehydrate_registry(&pool, &booted, "device-1")
            .await
            .expect("rehydrate");

        assert_eq!(rehydrated, 2, "one engine per space with saved rows");
        for space in [SPACE_A, SPACE_B] {
            let space = SpaceId::from_trusted(space);
            assert_eq!(
                booted.loro_vv(&space),
                state.registry.loro_vv(&space),
                "the booted engine is at the version the dead process's was"
            );
        }
        assert_eq!(
            booted.dirty_count(),
            2,
            "a space built from deltas holds more than its row, so it is dirty"
        );
        assert_eq!(
            delta_spaces(&pool).await,
            [SPACE_A, SPACE_B],
            "the rows are kept: until a pass covers them they are the saved engine"
        );
        assert!(holds(&booted, SPACE_A, "IN_SNAPSHOT"), "from the snapshot");
        assert!(holds(&booted, SPACE_A, "IN_DELTA"), "from the delta");
        assert!(
            holds(&booted, SPACE_B, "NO_SNAPSHOT_YET"),
            "from a delta with no snapshot under it"
        );
    }

    /// #6521 — a pass moves the stamp of every row it does not write. An
    /// engine built from its row and deltas is written by the next pass, so
    /// no stamp moves over ops only a delta holds.
    #[tokio::test]
    async fn a_space_booted_from_its_deltas_is_saved_by_the_next_pass_6521() {
        let (pool, _dir) = vault_that_boots_from_saved_rows().await;
        let state = crate::loro::shared::LoroState::new();
        create_saving_its_delta(&pool, &state, SPACE_A, "IN_SNAPSHOT").await;
        assert_eq!(save_all_engines(&pool, &state.registry).await.saved, 1);
        create_saving_its_delta(&pool, &state, SPACE_A, "IN_DELTA").await;
        let booted = LoroEngineRegistry::new();
        rehydrate_registry(&pool, &booted, "device-1")
            .await
            .expect("rehydrate");

        assert_eq!(
            save_all_engines(&pool, &booted).await.saved,
            1,
            "the pass after boot writes the space"
        );

        assert!(
            saved_row_holds(&pool, &SpaceId::from_trusted(SPACE_A), "IN_DELTA").await,
            "its row now holds what only the delta held"
        );
        assert_eq!(delta_spaces(&pool).await, Vec::<String>::new());
    }

    /// #6521 — a row that will not import stops boot, as a snapshot that will
    /// not import does: nothing is installed and nothing is deleted.
    #[tokio::test]
    async fn a_delta_that_will_not_import_stops_boot_6521() {
        let (pool, _dir) = vault_that_boots_from_saved_rows().await;
        let state = crate::loro::shared::LoroState::new();
        create_saving_its_delta(&pool, &state, SPACE_A, "READABLE").await;
        save_delta(&pool, SPACE_A).await;

        let booted = LoroEngineRegistry::new();
        let refused = rehydrate_registry(&pool, &booted, "device-1").await;

        assert!(
            matches!(refused, Err(AppError::Snapshot(_))),
            "an unreadable row is the unreadable-snapshot error: {refused:?}"
        );
        assert!(booted.is_empty(), "no engine is installed");
        assert_eq!(
            delta_spaces(&pool).await,
            [SPACE_A, SPACE_A],
            "both rows are still there"
        );
        assert!(
            crate::loro::delta::boots_from_saved_rows(&pool)
                .await
                .expect("read the marker"),
            "and the next boot reads them again"
        );
    }

    /// #6521 — rows that depend on an engine write no row holds cannot build
    /// the engine: it would lack that write and every later one of its peer.
    /// Boot discards every row and the marker, and builds from the snapshots
    /// for the op-log replay.
    #[tokio::test]
    async fn rows_that_depend_on_a_write_no_row_holds_are_discarded_6521() {
        let (pool, _dir) = vault_that_boots_from_saved_rows().await;
        let state = crate::loro::shared::LoroState::new();
        create_saving_its_delta(&pool, &state, SPACE_A, "IN_SNAPSHOT").await;
        assert_eq!(save_all_engines(&pool, &state.registry).await.saved, 1);
        let at_snapshot = state.registry.loro_vv(&SpaceId::from_trusted(SPACE_A));
        for block in ["FIRST", "LOST", "THIRD"] {
            create_saving_its_delta(&pool, &state, SPACE_A, block).await;
        }
        let lost = sqlx::query!(
            "DELETE FROM loro_doc_delta WHERE id = (SELECT id FROM loro_doc_delta ORDER BY id LIMIT 1 OFFSET 1)"
        )
        .execute(&pool)
        .await
        .expect("lose the middle row");
        assert_eq!(lost.rows_affected(), 1);

        let booted = LoroEngineRegistry::new();
        rehydrate_registry(&pool, &booted, "device-1")
            .await
            .expect("rehydrate");

        assert_eq!(
            booted.loro_vv(&SpaceId::from_trusted(SPACE_A)),
            at_snapshot,
            "the engine is its snapshot alone, for the replay to build on"
        );
        assert_eq!(
            delta_spaces(&pool).await,
            Vec::<String>::new(),
            "the rows are gone: a replayed op reuses the op ids they hold"
        );
        assert!(
            !crate::loro::delta::boots_from_saved_rows(&pool)
                .await
                .expect("read the marker"),
            "and boot recovery replays the op log"
        );
    }

    /// #6521 — a row can depend on a later one: a sync import writes the
    /// engine before its projection saves its delta, and a local write made
    /// on top of it commits in between. That is not a gap.
    #[tokio::test]
    async fn a_row_that_depends_on_a_later_row_builds_the_engine_6521() {
        let (pool, _dir) = vault_that_boots_from_saved_rows().await;
        let space = SpaceId::from_trusted(SPACE_A);
        let state = crate::loro::shared::LoroState::new();
        let mut peer = LoroEngine::with_peer_id("device-2").expect("engine");
        peer.apply_create_block("FROM_PEER", "content", "peer", None, 0)
            .expect("create");
        let update = peer.export_snapshot().expect("export");
        let (imported, import_delta) = state
            .registry
            .with_engine(&space, "device-1", |engine| {
                engine.capturing_delta(|engine| engine.import(&update))
            })
            .expect("engine")
            .expect("export the import's delta");
        imported.expect("import");
        create_saving_its_delta(&pool, &state, SPACE_A, "LOCAL_ON_TOP").await;
        let mut conn = pool.acquire().await.expect("conn");
        crate::loro::delta::insert_delta(&mut conn, &space, &import_delta.expect("a delta"))
            .await
            .expect("save the import's delta after the local write's");
        drop(conn);

        let booted = LoroEngineRegistry::new();
        rehydrate_registry(&pool, &booted, "device-1")
            .await
            .expect("rehydrate");

        assert_eq!(
            booted.loro_vv(&space),
            state.registry.loro_vv(&space),
            "both rows are in the engine, whichever was imported first"
        );
        assert_eq!(delta_spaces(&pool).await, [SPACE_A, SPACE_A]);
    }

    /// #6521 — rows that leave changes pending send boot to the snapshots,
    /// which are imported before any row is deleted: one that will not import
    /// stops boot with every row still there.
    #[tokio::test]
    async fn an_unreadable_snapshot_stops_boot_before_any_row_is_discarded_6521() {
        let (pool, _dir) = vault_that_boots_from_saved_rows().await;
        let state = crate::loro::shared::LoroState::new();
        // SPACE_A's snapshot row is written first, so it is imported first.
        create_saving_its_delta(&pool, &state, SPACE_A, "IN_SNAPSHOT").await;
        assert_eq!(save_all_engines(&pool, &state.registry).await.saved, 1);
        for block in ["FIRST", "LOST", "THIRD"] {
            create_saving_its_delta(&pool, &state, SPACE_A, block).await;
        }
        let lost = sqlx::query(
            "DELETE FROM loro_doc_delta \
             WHERE id = (SELECT id FROM loro_doc_delta ORDER BY id LIMIT 1 OFFSET 1)",
        )
        .execute(&pool)
        .await
        .expect("lose the middle row");
        assert_eq!(lost.rows_affected(), 1);
        // A snapshot no build can read, in a space imported after SPACE_A.
        seed_row(&pool, SPACE_B, 0).await;

        let refused = rehydrate_registry(&pool, &LoroEngineRegistry::new(), "device-1").await;

        assert!(
            matches!(refused, Err(AppError::Snapshot(_))),
            "the unreadable snapshot stops boot: {refused:?}"
        );
        assert_eq!(
            delta_spaces(&pool).await,
            [SPACE_A, SPACE_A],
            "no row was deleted on the way"
        );
        assert!(
            crate::loro::delta::boots_from_saved_rows(&pool)
                .await
                .expect("read the marker"),
            "nor the marker"
        );
    }

    /// #6521 — a sync import writes the engine outside the write lock. When a
    /// transaction that touched the engine first rolls back, the rewind drops
    /// the import's ops too, while the import's row is saved all the same. The
    /// next commit clears the marker, so boot does not build from rows the
    /// engine never held together. A rollback with no import under it does not.
    #[tokio::test]
    async fn a_commit_after_a_rewind_past_an_import_clears_the_marker_6521() {
        let (pool, _dir) = vault_that_boots_from_saved_rows().await;
        let space = SpaceId::from_trusted(SPACE_A);
        let state = crate::loro::shared::LoroState::new();
        let marker = async || {
            crate::loro::delta::boots_from_saved_rows(&pool)
                .await
                .expect("read the marker")
        };
        let write_and_roll_back = |import: Option<&[u8]>| {
            let scope = crate::loro::revert::RevertScope::arm(&state);
            state
                .registry
                .for_space_recording(&space, "device-1", &state.revert)
                .expect("engine")
                .engine_mut()
                .apply_create_block("ROLLED_BACK", "content", "never committed", None, 0)
                .expect("create");
            if let Some(update) = import {
                state
                    .registry
                    .with_engine(&space, "device-1", |engine| engine.import(update))
                    .expect("engine")
                    .expect("import");
            }
            scope.detach().revert();
        };

        write_and_roll_back(None);
        create_saving_its_delta(&pool, &state, SPACE_A, "AFTER_A_ROLLBACK").await;
        assert!(
            marker().await,
            "a rollback that dropped only its own writes leaves the rows usable"
        );

        let mut peer = LoroEngine::with_peer_id("device-2").expect("engine");
        peer.apply_create_block("FROM_PEER", "content", "peer", None, 0)
            .expect("create");
        write_and_roll_back(Some(&peer.export_snapshot().expect("export")));
        create_saving_its_delta(&pool, &state, SPACE_A, "AFTER_THE_LOST_IMPORT").await;
        assert!(
            !marker().await,
            "the import's row outlived its ops in the engine: the next boot must replay"
        );
    }

    /// Whether `space`'s saved row holds `block`.
    async fn saved_row_holds(pool: &SqlitePool, space: &SpaceId, block: &str) -> bool {
        let bytes = load_snapshot(pool, space)
            .await
            .expect("load")
            .expect("row");
        let mut saved = LoroEngine::with_peer_id("device-1").expect("engine");
        saved.import(&bytes).expect("import");
        saved.read_block(block).expect("read").is_some()
    }

    /// #6521 — a pass can export an engine while a transaction's write sits in
    /// it uncommitted. If that transaction then rolls back, the pass writes
    /// nothing: its row would hold a block that SQL, the op log and the engine
    /// do not, under op ids the next committed write reuses. The rewind marks
    /// the space dirty, so the next pass writes the engine as it now is.
    #[tokio::test]
    async fn a_pass_writes_nothing_when_a_write_it_exported_rolled_back_6521() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);
        let state = crate::loro::shared::LoroState::new();

        let scope = crate::loro::revert::RevertScope::arm(&state);
        state
            .registry
            .for_space_recording(&space, "device-1", &state.revert)
            .expect("engine")
            .engine_mut()
            .apply_create_block("ROLLED_BACK", "content", "never committed", None, 0)
            .expect("create");
        // A pass's own steps, with the rollback between its export and its
        // write: nothing outside a pass can park it there.
        let collected = Collected::read(&state.registry);
        let pairs = state.registry.snapshot_dirty_engines();
        let mut exported = LoroEngine::with_peer_id("device-1").expect("engine");
        exported
            .import(pairs[0].2.as_ref().expect("export"))
            .expect("import");
        assert!(
            exported.read_block("ROLLED_BACK").expect("read").is_some(),
            "the fixture: the pass exported the uncommitted write"
        );
        scope.detach().revert();

        let pass = write_pass(&pool, &state.registry, collected, pairs, covering(0)).await;

        assert!(
            matches!(pass, Err(AppError::Snapshot(_))),
            "a pass that exported a rolled-back write must write nothing: {pass:?}"
        );
        assert!(
            load_snapshot(&pool, &space).await.expect("load").is_none(),
            "and no row was committed"
        );

        assert_eq!(
            save_all_engines(&pool, &state.registry).await.saved,
            1,
            "the next pass saves the space the rewind left dirty"
        );
        assert!(
            !saved_row_holds(&pool, &space, "ROLLED_BACK").await,
            "as the rewound engine holds it"
        );
        assert_eq!(state.registry.dirty_count(), 0, "and the space is clean");
    }

    /// #6521 — a transaction whose commit failed has released the write lock
    /// and not yet rewound its engine. A pass that takes the lock in that gap
    /// cannot tell the write from a committed one, so it writes nothing until
    /// the transaction has settled.
    #[tokio::test]
    async fn a_pass_writes_nothing_while_a_write_is_neither_committed_nor_rewound_6521() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);
        let state = crate::loro::shared::LoroState::new();

        let scope = crate::loro::revert::RevertScope::arm(&state);
        state
            .registry
            .for_space_recording(&space, "device-1", &state.revert)
            .expect("engine")
            .engine_mut()
            .apply_create_block("UNSETTLED", "content", "in doubt", None, 0)
            .expect("create");
        let pending = scope.detach();

        assert_eq!(
            save_all_engines(&pool, &state.registry).await.saved,
            0,
            "a pass must not commit a row while an exported write may still be rewound"
        );
        assert!(
            load_snapshot(&pool, &space).await.expect("load").is_none(),
            "no row was committed"
        );

        // The commit path: the checkpoints are dropped, the write stays.
        drop(pending);
        assert_eq!(
            save_all_engines(&pool, &state.registry).await.saved,
            1,
            "once the transaction has settled without a rewind, the pass saves the space"
        );
        assert!(
            saved_row_holds(&pool, &space, "UNSETTLED").await,
            "with the committed write in its row"
        );
    }

    /// #6521 — a pass started while another is in flight waits for it.
    /// Some callers run [`save_all_engines`] themselves; a pass that had
    /// already exported a space could otherwise write its row after theirs,
    /// leaving a row older than its engine in a space that reads clean.
    ///
    /// The pass in flight is played by this test, holding the lock around a
    /// pass's own steps: nothing outside a pass can park it between its export
    /// and its write. The bounded wait is the time the second pass gets to run
    /// to its end when nothing makes it wait.
    #[tokio::test]
    async fn a_pass_started_during_another_waits_for_it_6521() {
        let (pool, _dir) = fresh_pool().await;
        let space = SpaceId::from_trusted(SPACE_A);
        let registry = LoroEngineRegistry::new();
        let create = |block: &str| {
            registry
                .for_space(&space, "device-1")
                .expect("engine")
                .engine_mut()
                .apply_create_block(block, "content", block, None, 0)
                .expect("create");
        };
        create("OLDER");

        let in_flight = ONE_PASS_AT_A_TIME.lock().await;
        let exported = registry.snapshot_dirty_engines();
        create("NEWER");
        let second = save_all_engines(&pool, &registry);
        tokio::pin!(second);
        let ran_at_once = tokio::time::timeout(std::time::Duration::from_millis(250), &mut second)
            .await
            .is_ok();
        for (space_id, mark_stamp, bytes) in exported {
            let mut conn = pool.acquire().await.expect("conn");
            write_snapshot_row(&mut conn, &space_id, bytes.expect("export"), 0, 0)
                .await
                .expect("write");
            registry.clear_dirty_if_unchanged(&space_id, mark_stamp);
        }
        drop(in_flight);
        if !ran_at_once {
            second.await;
        }

        assert!(
            saved_row_holds(&pool, &space, "NEWER").await,
            "the saved row must hold what the later pass exported"
        );
        assert_eq!(
            registry.dirty_count(),
            0,
            "and the space is clean with its newest state saved"
        );
    }
}
