use agaric_core::error::AppError;

/// Enable the op_log mutation bypass on `conn` (connection-scoped core).
///
/// Inserts the sentinel row into `_op_log_mutation_allowed`. Shared by the
/// transaction-scoped [`enable_op_log_mutation_bypass`] and the encapsulated
/// wipe helpers [`truncate`] / [`prune`] so the bypass INSERT lives in exactly
/// one place.
async fn enable_op_log_mutation_bypass_conn(
    conn: &mut sqlx::SqliteConnection,
) -> Result<(), AppError> {
    sqlx::query("INSERT INTO _op_log_mutation_allowed (token) VALUES (1)")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Disable the op_log mutation bypass on `conn` (connection-scoped core).
///
/// Removes every sentinel row from `_op_log_mutation_allowed`. Shared by
/// [`disable_op_log_mutation_bypass`] and the encapsulated wipe helpers.
async fn disable_op_log_mutation_bypass_conn(
    conn: &mut sqlx::SqliteConnection,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM _op_log_mutation_allowed")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Enable the op_log mutation bypass on `tx`.
///
/// Inserts a sentinel row into `_op_log_mutation_allowed` so the BEFORE
/// UPDATE / BEFORE DELETE triggers on `op_log` permit mutations for the
/// remainder of `tx`. Because the INSERT is part of `tx`'s pending writes,
/// sibling connections cannot observe it (WAL semantics).
///
/// Callers MUST invoke [`disable_op_log_mutation_bypass`] before commit so
/// the sentinel is removed from the WAL before the writer lock is released
/// — preventing it from ever becoming visible to other connections. On
/// rollback the row is discarded automatically.
///
/// # When to reach for [`truncate`] / [`prune`] instead
/// A caller that only wants to wipe (RESET) or compaction-prune `op_log`
/// should call [`truncate`] / [`prune`] — those encapsulate the
/// enable → delete → disable bracket so the bypass can never be left
/// dangling. This raw pair remains for callers (and tests) that need to
/// drive their own multi-statement bypass window.
///
/// # Errors
/// Returns [`AppError`] if the INSERT fails (e.g. the underlying connection
/// has been closed).
pub async fn enable_op_log_mutation_bypass(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<(), AppError> {
    enable_op_log_mutation_bypass_conn(tx).await
}

/// Disable the op_log mutation bypass on `tx`.
///
/// Removes any sentinel rows from `_op_log_mutation_allowed`. MUST be
/// called before commit when [`enable_op_log_mutation_bypass`] was called
/// earlier on the same `tx`; failing to do so would commit the sentinel
/// and silently grant every subsequent connection a global bypass.
///
/// On rollback this is unnecessary (the INSERT is rolled back too) but
/// calling it is still safe.
///
/// # Errors
/// Returns [`AppError`] if the DELETE fails (e.g. the underlying connection
/// has been closed).
pub async fn disable_op_log_mutation_bypass(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<(), AppError> {
    disable_op_log_mutation_bypass_conn(tx).await
}

/// Wholesale-wipe `op_log`, encapsulating the H-13 immutability-trigger
/// bypass bracket (#2895 slice 4).
///
/// The BEFORE DELETE trigger on `op_log` (migration 0036) ABORTS a bare
/// `DELETE FROM op_log` unless the `_op_log_mutation_allowed` sentinel is
/// present. Callers that open-coded the wipe had to remember to bracket it
/// with `enable_op_log_mutation_bypass` → delete → `disable_op_log_mutation_bypass`
/// by hand; forgetting the bracket aborts the whole transaction, and
/// forgetting the *disable* leaks a global bypass to every other connection.
/// This helper owns that dance so the caller can't get it wrong: it runs
/// enable → `DELETE FROM op_log` → disable on `conn`, leaving the bypass
/// DISABLED on return.
///
/// Opens NO transaction: the three statements run on the caller's
/// connection/transaction in order, so the wipe and its bypass bracket are
/// atomic with whatever surrounding write the caller commits (e.g. the
/// snapshot RESET). On any error the caller's transaction rolls back, which
/// discards the sentinel INSERT as well — the bypass never escapes.
///
/// This is the RESET-path counterpart to [`prune`] (compaction). Used by the
/// snapshot RESET (`agaric-sync`'s `apply_snapshot`).
///
/// # Errors
/// Returns [`AppError`] if any of the three statements fail.
pub async fn truncate(conn: &mut sqlx::SqliteConnection) -> Result<(), AppError> {
    enable_op_log_mutation_bypass_conn(&mut *conn).await?;
    sqlx::query!("DELETE FROM op_log")
        .execute(&mut *conn)
        .await?;
    disable_op_log_mutation_bypass_conn(&mut *conn).await?;
    Ok(())
}

/// Compaction-prune the ops of a single device from `op_log`, encapsulating
/// the H-13 immutability-trigger bypass bracket (#2895 slice 4).
///
/// Deletes rows older than `created_before` for `device_id` up to and
/// including `max_seq`:
///
/// ```sql
/// DELETE FROM op_log WHERE created_at < ?1 AND device_id = ?2 AND seq <= ?3
/// ```
///
/// The seq bound is the snapshot frontier for the device, so ops written
/// after the snapshot read (seq > `max_seq`) are never deleted even if their
/// `created_at` predates the cutoff. Returns the number of rows deleted.
///
/// Like [`truncate`], this self-brackets the H-13 bypass (enable → delete →
/// disable) around its own DELETE, so a compaction loop that calls `prune`
/// per device can't forget the bracket and each DELETE runs with the sentinel
/// present. This is behaviourally identical to the previous "bracket once
/// around the whole loop" form: the sentinel state is fully contained within
/// the caller's transaction, and every DELETE still observes it. Opens NO
/// transaction; leaves the bypass DISABLED on return. On error the caller's
/// transaction rolls back, discarding the sentinel INSERT.
///
/// # Errors
/// Returns [`AppError`] if any of the three statements fail.
pub async fn prune(
    conn: &mut sqlx::SqliteConnection,
    created_before: i64,
    device_id: &str,
    max_seq: i64,
) -> Result<u64, AppError> {
    enable_op_log_mutation_bypass_conn(&mut *conn).await?;
    let res = sqlx::query!(
        "DELETE FROM op_log WHERE created_at < ?1 AND device_id = ?2 AND seq <= ?3",
        created_before,
        device_id,
        max_seq,
    )
    .execute(&mut *conn)
    .await?;
    disable_op_log_mutation_bypass_conn(&mut *conn).await?;
    Ok(res.rows_affected())
}
