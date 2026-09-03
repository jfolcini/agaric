//! Durable per-device op-log high-water marks (#3310, #3998).
//!
//! ## Why this exists
//!
//! `op_log`'s local-append allocator used to derive the next `seq` purely
//! from the rows that happen to survive in the table:
//!
//! ```sql
//! SELECT COALESCE(MAX(seq), 0) + 1 FROM op_log WHERE device_id = ?
//! ```
//!
//! That makes the device's *identity counter* a function of its *retained
//! history*, and the system has two sanctioned paths that wipe history
//! wholesale:
//!
//! * [`super::prune`] (compaction) — bounded by `created_at < cutoff` and the
//!   device's own snapshot frontier, so a vault whose newest op predates the
//!   retention window is purged to **zero** rows (#3310). The IPC
//!   `MIN_RETENTION_DAYS` guard bounds only the window, not the outcome: a
//!   90-day-retention vault left untouched for a quarter reaches it too.
//! * [`super::truncate`] (the snapshot RESET) — an unbounded `DELETE FROM
//!   op_log` (#3998). Its only production caller is the paired-peer snapshot
//!   catch-up in `agaric-sync`'s `snapshot_transfer`.
//!
//! After either wipe the allocator restarted the device at `seq = 1` with
//! `parent_seqs = NULL`, re-minting op addresses the device had already
//! issued. `op_log`'s identity is `PRIMARY KEY (device_id, seq)` with no
//! epoch/lineage column, so those re-minted addresses ALIAS the ops a peer
//! still holds as `is_replicated = 1` audit rows: the peer's ingest is
//! `INSERT OR IGNORE` on that composite PK, so a post-wipe op is silently
//! swallowed as a "duplicate delivery" (or rejected outright by the
//! divergence probe, which sees a different hash at an address it already
//! holds). The device's post-wipe history then never replicates, permanently
//! and without a log line.
//!
//! ## The fix: keep the counter OUTSIDE the table it counts
//!
//! We persist a monotone per-device high-water mark in `app_settings` — the
//! same table, and for the same reason, that #792 uses for
//! `loro.peer_id_epoch`: **the RESET does not wipe it**
//! (`apply_snapshot`'s wipe list covers the cache tables plus the core
//! tables it re-populates from the snapshot; `app_settings` is deliberately
//! excluded so exactly this kind of identity state can outlive the swap).
//!
//! * Both wipe helpers call [`capture_device_frontier`] /
//!   [`capture_all_frontiers`] **before** their DELETE, in the caller's
//!   transaction, so the mark and the wipe commit or roll back together.
//! * [`next_seq_for_device`] allocates from
//!   `MAX(MAX(seq) over surviving rows, durable mark) + 1`, so the counter
//!   never walks backwards over a wipe.
//!
//! This covers BOTH wipe paths with one mechanism, which the floor-clause
//! alternative sketched in #3310 (`AND seq < ?3` on prune's DELETE) does
//! not: a floor clause leaves `truncate` — the path where the cross-device
//! aliasing is reachable **by construction**, because its only production
//! caller is a live paired-peer catch-up — completely untouched.
//!
//! ## Read failures fail CLOSED (the #2023 lesson)
//!
//! [`next_seq_for_device`] returns the error rather than coercing a failed
//! read to "no mark". #2023 established the same rule for the peer epoch:
//! treating an unreadable value as the default is precisely what re-forks
//! the identity space the mechanism exists to protect. A failed allocation
//! aborts the append (the caller's transaction rolls back); a silently
//! defaulted one would re-issue live addresses.
//!
//! That rule covers a failing *read*. A read that SUCCEEDS but returns a
//! value that is not a mark is a separate hazard, and it used to be
//! completely silent: [`read_high_water`] selected
//! `CAST(value AS INTEGER)`, and SQLite's `CAST` cannot fail — `'nonsense'`
//! became `0`, `'12abc'` became `12`, `'-5'` became `-5`. On an emptied log
//! that made [`next_seq_for_device`] hand back `1` again, i.e. the exact bug
//! this module exists to prevent, with no log line anywhere. So the value is
//! now fetched as TEXT and parsed in Rust, and an unparseable or negative
//! mark gets an explicit `tracing::warn!` — matching the precedent set by
//! `agaric_engine::loro::peer_epoch::load_peer_epoch`, which already warns
//! on a `peer_epoch` row that is not a `u64` before degrading to 0.
//!
//! Degrading (rather than erroring) is the right call here because the
//! condition is self-repairing: `record_high_water`'s upsert compares with
//! `CAST(app_settings.value AS INTEGER)`, so a garbage mark casts to 0 and
//! the very next wipe's real frontier wins the monotone comparison outright.
//! The defect being fixed is the SILENCE, not a live data-loss path.
//!
//! ## Marks are recorded for EVERY device, but only ever READ for the local one
//!
//! [`capture_all_frontiers`] records a mark for every `device_id` present in
//! `op_log`, including remote peers whose audit rows the RESET is about to
//! drop, because [`super::truncate`] has no notion of "which device is
//! local". Those extra rows are inert: the only reader is the local-append
//! allocator, and this device never appends under a peer's `device_id`
//! (remote rows arrive through `ingest_remote_op_in_tx`, which carries an
//! explicit `seq`). In particular the mark is deliberately NOT consulted by
//! `get_local_heads`, which must keep advertising the frontier we actually
//! HOLD.

use agaric_core::error::AppError;

/// `app_settings` key prefix for the durable per-device op-log high-water
/// mark. The full key is the prefix followed by the `device_id`.
///
/// An absent row means "no wipe has ever been recorded for this device", in
/// which case the surviving `MAX(seq)` is the whole truth — which is exactly
/// the pre-#3310 behaviour, so upgrading an existing vault never perturbs a
/// device that has not been through a wipe.
pub const HIGH_WATER_KEY_PREFIX: &str = "op_log.high_water.";

/// The `app_settings` key holding `device_id`'s durable high-water mark.
#[must_use]
pub fn high_water_key(device_id: &str) -> String {
    format!("{HIGH_WATER_KEY_PREFIX}{device_id}")
}

/// The next `seq` to allocate for `device_id`:
/// `MAX(surviving MAX(seq), durable high-water) + 1`.
///
/// Both reads run on the caller's connection, which for the append path is
/// the `BEGIN IMMEDIATE` command transaction — so they see one consistent
/// snapshot and no concurrent writer can slip a higher `seq` between them
/// (the same lock that already protects the read-then-INSERT pair).
///
/// # Errors
/// Returns [`AppError`] if either read fails. The failure is deliberately
/// NOT coerced to "start from the surviving rows" — see the module docs.
pub async fn next_seq_for_device(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
) -> Result<i64, AppError> {
    // The pre-#3310 allocator, unchanged and still the answer on every
    // vault that has never been wiped. `COALESCE(MAX(seq), 0) + 1` is
    // efficient because PRIMARY KEY (device_id, seq) gives SQLite a B-tree
    // index that makes `MAX(seq) WHERE device_id = ?` an O(log n) seek, not
    // a table scan.
    let row = sqlx::query!(
        r#"SELECT COALESCE(MAX(seq), 0) + 1 as "next_seq!: i64" FROM op_log WHERE device_id = ?"#,
        device_id,
    )
    .fetch_one(&mut *conn)
    .await?;
    // The floor a wipe left behind. Absent mark => 0 => floor 1 => the
    // expression above wins outright, so an un-wiped device is bit-for-bit
    // unaffected. A PK point lookup on `app_settings`.
    let floor = read_high_water(&mut *conn, device_id)
        .await?
        .unwrap_or(0)
        .saturating_add(1);
    Ok(row.next_seq.max(floor))
}

/// The durable high-water mark recorded for `device_id`, or `None` when no
/// wipe has ever been recorded for it.
///
/// The stored value is TEXT (`app_settings` is STRICT, migration 0053) and
/// is parsed in **Rust**, deliberately not with SQL's `CAST(value AS
/// INTEGER)`: `CAST` cannot fail, so a corrupt row silently became a mark of
/// `0` (or a truncated prefix like `'12abc'` → `12`) and
/// [`next_seq_for_device`] went straight back to re-issuing `seq = 1` over
/// an emptied log — the very defect this module exists to prevent, with
/// nothing in the logs. A value that is absent, unparseable, or negative is
/// now reported as `None` ("no usable mark") after an explicit
/// `tracing::warn!`, mirroring `loro::peer_epoch::load_peer_epoch`.
///
/// `None` is the correct degraded answer rather than an `Err`: it restores
/// exactly the pre-#3310 allocator (`MAX(seq) + 1` over surviving rows),
/// and the next wipe repairs the row — `record_high_water`'s upsert
/// compares `CAST(app_settings.value AS INTEGER)`, so any garbage casts to 0
/// and a real frontier always wins the monotone comparison. Erroring instead
/// would wedge every local append behind a self-healing cosmetic fault.
///
/// # Errors
/// Returns [`AppError`] if the read itself fails — that path still fails
/// CLOSED (see the module docs).
pub async fn read_high_water(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
) -> Result<Option<i64>, AppError> {
    let key = high_water_key(device_id);
    let raw: Option<String> = sqlx::query_scalar!(
        r#"SELECT value AS "value!: String" FROM app_settings WHERE key = ?"#,
        key,
    )
    .fetch_optional(&mut *conn)
    .await?;
    // Row genuinely absent — the legitimate never-wiped state.
    let Some(raw) = raw else { return Ok(None) };
    match raw.parse::<i64>() {
        // A negative mark is as meaningless as an unparseable one: seqs
        // start at 1, and `record_high_water` refuses to write `seq <= 0`,
        // so anything below 1 can only be corruption. Reporting it as a
        // mark would compute a floor of `n + 1 <= 0`, which `max()` throws
        // away — i.e. the silent restart again.
        Ok(seq) if seq > 0 => Ok(Some(seq)),
        Ok(seq) => {
            if first_report_for(device_id) {
                tracing::warn!(
                    %device_id,
                    value = %raw,
                    parsed = seq,
                    "op_log: high-water mark for device is not a positive seq; \
                     ignoring it and allocating from the surviving MAX(seq) \
                     (#3310). The next op_log wipe overwrites this row with the \
                     real frontier. Reported once per device per process."
                );
            }
            Ok(None)
        }
        Err(e) => {
            if first_report_for(device_id) {
                tracing::warn!(
                    %device_id,
                    value = %raw,
                    error = %e,
                    "op_log: high-water mark for device is not an i64; ignoring \
                     it and allocating from the surviving MAX(seq) (#3310). The \
                     next op_log wipe overwrites this row with the real frontier. \
                     Reported once per device per process."
                );
            }
            Ok(None)
        }
    }
}

/// Devices whose corrupt high-water mark has already been reported in this
/// process. See [`first_report_for`].
static CORRUPT_MARK_REPORTED: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashSet<String>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

/// Is this the first time this process has seen a corrupt mark for
/// `device_id`?
///
/// #3310 (review follow-up): the warn above is emitted from
/// [`read_high_water`], which [`next_seq_for_device`] calls on **every local
/// append** — i.e. once per user edit, not once per boot. The cited precedent,
/// `loro::peer_epoch::load_peer_epoch`, runs once at startup, and the
/// self-repair argument ("the next wipe overwrites the row") does not bound the
/// noise either, because wipes are rare by construction. Unbounded repetition
/// of a warn is how a log stops being read, which would defeat the whole point
/// of the change: the defect being fixed was SILENCE.
///
/// Keyed by device rather than a single global flag so a second device's
/// corrupt mark is never masked by the first's — the marks are per-device rows,
/// and in practice only the local device's is ever read (see the module docs),
/// so this is exactly one line per affected device per boot: the precedent's
/// frequency. Deliberately in-process only: a restart re-reports, which is what
/// makes the condition visible again after an upgrade or a support request.
///
/// A poisoned mutex is recovered rather than propagated — a panic in another
/// thread must not turn a cosmetic log-throttle into a failed append.
fn first_report_for(device_id: &str) -> bool {
    CORRUPT_MARK_REPORTED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(device_id.to_owned())
}

/// Raise `device_id`'s durable high-water mark to `seq`.
///
/// A no-op when `seq` is not higher than the recorded mark (the `WHERE` on
/// the upsert's `DO UPDATE`), so the mark is monotone: a later wipe of a
/// SHORTER surviving history can never lower the floor a previous wipe
/// established.
async fn record_high_water(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    seq: i64,
) -> Result<(), AppError> {
    if seq <= 0 {
        // Nothing to protect: the device has issued no ops under this id.
        return Ok(());
    }
    let key = high_water_key(device_id);
    // `app_settings.value` is TEXT (migration 0053, STRICT), so the mark is
    // stored as a decimal string and compared with an explicit CAST — the
    // same shape `loro.peer_id_epoch` uses.
    let value = seq.to_string();
    let now = crate::db::now_ms();
    sqlx::query!(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at \
         WHERE CAST(excluded.value AS INTEGER) > CAST(app_settings.value AS INTEGER)",
        key,
        value,
        now,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Capture `device_id`'s current `MAX(seq)` into its durable mark.
///
/// Called by [`super::prune`] immediately BEFORE its DELETE, on the caller's
/// transaction, so the floor is established atomically with the rows it
/// outlives.
///
/// # Errors
/// Returns [`AppError`] if the read or the upsert fails.
pub(super) async fn capture_device_frontier(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
) -> Result<(), AppError> {
    let max_seq: i64 = sqlx::query_scalar!(
        r#"SELECT COALESCE(MAX(seq), 0) AS "frontier!: i64" FROM op_log WHERE device_id = ?"#,
        device_id,
    )
    .fetch_one(&mut *conn)
    .await?;
    record_high_water(conn, device_id, max_seq).await
}

/// Capture the current `MAX(seq)` of EVERY device into its durable mark.
///
/// Called by [`super::truncate`] immediately BEFORE its unbounded DELETE.
/// `truncate` does not know which `device_id` is local (see the module docs
/// on why recording the remote ones is inert), so it records them all.
///
/// # Errors
/// Returns [`AppError`] if the read or any upsert fails.
pub(super) async fn capture_all_frontiers(
    conn: &mut sqlx::SqliteConnection,
) -> Result<(), AppError> {
    let rows = sqlx::query!(
        r#"SELECT device_id AS "device_id!: String", MAX(seq) AS "frontier!: i64"
           FROM op_log GROUP BY device_id"#,
    )
    .fetch_all(&mut *conn)
    .await?;
    for row in rows {
        record_high_water(&mut *conn, &row.device_id, row.frontier).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// #3310 — a corrupt mark must be LOUD
// ---------------------------------------------------------------------------
//
// These live inline rather than under `op_log/tests/` because they are about
// this file's own parse-vs-`CAST` decision, and the point of the fix is
// exactly that the decision is easy to un-make by accident: swapping the
// `parse::<i64>()` back for `CAST(value AS INTEGER)` compiles, keeps every
// happy-path test green, and silently reinstates the bug.
#[cfg(test)]
mod corrupt_mark_tests {
    use super::*;
    use tracing_subscriber::layer::SubscriberExt;

    /// Thread-safe buffered writer for in-process log capture. Mirrors the
    /// helper in `op_log::tests::origin` (AGENTS.md: "Test helper duplication
    /// is intentional").
    #[derive(Clone, Default)]
    struct WarnCapture(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for WarnCapture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for WarnCapture {
        type Writer = WarnCapture;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    impl WarnCapture {
        fn contents(&self) -> String {
            String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
        }
    }

    /// Write `value` verbatim into the device's high-water row, bypassing
    /// `record_high_water`'s validation — i.e. simulate a row corrupted by
    /// something other than this module.
    async fn plant_raw_mark(pool: &sqlx::SqlitePool, device_id: &str, value: &str) {
        sqlx::query("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)")
            .bind(high_water_key(device_id))
            .bind(value)
            .bind(crate::db::now_ms())
            .execute(pool)
            .await
            .unwrap();
    }

    /// Run `next_seq_for_device` under a scoped `warn`-capturing subscriber.
    async fn alloc_capturing_warns(pool: &sqlx::SqlitePool, device_id: &str) -> (i64, String) {
        let writer = WarnCapture::default();
        let subscriber = tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::new("warn"))
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(writer.clone())
                    .with_ansi(false),
            );
        let mut conn = pool.acquire().await.unwrap();
        let next = {
            let _guard = tracing::subscriber::set_default(subscriber);
            next_seq_for_device(&mut conn, device_id).await.unwrap()
        };
        (next, writer.contents())
    }

    /// #3310 robustness: `read_high_water` used to select
    /// `CAST(value AS INTEGER)`, and SQLite's `CAST` cannot fail. On an
    /// emptied log a mark of `'nonsense'` cast to 0, `'-5'` cast to a
    /// negative, and `'12abc'` truncated — in every case the allocator handed
    /// back a seq with NOTHING in the logs, and for `'nonsense'`/`'-5'` that
    /// seq was `1`: the exact re-minting of live op addresses this module
    /// exists to prevent, reintroduced silently.
    ///
    /// The mark is still degraded rather than fatal (the row self-repairs on
    /// the next wipe — `record_high_water`'s upsert casts the garbage to 0, so
    /// any real frontier wins the monotone comparison), matching
    /// `loro::peer_epoch::load_peer_epoch`. What must NOT happen is silence.
    #[tokio::test]
    async fn corrupt_high_water_mark_warns_instead_of_silently_restarting_seq() {
        // `"0"` parses cleanly and is still not a mark: the guard is
        // `seq > 0`, and a mark of 0 would compute a floor of 1 — the seq
        // restart this module exists to prevent. It is the only case here
        // that separates `> 0` from `>= 0`.
        for garbage in ["nonsense", "12abc", "-5", "0", ""] {
            let (pool, _dir) = crate::test_support::test_pool().await;
            // A distinct device per case: the report is throttled to once per
            // device per PROCESS (see `first_report_for`), and every case here
            // must be able to observe its own first report.
            let device_id = &format!("dev-3310-corrupt-{}", garbage.len());
            plant_raw_mark(&pool, device_id, garbage).await;

            let (next, logs) = alloc_capturing_warns(&pool, device_id).await;

            // The allocator's answer over an emptied log is still 1 — the row
            // carries no recoverable frontier. The defect being fixed is that
            // it used to arrive with no warning at all.
            assert!(
                !logs.is_empty(),
                "#3310: `next_seq_for_device` returned {next} over an emptied log \
                 whose mark is {garbage:?} and said NOTHING — this is the silent \
                 seq restart the module exists to prevent"
            );
            assert!(
                logs.contains("high-water mark"),
                "#3310: a corrupt mark of {garbage:?} must be reported, the way \
                 load_peer_epoch reports a non-u64 peer_epoch row; captured log \
                 output: {logs:?}"
            );
            assert!(
                logs.contains(device_id),
                "#3310: the warn must name the device whose mark is corrupt so the \
                 row can be found; captured log output: {logs:?}"
            );
            assert_eq!(
                next, 1,
                "over an empty op_log a corrupt mark leaves only MAX(seq)+1; the \
                 fix is that this no longer happens SILENTLY"
            );

            // ...and the read itself now reports "no usable mark" rather than a
            // number conjured by CAST.
            let mut conn = pool.acquire().await.unwrap();
            let read = read_high_water(&mut conn, device_id).await.unwrap();
            drop(conn);
            assert_eq!(
                read, None,
                "#3310: a mark of {garbage:?} is not a mark; CAST would have \
                 invented one"
            );
        }
    }

    /// #3310 (review follow-up): the report must be ONCE per device, not once
    /// per append.
    ///
    /// `read_high_water` is called from `next_seq_for_device`, which runs inside
    /// every local op append — so an unthrottled warn is one line per user
    /// EDIT, indefinitely, for as long as the corrupt row sits in
    /// `app_settings`. (The cited precedent, `load_peer_epoch`, runs once per
    /// boot; and "the next wipe repairs the row" does not bound anything,
    /// because wipes are rare by construction.) A warn that repeats per
    /// keystroke-batch is a warn nobody reads, which is the same failure mode —
    /// silence — the warn was added to fix.
    #[tokio::test]
    async fn corrupt_high_water_mark_is_reported_once_not_once_per_append() {
        let (pool, _dir) = crate::test_support::test_pool().await;
        let device_id = "dev-3310-once";
        plant_raw_mark(&pool, device_id, "nonsense").await;

        let (_, first) = alloc_capturing_warns(&pool, device_id).await;
        assert!(
            first.contains("high-water mark"),
            "the first append after a corrupt mark must still report it; \
             captured log output: {first:?}"
        );

        // Simulate the user carrying on editing: more appends, same corrupt row.
        for _ in 0..3 {
            let (_, again) = alloc_capturing_warns(&pool, device_id).await;
            assert!(
                again.is_empty(),
                "#3310: the corrupt mark must be reported once per device, not \
                 once per local append — every subsequent append must be silent; \
                 captured log output: {again:?}"
            );
        }

        // …and the degraded READ answer is unchanged by the throttle: the row is
        // still "no usable mark", it is only the logging that is bounded.
        let mut conn = pool.acquire().await.unwrap();
        let read = read_high_water(&mut conn, device_id).await.unwrap();
        assert_eq!(
            read, None,
            "throttling the report must not change what the read returns"
        );
    }

    /// The other half of the pair: a well-formed mark must still be honoured,
    /// and honoured QUIETLY. Without this, deleting the parse and always
    /// warning would pass the test above.
    #[tokio::test]
    async fn valid_high_water_mark_is_honoured_and_emits_no_warn() {
        let (pool, _dir) = crate::test_support::test_pool().await;
        let device_id = "dev-3310-valid";
        plant_raw_mark(&pool, device_id, "50000").await;

        let mut conn = pool.acquire().await.unwrap();
        let read = read_high_water(&mut conn, device_id).await.unwrap();
        drop(conn);
        assert_eq!(read, Some(50_000), "a well-formed mark must parse");

        let (next, logs) = alloc_capturing_warns(&pool, device_id).await;
        assert_eq!(
            next, 50_001,
            "the durable mark is the floor: an emptied log must not restart the \
             device at seq 1 (#3310)"
        );
        assert!(
            logs.is_empty(),
            "a healthy mark must not warn; captured log output: {logs:?}"
        );
    }
}
