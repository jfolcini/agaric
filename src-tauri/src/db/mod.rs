mod command_tx;
mod pool;
mod recovery;

pub use command_tx::*;
pub use pool::*;
// Recovery helpers are crate-internal. Non-test callers reach them via their
// module path (`super::recovery::…` inside `db`); this glob exists only so the
// `mod tests` block below — which uses `super::*` per repo convention — keeps
// seeing them unqualified.
#[cfg(test)]
pub(crate) use recovery::*;

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::{Row, Sqlite, SqlitePool};
    use std::path::Path;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    async fn test_pools() -> (DbPools, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pools = init_pools(&db_path).await.unwrap();
        (pools, dir)
    }

    /// #534 / migration 0088: the reserved property keys
    /// (`todo_state` / `priority` / `due_date` / `scheduled_date` / `space`)
    /// are column-backed on `blocks` (the single source of truth). A direct
    /// INSERT of such a key into `block_properties` must be rejected by the
    /// migration-0088 `key_not_reserved` CHECK constraint, proving the guard
    /// fires even when a caller bypasses the projection routing.
    #[tokio::test]
    async fn block_properties_rejects_reserved_key_534() {
        let (pool, _dir) = test_pool().await;

        // A normal block to own the (would-be) property row.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('GUARD1','content','guarded',NULL,1,'GUARD1')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Each column-backed key must be rejected by the guard. #589:
        // iterate the single source of truth so a key added to the constant
        // without a matching CHECK migration fails this test.
        for key in crate::op::COLUMN_BACKED_PROPERTY_KEYS {
            let res = sqlx::query(
                "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)",
            )
            .bind("GUARD1")
            .bind(key)
            .bind("X")
            .execute(&pool)
            .await;
            assert!(
                res.is_err(),
                "INSERT of reserved key '{key}' into block_properties must be aborted by the \
                 migration-0088 guard (it is column-backed on blocks)"
            );
        }

        // Sanity: a non-reserved key still inserts fine, so the trigger is
        // narrowly scoped to the reserved set and not blocking everything.
        sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
            .bind("GUARD1")
            .bind("effort")
            .bind("high")
            .execute(&pool)
            .await
            .expect("a non-reserved key must still be allowed in block_properties");
    }

    /// #589 drift guard — the key list inside the migration-0088
    /// `key_not_reserved` CHECK on `block_properties` must be EXACTLY
    /// `op::COLUMN_BACKED_PROPERTY_KEYS` (both directions). Extracts the
    /// `key NOT IN (...)` list from the live schema in `sqlite_master`
    /// and compares it as a set against the single source of truth in
    /// `op.rs`. Fails if a key is added to either side without the other.
    #[tokio::test]
    async fn reserved_key_set_matches_db_check_constraint_589() {
        use std::collections::BTreeSet;

        let (pool, _dir) = test_pool().await;

        let ddl: String =
            sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name = 'block_properties'")
                .fetch_one(&pool)
                .await
                .unwrap();

        // Locate the `key_not_reserved` CHECK, then its `key NOT IN (...)`
        // list. Parsing is anchored on the named constraint so an unrelated
        // NOT IN elsewhere in the DDL cannot be picked up by mistake.
        let check_start = ddl.find("key_not_reserved").expect(
            "block_properties DDL must contain the key_not_reserved CHECK (migration 0088)",
        );
        let tail = &ddl[check_start..];
        let not_in_start = tail
            .find("NOT IN (")
            .expect("key_not_reserved CHECK must use `key NOT IN (...)`");
        let list_start = not_in_start + "NOT IN (".len();
        let list_end = tail[list_start..]
            .find(')')
            .expect("key NOT IN list must be closed with ')'");
        let list = &tail[list_start..list_start + list_end];

        let db_keys: BTreeSet<String> = list
            .split(',')
            .map(|s| s.trim().trim_matches('\'').to_owned())
            .collect();
        let const_keys: BTreeSet<String> = crate::op::COLUMN_BACKED_PROPERTY_KEYS
            .iter()
            .map(|s| (*s).to_owned())
            .collect();

        assert_eq!(
            db_keys, const_keys,
            "the migration-0088 key_not_reserved CHECK and op::COLUMN_BACKED_PROPERTY_KEYS \
             must contain exactly the same keys — update them in lockstep (a new column-backed \
             key needs BOTH a new table-rebuild migration and a constant update)"
        );
    }

    /// #589 drift guard — `reserved_key_blocks_column` must map every key
    /// in `op::COLUMN_BACKED_PROPERTY_KEYS` to a `blocks` column (the four
    /// reserved keys to their same-named columns, `space` to `space_id`)
    /// and reject everything else. Membership already delegates to
    /// `is_column_backed_property_key`; this pins the per-key mapping arms
    /// so a constant addition without a mapping arm fails here.
    #[test]
    fn reserved_key_blocks_column_covers_column_backed_set_589() {
        for key in crate::op::COLUMN_BACKED_PROPERTY_KEYS {
            let col = reserved_key_blocks_column(key);
            assert!(
                col.is_some(),
                "column-backed key '{key}' must have a blocks-column mapping in \
                 reserved_key_blocks_column"
            );
            let expected = if key == crate::op::SPACE_PROPERTY_KEY {
                "space_id"
            } else {
                key
            };
            assert_eq!(
                col,
                Some(expected),
                "'{key}' must map to blocks column '{expected}'"
            );
        }
        for key in ["effort", "assignee", "space_id", "created_at", ""] {
            assert!(
                reserved_key_blocks_column(key).is_none(),
                "non-column-backed key '{key}' must map to None (lives in block_properties)"
            );
        }
    }

    /// Issue #109 Phase 1 — `now_ms()` returns a plausible wall-clock
    /// epoch-ms value. The test deliberately doesn't pin a value range
    /// against `chrono::Utc::now()` to avoid a circular self-test; it
    /// pins only the shape every downstream call site relies on (positive
    /// value, well below i64::MAX). It does NOT assert monotonicity:
    /// `now_ms()` is wall-clock, not OS-monotonic, and may step backward
    /// (NTP) — ordering of writes is the `(created_at, seq)` query layer's
    /// job, not this helper's.
    #[test]
    fn now_ms_returns_plausible_epoch_ms_109() {
        let a = now_ms();
        let b = now_ms();
        assert!(a > 0, "now_ms() must be positive (post-epoch)");
        assert!(b > 0, "now_ms() must be positive (post-epoch)");
        // Well below i64::MAX, where chrono panics. Year 2262-04-11
        // overflows i64 milliseconds; current date is in the 2020s, so
        // there's ~7 orders of magnitude of headroom.
        assert!(
            b < i64::MAX / 1000,
            "now_ms() must stay comfortably below i64::MAX for the foreseeable future"
        );
    }

    /// #1549 — `next_delete_ms()` is strictly increasing across rapid
    /// successive calls, even when wall-clock `now_ms()` would repeat within
    /// the same millisecond. This is the property that gives every distinct
    /// delete a distinct `deleted_at` cohort key, so the restore-cohort
    /// filter (`WHERE deleted_at = ?`) can't conflate two independent deletes.
    #[test]
    fn next_delete_ms_is_strictly_increasing_1549() {
        // A tight burst that — by construction — issues many calls within a
        // single wall-clock millisecond on any realistic machine. Each value
        // must be strictly greater than the previous one.
        let mut prev = next_delete_ms();
        assert!(prev > 0, "next_delete_ms() must be positive (post-epoch)");
        for _ in 0..10_000 {
            let cur = next_delete_ms();
            assert!(
                cur > prev,
                "next_delete_ms() must be strictly increasing: {cur} !> {prev}"
            );
            prev = cur;
        }
    }

    /// #1549 — concurrent callers never observe a torn read or a duplicate:
    /// across N threads each pulling many values, every value handed out is
    /// unique (the CAS loop is the single linearization point).
    #[test]
    fn next_delete_ms_unique_under_concurrency_1549() {
        use std::collections::HashSet;
        use std::sync::{Arc, Mutex};

        const THREADS: usize = 8;
        const PER_THREAD: usize = 5_000;

        let seen: Arc<Mutex<HashSet<i64>>> = Arc::new(Mutex::new(HashSet::new()));
        let handles: Vec<_> = (0..THREADS)
            .map(|_| {
                let seen = Arc::clone(&seen);
                std::thread::spawn(move || {
                    let mut local = Vec::with_capacity(PER_THREAD);
                    for _ in 0..PER_THREAD {
                        local.push(next_delete_ms());
                    }
                    let mut guard = seen.lock().unwrap();
                    for v in local {
                        assert!(
                            guard.insert(v),
                            "duplicate delete timestamp handed out: {v}"
                        );
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(
            seen.lock().unwrap().len(),
            THREADS * PER_THREAD,
            "every concurrent call must yield a unique delete timestamp"
        );
    }

    #[tokio::test]
    async fn init_pool_sets_wal_journal_mode() {
        let (pool, _dir) = test_pool().await;
        let row: (String,) = sqlx::query_as("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0.to_lowercase(), "wal", "journal_mode should be WAL");
    }

    #[tokio::test]
    async fn init_pool_enables_foreign_keys() {
        let (pool, _dir) = test_pool().await;
        let row: (i64,) = sqlx::query_as("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0, 1, "foreign_keys should be enabled (1)");
    }

    #[tokio::test]
    async fn init_pool_enforces_foreign_key_constraint() {
        let (pool, _dir) = test_pool().await;
        // Attempt to insert a block with a non-existent parent_id should fail
        // because of the FK constraint on blocks.parent_id -> blocks.id.
        let result = sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id) \
             VALUES (?, ?, ?, ?)",
            "CHILD",
            "content",
            "hi",
            "NONEXISTENT_PARENT",
        )
        .execute(&pool)
        .await;
        assert!(
            result.is_err(),
            "inserting a block with invalid parent_id should fail due to FK constraint"
        );
    }

    #[tokio::test]
    async fn init_pool_runs_migrations_creating_blocks_table() {
        let (pool, _dir) = test_pool().await;
        let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "blocks table should exist and be empty");
    }

    #[tokio::test]
    async fn init_pool_with_invalid_path_returns_error() {
        let result = init_pool(Path::new("/nonexistent/path/to/db.sqlite")).await;
        assert!(
            result.is_err(),
            "init_pool with invalid path should return an error"
        );
    }

    // Legacy `init_pool` should run `PRAGMA optimize` after migrations,
    // matching production `init_pools`. Real coverage: the call doesn't fail
    // and the pool is usable for a SELECT afterwards.
    #[tokio::test]
    async fn init_pool_runs_pragma_optimize() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.expect("init_pool should succeed");
        let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .expect("post-init SELECT should succeed");
        assert_eq!(count, 0, "fresh DB should have zero blocks");
    }

    /// Regression: migrations 0073 and 0080 rebuild `blocks` by
    /// creating `_new_blocks`, copying data, then `DROP TABLE blocks`.
    /// The original SQL declared `parent_id REFERENCES blocks(id)` and
    /// `page_id REFERENCES blocks(id)` inside `_new_blocks`. After the
    /// INSERT, `_new_blocks` itself became a child table with RESTRICT
    /// and data, causing `DROP TABLE blocks` to fail with FK constraint.
    /// The fix uses `REFERENCES _new_blocks(id)` (self-reference); after
    /// `ALTER TABLE _new_blocks RENAME TO blocks`, SQLite rewrites the
    /// reference to `blocks(id)`.
    #[tokio::test]
    async fn blocks_rebuild_self_fk_allows_drop() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&db_path)
                    .create_if_missing(true)
                    .pragma("foreign_keys", "ON"),
            )
            .await
            .unwrap();

        sqlx::query(
            "CREATE TABLE blocks (
                id TEXT PRIMARY KEY NOT NULL,
                parent_id TEXT REFERENCES blocks(id),
                page_id TEXT REFERENCES blocks(id)
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("INSERT INTO blocks VALUES ('B1', NULL, 'B1')")
            .execute(&pool)
            .await
            .unwrap();

        // Reproduce the fixed migration pattern.
        sqlx::query(
            "CREATE TABLE _new_blocks (
                id TEXT PRIMARY KEY NOT NULL,
                parent_id TEXT REFERENCES _new_blocks(id),
                page_id TEXT REFERENCES _new_blocks(id),
                CONSTRAINT page_id_self_for_pages CHECK (
                    page_id = id
                )
            ) STRICT",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("INSERT INTO _new_blocks SELECT * FROM blocks")
            .execute(&pool)
            .await
            .unwrap();

        // This DROP was the failure point before the fix.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query("ALTER TABLE _new_blocks RENAME TO blocks")
            .execute(&pool)
            .await
            .unwrap();

        let sql: (String,) = sqlx::query_as(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'blocks'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(
            sql.0.contains("REFERENCES \"blocks\"(id)"),
            "after rename the self-FK should point to blocks: {}",
            sql.0
        );
    }

    // ======================================================================
    // DbPools tests
    // ======================================================================

    #[tokio::test]
    async fn init_pools_write_pool_sets_wal() {
        let (pools, _dir) = test_pools().await;
        let row: (String,) = sqlx::query_as("PRAGMA journal_mode")
            .fetch_one(&pools.write)
            .await
            .unwrap();
        assert_eq!(
            row.0.to_lowercase(),
            "wal",
            "write pool journal_mode should be WAL"
        );
    }

    #[tokio::test]
    async fn init_pools_read_pool_sets_wal() {
        let (pools, _dir) = test_pools().await;
        let row: (String,) = sqlx::query_as("PRAGMA journal_mode")
            .fetch_one(&pools.read)
            .await
            .unwrap();
        // Read pool opens in WAL mode (shared journal with write pool)
        assert_eq!(
            row.0.to_lowercase(),
            "wal",
            "read pool journal_mode should be WAL"
        );
    }

    #[tokio::test]
    async fn init_pools_write_pool_enables_foreign_keys() {
        let (pools, _dir) = test_pools().await;
        let row: (i64,) = sqlx::query_as("PRAGMA foreign_keys")
            .fetch_one(&pools.write)
            .await
            .unwrap();
        assert_eq!(row.0, 1, "write pool foreign_keys should be enabled");
    }

    #[tokio::test]
    async fn init_pools_read_pool_enables_foreign_keys() {
        let (pools, _dir) = test_pools().await;
        let row: (i64,) = sqlx::query_as("PRAGMA foreign_keys")
            .fetch_one(&pools.read)
            .await
            .unwrap();
        assert_eq!(row.0, 1, "read pool foreign_keys should be enabled");
    }

    #[tokio::test]
    async fn init_pools_write_pool_can_write() {
        let (pools, _dir) = test_pools().await;
        let result = sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "W1",
            "content",
            "hello",
        )
        .execute(&pools.write)
        .await;
        assert!(result.is_ok(), "write pool should accept writes");
    }

    #[tokio::test]
    async fn init_pools_read_pool_rejects_writes() {
        let (pools, _dir) = test_pools().await;
        // The read pool has PRAGMA query_only = ON, so writes should fail
        let result = sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "R1",
            "content",
            "hello",
        )
        .execute(&pools.read)
        .await;
        assert!(
            result.is_err(),
            "read pool should reject INSERT due to query_only pragma"
        );
    }

    /// R2 (#347): `init_pools` asserts `PRAGMA query_only == 1` on the read
    /// pool at boot. A correctly-wired pool passes the assertion (init
    /// succeeds) AND every read connection reports `query_only = 1`, so the
    /// structural guard against accidental writes through the read pool is
    /// verified eagerly rather than on the first errant write.
    #[tokio::test]
    async fn init_pools_asserts_read_pool_query_only_at_boot() {
        let (pools, _dir) = test_pools().await;
        // init_pools returning Ok already means the boot assertion passed;
        // double-check the live pragma value on a fresh read connection.
        let query_only: i64 = sqlx::query_scalar("PRAGMA query_only")
            .fetch_one(&pools.read)
            .await
            .unwrap();
        assert_eq!(
            query_only, 1,
            "read pool must report PRAGMA query_only = 1 after init_pools boot assertion"
        );
    }

    #[tokio::test]
    async fn init_pools_read_pool_rejects_update() {
        let (pools, _dir) = test_pools().await;
        // First insert via write pool
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "RU1",
            "content",
            "hello",
        )
        .execute(&pools.write)
        .await
        .unwrap();

        // Attempt UPDATE via read pool should fail
        let result = sqlx::query!(
            "UPDATE blocks SET content = ? WHERE id = ?",
            "modified",
            "RU1",
        )
        .execute(&pools.read)
        .await;
        assert!(
            result.is_err(),
            "read pool should reject UPDATE due to query_only pragma"
        );
    }

    #[tokio::test]
    async fn init_pools_read_pool_rejects_delete() {
        let (pools, _dir) = test_pools().await;
        // First insert via write pool
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "RD1",
            "content",
            "hello",
        )
        .execute(&pools.write)
        .await
        .unwrap();

        // Attempt DELETE via read pool should fail
        let result = sqlx::query!("DELETE FROM blocks WHERE id = ?", "RD1")
            .execute(&pools.read)
            .await;
        assert!(
            result.is_err(),
            "read pool should reject DELETE due to query_only pragma"
        );
    }

    #[tokio::test]
    async fn init_pools_read_pool_allows_select() {
        let (pools, _dir) = test_pools().await;
        // Insert via write pool
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "RS1",
            "content",
            "hello",
        )
        .execute(&pools.write)
        .await
        .unwrap();

        // SELECT via read pool should work
        let row = sqlx::query!("SELECT content FROM blocks WHERE id = ?", "RS1")
            .fetch_one(&pools.read)
            .await
            .unwrap();
        assert_eq!(
            row.content.as_deref(),
            Some("hello"),
            "read pool should allow SELECT queries"
        );
    }

    #[tokio::test]
    async fn init_pools_read_sees_write_pool_data() {
        let (pools, _dir) = test_pools().await;
        // Write through write pool
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "VIS1",
            "content",
            "visible",
        )
        .execute(&pools.write)
        .await
        .unwrap();

        // Read pool should see the committed data (WAL mode)
        let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", "VIS1")
            .fetch_one(&pools.read)
            .await
            .unwrap();
        assert_eq!(
            count, 1,
            "read pool should see data committed by write pool"
        );
    }

    #[tokio::test]
    async fn init_pools_migrations_ran_on_write_pool() {
        let (pools, _dir) = test_pools().await;
        // Verify migrations ran by checking blocks table exists (via read pool)
        let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pools.read)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "blocks table should exist (migrations ran on write pool)"
        );
    }

    #[tokio::test]
    async fn init_pools_read_pool_query_only_pragma_is_set() {
        let (pools, _dir) = test_pools().await;
        let row: (i64,) = sqlx::query_as("PRAGMA query_only")
            .fetch_one(&pools.read)
            .await
            .unwrap();
        assert_eq!(row.0, 1, "read pool should have query_only = ON (1)");
    }

    #[tokio::test]
    async fn init_pools_write_pool_query_only_is_off() {
        let (pools, _dir) = test_pools().await;
        let row: (i64,) = sqlx::query_as("PRAGMA query_only")
            .fetch_one(&pools.write)
            .await
            .unwrap();
        assert_eq!(row.0, 0, "write pool should have query_only = OFF (0)");
    }

    #[tokio::test]
    async fn init_pools_with_invalid_path_returns_error() {
        let result = init_pools(Path::new("/nonexistent/path/to/db.sqlite")).await;
        assert!(
            result.is_err(),
            "init_pools with invalid path should return an error"
        );
    }

    #[tokio::test]
    async fn wal_autocheckpoint_is_configured() {
        let (pool, _dir) = test_pool().await;
        let row = sqlx::query_scalar!("PRAGMA wal_autocheckpoint")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row, Some(5000), "wal_autocheckpoint should be 5000 pages");
    }

    #[tokio::test]
    async fn init_pools_wal_autocheckpoint_configured() {
        let (pools, _dir) = test_pools().await;

        // Verify write pool has wal_autocheckpoint = 5000
        let write_val = sqlx::query_scalar!("PRAGMA wal_autocheckpoint")
            .fetch_one(&pools.write)
            .await
            .unwrap();
        assert_eq!(
            write_val,
            Some(5000),
            "write pool wal_autocheckpoint should be 5000 pages"
        );

        // Verify read pool has wal_autocheckpoint = 5000
        let read_val = sqlx::query_scalar!("PRAGMA wal_autocheckpoint")
            .fetch_one(&pools.read)
            .await
            .unwrap();
        assert_eq!(
            read_val,
            Some(5000),
            "read pool wal_autocheckpoint should be 5000 pages"
        );
    }

    // ======================================================================
    // Performance PRAGMAs: cache_size, mmap_size, temp_store
    // ======================================================================

    #[tokio::test]
    async fn init_pool_sets_performance_pragmas() {
        let (pool, _dir) = test_pool().await;

        // cache_size: stored as a negative value meaning KB. Platform-gated
        // (#420): 64 MB desktop / 8 MB Android. Assert against the source const.
        let cache_size = sqlx::query_scalar::<_, i64>("PRAGMA cache_size")
            .fetch_one(&pool)
            .await
            .unwrap();
        let expected_cache: i64 = super::CACHE_SIZE_PRAGMA.parse().unwrap();
        assert_eq!(
            cache_size, expected_cache,
            "cache_size should match CACHE_SIZE_PRAGMA"
        );

        // mmap_size: memory-mapped read region. Platform-gated (#420):
        // 256 MB desktop / 64 MB Android.
        let mmap_size = sqlx::query_scalar::<_, i64>("PRAGMA mmap_size")
            .fetch_one(&pool)
            .await
            .unwrap();
        let expected_mmap: i64 = super::MMAP_SIZE_PRAGMA.parse().unwrap();
        assert_eq!(
            mmap_size, expected_mmap,
            "mmap_size should match MMAP_SIZE_PRAGMA"
        );

        // temp_store: 2 == MEMORY (0 == DEFAULT, 1 == FILE, 2 == MEMORY).
        let temp_store = sqlx::query_scalar::<_, i64>("PRAGMA temp_store")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(temp_store, 2, "temp_store should be 2 (MEMORY)");
    }

    // ======================================================================
    // (issue #103): after migration 0072 dropped the redundant
    // idx_block_links_source, `WHERE source_id = ?` lookups must fall
    // through to the PK autoindex (sqlite_autoindex_block_links_1). Lock
    // that planner choice so a future schema change can't silently
    // regress to a full table scan.
    // ======================================================================

    #[tokio::test]
    async fn block_links_source_lookup_uses_pk_autoindex() {
        let (pool, _dir) = test_pool().await;
        let plan_rows: Vec<(i64, i64, i64, String)> =
            sqlx::query_as("EXPLAIN QUERY PLAN SELECT 1 FROM block_links WHERE source_id = ?")
                .bind("X")
                .fetch_all(&pool)
                .await
                .unwrap();
        let plan_text = plan_rows
            .iter()
            .map(|(_, _, _, detail)| detail.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            plan_text.contains("sqlite_autoindex_block_links_1"),
            "WHERE source_id = ? must use the PK autoindex after migration 0072 \
             dropped idx_block_links_source; got plan:\n{plan_text}"
        );
    }

    // ======================================================================
    // T-5: PRAGMA optimize test
    // ======================================================================

    #[tokio::test]
    async fn pragma_optimize_runs_without_error() {
        let (pool, _dir) = test_pool().await;
        let result = sqlx::query("PRAGMA optimize").execute(&pool).await;
        assert!(result.is_ok(), "PRAGMA optimize should succeed");
    }

    // ======================================================================
    // P-7: Write pool allows two connections
    // ======================================================================

    #[tokio::test]
    async fn init_pools_write_pool_allows_two_connections() {
        let (pools, _dir) = test_pools().await;
        // Acquire two write connections concurrently — should not deadlock
        // or timeout with max_connections(2).
        let conn1 = pools.write.acquire().await;
        assert!(conn1.is_ok(), "first write connection should succeed");
        let conn2 = pools.write.acquire().await;
        assert!(conn2.is_ok(), "second write connection should succeed");
    }

    // ======================================================================
    // Slow pool acquire logging
    // ======================================================================

    /// Thread-safe buffered writer usable as a `tracing_subscriber::fmt`
    /// writer so we can capture emitted log lines in-process.
    #[derive(Clone, Default)]
    struct BufWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for BufWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for BufWriter {
        type Writer = BufWriter;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    impl BufWriter {
        fn contents(&self) -> String {
            let bytes = self.0.lock().unwrap();
            String::from_utf8_lossy(&bytes).into_owned()
        }
    }

    #[tokio::test]
    async fn acquire_logged_fast_path_emits_no_warn() {
        use tracing_subscriber::layer::SubscriberExt;

        let (pool, _dir) = test_pool().await;

        let writer = BufWriter::default();
        // Install a scoped subscriber that only captures `warn` and above
        // via a BufWriter so we can inspect emitted events without racing
        // with the global subscriber.
        let subscriber = tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::new("warn"))
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(writer.clone())
                    .with_ansi(false),
            );
        let _guard = tracing::subscriber::set_default(subscriber);

        let result = acquire_logged(&pool, "test_fast").await;
        assert!(result.is_ok(), "fast acquire should succeed");
        drop(result);

        let contents = writer.contents();
        assert!(
            !contents.contains("slow pool acquire"),
            "fast pool acquire must not emit the slow-acquire warn, got log output: {contents:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn begin_immediate_logged_emits_warn_on_slow_acquire() {
        use tracing_subscriber::layer::SubscriberExt;

        // Build a dedicated pool with max_connections = 1 so that two
        // concurrent BEGIN IMMEDIATE callers force the second caller to
        // wait behind the first. The first caller sleeps for > SLOW_ACQUIRE
        // threshold while holding the connection, guaranteeing the second
        // caller's timed acquire crosses the threshold.
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("slow_acquire.db");
        let opts = base_connect_options(&db_path);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        let writer = BufWriter::default();
        let subscriber = tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::new("warn"))
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(writer.clone())
                    .with_ansi(false)
                    .with_target(true),
            );
        let _guard = tracing::subscriber::set_default(subscriber);

        // Hold the single pool slot for longer than SLOW_ACQUIRE_WARN_MS.
        let holder_pool = pool.clone();
        let holder = tokio::spawn(async move {
            let _conn = holder_pool.acquire().await.unwrap();
            let sleep_ms = u64::try_from(SLOW_ACQUIRE_WARN_MS)
                .expect("invariant: SLOW_ACQUIRE_WARN_MS = 100 fits in u64")
                + 150;
            tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
            // Drop releases the slot.
        });

        // Let the holder task actually start acquiring before we race.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        // This call must wait for the holder to release the slot, so the
        // acquire crosses the threshold and should emit a warn log.
        let tx = begin_immediate_logged(&pool, "test_slow").await;
        assert!(
            tx.is_ok(),
            "begin_immediate_logged should eventually succeed"
        );
        drop(tx);

        holder.await.unwrap();

        let contents = writer.contents();
        assert!(
            contents.contains("slow BEGIN IMMEDIATE"),
            "slow BEGIN IMMEDIATE must emit a warn log when acquire exceeds \
             SLOW_ACQUIRE_WARN_MS, got log output: {contents:?}"
        );
        assert!(
            contents.contains("test_slow"),
            "slow-acquire warn must include the caller-supplied label, got: {contents:?}"
        );
    }

    // ======================================================================
    // CommandTx newtype tests
    // ======================================================================

    use crate::op_log::OpRecord;

    /// Build a non-roundtrippable but structurally-valid `OpRecord` for
    /// tests that only care about whether dispatch *fires* (the
    /// materializer's internal payload parse will fail and emit a
    /// `warn`, which is exactly what `dispatch_background_or_warn`
    /// promises to do). No real op-log row is written.
    fn fake_op_record(device_id: &str, seq: i64, op_type: &str) -> OpRecord {
        OpRecord {
            device_id: device_id.to_string(),
            seq,
            parent_seqs: None,
            hash: "0".repeat(64),
            op_type: op_type.to_string(),
            payload: "{}".to_string(),
            created_at: 0,
            block_id: None,
        }
    }

    #[tokio::test]
    async fn command_tx_begin_immediate_opens_write_tx() {
        let (pool, _dir) = test_pool().await;
        let mut tx = CommandTx::begin_immediate(&pool, "test_cmd_tx_open")
            .await
            .expect("begin_immediate should succeed");

        // Writes via Deref should work exactly like a plain Transaction.
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "CMDTX_OPEN",
            "content",
            "hello"
        )
        .execute(&mut **tx)
        .await
        .expect("write through CommandTx should succeed");

        tx.commit_without_dispatch()
            .await
            .expect("commit without dispatch should succeed");

        let row = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", "CMDTX_OPEN")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row, 1, "commit_without_dispatch should persist the write");
    }

    #[tokio::test]
    async fn command_tx_deref_passes_through_to_in_tx_helpers() {
        // Prove that an existing `&mut sqlx::Transaction<'_, Sqlite>`
        // helper accepts `&mut *cmd_tx` unchanged. This is the
        // Load-bearing invariant for the migration strategy.
        async fn in_tx_style_helper(
            tx: &mut sqlx::Transaction<'_, Sqlite>,
            id: &str,
        ) -> Result<(), sqlx::Error> {
            sqlx::query!(
                "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
                id,
                "content",
                "from_helper"
            )
            .execute(&mut **tx)
            .await?;
            Ok(())
        }

        let (pool, _dir) = test_pool().await;
        let mut cmd_tx = CommandTx::begin_immediate(&pool, "test_deref_passthrough")
            .await
            .unwrap();

        // The helper signature is unchanged from the pre-
        // codebase — the Deref/DerefMut impls on CommandTx are what
        // makes `&mut *cmd_tx` match its expected `&mut Transaction`.
        in_tx_style_helper(&mut cmd_tx, "CMDTX_DEREF")
            .await
            .expect("in-tx helper should accept &mut *cmd_tx");

        cmd_tx.commit_without_dispatch().await.unwrap();

        let row = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", "CMDTX_DEREF")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row, 1, "helper-written row should be committed");
    }

    #[tokio::test]
    async fn command_tx_drop_rolls_back_writes() {
        let (pool, _dir) = test_pool().await;
        {
            let mut tx = CommandTx::begin_immediate(&pool, "test_drop_rollback")
                .await
                .unwrap();
            sqlx::query!(
                "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
                "CMDTX_DROP",
                "content",
                "x"
            )
            .execute(&mut **tx)
            .await
            .unwrap();
            // Drop without commit — sqlx::Transaction's Drop impl rolls
            // back implicitly. CommandTx adds no new guarantee here; we
            // assert the behaviour is preserved.
        }
        let row = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", "CMDTX_DROP")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row, 0, "drop without commit must roll back the write");
    }

    #[tokio::test]
    async fn command_tx_explicit_rollback_discards_pending() {
        let (pool, _dir) = test_pool().await;
        let mut tx = CommandTx::begin_immediate(&pool, "test_explicit_rollback")
            .await
            .unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "CMDTX_RB",
            "content",
            "x"
        )
        .execute(&mut **tx)
        .await
        .unwrap();
        tx.enqueue_background(fake_op_record("DEV", 1, "create_block"));
        tx.enqueue_background(fake_op_record("DEV", 2, "edit_block"));
        assert_eq!(tx.pending_len(), 2, "enqueue should grow pending");

        tx.rollback().await.expect("rollback should succeed");

        let row = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", "CMDTX_RB")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row, 0, "rollback must discard the write");
    }

    #[tokio::test]
    async fn command_tx_commit_and_dispatch_returns_pending_count_and_persists_writes() {
        use crate::materializer::Materializer;

        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let mut tx = CommandTx::begin_immediate(&pool, "test_commit_dispatch")
            .await
            .unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "CMDTX_C1",
            "content",
            "x"
        )
        .execute(&mut **tx)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "CMDTX_C2",
            "content",
            "y"
        )
        .execute(&mut **tx)
        .await
        .unwrap();
        tx.enqueue_background(fake_op_record("DEV", 1, "create_block"));
        tx.enqueue_background(fake_op_record("DEV", 2, "create_block"));
        tx.enqueue_background(fake_op_record("DEV", 3, "create_block"));

        let dispatched = tx
            .commit_and_dispatch(&materializer)
            .await
            .expect("commit_and_dispatch should succeed");
        assert_eq!(
            dispatched, 3,
            "commit_and_dispatch must return the pre-commit pending count"
        );

        let row = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM blocks WHERE id IN (?, ?)",
            "CMDTX_C1",
            "CMDTX_C2"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, 2, "commit must persist both writes");
    }

    #[tokio::test]
    async fn command_tx_commit_and_dispatch_with_no_pending_returns_zero() {
        use crate::materializer::Materializer;

        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let mut tx = CommandTx::begin_immediate(&pool, "test_zero_pending")
            .await
            .unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "CMDTX_ZERO",
            "content",
            "x"
        )
        .execute(&mut **tx)
        .await
        .unwrap();
        assert_eq!(tx.pending_len(), 0, "no enqueue, no pending");

        let dispatched = tx.commit_and_dispatch(&materializer).await.unwrap();
        assert_eq!(
            dispatched, 0,
            "commit_and_dispatch with nothing enqueued must still commit and return 0"
        );

        let row = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", "CMDTX_ZERO")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row, 1, "commit must have happened even with no dispatch");
    }

    #[tokio::test]
    async fn command_tx_pending_len_reflects_enqueues() {
        let (pool, _dir) = test_pool().await;
        let mut tx = CommandTx::begin_immediate(&pool, "test_pending_len")
            .await
            .unwrap();

        assert_eq!(tx.pending_len(), 0);
        tx.enqueue_background(fake_op_record("DEV", 1, "create_block"));
        assert_eq!(tx.pending_len(), 1);
        tx.enqueue_background(fake_op_record("DEV", 2, "edit_block"));
        assert_eq!(tx.pending_len(), 2);
        tx.enqueue_background(fake_op_record("DEV", 3, "delete_block"));
        assert_eq!(tx.pending_len(), 3);

        // Cleanup (tx.rollback() also clears).
        tx.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn command_tx_commit_without_dispatch_clears_pending() {
        let (pool, _dir) = test_pool().await;
        let mut tx = CommandTx::begin_immediate(&pool, "test_commit_no_dispatch")
            .await
            .unwrap();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            "CMDTX_ND",
            "content",
            "x"
        )
        .execute(&mut **tx)
        .await
        .unwrap();
        tx.enqueue_background(fake_op_record("DEV", 1, "create_block"));
        tx.enqueue_background(fake_op_record("DEV", 2, "edit_block"));
        assert_eq!(tx.pending_len(), 2);

        // Escape hatch — commits the tx but explicitly skips dispatch.
        // The queued records are discarded.
        tx.commit_without_dispatch()
            .await
            .expect("commit_without_dispatch should succeed");

        let row = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", "CMDTX_ND")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            row, 1,
            "commit_without_dispatch must still commit the transaction"
        );
    }

    /// Regression: when `blocks` is missing but `op_log` still has
    /// data (partial migration-73 DROP TABLE), `init_pool` must recreate
    /// `blocks` from `op_log` and then restore dependent tables after
    /// migrations so no user data is lost.
    #[tokio::test]
    async fn init_pool_recover_blocks_from_op_log_73() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");

        // Step 1: create a normal migrated database with some data.
        let pool = init_pool(&db_path).await.unwrap();

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('PAGE1','page','Page A',NULL,1,'PAGE1')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('CHILD1','content','child','PAGE1',1,'PAGE1')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) \
             VALUES ('CHILD1','effort','high')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES ('CHILD1','PAGE1')")
            .execute(&pool)
            .await
            .unwrap();

        // Seed op_log with create_block ops so recovery has something to replay.
        // created_at is INTEGER ms in the migrated schema (Issue #109).
        let ts = chrono::Utc::now().timestamp_millis();
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
             VALUES ('dev1', 1, 'h1', 'create_block', \
             '{\"block_id\":\"PAGE1\",\"block_type\":\"page\",\"content\":\"Page A\",\"parent_id\":null,\"position\":1}', \
             ?, 'user')",
        )
        .bind(ts)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
             VALUES ('dev1', 2, 'h2', 'create_block', \
             '{\"block_id\":\"RECOV1\",\"block_type\":\"content\",\"content\":\"recovered\",\"parent_id\":\"PAGE1\",\"position\":2}', \
             ?, 'user')",
        )
        .bind(ts)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
             VALUES ('dev1', 3, 'h3', 'set_property', \
             '{\"block_id\":\"RECOV1\",\"key\":\"due_date\",\"value_date\":\"2026-06-15\",\"value_text\":null,\"value_num\":null,\"value_ref\":null}', \
             ?, 'user')",
        )
        .bind(ts)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
             VALUES ('dev1', 4, 'h4', 'add_tag', \
             '{\"block_id\":\"RECOV1\",\"tag_id\":\"PAGE1\"}', \
             ?, 'user')",
        )
        .bind(ts)
        .execute(&pool)
        .await
        .unwrap();

        // Step 2: simulate corruption — drop blocks.  CASCADE deletes
        // dependent rows, but the empty tables remain with FK references
        // to the missing blocks table, so we cannot run DML on them.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();

        // Step 3: reopen the database with init_pool — recovery should run.
        drop(pool);
        let pool = init_pool(&db_path).await.unwrap();

        // Step 4: verify blocks were recovered from op_log.
        let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            count >= 2,
            "blocks should be recovered: expected at least 2 rows, got {count}"
        );

        // Verify the directly-inserted page and child survived.
        let page_exists: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM blocks WHERE id = 'PAGE1' AND block_type = 'page'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(page_exists, 1, "original page should survive recovery");

        // Verify the op_log-recovered block exists with correct page_id.
        let recov = sqlx::query("SELECT id, content, page_id FROM blocks WHERE id = 'RECOV1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let recov_id: String = recov.try_get("id").unwrap();
        let recov_content: String = recov.try_get("content").unwrap();
        let recov_page_id: Option<String> = recov.try_get("page_id").unwrap();
        assert_eq!(recov_id, "RECOV1");
        assert_eq!(recov_content, "recovered");
        assert_eq!(
            recov_page_id,
            Some("PAGE1".to_string()),
            "page_id should be computed from parent chain"
        );

        // Verify dependent tables were restored post-migration. #534:
        // `due_date` is a reserved key — column-backed on `blocks`, NEVER a
        // `block_properties` row — so recovery must leave block_properties
        // empty for it (the value lands on blocks.due_date, asserted below).
        let prop_count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = 'RECOV1' AND key = 'due_date'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            prop_count, 0,
            "reserved key 'due_date' must NOT be recovered into block_properties (#534)"
        );

        let tag_count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM block_tags WHERE block_id = 'RECOV1' AND tag_id = 'PAGE1'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(tag_count, 1, "tag should be recovered");

        // Verify denormalised column was backfilled.
        let due_row = sqlx::query("SELECT due_date FROM blocks WHERE id = 'RECOV1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let due: Option<String> = due_row.try_get("due_date").unwrap();
        assert_eq!(
            due,
            Some("2026-06-15".to_string()),
            "due_date should be backfilled from properties"
        );
    }

    /// Seed a fully-migrated pool with a space page, a content page, and a child
    /// of that page (all `space_id` NULL), plus the given op_log rows, then run
    /// `recover_derived_state_from_op_log` directly with the #616 positive
    /// corruption signal forced `true` (op_log non-empty + empty derived tables
    /// keep the secondary gate open), so this exercises the real production
    /// Replay path against a real schema — without the temp-table path
    /// that `DROP TABLE blocks` would trigger.
    #[cfg(test)]
    async fn seed_space_recovery_pool(ops: &[(i64, &str, &str)]) -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        for (id, ptype, page_id) in [("SPACE1", "page", "SPACE1"), ("PAGE1", "page", "PAGE1")] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
                 VALUES (?, ?, 'x', NULL, 1, ?)",
            )
            .bind(id)
            .bind(ptype)
            .bind(page_id)
            .execute(&pool)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('CHILD1','content','c','PAGE1',1,'PAGE1')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // #708: `blocks.space_id` REFERENCES `spaces(id)` (0089), and the
        // recovery `space` arm skips targets missing from the registry.
        // Register SPACE1 directly (not via an `is_space` property row —
        // that would close the derived-recovery gate, which requires
        // `block_properties` empty). Registry rows are NOT derived state:
        // on a real recovery they survive, exactly as seeded here.
        sqlx::query("INSERT INTO spaces (id) VALUES ('SPACE1')")
            .execute(&pool)
            .await
            .unwrap();
        let ts = chrono::Utc::now().timestamp_millis();
        for (seq, op, payload) in ops {
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
                 VALUES ('dev1', ?, ?, ?, ?, ?, 'user')",
            )
            .bind(seq)
            .bind(format!("h{seq}"))
            .bind(*op)
            .bind(*payload)
            .bind(ts)
            .execute(&pool)
            .await
            .unwrap();
        }
        recover_derived_state_from_op_log(&pool, true)
            .await
            .unwrap();
        (pool, dir)
    }

    #[cfg(test)]
    async fn space_id_of(pool: &SqlitePool, id: &str) -> Option<String> {
        sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// #534 regression: op-log recovery of a `set_property(space)` op must fan
    /// the `blocks.space_id` column out to the whole owning-page group
    /// (`WHERE id = ? OR page_id = ?`), exactly like the live
    /// `project_set_property_to_sql` — not just the page's own row.
    #[tokio::test]
    async fn recovery_set_space_fans_out_to_page_group_534() {
        let (pool, _dir) = seed_space_recovery_pool(&[(
            1,
            "set_property",
            r#"{"block_id":"PAGE1","key":"space","value_ref":"SPACE1","value_text":null,"value_num":null,"value_date":null}"#,
        )])
        .await;

        assert_eq!(space_id_of(&pool, "PAGE1").await.as_deref(), Some("SPACE1"));
        assert_eq!(
            space_id_of(&pool, "CHILD1").await.as_deref(),
            Some("SPACE1"),
            "child must inherit the page's space_id via recovery fan-out (#534)"
        );
        let prop: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_properties")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            prop, 0,
            "space must not be recovered as a block_properties row"
        );
    }

    /// #534 regression: op-log recovery of a `delete_property(space)` must null
    /// `blocks.space_id` for the whole owning-page group, not just the page row
    /// — otherwise descendants are stranded with a stale space_id after a
    /// recovery (the bug the adversarial review caught: clear used
    /// `WHERE id = ?` only, while the live clear paths fan out).
    #[tokio::test]
    async fn recovery_clear_space_fans_out_to_page_group_534() {
        let (pool, _dir) = seed_space_recovery_pool(&[
            (
                1,
                "set_property",
                r#"{"block_id":"PAGE1","key":"space","value_ref":"SPACE1","value_text":null,"value_num":null,"value_date":null}"#,
            ),
            (2, "delete_property", r#"{"block_id":"PAGE1","key":"space"}"#),
        ])
        .await;

        assert_eq!(
            space_id_of(&pool, "PAGE1").await,
            None,
            "page space_id cleared"
        );
        assert_eq!(
            space_id_of(&pool, "CHILD1").await,
            None,
            "child space_id must ALSO clear via recovery fan-out, not be stranded (#534)"
        );
    }

    /// #605 regression: op-log recovery of a `set_property(space)` op whose
    /// target space block is absent (purged, or never present in the local
    /// op_log) must be SKIPPED — `blocks.space_id` is `REFERENCES blocks(id)`
    /// and binding the dangling ref straight in trips FK 787, aborting
    /// recovery (and, because recovery refires every boot, turning one bad op
    /// into a permanent boot failure). The prior valid space assignment must
    /// survive (skip = unchanged, not NULL-clobber), and a second recovery
    /// pass must be idempotent.
    #[tokio::test]
    async fn recovery_set_space_dangling_target_skips_not_aborts_605() {
        let (pool, _dir) = seed_space_recovery_pool(&[
            // Happy path first: existing space target applies.
            (
                1,
                "set_property",
                r#"{"block_id":"PAGE1","key":"space","value_ref":"SPACE1","value_text":null,"value_num":null,"value_date":null}"#,
            ),
            // Dangling target: GHOST_SPACE has no blocks row — must be
            // skipped without aborting the replay tx.
            (
                2,
                "set_property",
                r#"{"block_id":"PAGE1","key":"space","value_ref":"GHOST_SPACE","value_text":null,"value_num":null,"value_date":null}"#,
            ),
        ])
        .await;
        // seed_space_recovery_pool unwraps recover_derived_state_from_op_log,
        // so reaching here proves the dangling ref did not abort recovery.

        assert_eq!(
            space_id_of(&pool, "PAGE1").await.as_deref(),
            Some("SPACE1"),
            "dangling space op must be skipped, leaving the prior valid space (#605)"
        );
        assert_eq!(
            space_id_of(&pool, "CHILD1").await.as_deref(),
            Some("SPACE1"),
            "fan-out member must also keep the prior valid space (#605)"
        );

        // Second pass (recovery can refire on a later boot while the #616
        // pending marker survives) must be idempotent — no error, same end state.
        recover_derived_state_from_op_log(&pool, true)
            .await
            .expect("second recovery pass must be idempotent, not FK-abort (#605)");
        assert_eq!(space_id_of(&pool, "PAGE1").await.as_deref(), Some("SPACE1"));
        assert_eq!(
            space_id_of(&pool, "CHILD1").await.as_deref(),
            Some("SPACE1")
        );
    }

    /// #708: a `set_property(space)` op whose target EXISTS as a block but
    /// was never flagged as a space (the #612 mis-stamp class) must also be
    /// skipped — the rebuilt `blocks.space_id REFERENCES spaces(id)` FK
    /// would otherwise abort recovery (permanent boot failure), exactly
    /// like the #605 dangling case.
    #[tokio::test]
    async fn recovery_set_space_unregistered_target_skips_708() {
        let (pool, _dir) = seed_space_recovery_pool(&[
            (
                1,
                "set_property",
                r#"{"block_id":"PAGE1","key":"space","value_ref":"SPACE1","value_text":null,"value_num":null,"value_date":null}"#,
            ),
            // CHILD1 exists as a block but is NOT in the `spaces` registry —
            // must be skipped, leaving the prior valid assignment intact.
            (
                2,
                "set_property",
                r#"{"block_id":"PAGE1","key":"space","value_ref":"CHILD1","value_text":null,"value_num":null,"value_date":null}"#,
            ),
        ])
        .await;

        assert_eq!(
            space_id_of(&pool, "PAGE1").await.as_deref(),
            Some("SPACE1"),
            "an existing-but-unregistered target must be skipped (#708), \
             leaving the prior valid space"
        );
        assert_eq!(
            space_id_of(&pool, "CHILD1").await.as_deref(),
            Some("SPACE1"),
            "fan-out member must also keep the prior valid space (#708)"
        );
    }

    /// #605 regression, full boot path (DROP-TABLE corruption): the
    /// recreated temp `blocks` table must carry `space_id` (no later
    /// migration re-runs to add it — `_sqlx_migrations` already records
    /// 0086), so a valid `set_property(space)` op replays onto the column
    /// instead of aborting boot with "no such column: space_id"; and an op
    /// whose target space block never reaches the recovered table must be
    /// skipped, not turn `init_pool` into a permanent boot failure. The
    /// dangling-target block survives with `space_id` NULL, and a subsequent
    /// boot (recovery refires while `block_properties` / `block_tags` stay
    /// empty) succeeds too.
    #[tokio::test]
    async fn init_pool_recovery_dangling_space_ref_boots_605() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        let ts = chrono::Utc::now().timestamp_millis();
        let ops: &[(i64, &str, &str)] = &[
            (
                1,
                "create_block",
                r#"{"block_id":"SPACE1","block_type":"page","content":"Space","parent_id":null,"position":1}"#,
            ),
            (
                2,
                "create_block",
                r#"{"block_id":"PAGE1","block_type":"page","content":"Page A","parent_id":null,"position":2}"#,
            ),
            (
                3,
                "create_block",
                r#"{"block_id":"PAGE2","block_type":"page","content":"Page B","parent_id":null,"position":3}"#,
            ),
            // #708: flag SPACE1 as a space, exactly as `create_space` logs it.
            // Replaying this property INSERT fires the 0089
            // `spaces_register_is_space` trigger, registering SPACE1 in the
            // `spaces` table — which the `space` arm's registry guard (and
            // the rebuilt `blocks.space_id` FK) now requires.
            (
                4,
                "set_property",
                r#"{"block_id":"SPACE1","key":"is_space","value_text":"true"}"#,
            ),
            // Valid target — must apply onto the temp table's space_id column.
            (
                5,
                "set_property",
                r#"{"block_id":"PAGE1","key":"space","value_ref":"SPACE1"}"#,
            ),
            // GHOST_SPACE has no create_block op — absent after recovery.
            (
                6,
                "set_property",
                r#"{"block_id":"PAGE2","key":"space","value_ref":"GHOST_SPACE"}"#,
            ),
        ];
        for (seq, op_type, payload) in ops {
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
                 VALUES ('dev1', ?, ?, ?, ?, ?, 'user')",
            )
            .bind(seq)
            .bind(format!("h{seq}"))
            .bind(op_type)
            .bind(payload)
            .bind(ts)
            .execute(&pool)
            .await
            .unwrap();
        }

        // Corrupt: drop blocks so recovery runs on reopen.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        drop(pool);

        // Boot 1: must NOT abort — neither with "no such column: space_id"
        // (temp-table schema) nor FK 787 (dangling ref) — the #605 regression.
        let pool = init_pool(&db_path)
            .await
            .expect("boot must survive set_property(space) replay incl. a dangling ref (#605)");
        let assert_space_ids = |pool: SqlitePool| async move {
            let valid: Option<String> =
                sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = 'PAGE1'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                valid.as_deref(),
                Some("SPACE1"),
                "valid space op must apply onto the recovered table's space_id (#605)"
            );
            let dangling: Option<String> =
                sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = 'PAGE2'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                dangling, None,
                "block survives with space_id NULL when the target space is absent (#605)"
            );
        };
        assert_space_ids(pool).await;

        // Boot 2: must also succeed, and the recovered space assignments
        // must persist. (#708 note: boot 1's replay re-inserted the
        // `is_space` property row, so the derived-state gate is closed on
        // this boot and recovery is skipped — the boot must simply not
        // re-fail and the state must be stable.)
        let pool = init_pool(&db_path)
            .await
            .expect("recovery must stay idempotent across boots (#605)");
        assert_space_ids(pool).await;
    }

    /// #429 regression: recovery replay of a `delete_block` op must (1) cascade
    /// the soft-delete through the whole subtree — a `delete_block` op encodes
    /// only the root, so without a descendant walk children reappear live under
    /// a tombstoned ancestor — and (2) stamp the op's OWN `created_at`, not a
    /// shared boot-time `now`, so distinct delete cohorts stay distinct for
    /// `list_trash` / `restore_block` grouping.
    #[tokio::test]
    async fn init_pool_recovery_cascades_delete_and_keeps_op_timestamp_429() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        // Deliberately-old delete timestamp so we can prove the recovered
        // `deleted_at` came from the op, not from boot-time `now`.
        const DELETE_TS_MS: i64 = 1_600_000_000_000; // 2020-09-13
        let create_ts: i64 = 1_500_000_000_000; // 2017, before the delete

        // Seed op_log: PAGE → CHILD → GRAND, then delete PAGE (root only).
        let creates = [
            (
                "s1",
                "P429",
                r#"{"block_id":"P429","block_type":"page","content":"P","parent_id":null,"position":1}"#,
            ),
            (
                "s2",
                "C429",
                r#"{"block_id":"C429","block_type":"content","content":"C","parent_id":"P429","position":1}"#,
            ),
            (
                "s3",
                "G429",
                r#"{"block_id":"G429","block_type":"content","content":"G","parent_id":"C429","position":1}"#,
            ),
        ];
        let mut seq = 1i64;
        for (h, _id, payload) in creates {
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
                 VALUES ('dev1', ?, ?, 'create_block', ?, ?, 'user')",
            )
            .bind(seq)
            .bind(h)
            .bind(payload)
            .bind(create_ts)
            .execute(&pool)
            .await
            .unwrap();
            seq += 1;
        }
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
             VALUES ('dev1', ?, 'sdel', 'delete_block', '{\"block_id\":\"P429\"}', ?, 'user')",
        )
        .bind(seq)
        .bind(DELETE_TS_MS)
        .execute(&pool)
        .await
        .unwrap();

        // Corrupt: drop blocks, reopen → recovery replays the op_log.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        drop(pool);
        let pool = init_pool(&db_path).await.unwrap();

        // (1) Cascade: every subtree member is soft-deleted, none left live.
        let live: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM blocks WHERE id IN ('P429','C429','G429') AND deleted_at IS NULL",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert!(
            live.is_empty(),
            "delete recovery must cascade to descendants; still-live: {live:?}"
        );

        // (2) Cohort + op timestamp: all three share one `deleted_at`, and it
        // is the 2020 op instant — not boot-time `now`. This DB is at head
        // (`_sqlx_migrations` records ≥ 0080 and post-DROP no later migration
        // re-runs to convert anything), so recovery writes INTEGER epoch-ms
        // (#618) — the encoding every at-head reader (`list_trash`,
        // `restore_block`) decodes as i64.
        let stamps: Vec<i64> =
            sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id IN ('P429','C429','G429')")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(stamps.len(), 3, "all three rows recovered");
        assert!(
            stamps.iter().all(|s| *s == DELETE_TS_MS),
            "the whole cohort must share the delete op's epoch-ms instant: {stamps:?}"
        );
    }

    /// Insert a raw op_log row (post-0079 schema: INTEGER-ms `created_at`).
    async fn insert_op(pool: &SqlitePool, seq: i64, op_type: &str, payload: &str, ts_ms: i64) {
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
             VALUES ('dev1', ?, ?, ?, ?, ?, 'user')",
        )
        .bind(seq)
        .bind(format!("h{seq}"))
        .bind(op_type)
        .bind(payload)
        .bind(ts_ms)
        .execute(pool)
        .await
        .unwrap();
    }

    /// #613 regression: recovery replay of a `restore_block` op must restore
    /// the whole `(seed, deleted_at_ref)` cohort — production restore
    /// un-deletes every descendant tombstoned by the SAME delete op — and
    /// must respect the cohort token: a root deleted by a DIFFERENT
    /// (earlier, unrelated) delete op must NOT be resurrected by a restore
    /// carrying a non-matching `deleted_at_ref`.
    #[tokio::test]
    async fn init_pool_recovery_restore_cascades_cohort_613() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        const CREATE_TS: i64 = 1_500_000_000_000;
        const DELETE_X_TS: i64 = 1_590_000_000_000; // unrelated earlier delete
        const DELETE_P_TS: i64 = 1_600_000_000_000; // the restored cohort
        const RESTORE_TS: i64 = 1_610_000_000_000;

        // Tree: P613 → C613 → G613, plus an independent root X613.
        insert_op(&pool, 1, "create_block",
            r#"{"block_id":"P613","block_type":"page","content":"P","parent_id":null,"position":1}"#,
            CREATE_TS).await;
        insert_op(&pool, 2, "create_block",
            r#"{"block_id":"C613","block_type":"content","content":"C","parent_id":"P613","position":1}"#,
            CREATE_TS).await;
        insert_op(&pool, 3, "create_block",
            r#"{"block_id":"G613","block_type":"content","content":"G","parent_id":"C613","position":1}"#,
            CREATE_TS).await;
        insert_op(&pool, 4, "create_block",
            r#"{"block_id":"X613","block_type":"content","content":"X","parent_id":null,"position":2}"#,
            CREATE_TS).await;
        // X613 deleted by an independent earlier op.
        insert_op(
            &pool,
            5,
            "delete_block",
            r#"{"block_id":"X613"}"#,
            DELETE_X_TS,
        )
        .await;
        // P613 subtree deleted, then restored with the matching cohort token.
        insert_op(
            &pool,
            6,
            "delete_block",
            r#"{"block_id":"P613"}"#,
            DELETE_P_TS,
        )
        .await;
        insert_op(
            &pool,
            7,
            "restore_block",
            &format!(r#"{{"block_id":"P613","deleted_at_ref":{DELETE_P_TS}}}"#),
            RESTORE_TS,
        )
        .await;
        // A restore aimed at X613 with a NON-matching token must not
        // resurrect it (the #613 unrelated-restore hazard).
        insert_op(
            &pool,
            8,
            "restore_block",
            &format!(r#"{{"block_id":"X613","deleted_at_ref":{DELETE_P_TS}}}"#),
            RESTORE_TS,
        )
        .await;

        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        drop(pool);
        let pool = init_pool(&db_path).await.unwrap();

        // The whole delete(P613) cohort is live again — descendants included.
        let live: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM blocks WHERE id IN ('P613','C613','G613') AND deleted_at IS NULL \
             ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            live,
            vec!["C613", "G613", "P613"],
            "restore recovery must un-delete the whole (seed, deleted_at_ref) cohort"
        );

        // X613 stays tombstoned with its original cohort stamp.
        let x_deleted_at: Option<i64> =
            sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = 'X613'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            x_deleted_at,
            Some(DELETE_X_TS),
            "a non-matching deleted_at_ref must not resurrect an unrelated deletion (#613)"
        );
    }

    /// #615 regression: recovery replay of a `purge_block` op must hard-delete
    /// the whole subtree. The temp recovery table has no FK cascade, so a
    /// root-only DELETE left purged descendants alive — and the orphan
    /// cleanup then PROMOTED them to live top-level blocks.
    #[tokio::test]
    async fn init_pool_recovery_purge_cascades_subtree_615() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        const TS: i64 = 1_600_000_000_000;
        insert_op(&pool, 1, "create_block",
            r#"{"block_id":"P615","block_type":"page","content":"P","parent_id":null,"position":1}"#,
            TS).await;
        insert_op(&pool, 2, "create_block",
            r#"{"block_id":"C615","block_type":"content","content":"C","parent_id":"P615","position":1}"#,
            TS).await;
        insert_op(&pool, 3, "create_block",
            r#"{"block_id":"G615","block_type":"content","content":"G","parent_id":"C615","position":1}"#,
            TS).await;
        // A survivor outside the purged subtree.
        insert_op(&pool, 4, "create_block",
            r#"{"block_id":"OUT615","block_type":"content","content":"O","parent_id":null,"position":2}"#,
            TS).await;
        insert_op(&pool, 5, "purge_block", r#"{"block_id":"P615"}"#, TS + 1000).await;

        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        drop(pool);
        let pool = init_pool(&db_path).await.unwrap();

        let purged_remnants: i64 =
            sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id IN ('P615','C615','G615')")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            purged_remnants, 0,
            "purge recovery must delete the whole subtree — no descendant may \
             survive (let alone be promoted to a live root, #615)"
        );

        let survivor: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = 'OUT615'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(survivor, 1, "blocks outside the purged subtree survive");
    }

    /// #614 regression: derived-state recovery must replay `remove_tag` —
    /// without the arm, every tag the user added and later removed
    /// resurrects after a recovery. The kept tag doubles as the positive
    /// control that the replay ran at all.
    #[tokio::test]
    async fn init_pool_recovery_removes_removed_tags_614() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        const TS: i64 = 1_600_000_000_000;
        insert_op(&pool, 1, "create_block",
            r#"{"block_id":"BLK614","block_type":"content","content":"b","parent_id":null,"position":1}"#,
            TS).await;
        insert_op(&pool, 2, "create_block",
            r#"{"block_id":"TAGKEEP614","block_type":"page","content":"keep","parent_id":null,"position":2}"#,
            TS).await;
        insert_op(&pool, 3, "create_block",
            r#"{"block_id":"TAGGONE614","block_type":"page","content":"gone","parent_id":null,"position":3}"#,
            TS).await;
        insert_op(
            &pool,
            4,
            "add_tag",
            r#"{"block_id":"BLK614","tag_id":"TAGKEEP614"}"#,
            TS + 100,
        )
        .await;
        insert_op(
            &pool,
            5,
            "add_tag",
            r#"{"block_id":"BLK614","tag_id":"TAGGONE614"}"#,
            TS + 200,
        )
        .await;
        insert_op(
            &pool,
            6,
            "remove_tag",
            r#"{"block_id":"BLK614","tag_id":"TAGGONE614"}"#,
            TS + 300,
        )
        .await;

        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        drop(pool);
        let pool = init_pool(&db_path).await.unwrap();

        let kept: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM block_tags WHERE block_id = 'BLK614' AND tag_id = 'TAGKEEP614'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(kept, 1, "never-removed tag must be recovered (replay ran)");

        let resurrected: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM block_tags WHERE block_id = 'BLK614' AND tag_id = 'TAGGONE614'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            resurrected, 0,
            "a removed tag must NOT resurrect after recovery (#614)"
        );
    }

    /// #651 regression: derived-state recovery must replay
    /// `rename_attachment` — otherwise a recovered attachment reverts to its
    /// pre-rename filename from the `add_attachment` op.
    #[tokio::test]
    async fn init_pool_recovery_replays_rename_attachment_651() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        const TS: i64 = 1_600_000_000_000;
        insert_op(&pool, 1, "create_block",
            r#"{"block_id":"BLK651","block_type":"content","content":"b","parent_id":null,"position":1}"#,
            TS).await;
        insert_op(&pool, 2, "add_attachment",
            r#"{"attachment_id":"ATT651","block_id":"BLK651","mime_type":"text/plain","filename":"draft.txt","size_bytes":12,"fs_path":"/tmp/draft.txt"}"#,
            TS + 100).await;
        insert_op(
            &pool,
            3,
            "rename_attachment",
            r#"{"attachment_id":"ATT651","old_filename":"draft.txt","new_filename":"final.txt"}"#,
            TS + 200,
        )
        .await;

        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        drop(pool);
        let pool = init_pool(&db_path).await.unwrap();

        let filename: String =
            sqlx::query_scalar("SELECT filename FROM attachments WHERE id = 'ATT651'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            filename, "final.txt",
            "recovered attachment must keep its post-rename filename (#651)"
        );
    }

    /// #616 regression: the derived-state replay needs a POSITIVE corruption
    /// signal — empty `block_properties` + `block_tags` alone are a
    /// legitimate steady state post-0088 (reserved-key-only vaults), and the
    /// old count-only gate re-ran the full op-log replay on every boot
    /// (resurrecting removed state and burning O(op_count) per boot).
    #[tokio::test]
    async fn derived_recovery_requires_positive_corruption_signal_616() {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();

        // Healthy vault shape: blocks + ops exist, derived tables empty.
        for (id, pos) in [("BLK616", 1i64), ("TAG616", 2i64)] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
                 VALUES (?, 'page', 'x', NULL, ?, ?)",
            )
            .bind(id)
            .bind(pos)
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        }
        insert_op(
            &pool,
            1,
            "add_tag",
            r#"{"block_id":"BLK616","tag_id":"TAG616"}"#,
            1_600_000_000_000,
        )
        .await;

        // No corruption signal: the gate must stay CLOSED — nothing replayed.
        recover_derived_state_from_op_log(&pool, false)
            .await
            .unwrap();
        let tags: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_tags")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            tags, 0,
            "without a positive corruption signal the replay must not run (#616)"
        );

        // Crash-retry path: the persisted pending marker (written by
        // `ensure_blocks_table_exists` in the recovery tx) opens the gate
        // even when this boot's in-memory flag is false — and a successful
        // replay clears it.
        sqlx::query("INSERT INTO app_settings (key, value, updated_at) VALUES (?, '1', ?)")
            .bind(DERIVED_RECOVERY_PENDING_KEY)
            .bind(now_ms())
            .execute(&pool)
            .await
            .unwrap();
        recover_derived_state_from_op_log(&pool, false)
            .await
            .unwrap();
        let tags: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_tags")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(tags, 1, "the pending marker must open the gate (#616)");
        let marker_left: i64 =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM app_settings WHERE key = ?")
                .bind(DERIVED_RECOVERY_PENDING_KEY)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            marker_left, 0,
            "a successful replay must clear the pending marker (#616)"
        );
    }

    /// #616 boot-loop regression: a reserved-key-only vault (op_log non-empty,
    /// derived tables legitimately empty) must NOT re-run the derived replay
    /// on every `init_pool` boot. Before the fix, each boot resurrected the
    /// removed tag below.
    #[tokio::test]
    async fn init_pool_does_not_replay_derived_state_every_boot_616() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();

        for (id, pos) in [("BLK616B", 1i64), ("TAG616B", 2i64)] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
                 VALUES (?, 'page', 'x', NULL, ?, ?)",
            )
            .bind(id)
            .bind(pos)
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        }
        // History where the tag was added then removed — live tables
        // correctly hold no row. The old every-boot replay would re-add it
        // (the missing remove_tag arm, #614) or at best burn a full replay.
        insert_op(
            &pool,
            1,
            "add_tag",
            r#"{"block_id":"BLK616B","tag_id":"TAG616B"}"#,
            1_600_000_000_000,
        )
        .await;
        drop(pool);

        // Healthy reboot — no corruption, no marker: the replay must not run.
        let pool = init_pool(&db_path).await.unwrap();
        let tags: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_tags")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            tags, 0,
            "a healthy boot must not replay the op-log into the derived tables (#616)"
        );
    }

    /// #429 (review fix): `op_created_at_rfc3339` must read a **TEXT** rfc3339
    /// `created_at` verbatim — the partial-migration-73 recovery target has
    /// not run migration 0079, so `created_at` is still TEXT, and reading it
    /// as `i64` first would corrupt the cohort timestamp. Also covers the
    /// INTEGER-ms (post-0079) era and the defensive all-digit-TEXT case.
    #[tokio::test]
    async fn op_created_at_rfc3339_reads_text_and_integer_created_at() {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("t.db")).await.unwrap();

        // TEXT rfc3339 (the recovery target population: 0079 not yet run).
        let row = sqlx::query("SELECT '2020-09-13T12:26:40+00:00' AS created_at")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            op_created_at_rfc3339(&row, "FALLBACK"),
            "2020-09-13T12:26:40+00:00",
            "TEXT rfc3339 created_at must be preserved, not coerced via i64"
        );

        // INTEGER-ms created_at (post-0079).
        let row = sqlx::query("SELECT 1600000000000 AS created_at")
            .fetch_one(&pool)
            .await
            .unwrap();
        let got = op_created_at_rfc3339(&row, "FALLBACK");
        assert!(got.starts_with("2020-09-13"), "INTEGER ms → rfc3339: {got}");

        // Defensive: TEXT column holding an all-digit ms value.
        let row = sqlx::query("SELECT '1600000000000' AS created_at")
            .fetch_one(&pool)
            .await
            .unwrap();
        let got = op_created_at_rfc3339(&row, "FALLBACK");
        assert!(
            got.starts_with("2020-09-13"),
            "all-digit TEXT → rfc3339: {got}"
        );

        // Empty / unreadable → fallback.
        let row = sqlx::query("SELECT '' AS created_at")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(op_created_at_rfc3339(&row, "FALLBACK"), "FALLBACK");
    }

    /// #618: `op_created_at_ms` must read every `created_at` era to epoch-ms —
    /// INTEGER ms (post-0079, the population the ms delete arm actually
    /// serves), the defensive all-digit-TEXT case, TEXT rfc3339 (converted
    /// to the exact instant via chrono), and fallback when unreadable.
    #[tokio::test]
    async fn op_created_at_ms_reads_integer_text_digit_and_rfc3339_618() {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("t.db")).await.unwrap();

        // INTEGER ms (post-0079 op_log — the era this helper serves).
        let row = sqlx::query("SELECT 1600000000000 AS created_at")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            op_created_at_ms(&row, -1),
            1_600_000_000_000,
            "INTEGER ms created_at must be read verbatim"
        );

        // Defensive: TEXT column holding an all-digit ms value.
        let row = sqlx::query("SELECT '1600000000000' AS created_at")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            op_created_at_ms(&row, -1),
            1_600_000_000_000,
            "all-digit TEXT created_at must parse to ms"
        );

        // TEXT rfc3339 → converted to ms via chrono (an i64 read of a TEXT
        // value fails sqlx's type check, so only the String path serves it).
        let row = sqlx::query("SELECT '2020-09-13T12:26:40+00:00' AS created_at")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            op_created_at_ms(&row, -1),
            1_600_000_000_000,
            "rfc3339 TEXT created_at must convert to the exact instant in ms"
        );

        // Empty / unreadable → fallback.
        let row = sqlx::query("SELECT '' AS created_at")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            op_created_at_ms(&row, -1),
            -1,
            "unreadable created_at must fall back"
        );
    }

    /// #618: seed a real `_sqlx_migrations` bookkeeping table recording every
    /// migration with `version <= through` as applied. Checksums come from the
    /// same `sqlx::migrate!` expansion production uses, so a subsequent
    /// `init_pool` boot validates the applied set and resumes at
    /// `through + 1` — exactly like a real DB whose later migration crashed.
    /// (The DDL mirrors sqlx-sqlite's `ensure_migrations_table`; the real
    /// migrator's `CREATE TABLE IF NOT EXISTS` then no-ops over it.)
    async fn seed_sqlx_migrations_through(pool: &SqlitePool, through: i64) {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS _sqlx_migrations (
                version BIGINT PRIMARY KEY,
                description TEXT NOT NULL,
                installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                success BOOLEAN NOT NULL,
                checksum BLOB NOT NULL,
                execution_time BIGINT NOT NULL
            )",
        )
        .execute(pool)
        .await
        .unwrap();

        let migrator = sqlx::migrate!("./migrations");
        for m in migrator.iter() {
            if !m.migration_type.is_up_migration() || m.version > through {
                continue;
            }
            sqlx::query(
                "INSERT INTO _sqlx_migrations \
                 (version, description, success, checksum, execution_time) \
                 VALUES (?, ?, TRUE, ?, -1)",
            )
            .bind(m.version)
            .bind(m.description.as_ref())
            .bind(m.checksum.as_ref())
            .execute(pool)
            .await
            .unwrap();
        }
    }

    /// #618 mechanical pin of the wedge: an rfc3339 TEXT `deleted_at` in the
    /// (non-STRICT) recovered `blocks` table makes the 0085 rebuild re-run
    /// fail — its bulk copy moves `deleted_at` RAW into the
    /// `_new_blocks … deleted_at INTEGER … STRICT` column with no julianday()
    /// conversion (only 0080 converts), so SQLite raises
    /// SQLITE_CONSTRAINT_DATATYPE. With INTEGER epoch-ms (the #618 recovery
    /// output) the same re-run succeeds and preserves the instant.
    #[tokio::test]
    async fn text_deleted_at_wedges_0085_rerun_integer_ms_passes_618() {
        let (pool, _dir) = unmigrated_pool().await;
        apply_migrations_through(&pool, 0, 84).await;
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();

        // The pre-#618 recovery temp table: non-STRICT, TEXT deleted_at.
        let temp_ddl_text = "CREATE TABLE blocks (
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
        )";
        sqlx::query(temp_ddl_text).execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, content, deleted_at) \
             VALUES ('B618', 'x', '2020-09-13T12:26:40+00:00')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let migrator = sqlx::migrate!("./migrations");
        let sql_0085 = migrator
            .iter()
            .find(|m| m.version == 85 && m.migration_type.is_up_migration())
            .expect("migration 0085 exists")
            .sql
            .as_str()
            .to_owned();

        let mut tx = pool.begin().await.unwrap();
        let err = sqlx::query(sqlx::AssertSqlSafe(sql_0085))
            .execute(&mut *tx)
            .await
            .expect_err(
                "0085 re-run over rfc3339 TEXT deleted_at must fail on the STRICT INTEGER column",
            );
        let msg = err.to_string();
        assert!(
            msg.contains("deleted_at"),
            "the failure must be the deleted_at datatype mismatch: {msg}"
        );
        tx.rollback().await.unwrap();

        // Same era, INTEGER epoch-ms deleted_at (the #618 recovery output):
        // the re-run succeeds (apply_migrations_through panics on failure)
        // and the instant survives to the rebuilt STRICT table.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        let temp_ddl_ms = "CREATE TABLE blocks (
            id             TEXT NOT NULL PRIMARY KEY,
            block_type     TEXT NOT NULL DEFAULT 'content',
            content        TEXT,
            parent_id      TEXT,
            position       INTEGER,
            deleted_at     INTEGER,
            todo_state     TEXT,
            priority       TEXT,
            due_date       TEXT,
            scheduled_date TEXT,
            page_id        TEXT
        )";
        sqlx::query(temp_ddl_ms).execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, content, deleted_at) VALUES ('B618', 'x', 1600000000000)",
        )
        .execute(&pool)
        .await
        .unwrap();
        apply_migrations_through(&pool, 84, 85).await;
        let got: i64 = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = 'B618'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            got, 1_600_000_000_000,
            "epoch-ms deleted_at must pass the 0085 rebuild verbatim"
        );
    }

    /// #618 end-to-end: a DB whose 0085 rebuild crashed after the DROP
    /// committed (`_sqlx_migrations` records 0084, `blocks` missing) must
    /// boot. Recovery replays the delete op as INTEGER epoch-ms (0080 is
    /// applied, so no julianday() conversion ever re-runs), the 0085..head
    /// re-run copies it into the STRICT INTEGER column, and a second boot
    /// stays healthy — the pre-#618 code wedged here permanently (boot 1
    /// failed 0085 on the TEXT deleted_at; every later boot found `blocks`
    /// present, skipped recovery, and failed 0085 the same way).
    #[tokio::test]
    async fn init_pool_recovery_at_0085_era_writes_ms_deleted_at_618() {
        let (pool, dir) = unmigrated_pool().await;
        let db_path = dir.path().join("test.db");
        apply_migrations_through(&pool, 0, 84).await;
        seed_sqlx_migrations_through(&pool, 84).await;

        const DELETE_TS_MS: i64 = 1_600_000_000_000; // 2020-09-13
        const CREATE_TS_MS: i64 = 1_500_000_000_000; // 2017, before the delete

        // op_log.created_at is INTEGER ms at v84 (0079 applied).
        let ops: &[(i64, &str, &str, i64)] = &[
            (
                1,
                "create_block",
                r#"{"block_id":"P618","block_type":"page","content":"P","parent_id":null,"position":1}"#,
                CREATE_TS_MS,
            ),
            (
                2,
                "create_block",
                r#"{"block_id":"C618","block_type":"content","content":"C","parent_id":"P618","position":1}"#,
                CREATE_TS_MS,
            ),
            (3, "delete_block", r#"{"block_id":"P618"}"#, DELETE_TS_MS),
        ];
        for (seq, op_type, payload, ts) in ops {
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
                 VALUES ('dev618', ?, ?, ?, ?, ?, 'user')",
            )
            .bind(seq)
            .bind(format!("h{seq}"))
            .bind(op_type)
            .bind(payload)
            .bind(ts)
            .execute(&pool)
            .await
            .unwrap();
        }

        // The 0085-era crash state: blocks gone, bookkeeping says 0084.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        drop(pool);

        // Boot 1: recovery + the 0085..head re-run must succeed.
        let pool = init_pool(&db_path).await.expect(
            "boot at the 0085 era must not wedge on the STRICT INTEGER deleted_at re-rebuild (#618)",
        );
        let stamps: Vec<i64> =
            sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id IN ('P618', 'C618')")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(stamps.len(), 2, "both subtree members must be recovered");
        assert!(
            stamps.iter().all(|s| *s == DELETE_TS_MS),
            "deleted_at must be the delete op's epoch-ms instant, got {stamps:?}"
        );
        drop(pool);

        // Boot 2: the wedge class is permanent, so prove the second boot is
        // healthy and the recovered cohort is stable.
        let pool = init_pool(&db_path)
            .await
            .expect("second boot must stay healthy (#618 wedge was permanent)");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE deleted_at = ?")
            .bind(DELETE_TS_MS)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            count, 2,
            "recovered deletion cohort must persist across boots"
        );
    }

    /// #618 era parity (the pre-0080 population /#429 originally
    /// served): with `_sqlx_migrations` recording only ≤0078, recovery must
    /// STILL write rfc3339 TEXT — 0080's julianday() backfill re-runs and is
    /// the designated converter. The op's instant must survive to head as the
    /// exact epoch-ms value.
    #[tokio::test]
    async fn init_pool_recovery_pre_0080_era_text_deleted_at_converts_via_0080_618() {
        let (pool, dir) = unmigrated_pool().await;
        let db_path = dir.path().join("test.db");
        apply_migrations_through(&pool, 0, 78).await;
        seed_sqlx_migrations_through(&pool, 78).await;

        // op_log.created_at is still TEXT rfc3339 at v78 (0079 not yet run).
        const DELETE_TS_RFC: &str = "2020-09-13T12:26:40+00:00";
        const DELETE_TS_MS: i64 = 1_600_000_000_000;
        let ops: &[(i64, &str, &str, &str)] = &[
            (
                1,
                "create_block",
                r#"{"block_id":"P618B","block_type":"page","content":"P","parent_id":null,"position":1}"#,
                "2017-07-14T02:40:00+00:00",
            ),
            (2, "delete_block", r#"{"block_id":"P618B"}"#, DELETE_TS_RFC),
        ];
        for (seq, op_type, payload, ts) in ops {
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
                 VALUES ('dev618', ?, ?, ?, ?, ?, 'user')",
            )
            .bind(seq)
            .bind(format!("h{seq}"))
            .bind(op_type)
            .bind(payload)
            .bind(ts)
            .execute(&pool)
            .await
            .unwrap();
        }

        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        drop(pool);

        let pool = init_pool(&db_path)
            .await
            .expect("pre-0080-era recovery must keep booting (#429 population)");
        let got: i64 = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = 'P618B'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            got, DELETE_TS_MS,
            "0080's julianday() backfill must convert the recovery's rfc3339 deleted_at \
             to the exact op instant"
        );
    }

    /// #618 sibling wedge (the #605 space_id column, era-inverted): on a DB
    /// whose `_sqlx_migrations` records exactly 0085 (0086 unapplied), the
    /// recovery temp table must NOT carry `space_id` — 0086's
    /// `ALTER TABLE blocks ADD COLUMN space_id` re-runs at boot and would
    /// abort with "duplicate column name". (The #605 era — 0086 recorded, no
    /// re-run — keeps the column; that path is pinned by the #605/#708 tests.)
    #[tokio::test]
    async fn init_pool_recovery_at_0086_era_omits_space_id_so_rerun_adds_it_618() {
        let (pool, dir) = unmigrated_pool().await;
        let db_path = dir.path().join("test.db");
        apply_migrations_through(&pool, 0, 85).await;
        seed_sqlx_migrations_through(&pool, 85).await;

        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
             VALUES ('dev618', 1, 'h1', 'create_block', \
             '{\"block_id\":\"P618C\",\"block_type\":\"page\",\"content\":\"P\",\"parent_id\":null,\"position\":1}', \
             1600000000000, 'user')",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        drop(pool);

        let pool = init_pool(&db_path).await.expect(
            "boot at the exactly-0085 era must not wedge 0086's ADD COLUMN space_id re-run (#618)",
        );
        // 0086 re-ran: the column exists, and the recovered block is intact.
        let space_id: Option<String> =
            sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = 'P618C'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(space_id, None, "recovered block boots with space_id NULL");
    }

    /// Regression: derived-state recovery must not crash when op_log
    /// contains `set_property` / `add_tag` ops that reference blocks absent
    /// from the recovered `blocks` table (purged locally, or created on
    /// another device and never present in the local op_log).  Those ops'
    /// FK columns (`block_id`, `value_ref`, `tag_id` → blocks(id)) would
    /// otherwise trip `FOREIGN KEY constraint failed (787)` and abort
    /// startup.  Dangling ops must be skipped; valid ones still recovered.
    #[tokio::test]
    async fn init_pool_recovery_skips_dangling_fk_refs_73() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");

        let pool = init_pool(&db_path).await.unwrap();

        let ts = chrono::Utc::now().timestamp_millis();

        // Seed op_log. Only PAGE1 / CHILD1 get create_block ops, so they are
        // the only blocks rebuilt; every GHOST_* id below is absent from the
        // recovered blocks table.
        let ops: &[(i64, &str, &str)] = &[
            (
                1,
                "create_block",
                "{\"block_id\":\"PAGE1\",\"block_type\":\"page\",\"content\":\"Page A\",\"parent_id\":null,\"position\":1}",
            ),
            (
                2,
                "create_block",
                "{\"block_id\":\"CHILD1\",\"block_type\":\"content\",\"content\":\"child\",\"parent_id\":\"PAGE1\",\"position\":2}",
            ),
            // Valid property on a live block — must survive.
            (
                3,
                "set_property",
                "{\"block_id\":\"CHILD1\",\"key\":\"effort\",\"value_text\":\"high\"}",
            ),
            // Dangling block_id (GHOST_BLOCK never created) — must be skipped.
            (
                4,
                "set_property",
                "{\"block_id\":\"GHOST_BLOCK\",\"key\":\"effort\",\"value_text\":\"low\"}",
            ),
            // Dangling value_ref (sole value points at missing block) — skip whole row.
            (
                5,
                "set_property",
                "{\"block_id\":\"CHILD1\",\"key\":\"related\",\"value_ref\":\"GHOST_REF\"}",
            ),
            // Valid tag — must survive.
            (
                6,
                "add_tag",
                "{\"block_id\":\"CHILD1\",\"tag_id\":\"PAGE1\"}",
            ),
            // Dangling tag_id — skip.
            (
                7,
                "add_tag",
                "{\"block_id\":\"CHILD1\",\"tag_id\":\"GHOST_TAG\"}",
            ),
            // Dangling tagged block_id — skip.
            (
                8,
                "add_tag",
                "{\"block_id\":\"GHOST_BLOCK\",\"tag_id\":\"PAGE1\"}",
            ),
        ];
        for (seq, op_type, payload) in ops {
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
                 VALUES ('dev1', ?, ?, ?, ?, ?, 'user')",
            )
            .bind(seq)
            .bind(format!("h{seq}"))
            .bind(op_type)
            .bind(payload)
            .bind(ts)
            .execute(&pool)
            .await
            .unwrap();
        }

        // Corrupt: drop blocks so recovery runs on reopen.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        drop(pool);

        // Must NOT panic / error with FK 787 — this is the regression.
        let pool = init_pool(&db_path)
            .await
            .expect("recovery must skip dangling FK refs instead of crashing");

        // Valid property recovered.
        let prio: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = 'CHILD1' AND key = 'effort'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            prio, 1,
            "valid property on a live block should be recovered"
        );

        // Dangling-block property skipped.
        let ghost_prop: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = 'GHOST_BLOCK'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(ghost_prop, 0, "property on a missing block must be skipped");

        // Dangling value_ref property skipped entirely.
        let related: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = 'CHILD1' AND key = 'related'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            related, 0,
            "property whose sole value_ref dangles must be skipped"
        );

        // Valid tag recovered; dangling tags skipped.
        let good_tag: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_tags WHERE block_id = 'CHILD1' AND tag_id = 'PAGE1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            good_tag, 1,
            "tag between two live blocks should be recovered"
        );

        let bad_tags: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_tags WHERE tag_id = 'GHOST_TAG' OR block_id = 'GHOST_BLOCK'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            bad_tags, 0,
            "tags referencing a missing block must be skipped"
        );
    }

    /// Regression: a `set_property` op that CLEARS a value (all `value_*`
    /// fields null — e.g. un-setting `todo_state`) must be replayed as a
    /// row-removal, not an all-NULL INSERT. The all-NULL row violates the
    /// `exactly_one_value` CHECK (migration 0062) and previously panicked
    /// the whole app at startup with `(275) CHECK constraint failed:
    /// exactly_one_value` while recovering derived tables from the op_log.
    #[tokio::test]
    async fn init_pool_recovery_handles_clear_property_op() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        let ts = chrono::Utc::now().timestamp_millis();

        let ops: &[(i64, &str, &str)] = &[
            (
                1,
                "create_block",
                "{\"block_id\":\"PAGE1\",\"block_type\":\"page\",\"content\":\"P\",\"parent_id\":null,\"position\":1}",
            ),
            (
                2,
                "create_block",
                "{\"block_id\":\"B1\",\"block_type\":\"content\",\"content\":\"b\",\"parent_id\":\"PAGE1\",\"position\":2}",
            ),
            // Set a generic property, then CLEAR it (the all-NULL op that
            // crashed boot). A non-reserved key keeps this exercising the
            // generic block_properties clear→DELETE path the regression guards
            // (reserved keys are column-backed, covered separately by #534).
            (
                3,
                "set_property",
                "{\"block_id\":\"B1\",\"key\":\"status\",\"value_text\":\"DOING\"}",
            ),
            (
                4,
                "set_property",
                "{\"block_id\":\"B1\",\"key\":\"status\",\"value_text\":null,\"value_num\":null,\"value_date\":null,\"value_ref\":null,\"value_bool\":null}",
            ),
            // An unrelated property that stays set — must survive the recovery.
            (
                5,
                "set_property",
                "{\"block_id\":\"B1\",\"key\":\"effort\",\"value_text\":\"high\"}",
            ),
        ];
        for (seq, op_type, payload) in ops {
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
                 VALUES ('dev1', ?, ?, ?, ?, ?, 'user')",
            )
            .bind(seq)
            .bind(format!("h{seq}"))
            .bind(op_type)
            .bind(payload)
            .bind(ts)
            .execute(&pool)
            .await
            .unwrap();
        }

        // Drop blocks so the empty-derived-tables recovery runs on reopen.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        drop(pool);

        // Must NOT panic with the exactly_one_value CHECK — the regression.
        let pool = init_pool(&db_path)
            .await
            .expect("recovery must replay a clear-property op as a delete, not crash");

        // Cleared property is row-absent.
        let todo: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = 'B1' AND key = 'status'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(todo, 0, "a cleared property must not be re-inserted");

        // The still-set property survives.
        let prio: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = 'B1' AND key = 'effort'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(prio, 1, "an unrelated set property must still be recovered");
    }

    /// Regression (#374): the `blocks`-table rebuild in migrations 0073/0080
    /// runs `DROP TABLE blocks` under `foreign_keys = ON`, which cascade-
    /// deletes every `attachments` row (migration 0061 gave
    /// `attachments.block_id` an `ON DELETE CASCADE`). `attachments` is the
    /// one AUTHORITATIVE child of `blocks` (not a derived cache), so that
    /// silently destroyed file metadata. Recovery must rebuild the table from
    /// the op-log `add_attachment` payloads, honouring later
    /// `delete_attachment` ops and skipping attachments whose owning block is
    /// gone. The `DROP TABLE blocks` below reproduces the exact cascade.
    #[tokio::test]
    async fn init_pool_recovery_restores_attachments_374() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        let ts = chrono::Utc::now().timestamp_millis();

        let ops: &[(i64, &str, &str)] = &[
            (
                1,
                "create_block",
                "{\"block_id\":\"PAGE1\",\"block_type\":\"page\",\"content\":\"P\",\"parent_id\":null,\"position\":1}",
            ),
            (
                2,
                "create_block",
                "{\"block_id\":\"CHILD1\",\"block_type\":\"content\",\"content\":\"b\",\"parent_id\":\"PAGE1\",\"position\":2}",
            ),
            // Live attachment on a recovered block — must be restored verbatim.
            (
                3,
                "add_attachment",
                "{\"attachment_id\":\"ATT1\",\"block_id\":\"CHILD1\",\"mime_type\":\"image/png\",\"filename\":\"a.png\",\"size_bytes\":123,\"fs_path\":\"attachments/ATT1.png\"}",
            ),
            // Attachment whose owning block was never created — must be skipped
            // (restoring it would trip the block_id FK and abort startup).
            (
                4,
                "add_attachment",
                "{\"attachment_id\":\"ATT2\",\"block_id\":\"GHOST\",\"mime_type\":\"image/png\",\"filename\":\"g.png\",\"size_bytes\":7,\"fs_path\":\"attachments/ATT2.png\"}",
            ),
            // Added then deleted — the later delete must win (net absent).
            (
                5,
                "add_attachment",
                "{\"attachment_id\":\"ATT3\",\"block_id\":\"CHILD1\",\"mime_type\":\"text/plain\",\"filename\":\"t.txt\",\"size_bytes\":4,\"fs_path\":\"attachments/ATT3.txt\"}",
            ),
            (
                6,
                "delete_attachment",
                "{\"attachment_id\":\"ATT3\",\"fs_path\":\"attachments/ATT3.txt\"}",
            ),
        ];
        for (seq, op_type, payload) in ops {
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
                 VALUES ('dev1', ?, ?, ?, ?, ?, 'user')",
            )
            .bind(seq)
            .bind(format!("h{seq}"))
            .bind(op_type)
            .bind(payload)
            .bind(ts)
            .execute(&pool)
            .await
            .unwrap();
        }

        // DROP blocks so the reopen rebuilds it from the op-log create ops
        // (and, under FK=ON, cascade-empties `attachments` exactly as the
        // 0073/0080 rebuild does). `attachments` is empty here because the
        // owning blocks don't exist yet — they're only materialised during
        // recovery — so the op-log replay is the sole source of restoration.
        sqlx::query("DROP TABLE blocks")
            .execute(&pool)
            .await
            .unwrap();
        drop(pool);

        let pool = init_pool(&db_path)
            .await
            .expect("recovery must restore attachments without crashing");

        // The live attachment is restored with every column intact.
        let row = sqlx::query(
            "SELECT block_id, mime_type, filename, size_bytes, fs_path, created_at \
             FROM attachments WHERE id = 'ATT1'",
        )
        .fetch_optional(&pool)
        .await
        .unwrap()
        .expect("live attachment ATT1 must be recovered from the op log");
        let block_id: String = row.try_get("block_id").unwrap();
        let mime: String = row.try_get("mime_type").unwrap();
        let filename: String = row.try_get("filename").unwrap();
        let size: i64 = row.try_get("size_bytes").unwrap();
        let fs_path: String = row.try_get("fs_path").unwrap();
        let created_at: i64 = row.try_get("created_at").unwrap();
        assert_eq!(block_id, "CHILD1");
        assert_eq!(mime, "image/png");
        assert_eq!(filename, "a.png");
        assert_eq!(size, 123);
        assert_eq!(fs_path, "attachments/ATT1.png");
        assert_eq!(
            created_at, ts,
            "created_at must come from the op's timestamp"
        );

        // Attachment on a missing block is skipped (no FK abort).
        let ghost: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE id = 'ATT2'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(ghost, 0, "attachment on a missing block must be skipped");

        // Added-then-deleted attachment stays absent (delete wins).
        let deleted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE id = 'ATT3'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(deleted, 0, "a deleted attachment must not be resurrected");

        // Idempotency: a second boot (recovery re-walks the op log because
        // this fixture has no properties/tags) must not duplicate or error —
        // `INSERT OR IGNORE` keeps ATT1 at exactly one row.
        drop(pool);
        let pool = init_pool(&db_path)
            .await
            .expect("a second recovery pass must not crash");
        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(total, 1, "recovery must be idempotent across boots");
    }

    // ======================================================================
    // Issue #376 — data-preservation across destructive migrations.
    //
    // Every other db-level test runs `sqlx::migrate!` against an EMPTY
    // database (see `test_pool` above), so no existing test seeds
    // pre-existing rows and migrates them forward. The two destructive
    // classes that were previously unvalidated:
    //   1. The `blocks` table rebuild in 0073 / 0080 (DROP/RENAME under
    //      `foreign_keys = ON`; the class that caused the #374 attachments
    //      data loss).
    //   2. The TEXT->INTEGER millisecond backfills in 0074-0082 that convert
    //      legacy RFC-3339 timestamps via
    //      `CAST(ROUND((julianday(col) - 2440587.5) * 86400000.0) AS INTEGER)`.
    //
    // The harness below applies migrations INCREMENTALLY up to a target
    // version, lets a test seed rows into the intermediate schema, then
    // applies the remaining migrations to head — something `sqlx::migrate!`
    // (all-or-nothing against an empty DB) cannot do.
    // ======================================================================

    /// Build a raw pool with the SAME pragmas production uses
    /// ([`base_connect_options`] — notably `foreign_keys = ON`), but WITHOUT
    /// running any migrations. Migrations are then applied by hand via
    /// [`apply_migrations_through`] so a test can interpose a seed step at an
    /// intermediate schema version.
    ///
    /// `max_connections(1)` keeps every statement (and therefore the
    /// per-connection `foreign_keys = ON` pragma) on a single connection, so
    /// the FK-cascade behaviour during the DROP/RENAME exactly matches a
    /// real single-connection migration run.
    async fn unmigrated_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(base_connect_options(&db_path))
            .await
            .unwrap();
        (pool, dir)
    }

    /// Apply every UP migration whose `version` is in `(after, through]`, in
    /// ascending version order, by executing each migration's raw SQL string
    /// against `pool`. Down-migrations are skipped.
    ///
    /// Mechanism notes:
    /// * The migrator is the same `sqlx::migrate!("./migrations")` expansion
    ///   production uses; `.iter()` yields `Migration { version, sql,
    ///   migration_type, .. }` in source order, which we sort by version to
    ///   be robust to ordering.
    /// * sqlx's SQLite driver executes a multi-statement raw SQL string
    ///   (which every rebuild migration is) when handed to
    ///   `sqlx::query(sql).execute(&mut tx)` — verified by these tests
    ///   reaching head successfully through the 0073/0080 rebuilds.
    /// * CRUCIALLY, each migration is run inside its OWN transaction, exactly
    ///   as sqlx's `Migrate::apply` does (`self.begin()` … `tx.commit()`, see
    ///   sqlx-sqlite `migrate.rs`), keeping the harness faithful to prod
    ///   atomicity: an aborted rebuild rolls back wholesale. Note what the
    ///   transaction does NOT do — it does not change FK semantics at the
    ///   DROP. `DROP TABLE blocks` under `foreign_keys = ON` performs an
    ///   implicit `DELETE FROM blocks` whose effects land at the end of the
    ///   DROP statement itself, in or out of a transaction (verified against
    ///   SQLite 3.50): every child's `ON DELETE CASCADE` fires immediately
    ///   (the #374/#606 data loss, pinned by the `*_376` / `*_606` tests
    ///   below), and if any NON-cascade child still holds referencing rows
    ///   the DROP aborts with `FOREIGN KEY constraint failed`. The shipped
    ///   rebuilds succeed because every populated child of `blocks` carries
    ///   `ON DELETE CASCADE` — i.e. is silently wiped — NOT because of any
    ///   commit-time FK "re-validation" (the mechanism 0085's header
    ///   imagines; no such row re-check exists at COMMIT).
    /// * We do NOT touch sqlx's `_sqlx_migrations` bookkeeping table; this
    ///   harness is test-only and never hands the DB back to
    ///   `sqlx::migrate!`, so version tracking is irrelevant here.
    async fn apply_migrations_through(pool: &SqlitePool, after: i64, through: i64) {
        // Collect owned (version, SQL) pairs up front so nothing borrows the
        // local `Migrator` across the awaits below. The SQL strings come from
        // our own checked-in migration files, so `AssertSqlSafe` (which
        // accepts a non-'static `String`) is appropriate — there is no
        // untrusted input here.
        let migrator = sqlx::migrate!("./migrations");
        let mut migs: Vec<(i64, String)> = migrator
            .iter()
            .filter(|m| m.migration_type.is_up_migration())
            .map(|m| (m.version, m.sql.as_str().to_owned()))
            .collect();
        migs.sort_by_key(|(version, _)| *version);
        for (version, sql) in migs {
            if version > after && version <= through {
                let mut tx = pool
                    .begin()
                    .await
                    .unwrap_or_else(|e| panic!("begin tx for migration {version}: {e}"));
                sqlx::query(sqlx::AssertSqlSafe(sql))
                    .execute(&mut *tx)
                    .await
                    .unwrap_or_else(|e| panic!("migration {version} failed to apply: {e}"));
                tx.commit()
                    .await
                    .unwrap_or_else(|e| panic!("commit migration {version}: {e}"));
            }
        }
    }

    /// Apply every UP migration with `version > after`, to head.
    async fn apply_migrations_to_head(pool: &SqlitePool, after: i64) {
        apply_migrations_through(pool, after, i64::MAX).await;
    }

    // ----------------------------------------------------------------------
    // Deliverable 1: the julianday CAST formula, in isolation.
    //
    // This pins the exact backfill expression used by every ms migration
    // (0074-0082) against the chrono ground truth: correctness, rounding,
    // and NULL/malformed handling. It runs on a bare connection (no schema),
    // so it is immune to migration drift.
    // ----------------------------------------------------------------------

    /// Evaluate the production backfill expression for one bound input.
    async fn julianday_ms(pool: &SqlitePool, input: Option<&str>) -> Option<i64> {
        sqlx::query_scalar::<_, Option<i64>>(
            "SELECT CAST(ROUND((julianday(?) - 2440587.5) * 86400000.0) AS INTEGER)",
        )
        .bind(input)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn julianday_cast_matches_chrono_376() {
        use chrono::DateTime;

        let (pool, _dir) = unmigrated_pool().await;

        // NULL in -> NULL out.
        assert_eq!(
            julianday_ms(&pool, None).await,
            None,
            "NULL timestamp must convert to NULL ms"
        );

        // Representative valid RFC-3339 forms. Each `expected` is computed
        // independently by chrono so the assertion is a true cross-check of
        // the SQL formula, not a self-test.
        let cases = [
            "2025-08-15T12:00:00Z",
            "2025-08-15T12:00:00+00:00",
            "2025-08-15T12:00:00.123Z",
            // chrono parses the space-separated form via parse_from_rfc3339
            // only with a 'T'; SQLite's julianday accepts the space form, so
            // we compare against the equivalent 'T' instant below.
        ];
        for input in cases {
            let expected = DateTime::parse_from_rfc3339(input)
                .unwrap_or_else(|e| panic!("chrono should parse {input}: {e}"))
                .timestamp_millis();
            let got = julianday_ms(&pool, Some(input)).await;
            assert_eq!(
                got,
                Some(expected),
                "SQL julianday formula for {input} must equal chrono's {expected} ms"
            );
        }

        // Space-separated form: SQLite's julianday accepts "YYYY-MM-DD HH:MM:SS"
        // and treats it as UTC, identical to the 'T'/'Z' instant.
        let space_input = "2025-08-15 12:00:00";
        let space_expected = DateTime::parse_from_rfc3339("2025-08-15T12:00:00Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            julianday_ms(&pool, Some(space_input)).await,
            Some(space_expected),
            "space-separated timestamp must convert to the same UTC ms as the 'T'/'Z' form"
        );

        // Sub-second precision survives the ROUND (123 ms above proves it;
        // assert it explicitly is non-zero in the fractional part).
        let sub = DateTime::parse_from_rfc3339("2025-08-15T12:00:00.123Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            sub % 1000,
            123,
            "sub-second component must be 123 ms (sanity on the chrono ground truth)"
        );

        // Malformed input: SQLite's julianday() returns NULL for an
        // unparseable string, so the whole expression yields NULL. This pins
        // the "NULL on malformed" behaviour the migrations rely on (a
        // malformed legacy value becomes NULL rather than aborting the
        // backfill or producing garbage).
        assert_eq!(
            julianday_ms(&pool, Some("not-a-date")).await,
            None,
            "malformed timestamp must convert to NULL (SQLite julianday returns NULL)"
        );
    }

    // ----------------------------------------------------------------------
    // Deliverable 2: the `blocks` rebuilds and the #374 cascade, observed
    // through the REAL migration SQL via the seed-then-migrate harness.
    //
    // After migration 0061, `attachments.block_id` carries
    // `REFERENCES blocks(id) ON DELETE CASCADE`. The 0073 and 0080 blocks
    // rebuilds run `DROP TABLE blocks` under `foreign_keys = ON`.
    //
    // IMPORTANT — what these tests pin (and why the naive "child survives"
    // assertion is WRONG): empirically, and by the project's own design,
    // `DROP TABLE blocks` under `foreign_keys = ON` IMMEDIATELY fires the
    // `ON DELETE CASCADE` and deletes every `attachments` row — even inside
    // the per-migration transaction sqlx uses (the cascade is part of the
    // DROP, not a deferred FK *validation*). This is the exact #374 data
    // loss. Production does NOT prevent it at the migration layer; it
    // RECOVERS the rows at startup from the op-log `add_attachment` payloads
    // (see `recover_derived_state_from_op_log`, and the
    // `init_pool_recovery_restores_attachments_374` regression test). These
    // harness tests therefore pin the real, faithful contract:
    //   * the migration path cascade-deletes the attachment row (a tripwire:
    //     if a future change makes the rebuild preserve children, that's a
    //     behaviour change to flag and re-evaluate against the recovery
    //     logic), AND
    //   * the parent `blocks` row and the authoritative `op_log` record both
    //     SURVIVE the rebuild — i.e. nothing the recovery depends on is lost,
    //     so the #374 restoration remains possible.
    // ----------------------------------------------------------------------

    /// Seed one page block, one attachment child, and the op-log
    /// `add_attachment` record (the authoritative source the #374 recovery
    /// replays) into the post-0061 intermediate schema. At seed time both
    /// `attachments.created_at` and `op_log.created_at` are still legacy
    /// `TEXT` (their ms cutovers are 0081/0079), so the timestamps are
    /// RFC-3339 strings.
    ///
    /// Seeds only `blocks` + `attachments` (the attachment's `created_at`
    /// stays TEXT until 0081, so this is used at intermediate versions where
    /// that column is still TEXT). The corresponding op-log `add_attachment`
    /// record is seeded by each caller via [`seed_add_attachment_op`] with a
    /// `created_at` of the correct type for that version (TEXT before 0079,
    /// INTEGER ms after).
    async fn seed_block_and_attachment(pool: &SqlitePool, block_id: &str, att_id: &str) {
        // A page block satisfies the page_id_self_for_pages CHECK that 0073
        // introduces (block_type='page' => page_id=id).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id) \
             VALUES (?, 'page', 'seeded page', ?)",
        )
        .bind(block_id)
        .bind(block_id)
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO attachments \
             (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, ?, 'image/png', 'pic.png', 123, ?, '2025-08-15T12:00:00Z')",
        )
        .bind(att_id)
        .bind(block_id)
        .bind(format!("attachments/{att_id}.png"))
        .execute(pool)
        .await
        .unwrap();
    }

    /// Seed an op-log `add_attachment` record. `created_at` is bound as a raw
    /// pre-formatted SQL literal fragment so callers can pass an RFC-3339
    /// string literal (pre-0079, TEXT column) or an integer ms literal
    /// (post-0079, INTEGER STRICT column).
    async fn seed_add_attachment_op(
        pool: &SqlitePool,
        block_id: &str,
        att_id: &str,
        op_seq: i64,
        created_at_literal: &str,
    ) {
        let payload = format!(
            "{{\"attachment_id\":\"{att_id}\",\"block_id\":\"{block_id}\",\
             \"mime_type\":\"image/png\",\"filename\":\"pic.png\",\
             \"size_bytes\":123,\"fs_path\":\"attachments/{att_id}.png\"}}"
        );
        let sql = format!(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, origin) \
             VALUES ('dev376', {op_seq}, 'h', 'add_attachment', ?, {created_at_literal}, 'user')"
        );
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(payload)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Seed before the FIRST blocks rebuild (0073) and migrate all the way to
    /// head through BOTH rebuilds (0073 and 0080). Pins the #374 cascade:
    /// the attachment is destroyed by the DROP, while the parent block and
    /// the op-log record (the recovery source) both survive.
    #[tokio::test]
    async fn blocks_rebuild_cascade_deletes_attachment_but_keeps_recovery_source_376() {
        let (pool, _dir) = unmigrated_pool().await;
        // Bring the schema up to just before the first blocks rebuild.
        apply_migrations_through(&pool, 0, 72).await;
        seed_block_and_attachment(&pool, "BLK376A", "ATT376A").await;
        // At v72 op_log.created_at is still TEXT, so seed a valid RFC-3339
        // string; 0079's julianday backfill converts it cleanly and the row
        // survives to head.
        seed_add_attachment_op(&pool, "BLK376A", "ATT376A", 1, "'2025-08-15T12:00:00Z'").await;

        // Migrate through 0073, 0080, and the ms cutovers to head.
        apply_migrations_to_head(&pool, 72).await;

        // #374: the ON DELETE CASCADE child is destroyed by the blocks DROP.
        let att_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE id = 'ATT376A'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            att_count, 0,
            "the blocks rebuild's `DROP TABLE blocks` under FK=ON cascade-deletes the \
             attachment (the #374 data-loss class). If this ever becomes 1, the rebuild's \
             FK behaviour changed — re-evaluate against recover_derived_state_from_op_log"
        );

        // The parent block itself is copied through every rebuild — never lost.
        let blk_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = 'BLK376A'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            blk_count, 1,
            "the parent block must survive both blocks rebuilds (bulk-copy, not cascade)"
        );

        // The authoritative op-log record survives, so the #374 recovery can
        // restore the attachment at the next startup.
        let op_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM op_log WHERE device_id = 'dev376' AND op_type = 'add_attachment'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            op_count, 1,
            "the op-log add_attachment record (the recovery source) must survive the rebuilds"
        );
    }

    /// Narrower variant: seed right before the SECOND blocks rebuild (0080)
    /// so the attachment crosses only that DROP/RENAME. Guards the 0080
    /// cascade independently of 0073, and confirms the recovery source
    /// (op_log) survives that rebuild too.
    #[tokio::test]
    async fn blocks_0080_rebuild_cascade_deletes_attachment_376() {
        let (pool, _dir) = unmigrated_pool().await;
        // 0079 is the last migration before the 0080 blocks rebuild.
        apply_migrations_through(&pool, 0, 79).await;
        seed_block_and_attachment(&pool, "BLK376B", "ATT376B").await;
        // At v79 op_log.created_at is already INTEGER STRICT (the 0079 cutover
        // ran), so seed an integer ms literal.
        seed_add_attachment_op(&pool, "BLK376B", "ATT376B", 1, "1755259200000").await;

        apply_migrations_to_head(&pool, 79).await;

        let att_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE id = 'ATT376B'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            att_count, 0,
            "the 0080 blocks rebuild cascade-deletes the attachment (#374 class)"
        );

        let op_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM op_log WHERE device_id = 'dev376' AND op_type = 'add_attachment'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            op_count, 1,
            "the op-log recovery source must survive the 0080 rebuild"
        );
    }

    // ----------------------------------------------------------------------
    // Issue #708 — the 0089 `spaces` registry + `blocks` rebuild.
    //
    // 0089 is the FIRST blocks rebuild after the #606 lesson (DROP TABLE
    // blocks under foreign_keys=ON cascade-wipes children immediately —
    // pinned by the #376 tests above), so these tests assert the new
    // contract: the authoritative satellites `page_aliases` / `block_drafts`
    // are PRESERVED across the rebuild, the registry is backfilled from
    // `is_space = 'true'` property rows (live AND soft-deleted), valid
    // memberships survive, and mis-stamped memberships (#612 class) are
    // NULLed rather than aborting the migration.
    // ----------------------------------------------------------------------

    /// Seed a representative pre-0089 (v88) database and migrate to head.
    #[tokio::test]
    async fn spaces_0089_backfill_preserves_satellites_and_repairs_orphans_708() {
        let (pool, _dir) = unmigrated_pool().await;
        apply_migrations_through(&pool, 0, 88).await;

        // Two space blocks: S1 live, S2 soft-deleted (#681 shape) — both
        // flagged `is_space = 'true'`.
        for (id, deleted) in [("S1708", "NULL"), ("S2708", "1700000000000")] {
            let sql = format!(
                "INSERT INTO blocks (id, block_type, content, page_id, deleted_at) \
                 VALUES (?, 'page', 'Space', ?, {deleted})"
            );
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(id)
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO block_properties (block_id, key, value_text) \
                 VALUES (?, 'is_space', 'true')",
            )
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        }

        // P1: page legitimately in S1 (+ a content child, fan-out shape).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id, space_id) \
             VALUES ('P1708', 'page', 'Page', 'P1708', 'S1708')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, page_id, space_id) \
             VALUES ('C1708', 'content', 'c', 'P1708', 'P1708', 'S1708')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // P2: mis-stamped membership (#612 class) — `space_id` points at
        // P1, a block that is NOT a space. Legal under the pre-0089
        // `REFERENCES blocks(id)`.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id, space_id) \
             VALUES ('P2708', 'page', 'Page', 'P2708', 'P1708')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // The #606 satellites — authoritative, NOT op-log-recoverable.
        sqlx::query("INSERT INTO page_aliases (page_id, alias) VALUES ('P1708', 'alias-708')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO block_drafts (block_id, content, updated_at) \
             VALUES ('P1708', 'draft body', 1700000000123)",
        )
        .execute(&pool)
        .await
        .unwrap();

        apply_migrations_to_head(&pool, 88).await;

        // Registry backfilled from the `is_space` rows — INCLUDING the
        // soft-deleted space (the registry mirrors the flag, not liveness).
        let registered: Vec<String> = sqlx::query_scalar("SELECT id FROM spaces ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(
            registered,
            vec!["S1708".to_string(), "S2708".to_string()],
            "registry must contain exactly the is_space-flagged blocks (live + tombstoned)"
        );

        // Valid memberships survive the rebuild; the mis-stamp is NULLed.
        let p1: Option<String> =
            sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = 'P1708'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(p1.as_deref(), Some("S1708"), "valid membership preserved");
        let c1: Option<String> =
            sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = 'C1708'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(c1.as_deref(), Some("S1708"), "child membership preserved");
        let p2: Option<String> =
            sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = 'P2708'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            p2, None,
            "mis-stamped space_id (#612 class) must be NULLed, not abort the migration"
        );

        // #606: the satellites SURVIVE this rebuild (unlike 0073/0080/0085,
        // which cascade-wiped them — the behaviour the #376 tests pin).
        let alias: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM page_aliases WHERE page_id = 'P1708' AND alias = 'alias-708'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            alias, 1,
            "page_aliases must survive the 0089 rebuild (#606)"
        );
        let draft: Option<(String, i64)> =
            sqlx::query_as("SELECT content, updated_at FROM block_drafts WHERE block_id = 'P1708'")
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert_eq!(
            draft,
            Some(("draft body".to_string(), 1700000000123)),
            "block_drafts must survive the 0089 rebuild byte-for-byte (#606)"
        );

        // No scratch tables left behind.
        let scratch: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE '\\_preserve\\_%' ESCAPE '\\' \
             OR name = '_spaces_backfill'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(scratch, 0, "0089 must drop its scratch tables");
    }

    /// Fresh-DB (head) contract: the `spaces_register_is_space` trigger
    /// registers a block the moment its `is_space = 'true'` property row
    /// lands, and the rebuilt FK rejects stamping `blocks.space_id` with
    /// anything that is not registered — the #612 bug class made
    /// unrepresentable.
    #[tokio::test]
    async fn spaces_0089_trigger_registers_and_fk_rejects_non_spaces_708() {
        let (pool, _dir) = unmigrated_pool().await;
        apply_migrations_to_head(&pool, 0).await;

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id) \
             VALUES ('SREG708', 'page', 'Space', 'SREG708')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id) \
             VALUES ('PREG708', 'page', 'Page', 'PREG708')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Not yet registered → stamping the FK fails for BOTH a plain block
        // and the not-yet-flagged space block.
        for target in ["PREG708", "SREG708"] {
            let res = sqlx::query("UPDATE blocks SET space_id = ? WHERE id = 'PREG708'")
                .bind(target)
                .execute(&pool)
                .await;
            assert!(
                res.is_err(),
                "space_id = '{target}' must violate the spaces(id) FK before registration"
            );
        }

        // Flag it — the trigger registers it.
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) \
             VALUES ('SREG708', 'is_space', 'true')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let registered: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM spaces WHERE id = 'SREG708'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            registered, 1,
            "is_space INSERT must register the block via the 0089 trigger"
        );

        // Now the stamp succeeds.
        sqlx::query("UPDATE blocks SET space_id = 'SREG708' WHERE id = 'PREG708'")
            .execute(&pool)
            .await
            .expect("registered space must be a valid space_id FK target");

        // Re-flagging is idempotent (INSERT OR REPLACE shape re-fires the
        // trigger; INSERT OR IGNORE absorbs it).
        sqlx::query(
            "INSERT OR REPLACE INTO block_properties (block_id, key, value_text) \
             VALUES ('SREG708', 'is_space', 'true')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let still_one: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM spaces WHERE id = 'SREG708'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(still_one, 1, "re-flagging must not duplicate registry rows");

        // Purging the space block cascades the registry row away and
        // SET-NULLs the surviving membership (graceful degrade; the boot
        // backfill reassigns).
        sqlx::query("DELETE FROM blocks WHERE id = 'SREG708'")
            .execute(&pool)
            .await
            .unwrap();
        let gone: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM spaces WHERE id = 'SREG708'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(gone, 0, "purging the block must cascade the registry row");
        let nulled: Option<String> =
            sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = 'PREG708'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            nulled, None,
            "ON DELETE SET NULL must clear surviving memberships on space purge"
        );
    }

    // ----------------------------------------------------------------------
    // Deliverable 3: ms-conversion preservation on real seeded data.
    //
    // Seed legacy TEXT timestamps into `op_log.created_at` just before its
    // ms-backfill migration (0079), migrate to head, and assert each INTEGER
    // ms value equals the chrono expectation. op_log.created_at is NOT NULL,
    // so we exercise the valid `...Z`, `+00:00`, sub-second, and space forms
    // here; NULL handling is pinned by Deliverable 1's formula test and by
    // the blocks.deleted_at nullable path below.
    // ----------------------------------------------------------------------

    /// Insert one op_log row with a legacy RFC-3339 `created_at` string at
    /// the pre-0079 schema. (device_id, seq) is the PK; op_log at this point
    /// has columns through 0064's `attachment_id`.
    async fn seed_op_log_row(pool: &SqlitePool, seq: i64, created_at: &str) {
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, hash, op_type, payload, created_at, origin) \
             VALUES ('dev376', ?, 'h', 'create', '{}', ?, 'user')",
        )
        .bind(seq)
        .bind(created_at)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn op_log_created_at_ms_backfill_preserves_instants_376() {
        use chrono::DateTime;

        let (pool, _dir) = unmigrated_pool().await;
        // 0078 is the last migration before op_log's ms cutover (0079).
        apply_migrations_through(&pool, 0, 78).await;

        // seq -> legacy RFC-3339 string. All representative forms.
        let rows = [
            (1_i64, "2025-08-15T12:00:00Z"),
            (2, "2025-08-15T12:00:00+00:00"),
            (3, "2025-08-15T12:00:00.123Z"),
            (4, "2025-08-15 12:00:00"),
        ];
        for (seq, ts) in rows {
            seed_op_log_row(&pool, seq, ts).await;
        }

        apply_migrations_to_head(&pool, 78).await;

        // Every seeded row must survive the rebuild (no row loss), and its
        // created_at must now be the chrono-computed ms instant.
        let surviving: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM op_log WHERE device_id = 'dev376'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            surviving, 4,
            "all seeded op_log rows must survive the 0079 rebuild"
        );

        for (seq, ts) in rows {
            // chrono parse_from_rfc3339 needs a 'T'; normalise the space form.
            let normalized = ts.replacen(' ', "T", 1);
            let normalized = if normalized.ends_with('Z')
                || normalized.contains('+')
                || normalized.matches('-').count() > 2
            {
                normalized
            } else {
                format!("{normalized}Z")
            };
            let expected = DateTime::parse_from_rfc3339(&normalized)
                .unwrap_or_else(|e| panic!("chrono should parse {normalized}: {e}"))
                .timestamp_millis();
            let got: i64 = sqlx::query_scalar(
                "SELECT created_at FROM op_log WHERE device_id = 'dev376' AND seq = ?",
            )
            .bind(seq)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(
                got, expected,
                "op_log seq {seq} ({ts}) must backfill to chrono's {expected} ms"
            );
        }
    }

    /// blocks.deleted_at ms cutover (0080) on the NULLABLE column: a live
    /// block (NULL deleted_at) must stay NULL, and a soft-deleted block's
    /// RFC-3339 string must convert to the chrono ms instant. Seeded just
    /// before 0080 (after 0079), migrated to head.
    #[tokio::test]
    async fn blocks_deleted_at_ms_backfill_handles_null_and_value_376() {
        use chrono::DateTime;

        let (pool, _dir) = unmigrated_pool().await;
        apply_migrations_through(&pool, 0, 79).await;

        // Live block: deleted_at NULL.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content) VALUES ('LIVE376', 'content', 'x')",
        )
        .execute(&pool)
        .await
        .unwrap();
        // Soft-deleted block: legacy RFC-3339 deleted_at string.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, deleted_at) \
             VALUES ('DEL376', 'content', 'y', '2025-08-15T12:00:00.123Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        apply_migrations_to_head(&pool, 79).await;

        let live: Option<i64> =
            sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = 'LIVE376'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            live, None,
            "a live block's NULL deleted_at must stay NULL through 0080"
        );

        let expected = DateTime::parse_from_rfc3339("2025-08-15T12:00:00.123Z")
            .unwrap()
            .timestamp_millis();
        let del: Option<i64> =
            sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = 'DEL376'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            del,
            Some(expected),
            "a soft-deleted block's RFC-3339 deleted_at must backfill to chrono's {expected} ms"
        );
    }

    // ======================================================================
    // Issue #606 — blocks rebuilds cascade-wipe AUTHORITATIVE satellites.
    //
    // `page_aliases.page_id` (0061) and `block_drafts.block_id` (0038) carry
    // `REFERENCES blocks(id) ON DELETE CASCADE`. Unlike attachments /
    // properties / tags, NEITHER re-materializes from the op log at boot:
    // page_aliases emits no op_log entries (#110) and block_drafts is
    // device-local. So the `DROP TABLE blocks` in each shipped rebuild
    // (0073, 0080, 0085) permanently destroyed both tables for upgrading
    // users — the cascade fires as part of the DROP itself, inside the
    // migration transaction (see the #376 section above). 0085's header
    // comment claiming the rebuild is safe for referencing FK rows is FALSE
    // for cascade children; migrations are append-only so the correction
    // lives in migrations/AGENTS.md §Table-rebuild and in these tests.
    //
    // Forward-looking contract pinned here:
    //   * tripwire — 0085 (the last shipped rebuild) does wipe both tables
    //     (documents the real shipped behaviour; if it ever "heals", the
    //     harness drifted);
    //   * drift guard — the detector below scans EVERY migration's SQL for a
    //     `DROP TABLE blocks` statement, asserts the known-wiping set is
    //     exactly {0073, 0080, 0085}, and for every FUTURE rebuild seeds
    //     page_aliases + block_drafts immediately before it and asserts both
    //     survive to head (future rebuilds must copy them aside per
    //     migrations/AGENTS.md §Table-rebuild);
    //   * end-to-end — rows seeded right after 0085 must survive every
    //     later migration to head.
    // ======================================================================

    /// The last shipped blocks rebuild that cascade-wiped the authoritative
    /// satellites. Rebuilds with a version above this MUST preserve them.
    /// Do NOT bump this constant to silence a failing drift test — fix the
    /// new rebuild migration to copy the satellites aside instead.
    const LAST_WIPING_BLOCKS_REBUILD: i64 = 85;

    /// Every shipped blocks rebuild that destroyed page_aliases +
    /// block_drafts (damage is unrecoverable; list is closed).
    const KNOWN_WIPING_BLOCKS_REBUILDS: [i64; 3] = [73, 80, 85];

    /// True if `sql` contains a `DROP TABLE [IF EXISTS] blocks` STATEMENT
    /// (line comments stripped, whitespace collapsed, case-insensitive,
    /// `blocks` matched as a whole identifier).
    ///
    /// Known bounded gaps (deliberate; matching repo SQL style is enough):
    /// a quoted (`"blocks"`) or schema-qualified (`main.blocks`) drop, a
    /// rename-first rebuild (`ALTER TABLE blocks RENAME TO _old_blocks` —
    /// which ALSO re-points child FKs at the renamed table before dropping
    /// it), or a `--` inside a string literal earlier on the same line all
    /// evade this detector. None void the protection: any future migration
    /// that wipes the satellites — however it spells the drop — still fails
    /// `page_aliases_and_block_drafts_survive_migrations_after_0085_606`,
    /// which seeds at 0085 and asserts survival to head. Missing a detection
    /// here only costs the per-rebuild diagnostic precision of the loop in
    /// `future_blocks_rebuild_migrations_must_preserve_alias_and_draft_rows_606`.
    fn sql_drops_blocks_table(sql: &str) -> bool {
        let stripped = sql
            .lines()
            .map(|l| l.split("--").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join(" ")
            .to_uppercase();
        let collapsed = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
        let collapsed = collapsed.replace("DROP TABLE IF EXISTS ", "DROP TABLE ");
        let needle = "DROP TABLE BLOCKS";
        let mut start = 0;
        while let Some(pos) = collapsed[start..].find(needle) {
            let after = start + pos + needle.len();
            match collapsed.as_bytes().get(after) {
                None => return true,
                Some(c) if !c.is_ascii_alphanumeric() && *c != b'_' => return true,
                _ => start = after,
            }
        }
        false
    }

    /// Sorted versions of every UP migration, and the subset whose SQL drops
    /// the `blocks` table (i.e. rebuild-style migrations).
    fn up_migration_versions() -> (Vec<i64>, Vec<i64>) {
        let migrator = sqlx::migrate!("./migrations");
        let mut all: Vec<(i64, bool)> = migrator
            .iter()
            .filter(|m| m.migration_type.is_up_migration())
            .map(|m| (m.version, sql_drops_blocks_table(m.sql.as_str())))
            .collect();
        all.sort_by_key(|(version, _)| *version);
        let versions: Vec<i64> = all.iter().map(|(v, _)| *v).collect();
        let rebuilds: Vec<i64> = all
            .iter()
            .filter(|(_, drops)| *drops)
            .map(|(v, _)| *v)
            .collect();
        (versions, rebuilds)
    }

    /// Seed one page block plus the two authoritative satellites: a
    /// page_aliases row and a block_drafts row. Valid for any schema version
    /// of 0084 or newer (post-0082, block_drafts.updated_at is INTEGER ms;
    /// post-0073, the page_id_self_for_pages CHECK requires page_id = id for
    /// pages).
    async fn seed_page_with_alias_and_draft(pool: &SqlitePool, block_id: &str, alias: &str) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id) \
             VALUES (?, 'page', 'seeded page 606', ?)",
        )
        .bind(block_id)
        .bind(block_id)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO page_aliases (page_id, alias) VALUES (?, ?)")
            .bind(block_id)
            .bind(alias)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO block_drafts (block_id, content, updated_at) \
             VALUES (?, 'draft content 606', 1755259200000)",
        )
        .bind(block_id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Count the seeded alias / draft rows for `block_id` after migrating.
    async fn satellite_counts(pool: &SqlitePool, block_id: &str) -> (i64, i64) {
        let aliases: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM page_aliases WHERE page_id = ?")
                .bind(block_id)
                .fetch_one(pool)
                .await
                .unwrap();
        let drafts: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM block_drafts WHERE block_id = ?")
                .bind(block_id)
                .fetch_one(pool)
                .await
                .unwrap();
        (aliases, drafts)
    }

    /// Tripwire pinning what actually shipped: rows seeded just before the
    /// 0085 blocks rebuild are cascade-wiped by its `DROP TABLE blocks`
    /// (contradicting 0085's own safety header), while the parent block
    /// survives via the bulk copy. The damage class is permanent — neither
    /// table re-materializes from the op log.
    #[tokio::test]
    async fn blocks_0085_rebuild_cascade_wipes_page_aliases_and_drafts_606() {
        let (pool, _dir) = unmigrated_pool().await;
        // 0084 is the last migration before the 0085 blocks rebuild.
        apply_migrations_through(&pool, 0, 84).await;
        seed_page_with_alias_and_draft(&pool, "BLK606A", "alias-606-a").await;

        apply_migrations_to_head(&pool, 84).await;

        let (aliases, drafts) = satellite_counts(&pool, "BLK606A").await;
        assert_eq!(
            (aliases, drafts),
            (0, 0),
            "the 0085 blocks rebuild's DROP TABLE cascade-wipes page_aliases and \
             block_drafts (the shipped #606 data loss; 0085's safety header is false). \
             If either count is now 1, the rebuild's FK behaviour changed — update \
             migrations/AGENTS.md §Table-rebuild and this tripwire together"
        );

        let blk: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = 'BLK606A'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(blk, 1, "the parent block survives the rebuild's bulk copy");
    }

    /// End-to-end forward pin: page_aliases + block_drafts rows seeded right
    /// AFTER the last wiping rebuild (0085) must survive every remaining
    /// migration to head. Any future migration that loses them — rebuild or
    /// otherwise — fails here.
    #[tokio::test]
    async fn page_aliases_and_block_drafts_survive_migrations_after_0085_606() {
        let (pool, _dir) = unmigrated_pool().await;
        apply_migrations_through(&pool, 0, LAST_WIPING_BLOCKS_REBUILD).await;
        seed_page_with_alias_and_draft(&pool, "BLK606B", "alias-606-b").await;

        apply_migrations_to_head(&pool, LAST_WIPING_BLOCKS_REBUILD).await;

        let (aliases, drafts) = satellite_counts(&pool, "BLK606B").await;
        assert_eq!(
            (aliases, drafts),
            (1, 1),
            "page_aliases and block_drafts are AUTHORITATIVE (no op-log recovery; \
             #606) and must survive every migration after 0085. A future blocks \
             rebuild must copy them aside before DROP TABLE blocks and restore them \
             after the rename — see migrations/AGENTS.md §Table-rebuild"
        );
        let draft_content: String =
            sqlx::query_scalar("SELECT content FROM block_drafts WHERE block_id = 'BLK606B'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(draft_content, "draft content 606");
    }

    /// Drift guard over the migration SOURCE: detect every rebuild-style
    /// migration (a `DROP TABLE blocks` statement), pin the known-wiping set
    /// exactly, and for each rebuild newer than 0085 run the full
    /// seed-before / migrate-through / assert-survival cycle so a future
    /// rebuild that forgets the copy-aside step fails this test the moment
    /// it is added.
    #[tokio::test]
    async fn future_blocks_rebuild_migrations_must_preserve_alias_and_draft_rows_606() {
        let (versions, rebuilds) = up_migration_versions();

        // Detector meta-check: the shipped wiping rebuilds must be found
        // exactly. If this fails, the detector regressed (false negatives
        // would silently void the loop below).
        let known: Vec<i64> = rebuilds
            .iter()
            .copied()
            .filter(|v| *v <= LAST_WIPING_BLOCKS_REBUILD)
            .collect();
        assert_eq!(
            known,
            KNOWN_WIPING_BLOCKS_REBUILDS.to_vec(),
            "rebuild detector drifted: it must find exactly the shipped blocks \
             rebuilds 0073/0080/0085 (and never miss one)"
        );

        // Every FUTURE rebuild must preserve the authoritative satellites.
        for rebuild in rebuilds
            .iter()
            .copied()
            .filter(|v| *v > LAST_WIPING_BLOCKS_REBUILD)
        {
            let before = versions
                .iter()
                .copied()
                .filter(|v| *v < rebuild)
                .max()
                .expect("a rebuild migration always has a predecessor");
            let (pool, _dir) = unmigrated_pool().await;
            apply_migrations_through(&pool, 0, before).await;
            seed_page_with_alias_and_draft(&pool, "BLK606C", "alias-606-c").await;
            apply_migrations_to_head(&pool, before).await;

            let (aliases, drafts) = satellite_counts(&pool, "BLK606C").await;
            assert_eq!(
                (aliases, drafts),
                (1, 1),
                "blocks rebuild migration {rebuild} cascade-wipes page_aliases and/or \
                 block_drafts (#606). These tables do NOT recover from the op log — \
                 the rebuild must copy them to scratch tables before `DROP TABLE \
                 blocks` and restore them after the rename. Recipe in \
                 migrations/AGENTS.md §Table-rebuild"
            );
        }
    }

    /// Executable pin of the migrations/AGENTS.md §Table-rebuild recipe: run
    /// the documented copy-aside / swap / restore SQL as a synthetic future
    /// rebuild against the HEAD schema, inside a single transaction exactly
    /// as sqlx wraps a migration, and assert the authoritative satellites
    /// survive. The future-rebuild drift guard above runs zero iterations
    /// until a real post-0085 rebuild lands, so without this test nothing in
    /// CI ever executes the recipe — it could drift (FK mismatch on restore,
    /// TEMP-table/transaction interaction, STRICT friction) and the failure
    /// would surface only while writing the next real rebuild migration.
    #[tokio::test]
    async fn agents_md_table_rebuild_recipe_preserves_satellites_606() {
        let (pool, _dir) = unmigrated_pool().await;
        apply_migrations_to_head(&pool, 0).await;
        seed_page_with_alias_and_draft(&pool, "BLK606D", "alias-606-d").await;

        // Recreate `blocks` verbatim from whatever schema HEAD currently has
        // (so this test never drifts from the real schema), then run the
        // recipe. The DDL must be FULLY redirected to `_new_blocks` — table
        // name AND self-FKs — mirroring 0085's `REFERENCES _new_blocks(id)`
        // pattern: a self-FK left pointing at the OLD `blocks` makes the
        // later `DROP TABLE blocks` abort with `FOREIGN KEY constraint
        // failed` (the copied rows still reference it; the implicit-DELETE
        // check lands at the end of the DROP statement, tx or not). The
        // stored DDL mixes quoted self-FKs (`REFERENCES "blocks"(id)`,
        // rewritten by 0085's RENAME) and unquoted ones (0086's
        // `ADD COLUMN space_id TEXT REFERENCES blocks(id)`).
        let create_blocks: String = sqlx::query_scalar(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'blocks'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let create_new_blocks = create_blocks
            .replace("\"blocks\"", "_new_blocks")
            .replace("REFERENCES blocks(", "REFERENCES _new_blocks(")
            .replace("CREATE TABLE blocks", "CREATE TABLE _new_blocks");
        assert!(
            create_new_blocks.starts_with("CREATE TABLE _new_blocks"),
            "blocks DDL rewrite drifted; stored DDL was: {create_blocks}"
        );
        assert!(
            !create_new_blocks.contains("REFERENCES blocks")
                && !create_new_blocks.contains("REFERENCES \"blocks\""),
            "a self-FK still points at the old blocks table — the synthetic \
             rebuild's DROP would abort. Stored DDL was: {create_blocks}"
        );

        let recipe = format!(
            "{create_new_blocks};\n\
             INSERT INTO _new_blocks SELECT * FROM blocks;\n\
             -- 1. Copy authoritative children aside (BEFORE the DROP).\n\
             CREATE TEMP TABLE _keep_page_aliases AS SELECT * FROM page_aliases;\n\
             CREATE TEMP TABLE _keep_block_drafts AS SELECT * FROM block_drafts;\n\
             -- 2. The rebuild swap. The DROP cascade-empties the children HERE.\n\
             DROP TABLE blocks;\n\
             ALTER TABLE _new_blocks RENAME TO blocks;\n\
             -- 3. Restore the children (their tables survive the cascade, emptied).\n\
             INSERT INTO page_aliases SELECT * FROM _keep_page_aliases;\n\
             INSERT INTO block_drafts SELECT * FROM _keep_block_drafts;\n\
             DROP TABLE _keep_page_aliases;\n\
             DROP TABLE _keep_block_drafts;"
        );
        let mut tx = pool.begin().await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(recipe))
            .execute(&mut *tx)
            .await
            .expect("the AGENTS.md §Table-rebuild recipe must apply cleanly in one tx");
        tx.commit().await.unwrap();

        let (aliases, drafts) = satellite_counts(&pool, "BLK606D").await;
        assert_eq!(
            (aliases, drafts),
            (1, 1),
            "the documented copy-aside/restore recipe must carry page_aliases and \
             block_drafts through a blocks rebuild (migrations/AGENTS.md \
             §Table-rebuild, #606)"
        );
        let blk: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = 'BLK606D'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(blk, 1, "the parent block survives the synthetic rebuild");
    }
}
