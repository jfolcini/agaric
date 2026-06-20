// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

//! Resource-envelope benchmark at 100K blocks (#1231 Phase 3).
//!
//! We bench *latency* everywhere else; this captures the **resource envelope**
//! of a full vault, which had no coverage: how big is the on-disk DB and what
//! does it hold at 100K blocks. Concretely it reports:
//!   - DB file size on disk (main `.db` + `-wal` + `-shm` sidecars),
//!   - row counts for the heavy tables (`blocks`, `op_log`, `block_properties`,
//!     `block_links`),
//!   - bytes-per-block, derived from the above.
//!
//! ## Peak memory — the gap, and why it's not gated here
//! Peak RSS is impractical to measure cleanly inside a Criterion bench: the
//! process already holds the whole prior bench suite, the SQLite page cache,
//! and Criterion's own machinery, so any `getrusage`/`/proc` read would
//! attribute unrelated allocations to "the 100K vault." Peak memory is better
//! captured by an out-of-process probe (e.g. `/usr/bin/time -v` around a
//! single-vault harness or a heaptrack run) — that's the documented gap. The
//! DB-on-disk size is a faithful, reproducible proxy for the persistent
//! footprint, and the page cache (the dominant in-memory cost) is bounded by
//! the SQLite cache_size pragma, not by block count, so disk size is the
//! scale-sensitive number worth tracking here.
//!
//! The envelope numbers are printed to stderr at seed time (visible under
//! `--test`). The benched operation is a cheap `COUNT(*)` so Criterion has a
//! stable thing to time; the *report* is the deliverable, not the timing.
//!
//! ## Fixture schema-drift rules (benches/AGENTS.md)
//! Mirrors `interactive_slo.rs::seed_resolve_fixture`: `op_log.created_at` is
//! INTEGER epoch-ms (0079); `page_id = id` on pages (0073); `blocks.space_id`
//! (0086) backed by a `spaces` registry row (0089); a handful of property rows
//! per block using a free-form (non-reserved) key (0088 CHECK).

use criterion::{Criterion, criterion_group, criterion_main};

use agaric_lib::db::init_pool;

use sqlx::SqlitePool;
use std::path::Path;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// 100K-block vault — the realistic ceiling (#1231).
const VAULT_SIZE: usize = 100_000;

/// ~1 page per 100 content blocks → 1000 pages at 100K total.
const PAGE_COUNT: usize = 1_000;

/// Space ULID for the seeded vault (Crockford base32, 26 chars).
const ENV_SPACE_ID: &str = "01RESOURCEENV000000000000A";

/// Base `op_log.created_at`, epoch milliseconds (2025-01-15T12:00:00Z).
const ENV_BASE_TS_MS: i64 = 1_736_942_400_000;

/// One COUNT(*) is cheap; a small sample keeps the (heavy) seed amortized.
const SAMPLE_SIZE: usize = 10;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async fn open_pool(db_path: &Path) -> SqlitePool {
    init_pool(db_path).await.unwrap()
}

/// Seed `VAULT_SIZE` blocks across `PAGE_COUNT` pages, each content block
/// carrying `page_id`, `space_id`, an `op_log` row, a handful of property
/// rows, and (round-robin) a cross-page link — a realistic full vault.
async fn seed_vault(pool: &SqlitePool, n: usize) {
    let mut tx = pool.begin().await.unwrap();

    // Space owner + registry row (FK target for space_id, migration 0089).
    sqlx::query(
        "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', 'ResourceEnvSpace', NULL, NULL, ?)",
    )
    .bind(ENV_SPACE_ID)
    .bind(ENV_SPACE_ID)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(ENV_SPACE_ID)
        .execute(&mut *tx)
        .await
        .unwrap();

    let mut page_ids: Vec<String> = Vec::with_capacity(PAGE_COUNT);
    for p in 0..PAGE_COUNT {
        let page_id = format!("REPG{p:020}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', ?, NULL, ?, ?, ?)",
        )
        .bind(&page_id)
        .bind(format!("Resource-envelope page {p}"))
        .bind(p as i64 + 1)
        .bind(&page_id)
        .bind(ENV_SPACE_ID)
        .execute(&mut *tx)
        .await
        .unwrap();
        page_ids.push(page_id);
    }

    for i in 0..n {
        let id = format!("REBK{i:020}");
        let content = format!("Resource-envelope block {i} with some placeholder content.");
        let ts = ENV_BASE_TS_MS + i as i64;
        let owning_page = &page_ids[i % PAGE_COUNT];
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'content', ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&content)
        .bind(owning_page)
        .bind(i as i64 + 1)
        .bind(owning_page)
        .bind(ENV_SPACE_ID)
        .execute(&mut *tx)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
             VALUES ('dev-bench', ?, 'fakehash', 'create_block', ?, ?)",
        )
        .bind(i as i64 + 1)
        .bind(format!(
            r#"{{"block_id":"{id}","block_type":"content","parent_id":"{owning_page}","content":"{content}"}}"#,
        ))
        .bind(ts)
        .execute(&mut *tx)
        .await
        .unwrap();

        // A realistic handful of property rows per block (free-form, non-
        // reserved keys — the 0088 CHECK forbids reserved keys here).
        for key in &["custom_a", "custom_b"] {
            sqlx::query(
                "INSERT OR REPLACE INTO block_properties (block_id, key, value_text) \
                 VALUES (?, ?, 'envelope_value')",
            )
            .bind(&id)
            .bind(key)
            .execute(&mut *tx)
            .await
            .unwrap();
        }

        // One cross-page link from each content block (block_links is part of
        // the on-disk footprint).
        let target_page = &page_ids[(i + 1) % PAGE_COUNT];
        sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(&id)
            .bind(target_page)
            .execute(&mut *tx)
            .await
            .unwrap();
    }

    tx.commit().await.unwrap();
}

/// Sum the on-disk size of the SQLite DB and its WAL/SHM sidecars.
fn db_disk_size(db_path: &Path) -> u64 {
    let main = std::fs::metadata(db_path).map_or(0, |m| m.len());
    let wal = std::fs::metadata(format!("{}-wal", db_path.display())).map_or(0, |m| m.len());
    let shm = std::fs::metadata(format!("{}-shm", db_path.display())).map_or(0, |m| m.len());
    main + wal + shm
}

/// Row count for one of the heavy tables. The table name is matched against a
/// fixed allowlist of string literals (never interpolated from a variable) so
/// no dynamic SQL is constructed.
async fn count(pool: &SqlitePool, table: &str) -> i64 {
    let sql = match table {
        "blocks" => "SELECT COUNT(*) FROM blocks",
        "op_log" => "SELECT COUNT(*) FROM op_log",
        "block_properties" => "SELECT COUNT(*) FROM block_properties",
        "block_links" => "SELECT COUNT(*) FROM block_links",
        other => panic!("count(): unexpected table {other}"),
    };
    sqlx::query_scalar::<_, i64>(sql)
        .fetch_one(pool)
        .await
        .unwrap()
}

// ===========================================================================
// resource_envelope — seed once, report DB size + row counts, bench a COUNT(*)
// ===========================================================================

fn bench_resource_envelope(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("resource_envelope_vault.db");

    let pool = rt.block_on(open_pool(&db_path));
    rt.block_on(seed_vault(&pool, VAULT_SIZE));
    // Checkpoint so the main .db file reflects the full vault before sizing.
    rt.block_on(async {
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&pool)
            .await
            .ok();
    });

    // ---- Report the resource envelope (stderr; visible under --test) ----
    let (blocks, ops, props, links, disk) = rt.block_on(async {
        (
            count(&pool, "blocks").await,
            count(&pool, "op_log").await,
            count(&pool, "block_properties").await,
            count(&pool, "block_links").await,
            db_disk_size(&db_path),
        )
    });
    let bytes_per_block = if blocks > 0 {
        disk as f64 / blocks as f64
    } else {
        0.0
    };
    eprintln!("=== resource envelope @ 100K blocks (#1231 Phase 3) ===");
    eprintln!("  blocks rows .............. {blocks}");
    eprintln!("  op_log rows .............. {ops}");
    eprintln!("  block_properties rows .... {props}");
    eprintln!("  block_links rows ......... {links}");
    eprintln!(
        "  DB on disk (db+wal+shm) .. {disk} bytes ({:.2} MiB)",
        disk as f64 / (1024.0 * 1024.0)
    );
    eprintln!("  bytes per block .......... {bytes_per_block:.1}");
    eprintln!("  peak memory .............. NOT measured here (out-of-process gap; see file docs)");

    // ---- Benched op: a cheap COUNT(*) so Criterion has a stable timing ----
    let mut group = c.benchmark_group("resource_envelope");
    group.sample_size(SAMPLE_SIZE);
    group.bench_function("count_blocks_100k", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            async move { count(&pool, "blocks").await }
        });
    });
    group.finish();

    rt.block_on(async { pool.close().await });
}

// ===========================================================================
// Harness
// ===========================================================================

criterion_group!(resource_envelope_benches, bench_resource_envelope);
criterion_main!(resource_envelope_benches);
