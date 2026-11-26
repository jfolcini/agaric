//! The durability barrier (#6524): make every commit so far survive a power cut.
//!
//! The pools commit under `synchronous = NORMAL`
//! ([`base_connect_options`](super::base_connect_options)), which in WAL mode
//! writes a commit to the `-wal` file and does not sync it, so a power cut
//! rolls back the commits made since the last checkpoint. For an edit only this
//! device holds that loses the edit. Once a peer holds it, it is a fork: the
//! device comes back behind what the peer has of it and reuses those Loro
//! counters and op-log seqs. So sync calls [`make_commits_durable`] once per
//! outgoing stream, after reading what it will send and before sending any.
//!
//! ## Why a commit under `synchronous = FULL`
//!
//! SQLite syncs the WAL file when a transaction that wrote a frame commits
//! under `synchronous = FULL` (`sqlite3WalFrames`: "Padding and syncing only
//! occur if this set of frames complete a transaction and if PRAGMA
//! synchronous=FULL"). A sync is of the whole file, and the file holds every
//! commit the database file does not: a checkpoint syncs the WAL before it
//! copies a frame out and the database file once it has copied them all, and
//! the WAL is only written from its start again after that.
//!
//! The other candidates do not give the guarantee:
//!
//! * A checkpoint syncs the WAL only when it has a frame it may copy and takes
//!   read lock 0 (`walCheckpoint`), so a reader on an older snapshot makes
//!   `PRAGMA wal_checkpoint(PASSIVE)` return having synced nothing. The other
//!   modes wait for those readers while holding the write lock.
//! * An `fsync` of the `-wal` file from outside SQLite skips the sync of the
//!   directory entry that SQLite's own sync does for a WAL it has just created.
//!
//! ## What is not tested
//!
//! Whether the bytes reached the disk: only a power cut shows that. The tests
//! pin what SQLite is asked for (the barrier's connection settings, and that
//! each barrier commits a change) and, at each call site, that a failed barrier
//! sends nothing.

use sqlx::sqlite::{SqliteConnectOptions, SqliteSynchronous};
use sqlx::{ConnectOptions, Connection, SqlitePool};

/// The `app_settings` row each barrier's commit changes. Its value counts them.
pub(crate) const DURABLE_BARRIERS_KEY: &str = "sync.durable_barriers";

/// `pool`'s connection settings, with commits that sync.
fn barrier_connect_options(pool: &SqlitePool) -> SqliteConnectOptions {
    pool.connect_options()
        .as_ref()
        .clone()
        .synchronous(SqliteSynchronous::Full)
        // macOS: `fsync` leaves the data in the drive's write cache, and SQLite
        // asks for `F_FULLFSYNC` only under this pragma. No effect elsewhere.
        .pragma("fullfsync", "ON")
}

/// Make every transaction committed to `pool`'s database so far durable.
///
/// It takes a connection of its own, so the pool's keep committing under
/// `NORMAL`. After an error they may not be durable: the caller sends nothing.
pub async fn make_commits_durable(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    // A writer outside the queue takes the write lock from the writers in it.
    // Waiting for the turn also waits out a transaction that was open while the
    // caller read the engine, so that transaction's commit is among those synced.
    let _turn = super::write_turns(pool).lock_owned().await;
    let mut conn = barrier_connect_options(pool).connect().await?;
    let now = super::now_ms();
    // A commit that changed no page writes no frame, and so syncs nothing.
    sqlx::query!(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, '1', ?2) \
         ON CONFLICT (key) DO UPDATE SET \
             value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), \
             updated_at = excluded.updated_at",
        DURABLE_BARRIERS_KEY,
        now,
    )
    .execute(&mut conn)
    .await?;
    conn.close().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{break_durability_barrier, durable_barriers, test_pool};

    async fn pragma(conn: &mut sqlx::SqliteConnection, read: &'static str) -> i64 {
        sqlx::query_scalar(read)
            .fetch_one(conn)
            .await
            .expect("read the pragma")
    }

    #[tokio::test]
    async fn the_barrier_connection_syncs_its_commits_and_the_pool_does_not() {
        let (pool, _dir) = test_pool().await;

        let mut barrier = barrier_connect_options(&pool)
            .connect()
            .await
            .expect("open a barrier connection");
        assert_eq!(
            pragma(&mut barrier, "PRAGMA synchronous").await,
            2,
            "the barrier commits under synchronous = FULL, which syncs the WAL"
        );
        assert_eq!(
            pragma(&mut barrier, "PRAGMA fullfsync").await,
            1,
            "the barrier's sync is F_FULLFSYNC where the platform has one"
        );

        make_commits_durable(&pool).await.expect("run a barrier");
        let mut pooled = pool.acquire().await.expect("a pool connection");
        assert_eq!(
            pragma(&mut pooled, "PRAGMA synchronous").await,
            1,
            "local writes stay under synchronous = NORMAL after a barrier ran"
        );
    }

    #[tokio::test]
    async fn each_barrier_commits_a_change() {
        let (pool, _dir) = test_pool().await;
        assert_eq!(durable_barriers(&pool).await, 0, "no barrier has run yet");

        make_commits_durable(&pool)
            .await
            .expect("the first barrier");
        assert_eq!(
            durable_barriers(&pool).await,
            1,
            "the first barrier's commit inserted the row"
        );

        make_commits_durable(&pool)
            .await
            .expect("the second barrier");
        assert_eq!(
            durable_barriers(&pool).await,
            2,
            "a later barrier's commit changes the row, so it has a frame to sync"
        );
    }

    #[tokio::test]
    async fn a_barrier_that_cannot_commit_is_an_error() {
        let (pool, _dir) = test_pool().await;
        break_durability_barrier(&pool).await;

        let outcome = make_commits_durable(&pool).await;

        assert!(
            outcome.is_err(),
            "a barrier whose commit failed must not report durability: {outcome:?}"
        );
        assert_eq!(
            durable_barriers(&pool).await,
            0,
            "the failed barrier committed nothing"
        );
    }
}
