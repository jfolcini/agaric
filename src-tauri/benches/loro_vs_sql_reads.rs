//! PEND-09 Phase 0 day-10 — paired SQL read benchmark.
//!
//! Day-7's `read_path_bench` (in the now-archived loro-spike crate; see
//! git tag `pend-09/spike-archive`) measured Loro's three materializer
//! read shapes on a populated 25K-block doc:
//!
//! - (A) per-id `read_block` (single-row keyed lookup) — 2.29 µs/read
//! - (B) `list_children`-equivalent walk (no parent_id index) — 24.83 ms/walk
//! - (C) `read_property` per `(block_id, key)` — 0.88 µs/read
//!
//! That bench could only compare against a qualitative "typical SQL is
//! ~10-50 µs" band because the spike crate has no SQLite dep (by design —
//! the spike's "DO NOT pull in SQLite into the spike crate" rule).
//!
//! This bench is the SQL-side counterpart, run from the agaric crate
//! (which has the production SQLite stack + every migration applied).
//! Same three read shapes, same scale (~25K alive blocks), so the
//! numbers are directly comparable to the day-7 table.
//!
//! ## Bootstrap shape
//!
//! Mirrors the day-4/day-7 spike op-mix as closely as practical via raw
//! SQL inserts (transaction-batched for speed, since the writes are not
//! the thing under test):
//!
//! - 16 page-root blocks (`PAGE_0000..PAGE_0015`)
//! - 25 145 alive content blocks parented under random page roots
//!   (matches the day-7 reference doc's alive count)
//! - ~10 000 `block_properties` rows across four non-reserved keys
//!   (`category`, `theme`, `tag`, `note`) — non-reserved on purpose so
//!   they stay in `block_properties` rather than getting routed to
//!   reserved columns on `blocks` (see `op::is_reserved_property_key`).
//!   The spike-side equivalent stores these in a generic
//!   `(block_id, key) -> value` LoroMap and the read-path numbers are
//!   shape-comparable.
//!
//! ## Three read shapes
//!
//! - **(A)** 10 000 `SELECT id, … FROM blocks WHERE id = ?` — keyed
//!   point lookup against `idx_blocks_*` / blocks PK.  Direct analogue
//!   to the spike's `read_block`.
//! - **(B)** 1 000 `pagination::list_children` calls.  This is the
//!   production hot-path API for "children of X" queries; it serves
//!   the same workload the spike's shape-(B) walk targeted.  Two
//!   sub-measurements:
//!   - **(B1)** first page only (limit = 200 = `MAX_PAGE_SIZE`) — how
//!     production code actually paginates.
//!   - **(B2)** drain all children via cursor pagination — apples-to-
//!     apples against the spike's "collect every child" walk.  The
//!     spike's shape-(B) walk visits all ~25K blocks per parent and
//!     materialises every child, so this is the fairest comparison.
//! - **(C)** 1 000 `SELECT * FROM block_properties WHERE block_id = ?
//!   AND key = ?` — single-row PK lookup on the `(block_id, key)`
//!   primary key.  Direct analogue to the spike's `read_property`.
//!
//! ## Output
//!
//! Wall-clock totals + per-read averages, plus a final summary table
//! that mirrors the day-7 output format so they can be pasted side-by-
//! side into SPIKE-NOTES.md.
//!
//! ## Constraints honoured
//!
//! - DO NOT add `loro` to the agaric crate's deps — this bench is pure
//!   SQL-side.  All Loro numbers below are quoted from the day-7
//!   reference run, not re-measured here.
//! - DO NOT modify production code.  Only this bench file + a
//!   `[[bench]]` entry in `Cargo.toml` are added.
//! - DO NOT modify the spike crate's `LoroEngine`.

// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]
#![allow(clippy::cast_precision_loss)]

use std::time::Instant;

use agaric_lib::db::init_pool;
use agaric_lib::pagination::{list_children, PageRequest};
use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Tunables — match day-7 spike bootstrap as closely as practical.
// ---------------------------------------------------------------------------

/// Page-root pool size, matches replay_bench / read_path_bench.
const PAGE_ROOTS: usize = 16;

/// Alive-block target — day-4 / day-7 reference doc had 25 145 alive
/// blocks at 100K ops; we seed exactly that many for a direct
/// comparison.
const ALIVE_BLOCKS: usize = 25_145;

/// Property rows.  Day-7 synth path issues ~10K SetProperty ops over
/// ~30K created blocks across 4 keys.  We seed 10K rows directly so the
/// `(block_id, key)` PK lookup hits a populated row often enough to
/// exercise the warm path.
const PROPERTY_ROWS: usize = 10_000;

/// Shape (A): `read_block` calls.
const READ_BLOCK_COUNT: usize = 10_000;

/// Shape (B): `list_children` calls.
const LIST_CHILDREN_COUNT: usize = 1_000;

/// Shape (C): property reads.
const READ_PROPERTY_COUNT: usize = 1_000;

/// Property keys.  Non-reserved on purpose so they live in
/// `block_properties` (reserved keys — `priority`, `todo_state`,
/// `due_date`, `scheduled_date` — would route to columns on `blocks`
/// via the production `is_reserved_property_key` helper, which would
/// not exercise the `block_properties` PK index this bench is
/// measuring).
const PROPERTY_KEYS: &[&str] = &["category", "theme", "tag", "note"];

/// `pagination::PageRequest` clamps `limit` to [1, MAX_PAGE_SIZE] = 200.
/// Production hot-path queries paginate at this ceiling for "fetch a
/// page of children".
const MAX_PAGE: i64 = 200;

/// Same seed shape as the spike's xorshift bootstrap so the bench is
/// reproducible run-over-run.
const SEED: u64 = 0x9E37_79B9_7F4A_7C15;

// ---------------------------------------------------------------------------
// xorshift* — tiny PRNG, same generator as the spike's read_path_bench so
// the two benches share their RNG idiom (avoids pulling rand into the
// agaric bench harness).
// ---------------------------------------------------------------------------

struct XorShift64 {
    state: u64,
}

impl XorShift64 {
    fn new(seed: u64) -> Self {
        let s = if seed == 0 {
            0xDEAD_BEEF_CAFE_BABE
        } else {
            seed
        };
        Self { state: s }
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn next_index(&mut self, n: usize) -> usize {
        if n == 0 {
            return 0;
        }
        (self.next_u64() % (n as u64)) as usize
    }
}

// ---------------------------------------------------------------------------
// Bootstrap — bulk-insert a populated DB matching the day-7 spike shape.
// ---------------------------------------------------------------------------

async fn bootstrap(pool: &SqlitePool) -> (Vec<String>, Vec<String>) {
    let mut rng = XorShift64::new(SEED);

    // 1. Page roots.
    let mut page_roots = Vec::with_capacity(PAGE_ROOTS);
    let mut tx = pool.begin().await.unwrap();
    for i in 0..PAGE_ROOTS {
        let id = format!("PAGE_{i:04}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position) \
             VALUES (?, 'page', ?, ?)",
        )
        .bind(&id)
        .bind(format!("Page {i}"))
        .bind((i as i64) * 10_000)
        .execute(&mut *tx)
        .await
        .unwrap();
        page_roots.push(id);
    }
    tx.commit().await.unwrap();

    // 2. Alive content blocks.  Single transaction batched in chunks of
    // 1 000 so the WAL doesn't get hammered (matches the
    // pagination_bench seed pattern).
    let mut block_ids = Vec::with_capacity(ALIVE_BLOCKS);
    let chunk_size = 1_000;
    let mut idx = 0usize;
    while idx < ALIVE_BLOCKS {
        let mut tx = pool.begin().await.unwrap();
        let end = (idx + chunk_size).min(ALIVE_BLOCKS);
        for i in idx..end {
            let id = format!("BLK_{i:08}");
            let parent = &page_roots[rng.next_index(PAGE_ROOTS)];
            // Spread positions over a wide range like the spike's
            // synth path (rng.next_u64() as i64).  Sentinel-NULL is
            // not used here — every block gets a real position.
            let position = (rng.next_u64() >> 1) as i64;
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'content', ?, ?, ?)",
            )
            .bind(&id)
            .bind(format!("block #{i}"))
            .bind(parent)
            .bind(position)
            .execute(&mut *tx)
            .await
            .unwrap();
            block_ids.push(id);
        }
        tx.commit().await.unwrap();
        idx = end;
    }

    // 3. Property rows.  ~10K rows across 4 non-reserved keys, randomly
    // assigned to alive blocks.  The (block_id, key) PK enforces
    // uniqueness, so we pick distinct (block_id, key) pairs by
    // tracking a small bitset per block.  Cheaper alternative: try
    // each insert and fall through on PK conflict.  Since 10K rows
    // over 25K blocks × 4 keys = 100K possible cells, we'd hit ~1%
    // collision — fast enough to just OR-IGNORE and loop until we
    // have enough rows.
    let mut prop_rng = XorShift64::new(SEED ^ 0xDEAD_BEEF_F00D_C0DE);
    let mut prop_count = 0usize;
    let mut attempts = 0usize;
    let max_attempts = PROPERTY_ROWS * 4;
    let mut tx = pool.begin().await.unwrap();
    while prop_count < PROPERTY_ROWS && attempts < max_attempts {
        let bidx = prop_rng.next_index(block_ids.len());
        let kidx = prop_rng.next_index(PROPERTY_KEYS.len());
        let block_id = &block_ids[bidx];
        let key = PROPERTY_KEYS[kidx];
        let value = format!("v_{}", prop_rng.next_u64() & 0xFFFF);
        // OR IGNORE so PK collisions silently skip.
        let res = sqlx::query(
            "INSERT OR IGNORE INTO block_properties (block_id, key, value_text) \
             VALUES (?, ?, ?)",
        )
        .bind(block_id)
        .bind(key)
        .bind(&value)
        .execute(&mut *tx)
        .await
        .unwrap();
        if res.rows_affected() > 0 {
            prop_count += 1;
        }
        attempts += 1;
        if attempts % 1_000 == 0 {
            // Commit periodically so the WAL stays bounded.
            tx.commit().await.unwrap();
            tx = pool.begin().await.unwrap();
        }
    }
    tx.commit().await.unwrap();

    println!(
        "bootstrap: {PAGE_ROOTS} page roots + {ALIVE_BLOCKS} alive blocks + \
         {prop_count} property rows ({attempts} attempts)",
    );
    (page_roots, block_ids)
}

// ---------------------------------------------------------------------------
// Shape A — single-row WHERE id = ? × 10K
// ---------------------------------------------------------------------------

async fn shape_a(pool: &SqlitePool, block_ids: &[String]) -> std::time::Duration {
    let mut sample_rng = XorShift64::new(SEED ^ 0xA77E_AD7E_AD7E_AD7E);
    let targets: Vec<&str> = (0..READ_BLOCK_COUNT)
        .map(|_| block_ids[sample_rng.next_index(block_ids.len())].as_str())
        .collect();

    let start = Instant::now();
    let mut hits = 0usize;
    for id in &targets {
        // sqlx::query_as! requires a static literal; we use a typed
        // tuple with `query_scalar` for the cheapest possible path
        // (just confirm the row exists).  But the real comparison
        // shape is "fetch a row" — so we materialise the same column
        // set BlockRow uses, via `query_as`.  This matches the work
        // the spike's `read_block` does on the Loro side (decode +
        // clone the block's content + parent_id + position fields).
        let row: Option<(String, String, Option<String>, Option<String>, Option<i64>)> =
            sqlx::query_as(
                "SELECT id, block_type, content, parent_id, position \
                 FROM blocks WHERE id = ?",
            )
            .bind(*id)
            .fetch_optional(pool)
            .await
            .unwrap();
        if row.is_some() {
            hits += 1;
        }
    }
    let elapsed = start.elapsed();
    let per = elapsed / READ_BLOCK_COUNT as u32;
    println!("---- shape (A): SELECT … WHERE id = ? × {READ_BLOCK_COUNT} ----");
    println!(
        "  total elapsed = {:.3}s   ({:>7.2} µs/read)",
        elapsed.as_secs_f64(),
        per.as_secs_f64() * 1_000_000.0,
    );
    println!("  hits = {hits} / {READ_BLOCK_COUNT}");
    elapsed
}

// ---------------------------------------------------------------------------
// Shape B — list_children × 1K
// ---------------------------------------------------------------------------

/// (B1) first page only — limit = 200, no cursor pagination.
async fn shape_b1(pool: &SqlitePool, page_roots: &[String]) -> std::time::Duration {
    let mut sample_rng = XorShift64::new(SEED ^ 0xB1B1_B1B1_B1B1_B1B1);
    let targets: Vec<&str> = (0..LIST_CHILDREN_COUNT)
        .map(|_| page_roots[sample_rng.next_index(page_roots.len())].as_str())
        .collect();

    let page = PageRequest::new(None, Some(MAX_PAGE)).unwrap();
    let start = Instant::now();
    let mut total_rows = 0usize;
    for parent in &targets {
        let resp = list_children(pool, Some(parent), &page, None)
            .await
            .unwrap();
        total_rows += resp.items.len();
    }
    let elapsed = start.elapsed();
    let per = elapsed / LIST_CHILDREN_COUNT as u32;
    println!(
        "---- shape (B1): list_children first-page (limit={MAX_PAGE}) × {LIST_CHILDREN_COUNT} ----"
    );
    println!(
        "  total elapsed = {:.3}s   ({:>7.2} µs/call = {:>7.3} ms/call)",
        elapsed.as_secs_f64(),
        per.as_secs_f64() * 1_000_000.0,
        per.as_secs_f64() * 1_000.0,
    );
    println!(
        "  total rows fetched = {total_rows} (avg {:.1} rows/call)",
        total_rows as f64 / LIST_CHILDREN_COUNT as f64,
    );
    elapsed
}

/// (B2) drain all children — cursor-paginate until exhausted.  This is
/// the apples-to-apples comparison against the spike's shape-(B) walk,
/// which collects every child.
async fn shape_b2(pool: &SqlitePool, page_roots: &[String]) -> std::time::Duration {
    let mut sample_rng = XorShift64::new(SEED ^ 0xB2B2_B2B2_B2B2_B2B2);
    let targets: Vec<&str> = (0..LIST_CHILDREN_COUNT)
        .map(|_| page_roots[sample_rng.next_index(page_roots.len())].as_str())
        .collect();

    let start = Instant::now();
    let mut total_rows = 0usize;
    for parent in &targets {
        let mut after: Option<String> = None;
        loop {
            let page = PageRequest::new(after.clone(), Some(MAX_PAGE)).unwrap();
            let resp = list_children(pool, Some(parent), &page, None)
                .await
                .unwrap();
            total_rows += resp.items.len();
            match resp.next_cursor {
                Some(cursor) => after = Some(cursor),
                None => break,
            }
        }
    }
    let elapsed = start.elapsed();
    let per = elapsed / LIST_CHILDREN_COUNT as u32;
    println!("---- shape (B2): list_children drain-all (paginated) × {LIST_CHILDREN_COUNT} ----");
    println!(
        "  total elapsed = {:.3}s   ({:>7.3} ms/walk = {:>7.2} µs/walk)",
        elapsed.as_secs_f64(),
        per.as_secs_f64() * 1_000.0,
        per.as_secs_f64() * 1_000_000.0,
    );
    println!(
        "  total rows visited = {total_rows} (avg {:.1} rows/walk)",
        total_rows as f64 / LIST_CHILDREN_COUNT as f64,
    );
    elapsed
}

// ---------------------------------------------------------------------------
// Shape C — single-row block_properties point lookup × 1K
// ---------------------------------------------------------------------------

async fn shape_c(pool: &SqlitePool, block_ids: &[String]) -> std::time::Duration {
    let mut sample_rng = XorShift64::new(SEED ^ 0xC0FF_EE00_C0FF_EE00);
    let targets: Vec<(String, &'static str)> = (0..READ_PROPERTY_COUNT)
        .map(|_| {
            let bid = block_ids[sample_rng.next_index(block_ids.len())].clone();
            let key = PROPERTY_KEYS[sample_rng.next_index(PROPERTY_KEYS.len())];
            (bid, key)
        })
        .collect();

    let start = Instant::now();
    let mut hits = 0usize;
    let mut misses = 0usize;
    for (block_id, key) in &targets {
        // Single-row lookup on the (block_id, key) primary key.
        let row: Option<(Option<String>, Option<f64>, Option<String>, Option<String>)> =
            sqlx::query_as(
                "SELECT value_text, value_num, value_date, value_ref \
             FROM block_properties WHERE block_id = ? AND key = ?",
            )
            .bind(block_id)
            .bind(*key)
            .fetch_optional(pool)
            .await
            .unwrap();
        if row.is_some() {
            hits += 1;
        } else {
            misses += 1;
        }
    }
    let elapsed = start.elapsed();
    let per = elapsed / READ_PROPERTY_COUNT as u32;
    println!("---- shape (C): SELECT … FROM block_properties WHERE block_id = ? AND key = ? × {READ_PROPERTY_COUNT} ----");
    println!(
        "  total elapsed = {:.3}s   ({:>7.2} µs/read)",
        elapsed.as_secs_f64(),
        per.as_secs_f64() * 1_000_000.0,
    );
    println!("  hits = {hits}, misses = {misses}");
    elapsed
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

fn main() {
    let overall = Instant::now();

    println!("PEND-09 Phase 0 day-10 — paired SQL read benchmark");
    println!("===================================================");
    println!("seed                 = 0x{SEED:016x}");
    println!("page roots           = {PAGE_ROOTS}");
    println!("alive blocks         = {ALIVE_BLOCKS}");
    println!("property rows        = {PROPERTY_ROWS}");
    println!("shape A reads        = {READ_BLOCK_COUNT}");
    println!("shape B walks        = {LIST_CHILDREN_COUNT}");
    println!("shape C reads        = {READ_PROPERTY_COUNT}");
    println!();

    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(async { init_pool(&dir.path().join("loro_vs_sql.db")).await.unwrap() });

    let bootstrap_start = Instant::now();
    let (page_roots, block_ids) = rt.block_on(async { bootstrap(&pool).await });
    println!(
        "bootstrap done in {:.3}s (alive blocks = {})",
        bootstrap_start.elapsed().as_secs_f64(),
        block_ids.len(),
    );
    println!();

    let a = rt.block_on(async { shape_a(&pool, &block_ids).await });
    println!();
    let b1 = rt.block_on(async { shape_b1(&pool, &page_roots).await });
    println!();
    let b2 = rt.block_on(async { shape_b2(&pool, &page_roots).await });
    println!();
    let c = rt.block_on(async { shape_c(&pool, &block_ids).await });
    println!();

    // ---- Headline summary table — same shape as day-7's --------------
    println!("---- summary table (SQL — agaric crate) ----");
    println!("| shape                                   | reads   | total       | per-read     |");
    println!("| --------------------------------------- | ------- | ----------- | ------------ |");
    println!(
        "| (A) SELECT WHERE id = ?                 | {:>7} | {:>7.3}s    | {:>7.2} µs   |",
        READ_BLOCK_COUNT,
        a.as_secs_f64(),
        (a / READ_BLOCK_COUNT as u32).as_secs_f64() * 1_000_000.0,
    );
    println!(
        "| (B1) list_children first-page (lim 200) | {:>7} | {:>7.3}s    | {:>7.2} µs   |",
        LIST_CHILDREN_COUNT,
        b1.as_secs_f64(),
        (b1 / LIST_CHILDREN_COUNT as u32).as_secs_f64() * 1_000_000.0,
    );
    println!(
        "| (B2) list_children drain-all            | {:>7} | {:>7.3}s    | {:>7.3} ms   |",
        LIST_CHILDREN_COUNT,
        b2.as_secs_f64(),
        (b2 / LIST_CHILDREN_COUNT as u32).as_secs_f64() * 1_000.0,
    );
    println!(
        "| (C) block_properties WHERE id, key      | {:>7} | {:>7.3}s    | {:>7.2} µs   |",
        READ_PROPERTY_COUNT,
        c.as_secs_f64(),
        (c / READ_PROPERTY_COUNT as u32).as_secs_f64() * 1_000_000.0,
    );
    println!();

    // ---- Day-7 Loro reference numbers (quoted, NOT re-measured) ------
    //
    // The Loro spike crate was a separate cargo workspace member during
    // Phase 0 (archived in Phase-2 day-8; see git tag
    // `pend-09/spike-archive`); we honour the "do not add loro to agaric
    // deps" rule.  These numbers come from the day-7 reference run
    // logged at git tag `pend-09/spike-archive` (spike-notes.md within
    // the archived crate; see also `SESSION-LOG.md` Session 698).
    println!("---- day-7 Loro reference (quoted from git tag pend-09/spike-archive) ----");
    println!("| (A) Loro read_block                     | 10000 |  0.023s   |    2.29 µs   |");
    println!("| (B) Loro list_children-walk             |  1000 | 24.832s   |   24.83 ms   |");
    println!("| (C) Loro read_property                  |  1000 |  0.001s   |    0.88 µs   |");
    println!();

    // ---- Ratio summary ------------------------------------------------
    let a_per_us = (a / READ_BLOCK_COUNT as u32).as_secs_f64() * 1_000_000.0;
    let b1_per_us = (b1 / LIST_CHILDREN_COUNT as u32).as_secs_f64() * 1_000_000.0;
    let b2_per_ms = (b2 / LIST_CHILDREN_COUNT as u32).as_secs_f64() * 1_000.0;
    let c_per_us = (c / READ_PROPERTY_COUNT as u32).as_secs_f64() * 1_000_000.0;

    let loro_a_us = 2.29;
    let loro_b_ms = 24.83;
    let loro_c_us = 0.88;

    println!("---- Loro vs SQL ratios ----");
    println!(
        "  Shape (A): Loro {loro_a_us:.2} µs vs SQL {a_per_us:.2} µs  →  Loro is {:.2}× {} than SQL",
        if a_per_us >= loro_a_us {
            a_per_us / loro_a_us
        } else {
            loro_a_us / a_per_us
        },
        if a_per_us >= loro_a_us {
            "faster"
        } else {
            "slower"
        },
    );
    println!(
        "  Shape (B1, first page only): SQL {b1_per_us:.2} µs vs Loro {:.2} µs (full walk; SQL not directly comparable)",
        loro_b_ms * 1_000.0,
    );
    println!(
        "  Shape (B2, drain all): Loro {loro_b_ms:.2} ms vs SQL {b2_per_ms:.3} ms  →  SQL is {:.0}× {} than Loro",
        if b2_per_ms >= loro_b_ms {
            b2_per_ms / loro_b_ms
        } else {
            loro_b_ms / b2_per_ms
        },
        if b2_per_ms >= loro_b_ms {
            "slower"
        } else {
            "faster"
        },
    );
    println!(
        "  Shape (C): Loro {loro_c_us:.2} µs vs SQL {c_per_us:.2} µs  →  Loro is {:.2}× {} than SQL",
        if c_per_us >= loro_c_us {
            c_per_us / loro_c_us
        } else {
            loro_c_us / c_per_us
        },
        if c_per_us >= loro_c_us {
            "faster"
        } else {
            "slower"
        },
    );
    println!();

    println!(
        "total wall-clock (incl. bootstrap) = {:.3}s",
        overall.elapsed().as_secs_f64(),
    );
}
