//! Attachment apply handlers and the orphaned-attachment cleanup
//! reconciliation (C-3c).

use super::*;

// #2621 (THE INVERSION): the three per-op `apply_*_attachment_tx` writers
// (pure `attachments`-table SQL) moved DOWN into
// `agaric_engine::apply::attachments`; `apply_op_tx` (also moved) calls them
// there. The orphaned-attachment GC below is a background reconciliation task
// (called from `task_handlers` / maintenance / the app) and stays app-side.

/// Maximum number of attachment files inspected per batch before
/// yielding the runtime. Bounding the chunk size prevents a vault with
/// thousands of attachments from blocking the materializer for seconds
/// at a time (C-3c).
pub(super) const CLEANUP_BATCH_SIZE: usize = 1000;

/// Inter-batch yield duration in milliseconds. Combined with
/// `CLEANUP_BATCH_SIZE`, this caps the materializer's GC stall to the
/// time it takes to stat 1000 files plus a 10ms sleep, even on
/// pathologically large vaults.
pub(super) const CLEANUP_BATCH_SLEEP_MS: u64 = 10;

/// #3519 — filename prefix for a GC *quarantine* file.
///
/// An orphan's bytes are `rename`d aside under this name while the GC asks,
/// one last time, whether anything has come to reference the original path.
/// The quarantine sibling deliberately lives in the SAME directory as the file
/// it shelters, which buys two properties for free:
///
/// * the rename is same-filesystem, hence atomic — the bytes are never in a
///   state where neither name resolves to them;
/// * a quarantine file stranded by a crash (or by a failed restore) sits
///   inside `attachments/`, so the NEXT pass walks it, finds no
///   `attachments` row referencing it — true by construction, since no writer
///   can mint this name — and reclaims it. The scheme therefore needs no
///   separate boot-time sweep of its own.
const GC_QUARANTINE_PREFIX: &str = ".agaric-gc-";

/// #3325 — the filename shape both attachment-bytes writers leave on disk
/// while a write is still in flight: `<final name>.tmp-<32 lower-case hex>`.
///
/// `agaric_sync::sync_files::write_attachment_streaming` (the sync receive
/// path) and `write_attachment_file` (the local `add_attachment` path) both
/// build their temp as a SIBLING of the final path — which they must, so the
/// publishing `rename` is same-filesystem and therefore atomic. Since every
/// attachment's `fs_path` is `attachments/<storage_id>`, that sibling lands
/// *inside* this GC's walk root, and it is unreferenced by construction: no
/// `attachments` row will ever name a temp, so neither the bulk snapshot nor
/// the write-pool re-check can vouch for one. Walking them as ordinary
/// candidates therefore misclassifies every in-flight write as an orphan.
const TRANSFER_TEMP_MARKER: &str = ".tmp-";

/// Length of the hex suffix in [`TRANSFER_TEMP_MARKER`]'s shape — a
/// `u128::from(Ulid)` rendered `{:032x}`.
const TRANSFER_TEMP_HEX_LEN: usize = 32;

/// How stale a transfer temp must be before the GC will reclaim it.
///
/// Skipping temps outright would trade one leak for another: `Drop` on
/// `TempAttachmentWriter` unlinks the temp on every ordinary exit path, but
/// never on `SIGKILL` / OOM-kill / power loss, and nothing else on the system
/// reclaims one. (Contrast `sweep_orphaned_snapshot_temps`, which can delete
/// its own temps unconditionally *because* it runs once at boot before the
/// daemon accepts connections — a luxury this GC does not have: it is enqueued
/// at boot, every 24 h, and after compaction, all of them concurrent with live
/// sync.) So we age-gate instead.
///
/// The bound comes from the protocol, not from taste. Every receive on the
/// file-transfer path is wrapped in `transport::RECV_TIMEOUT`, so an in-flight
/// temp cannot go longer than that without a frame arriving (which retouches
/// its mtime) or the transfer erroring out and `Drop` unlinking it. A live
/// temp's mtime is therefore always younger than `RECV_TIMEOUT`. Twenty times
/// that is the margin for a slow or coarse-granularity filesystem clock, and
/// costs only that a crash-stranded temp is reclaimed by a later pass rather
/// than the very next one.
const TRANSFER_TEMP_REAP_AFTER: std::time::Duration =
    std::time::Duration::from_secs(agaric_sync::transport::RECV_TIMEOUT.as_secs() * 20);

/// Does this file name have the in-flight-transfer temp shape?
///
/// Deliberately exact rather than a loose `contains(".tmp")`: the GC's own
/// [`GC_QUARANTINE_PREFIX`] files also end in `.tmp`, and #3519 depends on a
/// stranded quarantine file being walked and reclaimed as an orphan by the
/// next pass. Requiring the marker to be followed by exactly
/// [`TRANSFER_TEMP_HEX_LEN`] lower-case hex digits — the `{:032x}` the writers
/// emit — keeps the two schemes disjoint, and keeps a user-named file like
/// `notes.tmp-draft` out of the exemption.
fn is_transfer_temp(file_name: &str) -> bool {
    let Some((stem, suffix)) = file_name.rsplit_once(TRANSFER_TEMP_MARKER) else {
        return false;
    };
    !stem.is_empty()
        && suffix.len() == TRANSFER_TEMP_HEX_LEN
        && suffix
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Has this transfer temp been sitting untouched long enough that no live
/// writer can still own it?
///
/// Answers conservatively — an unreadable mtime, or one the clock places in
/// the future, yields `false` (keep the file). Being wrong in this direction
/// costs one abandoned temp's disk until a later pass; being wrong in the
/// other destroys a transfer in flight.
async fn transfer_temp_is_abandoned(path: &Path) -> bool {
    let Ok(meta) = tokio::fs::metadata(path).await else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return false;
    };
    modified
        .elapsed()
        .is_ok_and(|age| age >= TRANSFER_TEMP_REAP_AFTER)
}

/// Build the quarantine sibling for `full_path`. The ULID makes the name
/// unique per candidate, so two files quarantined in the same directory (even
/// across concurrent passes) cannot collide and clobber each other's bytes.
fn gc_quarantine_path(full_path: &Path) -> PathBuf {
    let parent = full_path.parent().unwrap_or_else(|| Path::new(""));
    parent.join(format!(
        "{GC_QUARANTINE_PREFIX}{}.tmp",
        ulid::Ulid::generate().to_string().to_uppercase()
    ))
}

/// #3519 test-only rendezvous, fired at the exact instant that used to be
/// unrecoverable: the authoritative write-pool re-check has just classified a
/// file as an orphan, and not a single byte has moved yet.
///
/// A test installs a sender here, commits a racing `attachments` row when the
/// GC reaches the point, releases the GC, and then asserts on the outcome.
/// That is the only way to observe this window deterministically — it is
/// microseconds wide in production, so a timing-based test would assert
/// nothing on most runs.
#[cfg(test)]
pub(crate) type GcRaceRendezvous =
    tokio::sync::mpsc::UnboundedSender<(String, tokio::sync::oneshot::Sender<()>)>;

/// Installed sender for [`GcRaceRendezvous`]. `None` in every test that does
/// not opt in, so the hook costs one uncontended mutex acquisition per
/// *orphan candidate* (not per walked file) in the test build and nothing at
/// all in a release build.
#[cfg(test)]
pub(crate) static GC_RACE_RENDEZVOUS: std::sync::Mutex<Option<GcRaceRendezvous>> =
    std::sync::Mutex::new(None);

/// Pause the GC at the rendezvous, if a test has installed one, until the test
/// acknowledges. A closed channel or an unheard message is not an error: the
/// GC simply proceeds.
#[cfg(test)]
async fn gc_race_rendezvous(relative_str: &str) {
    let sender = {
        let guard = GC_RACE_RENDEZVOUS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.clone()
    };
    let Some(sender) = sender else {
        return;
    };
    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
    if sender.send((relative_str.to_string(), ack_tx)).is_ok() {
        let _ = ack_rx.await;
    }
}

/// C-3c — reconcile the `attachments/` directory under
/// `app_data_dir` against the rows of the `attachments` table.
///
/// For every file under `<app_data_dir>/attachments/` (recursively),
/// we check whether the file's relative path is referenced by any row
/// in the `attachments` table. Files with no referencing row are
/// orphans (left behind by the historical leak before C-3a/b shipped,
/// or by any future code path that drops `fs_path` from a payload)
/// and are unlinked.
///
/// Concurrency / TOCTOU (#2032): this GC runs as a background JoinSet
/// task (`run_background`) concurrently with the foreground apply path
/// (`run_foreground`), which commits `AddAttachment` rows. A row+file
/// committed AFTER the bulk reference load but BEFORE its file is
/// considered for unlink would otherwise look like an orphan and be
/// removed out from under a just-added attachment. Two mitigations close
/// the window:
///   1. The referenced-path set is loaded BEFORE the on-disk file list
///      is collected, so the reference set is at least as fresh as the
///      file list (never staler).
///   2. Immediately before each unlink we RE-CHECK membership with a
///      fresh `SELECT 1 FROM attachments WHERE fs_path = ?` on the WRITE
///      pool (the same pool the foreground apply commits through, so it
///      cannot lag the writer the way a read-replica snapshot can). The
///      file is unlinked only if it is STILL unreferenced per that
///      write-pool read.
///   3. #3519: that re-check and the removal of the bytes are nonetheless
///      two operations with nothing serialising a writer against the gap
///      between them, so the removal is not allowed to be destructive —
///      see the quarantine section below.
///
/// Robustness guarantees:
/// - Missing or empty `attachments/` directory is a no-op (early
///   return), so a "vault never seeded" install never accidentally
///   touches anything.
/// - Per-file unlink errors (other than `NotFound`, which is logged at
///   info as already-clean) are logged at warn and the pass continues
///   — the GC must complete even if individual files cannot be
///   removed.
/// - Subdirectories under `attachments/` are walked recursively. Ingest
///   currently writes backend-generated paths directly under that directory,
///   while synced vaults may still contain valid nested layouts.
///
/// Returns `Ok(())` always — failures are logged, never propagated,
/// because a partial GC pass is strictly better than no GC pass.
///
/// # Pool usage (#385, #2032)
///
/// The set of referenced `fs_path`s is loaded **once** via a single
/// `SELECT fs_path FROM attachments` on `read_pool` (the dedicated
/// reader, when configured) into an in-memory `HashSet`, used as a cheap
/// in-memory pre-filter so we do not issue a query for every walked
/// file. This bulk load replaces the historical per-file
/// `SELECT 1 FROM attachments WHERE fs_path = ?` against the write pool
/// as the *fast path*, which (a) contended with the foreground apply
/// path for the single SQLite writer and (b) could not use the *partial*
/// `fs_path` index (`WHERE deleted_at IS NULL`, migrations 0061/0081)
/// because the predicate-less lookup forced a per-file scan.
///
/// A file that is in the set is kept immediately. A file that is NOT in
/// the (possibly slightly stale) set is RE-CHECKED with a single
/// `SELECT 1 FROM attachments WHERE fs_path = ?` on the **write** pool
/// before unlinking — this is the authoritative decision and closes the
/// #2032 race where a concurrently-added attachment is missing from the
/// bulk snapshot. The blob-prune `DELETE`s run on the same write pool
/// against the same `attachments` table, so the orphan decision and the
/// blob prune share one consistent view.
///
/// # Prune-before-unlink ordering (#3371)
///
/// An `attachment_blobs` row maps a `content_hash` to an `on_disk_path`,
/// and `add_attachment` dedups fresh bytes onto that path. Every blob-row
/// prune therefore happens **before** the corresponding file is unlinked,
/// never after: a row that outlives its bytes is a permanently broken
/// reference, whereas a row pruned while its file still exists merely
/// costs one redundant re-copy on the next ingest of those bytes. The
/// prune happens in two places, both ahead of any `remove_file`: a bulk
/// sweep before the walk (covering rows whose path is not on disk at all)
/// and a guarded per-file `DELETE ... WHERE on_disk_path = ? AND ... NOT
/// IN (SELECT fs_path FROM attachments)` immediately before each
/// candidate's write-pool re-check. If the per-file prune fails, the
/// unlink is skipped — bytes are never removed while a mapping to them
/// may still resolve.
///
/// # Quarantine-before-destroy (#3519)
///
/// The write-pool re-check above answers "is this path referenced?" at an
/// instant, and the unlink acts on that answer at a later instant. Between
/// them a writer carrying an *explicit* `fs_path` — a replicated peer
/// `AddAttachment`, or the undo of a local `DeleteAttachment`, both of which
/// re-insert a row straight from an op payload — can commit a reference to the
/// path we are about to empty. (The ordinary local `add_attachment` can no
/// longer get in: #3371 destroys the `attachment_blobs` mapping *before* the
/// re-check, so no dedup can mint a fresh reference to the path afterwards.)
///
/// It is worth being precise about what can and cannot be fixed here, because
/// the obvious remedies do not work. Neither a global write mutex nor an
/// `IMMEDIATE` transaction spanning the check and the unlink closes anything:
/// those writers do not *derive* their reference from any database state this
/// pass mutates, they carry it in the payload. Mutual exclusion only decides
/// whether such a writer commits just before the gap or just after it, and
/// "just after" produces exactly the same row-pointing-at-deleted-bytes
/// outcome. A lock would buy a stall of the single SQLite writer across
/// filesystem I/O and close nothing.
///
/// What is genuinely fixable is the GC's *self-consistency*: it must never
/// destroy bytes that were referenced at any point during its own decision
/// procedure. So the unlink is made non-destructive and the decision is
/// re-confirmed after the fact:
///
///   1. `rename` the candidate to a [`GC_QUARANTINE_PREFIX`] sibling. Atomic,
///      same directory, bytes preserved under a name no writer can name.
///   2. Re-run the write-pool reference query. Any writer that committed at
///      any point up to here is now visible.
///   3. If a reference appeared, `rename` the bytes back and keep them.
///      Otherwise unlink the quarantined copy.
///
/// A writer that commits *after* step 2 still ends up with a row whose bytes
/// are absent — but that is not this window. It is indistinguishable from a
/// writer that commits after the pass has ended entirely, and it is an
/// already-first-class state: `find_missing_attachments` detects a row whose
/// file is absent (or whose length disagrees) and re-requests the bytes from a
/// peer on the next sync. This function's contract is the one it can actually
/// keep — it never contradicts its own answer — and the doc no longer implies
/// a race-freedom it cannot have.
///
/// The cost is one extra `rename` and one extra write-pool `SELECT` per
/// *orphan candidate* — files that miss the bulk snapshot, not every walked
/// file — and, on the failure path, orphan bytes surviving one extra pass.
/// Nothing is serialised, and the writer is never held across I/O.
///
/// # In-flight transfer temps (#3325)
///
/// Everything above reasons about a file that either is or is not referenced
/// by a row. A `*.tmp-<hex>` being written right now is neither: it is a file
/// whose row does not exist *yet* and, by design, will never name it — the
/// `attachments` row points at the final path, and the temp only becomes that
/// path via `rename` once the last byte has landed. So no query this pass can
/// run vouches for it, the bulk snapshot misses it, the write-pool re-check
/// misses it, and even the #3519 post-quarantine confirmation misses it. The
/// pass would take the bytes out from under an active writer — on Unix the
/// writer keeps filling the now-unreachable inode, so the whole transfer is
/// silently discarded and its publishing `rename` fails.
///
/// Such names are therefore skipped in the walk, subject to
/// [`TRANSFER_TEMP_REAP_AFTER`] so a temp stranded by a process kill is still
/// reclaimed. See [`is_transfer_temp`] for why the match is exact rather than
/// a loose `.tmp` test — the quarantine files above end in `.tmp` too, and
/// #3519 depends on those *being* collected.
///
/// Semantics are preserved exactly: the old query had **no**
/// `deleted_at IS NULL` predicate, so it matched soft-deleted rows too;
/// the bulk `SELECT fs_path FROM attachments` likewise loads every row
/// (active and soft-deleted). A file is an orphan iff its normalized
/// relative path is not present in the set.
pub(crate) async fn cleanup_orphaned_attachments(
    pool: &SqlitePool,
    read_pool: Option<&SqlitePool>,
    app_data_dir: &Path,
) -> Result<(), AppError> {
    let attachments_root = app_data_dir.join("attachments");

    // Safety check: missing directory is an explicit no-op. A vault
    // that has never received an attachment will not have this
    // directory at all on most platforms — touching anything in this
    // case would be surprising.
    if !tokio::fs::try_exists(&attachments_root)
        .await
        .unwrap_or(false)
    {
        tracing::debug!(
            path = %attachments_root.display(),
            "cleanup_orphaned_attachments: attachments directory missing — no-op"
        );
        return Ok(());
    }

    // #2032: load the referenced-path set BEFORE collecting the on-disk
    // file list, so the reference snapshot is at least as fresh as the
    // file list (never staler). If the order were reversed, a file
    // committed between the walk and the load would be in `files` but
    // absent from `referenced_paths`, maximizing the orphan-misfire
    // window. (The per-file write-pool re-check below is the actual
    // correctness guarantee; this ordering merely narrows the window.)
    //
    // #385: load the full set of referenced `fs_path`s ONCE on the read
    // pool, rather than issuing one write-pool `SELECT 1 WHERE fs_path = ?`
    // per walked file. The read pool (when configured) keeps this off the
    // single SQLite writer; falling back to the write pool preserves the
    // legacy behaviour for single-pool (test / legacy) materializers.
    //
    // The legacy per-file query had NO `deleted_at IS NULL` predicate, so
    // it matched soft-deleted rows too — we replicate that by selecting
    // every row's `fs_path` (no predicate). `fs_path` is stored as a
    // relative, forward-slash path by attachment ingest, which is the
    // exact normalized shape we compute per walked file below, so an
    // in-memory `HashSet` membership test is byte-equivalent to the old
    // `WHERE fs_path = ?` comparison.
    let lookup_pool = read_pool.unwrap_or(pool);
    let referenced_paths: std::collections::HashSet<String> = match sqlx::query_scalar!(
        r#"SELECT fs_path as "fs_path!: String" FROM attachments"#
    )
    .fetch_all(lookup_pool)
    .await
    {
        Ok(rows) => rows.into_iter().collect(),
        Err(e) => {
            // A failure to load the reference set must NOT cause the
            // GC to treat every file as an orphan. Abort the pass
            // (Ok, since the contract is "never propagate") and leave
            // all files untouched.
            tracing::warn!(
                error = %e,
                "cleanup_orphaned_attachments: failed to load referenced fs_paths; aborting pass"
            );
            return Ok(());
        }
    };

    // Walk the attachments subtree iteratively (DFS via a Vec stack)
    // to avoid stack-recursion overhead on deeply nested layouts. We
    // collect file paths first, then process them in batches of
    // `CLEANUP_BATCH_SIZE` so a vault with thousands of attachments
    // does not block the materializer for seconds.
    let mut files: Vec<PathBuf> = Vec::new();
    // #3325: in-flight transfer temps skipped by the walk. Counted, not just
    // logged, because "no files to consider" and "the only files here are
    // being written right now" are different states and the pass must not
    // report the second as the first.
    let mut exempted_temps: u64 = 0;
    let mut dir_stack: Vec<PathBuf> = vec![attachments_root.clone()];
    while let Some(dir) = dir_stack.pop() {
        let mut rd = match tokio::fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(e) => {
                tracing::warn!(
                    path = %dir.display(),
                    error = %e,
                    "cleanup_orphaned_attachments: failed to read directory; skipping subtree"
                );
                continue;
            }
        };
        loop {
            match rd.next_entry().await {
                Ok(Some(entry)) => {
                    let path = entry.path();
                    let file_type = match entry.file_type().await {
                        Ok(ft) => ft,
                        Err(e) => {
                            tracing::warn!(
                                path = %path.display(),
                                error = %e,
                                "cleanup_orphaned_attachments: failed to stat entry; skipping"
                            );
                            continue;
                        }
                    };
                    if file_type.is_dir() {
                        dir_stack.push(path);
                    } else if file_type.is_file() {
                        // #3325: an in-flight `*.tmp-<hex>` is a write in
                        // progress, not an orphan. It can never be referenced
                        // — the row naming it is committed only after the
                        // publishing rename — so every check this pass makes
                        // would classify it as garbage and destroy a transfer
                        // mid-flight. Exempt it unless it is old enough that
                        // no live writer could still own it, which is how a
                        // temp stranded by a process kill still gets reclaimed.
                        if is_transfer_temp(&entry.file_name().to_string_lossy())
                            && !transfer_temp_is_abandoned(&path).await
                        {
                            exempted_temps += 1;
                            tracing::debug!(
                                path = %path.display(),
                                "cleanup_orphaned_attachments: skipping an in-flight transfer temp (#3325)"
                            );
                        } else {
                            files.push(path);
                        }
                    }
                    // Symlinks and other entry types are intentionally
                    // ignored: the attachment writer only
                    // produces regular files, so anything else under
                    // the tree is user-managed and out of scope.
                }
                Ok(None) => break,
                Err(e) => {
                    tracing::warn!(
                        path = %dir.display(),
                        error = %e,
                        "cleanup_orphaned_attachments: error iterating directory entries"
                    );
                    break;
                }
            }
        }
    }

    // #1993 Phase 1 — refcount-aware blob reconciliation. The file walk below
    // already implements the refcount-on-demand contract for BYTES: a blob
    // file is unlinked only when NO `attachments` row references its
    // `fs_path` (membership test against `referenced_paths`). A shared blob
    // (N rows → 1 file) survives until the last referencing row is gone, then
    // becomes an unreferenced file and is unlinked. Here we additionally prune
    // any `attachment_blobs` row whose `on_disk_path` is no longer referenced
    // by a live `attachments` row so the blob store does not accumulate
    // dangling entries. Done on the write pool (the table is small; the delete
    // is a single statement). Best-effort: a failure is logged, not
    // propagated, matching the "partial GC beats no GC" contract.
    //
    // #3371 — this sweep runs BEFORE any unlink, not after. A blob row maps a
    // `content_hash` to an `on_disk_path`, and `add_attachment` dedups new
    // bytes onto that path (`SELECT on_disk_path FROM attachment_blobs WHERE
    // content_hash = ?`). Unlinking first and pruning afterwards leaves a
    // window in which the mapping resolves to a path whose bytes are already
    // gone, so a concurrent re-add of the same bytes commits an `attachments`
    // row pointing at a deleted file. The two directions are NOT symmetric:
    //   * row pruned while the file still exists → the next ingest of those
    //     bytes re-copies them once (a wasted write, self-healing);
    //   * row present while the file is gone → a permanently broken reference.
    // So we always destroy the mapping before the bytes. The per-file guarded
    // prune inside the loop below covers rows that appear (or become
    // unreferenced) after this sweep; this bulk pass additionally covers rows
    // whose `on_disk_path` is not on disk at all and therefore never walked.
    //
    // #3325 — it also runs BEFORE the "nothing to walk" early return, not
    // after. Rows whose path is not on disk at all are exactly the rows an
    // empty walk leaves behind, so the case where this sweep is the ONLY thing
    // that can help is the case the early return used to skip. The #3325 temp
    // exemption gave that hole a second entrance (a directory holding only
    // in-flight temps now walks to zero candidates), which is what made it
    // worth closing rather than noting.
    //
    // The attachment_blobs table (migration 0094) is not yet in the offline
    // .sqlx cache, so use the runtime form here.
    // dynamic-sql: static SQL; attachment_blobs is absent from the .sqlx cache.
    let mut pruned_blobs = match sqlx::query(
        "DELETE FROM attachment_blobs \
         WHERE on_disk_path NOT IN (SELECT fs_path FROM attachments)",
    )
    .execute(pool)
    .await
    {
        Ok(r) => r.rows_affected(),
        Err(e) => {
            tracing::warn!(
                error = %e,
                "cleanup_orphaned_attachments: failed to prune orphaned attachment_blobs rows"
            );
            0
        }
    };

    // Safety check: even if the directory exists, there may be nothing to
    // consider — every attachment already deleted, or (since #3325) every file
    // present being written right now. Either way there is no candidate to
    // walk, so return; the blob sweep above has already run, which is the part
    // that still had work to do.
    if files.is_empty() {
        tracing::debug!(
            path = %attachments_root.display(),
            exempted_temps,
            pruned_blobs,
            "cleanup_orphaned_attachments: no walkable candidates — no-op"
        );
        return Ok(());
    }

    let mut scanned: u64 = 0;
    let mut unlinked: u64 = 0;
    let mut errors: u64 = 0;
    // #3519: candidates whose bytes were quarantined and then handed back
    // because a reference appeared after the orphan decision. A non-zero
    // value is the scheme earning its keep, not a fault.
    let mut restored: u64 = 0;

    for chunk in files.chunks(CLEANUP_BATCH_SIZE) {
        for full_path in chunk {
            scanned += 1;
            // Strip the app_data_dir prefix so we compare against the
            // relative path stored in `attachments.fs_path` by
            // attachment ingest.
            let Ok(relative) = full_path.strip_prefix(app_data_dir) else {
                tracing::warn!(
                    path = %full_path.display(),
                    "cleanup_orphaned_attachments: file path outside app_data_dir; skipping"
                );
                continue;
            };
            // The writer stores `fs_path` with forward slashes (the
            // frontend's `path` plugin normalizes). On Windows the
            // walked path uses backslashes; coerce to the writer's
            // shape before the lookup so the comparison agrees.
            let Some(relative_str_raw) = relative.to_str() else {
                tracing::warn!(
                    path = %full_path.display(),
                    "cleanup_orphaned_attachments: non-UTF8 path; skipping"
                );
                continue;
            };
            let relative_str = relative_str_raw.replace('\\', "/");

            // #385: in-memory membership test against the pre-loaded set
            // is the fast path. A hit means the file is referenced — keep
            // it without touching the DB.
            if referenced_paths.contains(&relative_str) {
                // File is referenced — keep it.
                continue;
            }

            // #3371: this file is an unlink CANDIDATE. Before we can remove
            // its bytes we must first remove any `attachment_blobs` mapping
            // that would let a concurrent `add_attachment` dedup onto them.
            // The `NOT IN` guard makes the decision atomic against the single
            // SQLite writer: if a row already references this path (a
            // concurrent add that raced the bulk snapshot) the DELETE matches
            // nothing and the live mapping is preserved — the write-pool
            // re-check below then keeps the file. Running the prune BEFORE
            // that re-check (rather than after it) is deliberate: once the
            // mapping is gone, no later dedup can point a fresh row at this
            // path, so the only remaining way to acquire a reference is an
            // explicit `fs_path` from a remote op, which the re-check sees.
            //
            // This statement runs only for files that MISS the bulk snapshot
            // (orphans and concurrent adds), not for every walked file, so it
            // costs no extra writes on a healthy vault.
            //
            // attachment_blobs (migration 0094) is absent from the offline
            // .sqlx cache, so use the runtime form here.
            // dynamic-sql: static SQL; attachment_blobs is not in .sqlx.
            match sqlx::query(
                "DELETE FROM attachment_blobs \
                 WHERE on_disk_path = ? \
                   AND on_disk_path NOT IN (SELECT fs_path FROM attachments)",
            )
            .bind(&relative_str)
            .execute(pool)
            .await
            {
                Ok(r) => pruned_blobs += r.rows_affected(),
                Err(e) => {
                    // The mapping may still resolve to this path. Unlinking
                    // now would leave exactly the dangling `hash → deleted
                    // path` reference this ordering exists to prevent, so be
                    // conservative and leave the bytes for the next pass.
                    errors += 1;
                    tracing::warn!(
                        path = %full_path.display(),
                        error = %e,
                        "cleanup_orphaned_attachments: blob-mapping prune failed; skipping unlink to avoid leaving a blob row pointing at deleted bytes"
                    );
                    continue;
                }
            }

            // #2032: a MISS in the bulk snapshot is not authoritative —
            // the snapshot may have been loaded (a) before a concurrent
            // foreground `AddAttachment` committed, or (b) from a
            // read-replica that lags the writer. Re-check membership with
            // a fresh `SELECT 1 FROM attachments WHERE fs_path = ?` on the
            // WRITE pool, which cannot lag the foreground apply path. Only
            // if the row is STILL absent do we treat the file as an
            // orphan. This closes the TOCTOU window for a just-added
            // attachment whose file is already on disk.
            //
            // The runtime form (not `query!`) keeps this off the offline
            // `.sqlx` cache, matching the blob-prune DELETEs.
            // dynamic-sql: static SQL; kept off the offline `.sqlx` cache.
            match sqlx::query("SELECT 1 FROM attachments WHERE fs_path = ?")
                .bind(&relative_str)
                .fetch_optional(pool)
                .await
            {
                Ok(Some(_)) => {
                    // Now referenced per the authoritative write pool —
                    // a concurrent add raced the bulk snapshot. Keep it.
                    tracing::debug!(
                        path = %full_path.display(),
                        "cleanup_orphaned_attachments: write-pool re-check found a reference; keeping (race with concurrent add)"
                    );
                    continue;
                }
                Ok(None) => {
                    // Genuinely unreferenced — fall through to unlink.
                }
                Err(e) => {
                    // Could not confirm orphan status. Be conservative:
                    // do NOT unlink on an indeterminate re-check, since a
                    // false unlink destroys a just-added attachment.
                    errors += 1;
                    tracing::warn!(
                        path = %full_path.display(),
                        error = %e,
                        "cleanup_orphaned_attachments: write-pool re-check failed; skipping unlink to avoid destroying a possibly-referenced file"
                    );
                    continue;
                }
            }

            // #3519 — the re-check above and the destruction of the bytes are
            // still two operations, and nothing serialises a writer against
            // the gap between them. So do not make the second operation
            // destructive: QUARANTINE, confirm, and only then destroy.
            #[cfg(test)]
            gc_race_rendezvous(&relative_str).await;

            let quarantine = gc_quarantine_path(full_path);
            match tokio::fs::rename(full_path, &quarantine).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    tracing::info!(
                        path = %full_path.display(),
                        "cleanup_orphaned_attachments: orphan already missing; skipping"
                    );
                    continue;
                }
                Err(e) => {
                    // Could not shelter the bytes, so do not remove them.
                    // The next pass retries; an orphan that outlives one
                    // sweep costs disk, which is the cheap failure.
                    errors += 1;
                    tracing::warn!(
                        path = %full_path.display(),
                        error = %e,
                        "cleanup_orphaned_attachments: failed to quarantine orphan; leaving bytes for the next pass"
                    );
                    continue;
                }
            }

            // The bytes now live under a name no writer can reference, and
            // the original path resolves to nothing. Ask the write pool once
            // more. Anything that committed a reference at any point during
            // this candidate's evaluation — including inside the old
            // check-to-unlink gap — is visible here, and its bytes are still
            // intact, one rename away.
            //
            // dynamic-sql: static SQL; kept off the offline `.sqlx` cache.
            let confirmed_orphan = match sqlx::query("SELECT 1 FROM attachments WHERE fs_path = ?")
                .bind(&relative_str)
                .fetch_optional(pool)
                .await
            {
                Ok(None) => true,
                Ok(Some(_)) => {
                    tracing::info!(
                        path = %full_path.display(),
                        "cleanup_orphaned_attachments: a reference appeared after the orphan decision; restoring quarantined bytes (#3519)"
                    );
                    false
                }
                Err(e) => {
                    errors += 1;
                    tracing::warn!(
                        path = %full_path.display(),
                        error = %e,
                        "cleanup_orphaned_attachments: post-quarantine confirmation failed; restoring bytes rather than guessing"
                    );
                    false
                }
            };

            if !confirmed_orphan {
                match tokio::fs::rename(&quarantine, full_path).await {
                    Ok(()) => restored += 1,
                    Err(e) => {
                        // The bytes are intact but parked under the
                        // quarantine name, where the next pass will reclaim
                        // them as an orphan. Loud, because this is the one
                        // branch of the scheme that can still lose data.
                        errors += 1;
                        tracing::error!(
                            path = %full_path.display(),
                            quarantine = %quarantine.display(),
                            error = %e,
                            "cleanup_orphaned_attachments: failed to restore quarantined bytes for a newly-referenced attachment"
                        );
                    }
                }
                continue;
            }

            // Confirmed orphan: destroy the quarantined bytes. Errors are
            // logged but never propagated, so the rest of the pass continues.
            match tokio::fs::remove_file(&quarantine).await {
                Ok(()) => {
                    unlinked += 1;
                    tracing::debug!(
                        path = %full_path.display(),
                        "cleanup_orphaned_attachments: removed orphan"
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    tracing::info!(
                        path = %full_path.display(),
                        "cleanup_orphaned_attachments: orphan already missing; skipping"
                    );
                }
                Err(e) => {
                    errors += 1;
                    tracing::warn!(
                        path = %full_path.display(),
                        quarantine = %quarantine.display(),
                        error = %e,
                        "cleanup_orphaned_attachments: failed to unlink quarantined orphan"
                    );
                }
            }
        }
        // Yield between batches so a vault with thousands of
        // attachments cannot starve the rest of the materializer.
        tokio::time::sleep(std::time::Duration::from_millis(CLEANUP_BATCH_SLEEP_MS)).await;
    }

    tracing::info!(
        scanned,
        unlinked,
        restored,
        errors,
        pruned_blobs,
        exempted_temps,
        "cleanup_orphaned_attachments: scanned {scanned} files, unlinked {unlinked} orphans, restored {restored} raced, {errors} errors, pruned {pruned_blobs} blob rows, skipped {exempted_temps} in-flight temps"
    );

    Ok(())
}
