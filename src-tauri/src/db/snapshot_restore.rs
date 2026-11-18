//! Restore the vault from a daily snapshot at the next launch (#6744).
//!
//! Settings › Data's *Restore…* calls [`request_restore`], which leaves a
//! marker beside the database naming the snapshot. Boot calls
//! [`restore_pending`] before anything opens the database, so the pool, the
//! engines and the materializer only ever see one vault.
//!
//! The copy that takes the vault's place differs from the snapshot by what
//! one transaction writes into it first:
//!
//! - A new Loro peer-id epoch (`agaric_engine::loro::peer_epoch`). A paired
//!   device holds ops this device made after the snapshot was taken. Under
//!   the old PeerID the restored engines would mint new ops at those
//!   counters, and the edits the snapshot lacks would be lost with no error
//!   (#6524). Under a new PeerID the old one is one more peer, whose later
//!   ops the paired device gives back.
//! - The replaced vault's op-log high-water marks and each device's last
//!   `seq`, so the `seq` allocator never mints again an address a paired
//!   device holds. A vault that cannot be read carries none, and is still
//!   replaced.
//! - The Markdown mirror's `RESTORED_KEY`, which pauses it, and its reading
//!   back turned off: the folder's files may now be newer than the notes, and
//!   read back, each page made since the snapshot would be made again beside
//!   the one a paired device gives back.
//!
//! The mirror's states go too: to them, the file of a page made since the
//! snapshot is one to remove.
//!
//! The replaced vault stays beside the database as `<db>.pre-restore-<ts>`,
//! with its `-wal` and `-shm`, and the attachment files only it refers to
//! move to `<db>.pre-restore-<ts>.attachments/`, out of the way of the
//! cleanup of unreferenced attachment files. [`prune_replaced_vaults`]
//! deletes both `KEPT_FOR` after the restore.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use agaric_core::error::AppError;
use agaric_engine::loro::peer_epoch::PEER_EPOCH_KEY;
use agaric_store::op_log::{HIGH_WATER_KEY_PREFIX, record_high_water};
use chrono::NaiveDate;
use rand::RngExt;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use sqlx::{ConnectOptions, Connection, SqliteConnection};

use super::daily_snapshot::snapshot_file;
use crate::mirror::store::{READ_BACK_KEY, RESTORED_KEY, forget_everything, write_atomic};

/// How long a replaced vault and its attachment files are kept.
const KEPT_FOR: Duration = Duration::from_secs(30 * 24 * 3600);

/// What follows the database's file name in a replaced vault's, before the
/// Unix second its restore was asked for.
const KEPT_INFIX: &str = ".pre-restore-";

/// What follows a replaced vault's file name in the name of the folder
/// holding its attachment files.
const KEPT_ATTACHMENTS: &str = ".attachments";

/// `path` with `suffix` added to its file name.
fn beside(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// The marker a pending restore leaves: `<day> <ts>`, the snapshot's day and
/// the Unix second the restore was asked for, which names the kept vault.
fn marker_file(db_path: &Path) -> PathBuf {
    beside(db_path, ".restore-pending")
}

/// Ask for the vault at `db_path` to be replaced by `day`'s snapshot at the
/// next launch.
///
/// # Errors
///
/// [`AppError::NotFound`] when the day has no snapshot; the marker cannot be
/// written.
pub fn request_restore(db_path: &Path, day: NaiveDate) -> Result<(), AppError> {
    if !snapshot_file(db_path, day).try_exists()? {
        return Err(AppError::NotFound(format!("the daily snapshot of {day}")));
    }
    let asked_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    write_atomic(
        &marker_file(db_path),
        format!("{day} {asked_at}\n").as_bytes(),
    )?;
    Ok(())
}

/// The pending restore's snapshot day and timestamp, `None` when none is
/// pending. A marker that does not read is removed.
fn pending(marker: &Path) -> Option<(NaiveDate, u64)> {
    let text = match std::fs::read_to_string(marker) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        read => read,
    };
    let parsed = text.as_deref().ok().and_then(|text| {
        let (day, asked_at) = text.trim().split_once(' ')?;
        Some((day.parse().ok()?, asked_at.parse().ok()?))
    });
    if parsed.is_none() {
        tracing::error!(marker = ?text, "a pending restore's marker does not read; the vault is unchanged");
        remove_marker(marker);
    }
    parsed
}

/// One left in place is read again at every boot.
fn remove_marker(marker: &Path) {
    if let Err(e) = std::fs::remove_file(marker) {
        tracing::warn!(error = %e, "could not remove the pending restore's marker");
    }
}

/// Remove the database at `path` with whatever SQLite left beside it.
fn remove_database(path: &Path) {
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let _ = std::fs::remove_file(beside(path, suffix));
    }
}

fn rename_if_any(from: &Path, to: &Path) -> std::io::Result<()> {
    match std::fs::rename(from, to) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Replace the vault at `db_path` with the snapshot a pending restore names;
/// nothing when none is pending. Boot runs it before anything opens the
/// database.
///
/// A crash at any step leaves the old vault or the restored one under the
/// database's name, and the next boot finishes: the copy is complete beside
/// the vault before the vault moves, the vault's `-wal` moves with it so it
/// is never replayed into the copy, and the marker goes last. The kept
/// vault's name comes from the marker, so that boot finds what this one
/// moved; a kept vault with no copy left means the swap was done, and what
/// follows it is done again, each step skipping what is already done. A
/// restore that fails before the vault has moved is given up: logged, its
/// marker removed, the vault unchanged.
///
/// # Errors
///
/// The vault has moved and the copy could not take its place, or the
/// mirror's states could not be dropped. Boot must stop there: opening the
/// database would create an empty vault, and the mirror would remove files
/// by those states. The next launch tries again.
pub async fn restore_pending(db_path: &Path) -> Result<(), AppError> {
    let marker = marker_file(db_path);
    let Some((day, asked_at)) = pending(&marker) else {
        return Ok(());
    };
    let kept = beside(db_path, &format!("{KEPT_INFIX}{asked_at}"));
    let copy = beside(db_path, ".restoring");
    if !kept.try_exists()? {
        let started = match prepare(db_path, &snapshot_file(db_path, day), &copy).await {
            Ok(()) => rename_if_any(db_path, &kept).map_err(AppError::from),
            failed => failed,
        };
        if let Err(e) = started {
            tracing::error!(error = %e, %day, "the daily snapshot could not be restored; the vault is unchanged");
            remove_database(&copy);
            remove_marker(&marker);
            return Ok(());
        }
    }
    if copy.try_exists()? {
        for suffix in ["-wal", "-shm"] {
            rename_if_any(&beside(db_path, suffix), &beside(&kept, suffix))?;
        }
        std::fs::rename(&copy, db_path)?;
    }
    set_aside_attachments(db_path, &kept).await;
    if let Some(app_data_dir) = db_path.parent() {
        forget_everything(app_data_dir)?;
    }
    remove_marker(&marker);
    tracing::warn!(%day, kept = %kept.display(), "the vault was restored from its daily snapshot");
    Ok(())
}

/// Copy `snapshot` to `copy` and write into it what a restored vault needs
/// (module docs).
async fn prepare(db_path: &Path, snapshot: &Path, copy: &Path) -> Result<(), AppError> {
    // One an interrupted restore left.
    remove_database(copy);
    std::fs::copy(snapshot, copy)?;
    let marks = live_marks(db_path).await.unwrap_or_else(|e| {
        tracing::warn!(error = %e, "the vault being replaced cannot be read; its op-log marks are not carried");
        Vec::new()
    });
    // A rollback journal: once committed the transaction is in the one file,
    // with no `-wal` to move along with it.
    let mut conn = SqliteConnectOptions::new()
        .filename(copy)
        .journal_mode(SqliteJournalMode::Delete)
        .connect()
        .await?;
    let written = write_restore_state(&mut conn, &marks).await;
    conn.close().await?;
    written
}

async fn open_read_only(db_path: &Path) -> Result<SqliteConnection, AppError> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .read_only(true);
    Ok(options.connect().await?)
}

/// Each device's last op `seq` and its recorded high-water mark in the vault
/// at `db_path`.
async fn live_marks(db_path: &Path) -> Result<Vec<(String, i64)>, AppError> {
    let mut conn = open_read_only(db_path).await?;
    let marks = sqlx::query!(
        r#"SELECT device_id AS "device_id!: String", MAX(seq) AS "seq!: i64"
             FROM op_log GROUP BY device_id
           UNION ALL
           SELECT substr(key, length(?1) + 1), CAST(value AS INTEGER)
             FROM app_settings WHERE substr(key, 1, length(?1)) = ?1"#,
        HIGH_WATER_KEY_PREFIX,
    )
    .fetch_all(&mut conn)
    .await;
    let _ = conn.close().await;
    Ok(marks?
        .into_iter()
        .map(|row| (row.device_id, row.seq))
        .collect())
}

async fn write_restore_state(
    conn: &mut SqliteConnection,
    marks: &[(String, i64)],
) -> Result<(), AppError> {
    let mut tx = conn.begin().await?;
    // It salts the PeerID, so all it has to be is one this device never used.
    let epoch = rand::rng().random_range(1..=u64::MAX).to_string();
    let now = super::now_ms();
    for (key, value) in [
        (PEER_EPOCH_KEY, epoch.as_str()),
        (RESTORED_KEY, "true"),
        (READ_BACK_KEY, "false"),
    ] {
        sqlx::query!(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            key,
            value,
            now,
        )
        .execute(&mut *tx)
        .await?;
    }
    for (device_id, seq) in marks {
        record_high_water(&mut tx, device_id, *seq).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Every attachment's file in the vault at `db_path`, as a path below the
/// data folder.
async fn attachment_paths(db_path: &Path) -> Result<HashSet<String>, AppError> {
    let mut conn = open_read_only(db_path).await?;
    let paths = sqlx::query_scalar!(r#"SELECT fs_path as "fs_path!: String" FROM attachments"#)
        .fetch_all(&mut conn)
        .await;
    let _ = conn.close().await;
    Ok(paths?.into_iter().collect())
}

/// The attachment files the vault at `kept` refers to and the restored one
/// at `db_path` does not.
async fn only_in_replaced(db_path: &Path, kept: &Path) -> Result<Vec<String>, AppError> {
    let restored = attachment_paths(db_path).await?;
    let replaced = attachment_paths(kept).await?;
    Ok(replaced.difference(&restored).cloned().collect())
}

/// Move the attachment files only the replaced vault refers to into the
/// folder beside it, at their paths below the data folder: no row refers to
/// them now, so the cleanup of unreferenced attachment files would delete
/// them. A file already moved is skipped. A vault that cannot be read or a
/// file that cannot be moved is logged, and the restore goes on.
async fn set_aside_attachments(db_path: &Path, kept: &Path) {
    let Some(data_dir) = db_path.parent() else {
        return;
    };
    let paths = only_in_replaced(db_path, kept).await.unwrap_or_else(|e| {
        tracing::warn!(error = %e, "the replaced vault's attachments cannot be listed; none is set aside");
        Vec::new()
    });
    let aside = beside(kept, KEPT_ATTACHMENTS);
    for path in paths {
        let to = aside.join(&path);
        let moved = to
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| rename_if_any(&data_dir.join(&path), &to));
        if let Err(e) = moved {
            tracing::warn!(error = %e, %path, "an attachment file of the replaced vault could not be set aside");
        }
    }
}

/// Delete each vault a restore replaced `KEPT_FOR` or longer before `now`
/// (Unix seconds), with its `-wal`, its `-shm` and its attachment files. Its
/// age is read from its name: a file's modified time is when the vault was
/// last written, not when it was replaced.
///
/// # Errors
///
/// The vault's folder cannot be read, or one of them cannot be deleted.
pub fn prune_replaced_vaults(db_path: &Path, now: u64) -> std::io::Result<()> {
    let Some((dir, db_name)) = db_path.parent().zip(db_path.file_name()) else {
        return Ok(());
    };
    let prefix = format!("{}{KEPT_INFIX}", db_name.to_string_lossy());
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(rest) = name.to_str().and_then(|name| name.strip_prefix(&prefix)) else {
            continue;
        };
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        let Some((asked_at, suffix)) = rest.split_at_checked(digits) else {
            continue;
        };
        let Ok(asked_at) = asked_at.parse::<u64>() else {
            continue;
        };
        if now.saturating_sub(asked_at) < KEPT_FOR.as_secs() {
            continue;
        }
        match suffix {
            "" | "-wal" | "-shm" => std::fs::remove_file(entry.path())?,
            KEPT_ATTACHMENTS => std::fs::remove_dir_all(entry.path())?,
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::tests::common::{
        DEV, TEST_SPACE_ID, ensure_test_space, mark_block_as_space, settle,
    };
    use crate::commands::{
        add_attachment_with_bytes_inner, create_block_inner, create_page_in_space_inner,
        edit_block_inner,
    };
    use crate::db::daily_snapshot::take_daily_snapshot;
    use crate::db::init_pool;
    use crate::materializer::Materializer;
    use agaric_core::ulid::BlockId;
    use agaric_engine::loro::peer_epoch::load_peer_epoch;
    use agaric_engine::loro::snapshot::rehydrate_registry;
    use agaric_store::op_log::{high_water_key, read_high_water};
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    const DAY: &str = "2026-03-01";

    fn day() -> NaiveDate {
        DAY.parse().unwrap()
    }

    async fn set(pool: &SqlitePool, key: &str, value: &str) {
        sqlx::query(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, 0)",
        )
        .bind(key)
        .bind(value)
        .execute(pool)
        .await
        .unwrap();
    }

    /// The setting `key` in the database file at `path`, opened read-only.
    async fn setting_in(path: &Path, key: &str) -> Option<String> {
        let mut conn = SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .connect()
            .await
            .unwrap();
        let value = sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?")
            .bind(key)
            .fetch_optional(&mut conn)
            .await
            .unwrap();
        conn.close().await.unwrap();
        value
    }

    /// A migrated vault whose `note` setting reads `in the snapshot`, its
    /// snapshot for [`day`], and then the vault's `note` set to `newer`.
    async fn vault_with_snapshot() -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("notes.db");
        let pool = init_pool(&db_path).await.unwrap();
        set(&pool, "note", "in the snapshot").await;
        pool.close().await;
        assert!(take_daily_snapshot(&db_path, day()).await.unwrap());
        let pool = init_pool(&db_path).await.unwrap();
        set(&pool, "note", "newer").await;
        pool.close().await;
        (dir, db_path)
    }

    /// The vaults kept beside `db_path` by a restore, each without what a
    /// restore keeps with it.
    fn kept_vaults(db_path: &Path) -> Vec<String> {
        let mut kept = siblings(db_path, KEPT_INFIX);
        kept.retain(|name| {
            !["-wal", "-shm", KEPT_ATTACHMENTS]
                .iter()
                .any(|with| name.ends_with(with))
        });
        kept
    }

    /// The marker and the unfinished copy beside `db_path`, whichever is there.
    fn left_over(db_path: &Path) -> Vec<String> {
        let mut names = siblings(db_path, ".restore-pending");
        names.extend(siblings(db_path, ".restoring"));
        names
    }

    fn siblings(db_path: &Path, infix: &str) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(db_path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.contains(infix))
            .collect();
        names.sort();
        names
    }

    async fn block_content(pool: &SqlitePool, id: &str) -> Option<String> {
        sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await
            .unwrap()
    }

    async fn new_block(pool: &SqlitePool, mat: &Materializer, page: &str, text: &str) -> String {
        let parent = Some(BlockId::from_trusted(page));
        create_block_inner(pool, DEV, mat, "content".into(), text.into(), parent, None)
            .await
            .unwrap()
            .id
            .into_string()
    }

    /// A launch on the vault at `db_path`: its pool, and a materializer whose
    /// engines are loaded under the vault's epoch, as boot loads them.
    async fn launch(db_path: &Path) -> (SqlitePool, Materializer) {
        let pool = init_pool(db_path).await.unwrap();
        let mat = Materializer::new(pool.clone());
        let registry = &mat.loro_state().registry;
        registry.set_peer_epoch(load_peer_epoch(&pool).await.unwrap());
        rehydrate_registry(&pool, registry, DEV).await.unwrap();
        (pool, mat)
    }

    async fn own_head(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT MAX(seq) FROM op_log WHERE device_id = ?")
            .bind(DEV)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_pending_restore_swaps_in_the_snapshot_under_a_new_epoch_with_the_vaults_marks() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("notes.db");

        let (pool, mat) = launch(&db_path).await;
        ensure_test_space(&pool).await;
        mark_block_as_space(&pool, TEST_SPACE_ID).await;
        let page =
            create_page_in_space_inner(&pool, DEV, &mat, None, "Kept".into(), TEST_SPACE_ID.into())
                .await
                .unwrap()
                .into_string();
        let edited = new_block(&pool, &mat, &page, "in the snapshot").await;
        set(&pool, PEER_EPOCH_KEY, "7").await;
        set(&pool, &high_water_key("PEER"), "40").await;
        set(&pool, &high_water_key("ONLY-THE-SNAPSHOT-IS-HIGHER"), "90").await;
        settle(&mat).await;
        pool.close().await;
        assert!(take_daily_snapshot(&db_path, day()).await.unwrap());

        let (pool, mat) = launch(&db_path).await;
        let block = BlockId::from_trusted(&edited);
        edit_block_inner(&pool, DEV, &mat, block.clone(), "after the snapshot".into())
            .await
            .unwrap();
        let lost = new_block(&pool, &mat, &page, "made after the snapshot").await;
        set(&pool, &high_water_key("PEER"), "55").await;
        set(&pool, &high_water_key("ONLY-THE-SNAPSHOT-IS-HIGHER"), "10").await;
        let live_head = own_head(&pool).await;
        settle(&mat).await;
        pool.close().await;

        request_restore(&db_path, day()).unwrap();
        restore_pending(&db_path).await.unwrap();

        assert_eq!(left_over(&db_path), [""; 0], "marker and copy gone");
        assert!(
            !beside(&db_path, "-wal").exists(),
            "no log of the old vault"
        );
        let kept = kept_vaults(&db_path);
        assert_eq!(kept.len(), 1, "the replaced vault is kept: {kept:?}");

        let (pool, mat) = launch(&db_path).await;
        assert_eq!(
            block_content(&pool, &edited).await.as_deref(),
            Some("in the snapshot"),
            "the vault holds the snapshot's text"
        );
        assert_eq!(
            block_content(&pool, &lost).await,
            None,
            "and no later block"
        );
        let epoch = load_peer_epoch(&pool).await.unwrap();
        assert_ne!(epoch, 0, "a restored vault never keeps the legacy PeerID");
        assert_ne!(epoch, 7, "nor the snapshot's");
        let mut conn = pool.acquire().await.unwrap();
        for (device, mark, why) in [
            (DEV, live_head, "its own last seq"),
            ("PEER", 55, "the replaced vault's mark"),
            ("ONLY-THE-SNAPSHOT-IS-HIGHER", 90, "a mark is never lowered"),
        ] {
            let carried = read_high_water(&mut conn, device).await.unwrap();
            assert_eq!(carried, Some(mark), "{why}");
        }
        drop(conn);
        edit_block_inner(&pool, DEV, &mat, block, "after the restore".into())
            .await
            .unwrap();
        assert_eq!(
            own_head(&pool).await,
            live_head + 1,
            "the next op takes no address the replaced vault issued"
        );
        settle(&mat).await;
        pool.close().await;

        let replaced = init_pool(&dir.path().join(&kept[0])).await.unwrap();
        assert_eq!(
            block_content(&replaced, &edited).await.as_deref(),
            Some("after the snapshot"),
            "the kept vault is the one replaced"
        );
    }

    #[tokio::test]
    async fn a_marker_naming_no_snapshot_that_opens_is_removed_and_the_vault_left_alone() {
        let (dir, db_path) = vault_with_snapshot().await;
        std::fs::write(dir.path().join("notes.db.daily-2026-03-02"), b"no database").unwrap();

        for marker in ["2026-03-03 100", "2026-03-02 200", "restore everything"] {
            std::fs::write(marker_file(&db_path), marker).unwrap();
            restore_pending(&db_path).await.unwrap();

            assert_eq!(left_over(&db_path), [""; 0], "after {marker:?}");
            assert_eq!(siblings(&db_path, ".pre-restore-"), [""; 0]);
            assert_eq!(
                setting_in(&db_path, "note").await.as_deref(),
                Some("newer"),
                "the vault is the one it was after {marker:?}"
            );
            assert_eq!(setting_in(&db_path, PEER_EPOCH_KEY).await, None);
        }
    }

    #[tokio::test]
    async fn a_vault_that_cannot_be_read_is_still_replaced_by_the_snapshot() {
        let (dir, db_path) = vault_with_snapshot().await;
        std::fs::write(&db_path, b"no database").unwrap();

        request_restore(&db_path, day()).unwrap();
        restore_pending(&db_path).await.unwrap();

        assert_eq!(
            setting_in(&db_path, "note").await.as_deref(),
            Some("in the snapshot")
        );
        let epoch = setting_in(&db_path, PEER_EPOCH_KEY).await.unwrap();
        assert_ne!(epoch.parse::<u64>().unwrap(), 0);
        let kept = kept_vaults(&db_path);
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert_eq!(
            std::fs::read(dir.path().join(&kept[0])).unwrap(),
            b"no database"
        );
        assert_eq!(left_over(&db_path), [""; 0]);
    }

    /// The state a crash leaves once the vault has moved and its `-wal` has
    /// not.
    #[tokio::test]
    async fn a_restore_interrupted_after_the_vault_moved_is_finished_at_the_next_boot() {
        let (_dir, db_path) = vault_with_snapshot().await;
        std::fs::write(marker_file(&db_path), format!("{DAY} 500")).unwrap();
        let kept = beside(&db_path, ".pre-restore-500");
        let copy = beside(&db_path, ".restoring");
        prepare(&db_path, &snapshot_file(&db_path, day()), &copy)
            .await
            .unwrap();
        let epoch = setting_in(&copy, PEER_EPOCH_KEY).await;
        std::fs::rename(&db_path, &kept).unwrap();
        std::fs::write(beside(&db_path, "-wal"), b"the old vault's log").unwrap();

        restore_pending(&db_path).await.unwrap();

        assert_eq!(
            std::fs::read(beside(&kept, "-wal")).unwrap(),
            b"the old vault's log",
            "the log goes with its vault"
        );
        assert!(!beside(&db_path, "-wal").exists());
        assert_eq!(left_over(&db_path), [""; 0]);
        assert_eq!(
            setting_in(&db_path, "note").await.as_deref(),
            Some("in the snapshot")
        );
        assert_eq!(
            setting_in(&db_path, PEER_EPOCH_KEY).await,
            epoch,
            "the copy made before the crash is the one put in place"
        );
        assert_eq!(setting_in(&kept, "note").await.as_deref(), Some("newer"));
    }

    #[tokio::test]
    async fn a_marker_left_after_the_swap_does_not_restore_again() {
        let (_dir, db_path) = vault_with_snapshot().await;
        request_restore(&db_path, day()).unwrap();
        let marker = std::fs::read_to_string(marker_file(&db_path)).unwrap();
        restore_pending(&db_path).await.unwrap();
        let epoch = setting_in(&db_path, PEER_EPOCH_KEY).await;
        assert!(epoch.is_some());
        let pool = init_pool(&db_path).await.unwrap();
        set(&pool, "note", "written after the restore").await;
        pool.close().await;

        std::fs::write(marker_file(&db_path), marker).unwrap();
        restore_pending(&db_path).await.unwrap();

        assert_eq!(left_over(&db_path), [""; 0]);
        assert_eq!(
            setting_in(&db_path, "note").await.as_deref(),
            Some("written after the restore")
        );
        assert_eq!(setting_in(&db_path, PEER_EPOCH_KEY).await, epoch);
        assert_eq!(kept_vaults(&db_path).len(), 1);
    }

    /// `name` attached to `block` with `bytes`; its file, as a path below
    /// the data folder.
    async fn attach(
        pool: &SqlitePool,
        mat: &Materializer,
        data_dir: &Path,
        block: &str,
        name: &str,
        bytes: &[u8],
    ) -> String {
        let block = BlockId::from_trusted(block);
        let png = "image/png".to_owned();
        add_attachment_with_bytes_inner(
            pool,
            DEV,
            mat,
            data_dir,
            block,
            name.into(),
            png,
            bytes.to_vec(),
        )
        .await
        .unwrap()
        .fs_path
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn attachment_files_only_the_replaced_vault_refers_to_move_beside_it() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("notes.db");
        let (pool, mat) = launch(&db_path).await;
        ensure_test_space(&pool).await;
        mark_block_as_space(&pool, TEST_SPACE_ID).await;
        let page =
            create_page_in_space_inner(&pool, DEV, &mat, None, "Kept".into(), TEST_SPACE_ID.into())
                .await
                .unwrap()
                .into_string();
        let block = new_block(&pool, &mat, &page, "holds both").await;
        let in_snapshot = attach(
            &pool,
            &mat,
            dir.path(),
            &block,
            "old.png",
            b"in the snapshot",
        )
        .await;
        settle(&mat).await;
        pool.close().await;
        assert!(take_daily_snapshot(&db_path, day()).await.unwrap());
        let (pool, mat) = launch(&db_path).await;
        let since = attach(
            &pool,
            &mat,
            dir.path(),
            &block,
            "new.png",
            b"attached since",
        )
        .await;
        settle(&mat).await;
        pool.close().await;
        assert_ne!(in_snapshot, since);

        request_restore(&db_path, day()).unwrap();
        let marker = std::fs::read(marker_file(&db_path)).unwrap();
        restore_pending(&db_path).await.unwrap();

        let [kept] = kept_vaults(&db_path).try_into().unwrap();
        let aside = dir.path().join(format!("{kept}{KEPT_ATTACHMENTS}"));
        let set_aside = || std::fs::read(aside.join(&since)).ok();
        assert_eq!(set_aside().as_deref(), Some(&b"attached since"[..]));
        assert!(!dir.path().join(&since).exists(), "moved, not copied");
        assert_eq!(
            std::fs::read(dir.path().join(&in_snapshot)).unwrap(),
            b"in the snapshot",
            "a file the restored vault refers to stays"
        );
        assert!(!aside.join(&in_snapshot).exists());

        // A crash after the swap and before the move: the next boot moves it.
        std::fs::rename(aside.join(&since), dir.path().join(&since)).unwrap();
        std::fs::write(marker_file(&db_path), marker).unwrap();
        restore_pending(&db_path).await.unwrap();
        assert_eq!(set_aside().as_deref(), Some(&b"attached since"[..]));
        assert_eq!(left_over(&db_path), [""; 0]);
    }

    /// Every file here is written now: only the time in a name tells the
    /// replaced vaults apart.
    #[test]
    fn a_replaced_vault_and_its_attachments_are_deleted_thirty_days_after_the_restore() {
        const DAY_SECS: u64 = 24 * 3600;
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("notes.db");
        let others = [
            "notes.db",
            "notes.db.daily-2026-03-01",
            "notes.db.pre-restore-notes",
        ];
        let older = [
            "notes.db.pre-restore-1000",
            "notes.db.pre-restore-1000-shm",
            "notes.db.pre-restore-1000-wal",
            "notes.db.pre-restore-1000.attachments",
        ];
        let newer = [
            "notes.db.pre-restore-1001",
            "notes.db.pre-restore-1001.attachments",
        ];
        for name in others.iter().chain(&older).chain(&newer) {
            if name.ends_with(KEPT_ATTACHMENTS) {
                let inner = dir.path().join(name).join("attachments");
                std::fs::create_dir_all(&inner).unwrap();
                std::fs::write(inner.join("cat.png"), b"kept").unwrap();
            } else {
                std::fs::write(dir.path().join(name), b"kept").unwrap();
            }
        }
        let all = siblings(&db_path, "");

        prune_replaced_vaults(&db_path, 1000 + 30 * DAY_SECS - 1).unwrap();
        assert_eq!(siblings(&db_path, ""), all, "a second short of thirty days");

        prune_replaced_vaults(&db_path, 1000 + 30 * DAY_SECS).unwrap();
        let mut left: Vec<&str> = others.iter().chain(&newer).copied().collect();
        left.sort_unstable();
        assert_eq!(siblings(&db_path, ""), left);
    }
}
