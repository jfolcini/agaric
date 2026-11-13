//! A daily local snapshot of the vault (#6554).
//!
//! Once per local calendar day the maintenance daemon copies the database to
//! `<db>.daily-<YYYY-MM-DD>` beside it and keeps the newest
//! `MAX_KEPT_DAILY_SNAPSHOTS`. The copy is `snapshot_vault`'s `VACUUM INTO`
//! on a read-only connection: a consistent image of every committed
//! transaction, the ones still in the `-wal` included, taken under a read
//! transaction, so it never holds the write lock. The pre-migration backups
//! beside it (`<db>.pre-migration-<ts>`) are a different set, pruned on their
//! own.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};

use agaric_core::error::AppError;
use chrono::{Datelike, NaiveDate};

use super::pool::snapshot_vault;

/// Daily snapshots kept beside the vault.
const MAX_KEPT_DAILY_SNAPSHOTS: usize = 7;

const DATE_FORMAT: &str = "%Y-%m-%d";

/// `<db file name>.daily-`, the prefix of every daily snapshot's file name.
fn name_prefix(db_path: &Path) -> String {
    let db_name = db_path.file_name().unwrap_or_default().to_string_lossy();
    format!("{db_name}.daily-")
}

/// The daily snapshots beside `db_path`, oldest first. A sibling whose name
/// does not end in a date is not one, so nothing else is ever pruned.
fn daily_snapshots(db_path: &Path) -> std::io::Result<Vec<(NaiveDate, PathBuf)>> {
    let prefix = name_prefix(db_path);
    let mut snapshots = Vec::new();
    for entry in std::fs::read_dir(db_path.parent().unwrap_or(Path::new("")))? {
        let entry = entry?;
        let name = entry.file_name();
        let day = name
            .to_str()
            .and_then(|name| name.strip_prefix(&prefix))
            .and_then(|date| NaiveDate::parse_from_str(date, DATE_FORMAT).ok());
        if let Some(day) = day {
            snapshots.push((day, entry.path()));
        }
    }
    snapshots.sort();
    Ok(snapshots)
}

/// Take `day`'s snapshot of the vault at `db_path` unless it exists, then
/// delete all but the newest `MAX_KEPT_DAILY_SNAPSHOTS`. Answers whether a
/// snapshot was taken.
///
/// # Errors
///
/// The snapshot could not be written, and then no file is left for it and
/// nothing is pruned; or the snapshots could not be listed for pruning.
pub async fn take_daily_snapshot(db_path: &Path, day: NaiveDate) -> Result<bool, AppError> {
    let name = format!("{}{}", name_prefix(db_path), day.format(DATE_FORMAT));
    let snapshot = db_path.with_file_name(name);
    if snapshot.try_exists()? {
        return Ok(false);
    }
    // `VACUUM INTO` refuses an existing file, and a crash part way must not
    // leave half a database under the day's name: write beside it, flush,
    // then rename.
    let partial = snapshot.with_added_extension("partial");
    // One left by a crash; if it cannot go, the snapshot below fails on it.
    let _ = std::fs::remove_file(&partial);
    let written = async {
        snapshot_vault(db_path, &partial).await?;
        // Windows flushes only through a handle opened for writing.
        std::fs::File::options()
            .write(true)
            .open(&partial)?
            .sync_all()?;
        std::fs::rename(&partial, &snapshot)?;
        Ok::<_, AppError>(())
    }
    .await;
    if let Err(e) = written {
        // Half a copy only takes room on a disk that may be full.
        let _ = std::fs::remove_file(&partial);
        return Err(e);
    }

    let snapshots = daily_snapshots(db_path)?;
    let excess = snapshots.len().saturating_sub(MAX_KEPT_DAILY_SNAPSHOTS);
    for (_, old) in snapshots.into_iter().take(excess) {
        if let Err(e) = std::fs::remove_file(&old) {
            tracing::warn!(error = %e, snapshot = %old.display(), "could not delete an old daily snapshot");
        }
    }
    Ok(true)
}

/// The maintenance job's body: today's snapshot, if the day has none yet,
/// tried once per local day per run of the app (`last_attempt_day`, a
/// `num_days_from_ce`). A copy that fails for lack of room has filled the disk
/// while it ran, so it is not tried again every tick; the failure is logged
/// and the next day or the next launch tries again.
pub async fn daily_snapshot_tick(db_path: &Path, last_attempt_day: &AtomicI32) {
    let today = chrono::Local::now().date_naive();
    let day_number = today.num_days_from_ce();
    if last_attempt_day.swap(day_number, Ordering::Relaxed) == day_number {
        return;
    }
    match take_daily_snapshot(db_path, today).await {
        Ok(true) => tracing::info!(day = %today, "daily vault snapshot taken"),
        Ok(false) => {}
        Err(e) => tracing::error!(error = %e, "daily vault snapshot failed"),
    }
}

/// When the newest daily snapshot beside `db_path` was written, in Unix
/// milliseconds; `None` when there is none.
///
/// # Errors
///
/// The vault's folder or the snapshot's metadata could not be read.
pub fn last_daily_snapshot_ms(db_path: &Path) -> Result<Option<i64>, AppError> {
    let Some((_, newest)) = daily_snapshots(db_path)?.pop() else {
        return Ok(None);
    };
    let written = std::fs::metadata(newest)?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    Ok(Some(i64::try_from(written.as_millis()).unwrap_or(i64::MAX)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::TempDir;

    fn day(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 3, d).unwrap()
    }

    /// A migrated vault whose `app_settings` holds one marker row.
    async fn vault() -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("notes.db");
        let pool = init_pool(&db_path).await.unwrap();
        sqlx::query(
            "INSERT INTO app_settings (key, value, updated_at) VALUES ('snapshot-test', 'marker', 0)",
        )
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        (dir, db_path)
    }

    fn sibling_names(db_path: &Path, infix: &str) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(db_path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.contains(infix))
            .collect();
        names.sort();
        names
    }

    async fn marker_in(path: &Path) -> String {
        use sqlx::ConnectOptions;
        let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .connect()
            .await
            .unwrap();
        sqlx::query_scalar("SELECT value FROM app_settings WHERE key = 'snapshot-test'")
            .fetch_one(&mut conn)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn the_first_run_of_a_day_snapshots_the_vault_and_a_second_takes_none() {
        let (dir, db_path) = vault().await;

        assert!(take_daily_snapshot(&db_path, day(1)).await.unwrap());
        assert_eq!(
            sibling_names(&db_path, ".daily-"),
            ["notes.db.daily-2026-03-01"]
        );
        assert_eq!(
            marker_in(&dir.path().join("notes.db.daily-2026-03-01")).await,
            "marker"
        );

        assert!(!take_daily_snapshot(&db_path, day(1)).await.unwrap());
        assert_eq!(
            sibling_names(&db_path, ".daily-"),
            ["notes.db.daily-2026-03-01"]
        );
    }

    #[tokio::test]
    async fn the_next_day_takes_another_snapshot() {
        let (_dir, db_path) = vault().await;
        assert!(take_daily_snapshot(&db_path, day(1)).await.unwrap());
        assert!(take_daily_snapshot(&db_path, day(2)).await.unwrap());
        assert_eq!(
            sibling_names(&db_path, ".daily-"),
            ["notes.db.daily-2026-03-01", "notes.db.daily-2026-03-02"]
        );
    }

    #[tokio::test]
    async fn pruning_keeps_the_newest_snapshots_and_every_other_backup() {
        let (dir, db_path) = vault().await;
        let others = [
            "notes.db.pre-migration-100",
            "notes.db.pre-migration-200",
            "notes.db.pre-migration-300",
            "notes.db.pre-migration-400",
            "notes.db.daily-notes",
        ];
        for name in others {
            std::fs::write(dir.path().join(name), b"kept").unwrap();
        }
        for d in 1..=9 {
            take_daily_snapshot(&db_path, day(d)).await.unwrap();
        }

        let mut expected: Vec<String> = (3..=9)
            .map(|d| format!("notes.db.daily-2026-03-{d:02}"))
            .collect();
        assert_eq!(expected.len(), MAX_KEPT_DAILY_SNAPSHOTS);
        expected.push("notes.db.daily-notes".into());
        assert_eq!(sibling_names(&db_path, ".daily-"), expected);
        assert_eq!(sibling_names(&db_path, ".pre-migration-"), others[..4]);
    }

    #[tokio::test]
    async fn a_partial_file_left_by_a_crash_is_replaced() {
        let (dir, db_path) = vault().await;
        let partial = dir.path().join("notes.db.daily-2026-03-01.partial");
        std::fs::write(&partial, b"half a database").unwrap();

        assert!(take_daily_snapshot(&db_path, day(1)).await.unwrap());
        assert_eq!(
            sibling_names(&db_path, ".daily-"),
            ["notes.db.daily-2026-03-01"]
        );
        assert_eq!(
            marker_in(&dir.path().join("notes.db.daily-2026-03-01")).await,
            "marker"
        );
    }

    /// The copy fails part way: the last pages of a vault larger than
    /// SQLite's page cache are garbage, so the copy is already on disk when
    /// it reaches them.
    #[tokio::test]
    async fn a_snapshot_that_fails_part_way_leaves_no_file() {
        let (_dir, db_path) = vault().await;
        let pool = init_pool(&db_path).await.unwrap();
        sqlx::query(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4000) \
             INSERT INTO app_settings (key, value, updated_at) \
             SELECT 'filler-' || i, hex(randomblob(2000)), 0 FROM n",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let mut bytes = std::fs::read(&db_path).unwrap();
        let tail = bytes.len() - 16 * 4096;
        bytes[tail..].fill(0xFF);
        std::fs::write(&db_path, bytes).unwrap();

        assert!(take_daily_snapshot(&db_path, day(1)).await.is_err());
        assert_eq!(sibling_names(&db_path, ".daily-"), [""; 0]);
    }

    /// The snapshot cannot be written: a directory sits where it would be.
    #[tokio::test]
    async fn a_failed_snapshot_is_logged_by_the_tick_and_not_tried_again_that_day() {
        let (dir, db_path) = vault().await;
        let today = chrono::Local::now().date_naive();
        let blocked = |day: NaiveDate| {
            dir.path().join(format!(
                "notes.db.daily-{}.partial",
                day.format(DATE_FORMAT)
            ))
        };
        std::fs::create_dir(blocked(day(1))).unwrap();
        std::fs::create_dir(blocked(today)).unwrap();
        assert!(take_daily_snapshot(&db_path, day(1)).await.is_err());

        let this_launch = AtomicI32::new(0);
        daily_snapshot_tick(&db_path, &this_launch).await;
        assert_eq!(last_daily_snapshot_ms(&db_path).unwrap(), None);

        // The way is clear again, but the day's one attempt is spent.
        std::fs::remove_dir(blocked(today)).unwrap();
        daily_snapshot_tick(&db_path, &this_launch).await;
        assert_eq!(last_daily_snapshot_ms(&db_path).unwrap(), None);

        let next_launch = AtomicI32::new(0);
        daily_snapshot_tick(&db_path, &next_launch).await;
        assert!(last_daily_snapshot_ms(&db_path).unwrap().is_some());
    }

    #[tokio::test]
    async fn the_last_snapshot_time_is_the_newest_snapshots() {
        let (dir, db_path) = vault().await;
        assert_eq!(last_daily_snapshot_ms(&db_path).unwrap(), None);

        take_daily_snapshot(&db_path, day(1)).await.unwrap();
        take_daily_snapshot(&db_path, day(2)).await.unwrap();
        let at = |ms: u64| std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms);
        for (name, ms) in [
            ("notes.db.daily-2026-03-01", 9_000),
            ("notes.db.daily-2026-03-02", 5_000),
        ] {
            let file = std::fs::File::options()
                .write(true)
                .open(dir.path().join(name))
                .unwrap();
            file.set_modified(at(ms)).unwrap();
        }

        assert_eq!(last_daily_snapshot_ms(&db_path).unwrap(), Some(5_000));
    }
}
