use crate::error::AppError;

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
/// # Errors
/// Returns [`AppError`] if the INSERT fails (e.g. the underlying connection
/// has been closed).
pub async fn enable_op_log_mutation_bypass(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<(), AppError> {
    sqlx::query("INSERT INTO _op_log_mutation_allowed (token) VALUES (1)")
        .execute(&mut **tx)
        .await?;
    Ok(())
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
    sqlx::query("DELETE FROM _op_log_mutation_allowed")
        .execute(&mut **tx)
        .await?;
    Ok(())
}
