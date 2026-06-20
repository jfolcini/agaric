//! Attachment apply handlers and the orphaned-attachment cleanup
//! reconciliation (C-3c).

use super::*;

/// Per-variant body for [`OpType::AddAttachment`].
pub(super) async fn apply_add_attachment_tx(
    conn: &mut sqlx::SqliteConnection,
    p: AddAttachmentPayload,
    created_at: i64,
) -> Result<(), AppError> {
    let attachment_id_str = p.attachment_id.as_str();
    let block_id_str = p.block_id.as_str();
    sqlx::query!(
        "INSERT OR IGNORE INTO attachments \
             (id, block_id, filename, fs_path, mime_type, size_bytes, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        attachment_id_str,
        block_id_str,
        p.filename,
        p.fs_path,
        p.mime_type,
        p.size_bytes,
        created_at,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Per-variant body for [`OpType::DeleteAttachment`].
pub(super) async fn apply_delete_attachment_tx(
    conn: &mut sqlx::SqliteConnection,
    p: DeleteAttachmentPayload,
) -> Result<(), AppError> {
    let attachment_id_str = p.attachment_id.as_str();
    sqlx::query!("DELETE FROM attachments WHERE id = ?", attachment_id_str)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Per-variant body for [`OpType::RenameAttachment`].
pub(super) async fn apply_rename_attachment_tx(
    conn: &mut sqlx::SqliteConnection,
    p: RenameAttachmentPayload,
) -> Result<(), AppError> {
    let attachment_id_str = p.attachment_id.as_str();
    sqlx::query!(
        "UPDATE attachments SET filename = ? WHERE id = ?",
        p.new_filename,
        attachment_id_str
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

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
/// Threat model: single-user, multi-device. There are no concurrent
/// writers for a given attachment row, so there is no TOCTOU concern
/// between the `SELECT 1` existence check and the `remove_file`
/// unlink — the row cannot appear between the two operations.
///
/// Robustness guarantees:
/// - Missing or empty `attachments/` directory is a no-op (early
///   return), so a "vault never seeded" install never accidentally
///   touches anything.
/// - Per-file unlink errors (other than `NotFound`, which is logged at
///   info as already-clean) are logged at warn and the pass continues
///   — the GC must complete even if individual files cannot be
///   removed.
/// - Subdirectories under `attachments/` are walked recursively. The
///   `add_attachment_inner` path validator
///   (`check_attachment_fs_path_shape`) accepts subdirectories, and
///   Large-vault layouts may organize attachments in subdirs.
///
/// Returns `Ok(())` always — failures are logged, never propagated,
/// because a partial GC pass is strictly better than no GC pass.
///
/// # Pool usage (#385)
///
/// The set of referenced `fs_path`s is loaded **once** via a single
/// `SELECT fs_path FROM attachments` on `read_pool` (the dedicated
/// reader, when configured) into an in-memory `HashSet`, and membership
/// is tested per file in memory. This replaces the historical
/// per-file `SELECT 1 FROM attachments WHERE fs_path = ?` against the
/// write pool, which (a) contended with the foreground apply path for
/// the single SQLite writer and (b) could not use the *partial*
/// `fs_path` index (`WHERE deleted_at IS NULL`, migrations 0061/0081)
/// because the predicate-less lookup forced a per-file scan.
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

    // Walk the attachments subtree iteratively (DFS via a Vec stack)
    // to avoid stack-recursion overhead on deeply nested layouts. We
    // collect file paths first, then process them in batches of
    // `CLEANUP_BATCH_SIZE` so a vault with thousands of attachments
    // does not block the materializer for seconds.
    let mut files: Vec<PathBuf> = Vec::new();
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
                        files.push(path);
                    }
                    // Symlinks and other entry types are intentionally
                    // ignored: the writer (`add_attachment_inner`) only
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

    // Safety check: even if the directory exists, it may be empty
    // (e.g. all attachments were already deleted). Treat as no-op so
    // a pathological "vault never seeded" install never accidentally
    // touches anything.
    if files.is_empty() {
        tracing::debug!(
            path = %attachments_root.display(),
            "cleanup_orphaned_attachments: attachments directory empty — no-op"
        );
        return Ok(());
    }

    // #385: load the full set of referenced `fs_path`s ONCE on the read
    // pool, rather than issuing one write-pool `SELECT 1 WHERE fs_path = ?`
    // per walked file. The read pool (when configured) keeps this off the
    // single SQLite writer; falling back to the write pool preserves the
    // legacy behaviour for single-pool (test / legacy) materializers.
    //
    // The legacy per-file query had NO `deleted_at IS NULL` predicate, so
    // it matched soft-deleted rows too — we replicate that by selecting
    // every row's `fs_path` (no predicate). `fs_path` is stored as a
    // relative, forward-slash path by `add_attachment_inner`, which is the
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

    let mut scanned: u64 = 0;
    let mut unlinked: u64 = 0;
    let mut errors: u64 = 0;

    for chunk in files.chunks(CLEANUP_BATCH_SIZE) {
        for full_path in chunk {
            scanned += 1;
            // Strip the app_data_dir prefix so we compare against the
            // relative path stored in `attachments.fs_path` by
            // `add_attachment_inner`.
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

            // #385: in-memory membership test against the pre-loaded set,
            // replacing the per-file write-pool `SELECT 1 WHERE fs_path = ?`.
            if referenced_paths.contains(&relative_str) {
                // File is referenced — keep it.
                continue;
            }

            // Orphan: unlink. Errors are logged but never propagated, so
            // the rest of the pass continues.
            match tokio::fs::remove_file(&full_path).await {
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
                        error = %e,
                        "cleanup_orphaned_attachments: failed to unlink orphan"
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
        errors,
        "cleanup_orphaned_attachments: scanned {scanned} files, unlinked {unlinked} orphans, {errors} errors"
    );

    Ok(())
}
