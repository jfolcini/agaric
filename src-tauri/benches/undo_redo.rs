//! Criterion benchmarks for undo/redo operations at scale.
//!
//! Tests the performance of:
//!   1. `compute_reverse` — reverse-op computation with 100k ops in the log
//!   2. `list_page_history` — page-level history query with 100k ops
//!   3. `list_page_history` — deep nesting (10 levels, ~1111 blocks)
//!   4. `undo_page_op_inner` — undo at various depths (0, 10, 50, 100, 500)
//!   5. `revert_ops_inner` — batch revert of 50 ops from 100k op database
//!
//! Manual only — never in CI or pre-commit (see AGENTS.md).

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

use agaric_lib::commands::{
    compute_edit_diff_inner, redo_page_op_inner, restore_page_to_op_inner, revert_ops_inner,
    undo_page_op_inner,
};
use agaric_lib::db::init_pool;
use agaric_lib::materializer::Materializer;
use agaric_lib::op::OpRef;
use agaric_lib::pagination::{self, PageRequest};
use agaric_lib::reverse;

use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BENCH_DEVICE: &str = "bench-device";

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

/// Seed a page with `num_blocks` children, each with `ops_per_block` edit ops.
///
/// Returns `(page_id, total_seq_count)` where `total_seq_count` is the total
/// number of ops inserted (1 page create + num_blocks child creates + edits).
///
/// Uses raw SQL INSERTs in a single transaction for maximum speed.
async fn seed_flat_page(
    pool: &SqlitePool,
    num_blocks: usize,
    ops_per_block: usize,
) -> (String, i64) {
    let page_id = format!("PAGE{:020}", 0);
    let mut seq: i64 = 0;

    let mut tx = pool.begin().await.unwrap();

    // Create page block
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position) VALUES (?, 'page', 'Bench Page', 1)",
    )
    .bind(&page_id)
    .execute(&mut *tx)
    .await
    .unwrap();

    seq += 1;
    let ts = format!("2025-01-15T12:00:00.{seq:03}Z");
    let payload_json = format!(
        r#"{{"block_id":"{page_id}","block_type":"page","parent_id":null,"position":1,"content":"Bench Page"}}"#
    );
    sqlx::query(
        "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
         VALUES (?, ?, 'fakehash', 'create_block', ?, ?)",
    )
    .bind(BENCH_DEVICE)
    .bind(seq)
    .bind(&payload_json)
    .bind(&ts)
    .execute(&mut *tx)
    .await
    .unwrap();

    // Create child blocks and their edit ops
    for i in 0..num_blocks {
        let block_id = format!("BLK{i:020}");
        let position = i as i64 + 1;

        // Insert block row
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, ?, ?)",
        )
        .bind(&block_id)
        .bind(format!("Initial content {i}"))
        .bind(&page_id)
        .bind(position)
        .execute(&mut *tx)
        .await
        .unwrap();

        // Append create_block op
        seq += 1;
        let ts = format!(
            "2025-01-15T12:{:02}:{:02}.{:03}Z",
            seq / 3600,
            (seq / 60) % 60,
            seq % 1000
        );
        let create_json = format!(
            r#"{{"block_id":"{block_id}","block_type":"content","parent_id":"{page_id}","position":{position},"content":"Initial content {i}"}}"#
        );
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
             VALUES (?, ?, 'fakehash', 'create_block', ?, ?)",
        )
        .bind(BENCH_DEVICE)
        .bind(seq)
        .bind(&create_json)
        .bind(&ts)
        .execute(&mut *tx)
        .await
        .unwrap();

        // Append edit_block ops
        for j in 0..ops_per_block {
            seq += 1;
            let ts = format!(
                "2025-01-15T12:{:02}:{:02}.{:03}Z",
                seq / 3600,
                (seq / 60) % 60,
                seq % 1000
            );
            let edit_json = format!(
                r#"{{"block_id":"{block_id}","to_text":"Edit {j} of block {i}","prev_edit":null}}"#
            );
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
                 VALUES (?, ?, 'fakehash', 'edit_block', ?, ?)",
            )
            .bind(BENCH_DEVICE)
            .bind(seq)
            .bind(&edit_json)
            .bind(&ts)
            .execute(&mut *tx)
            .await
            .unwrap();
        }

        // Update block content to final edit
        if ops_per_block > 0 {
            sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
                .bind(format!("Edit {} of block {i}", ops_per_block - 1))
                .bind(&block_id)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
    }

    tx.commit().await.unwrap();
    (page_id, seq)
}

/// Seed a deeply nested page tree.
///
/// Creates a tree with `depth` levels. At each level, one "primary" child
/// gets further children (depth-first), plus `(width - 1)` leaf siblings.
/// Each block gets `ops_per_block` edit ops.
///
/// Total blocks ≈ width^depth (geometric series).
///
/// Returns `(root_page_id, total_seq_count)`.
async fn seed_deep_page(
    pool: &SqlitePool,
    depth: usize,
    width: usize,
    ops_per_block: usize,
) -> (String, i64) {
    let root_id = format!("ROOT{:020}", 0);
    let mut seq: i64 = 0;

    let mut tx = pool.begin().await.unwrap();

    // Create root page block
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position) VALUES (?, 'page', 'Root', 1)",
    )
    .bind(&root_id)
    .execute(&mut *tx)
    .await
    .unwrap();

    seq += 1;
    let ts = format!("2025-01-15T12:00:00.{seq:03}Z");
    let payload_json = format!(
        r#"{{"block_id":"{root_id}","block_type":"page","parent_id":null,"position":1,"content":"Root"}}"#
    );
    sqlx::query(
        "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
         VALUES (?, ?, 'fakehash', 'create_block', ?, ?)",
    )
    .bind(BENCH_DEVICE)
    .bind(seq)
    .bind(&payload_json)
    .bind(&ts)
    .execute(&mut *tx)
    .await
    .unwrap();

    // Recursive helper — uses a stack to avoid deep function recursion
    struct StackItem {
        parent_id: String,
        current_depth: usize,
    }

    let mut stack = vec![StackItem {
        parent_id: root_id.clone(),
        current_depth: 0,
    }];

    while let Some(item) = stack.pop() {
        if item.current_depth >= depth {
            continue;
        }

        for w in 0..width {
            let block_id = format!("D{:02}W{:02}S{:06}", item.current_depth, w, seq);
            let position = w as i64 + 1;

            // Insert block
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'content', ?, ?, ?)",
            )
            .bind(&block_id)
            .bind(format!("depth={} width={w}", item.current_depth))
            .bind(&item.parent_id)
            .bind(position)
            .execute(&mut *tx)
            .await
            .unwrap();

            // Append create op
            seq += 1;
            let ts = format!(
                "2025-01-15T12:{:02}:{:02}.{:03}Z",
                (seq / 3600) % 24,
                (seq / 60) % 60,
                seq % 1000
            );
            let create_json = format!(
                r#"{{"block_id":"{block_id}","block_type":"content","parent_id":"{}","position":{position},"content":"depth={} width={w}"}}"#,
                item.parent_id, item.current_depth
            );
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
                 VALUES (?, ?, 'fakehash', 'create_block', ?, ?)",
            )
            .bind(BENCH_DEVICE)
            .bind(seq)
            .bind(&create_json)
            .bind(&ts)
            .execute(&mut *tx)
            .await
            .unwrap();

            // Append edit ops
            for j in 0..ops_per_block {
                seq += 1;
                let ts = format!(
                    "2025-01-15T12:{:02}:{:02}.{:03}Z",
                    (seq / 3600) % 24,
                    (seq / 60) % 60,
                    seq % 1000
                );
                let edit_json =
                    format!(r#"{{"block_id":"{block_id}","to_text":"Edit {j}","prev_edit":null}}"#);
                sqlx::query(
                    "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
                     VALUES (?, ?, 'fakehash', 'edit_block', ?, ?)",
                )
                .bind(BENCH_DEVICE)
                .bind(seq)
                .bind(&edit_json)
                .bind(&ts)
                .execute(&mut *tx)
                .await
                .unwrap();
            }

            // Only the first child at each level gets further nesting
            if w == 0 {
                stack.push(StackItem {
                    parent_id: block_id,
                    current_depth: item.current_depth + 1,
                });
            }
        }
    }

    tx.commit().await.unwrap();
    (root_id, seq)
}

/// Create a fresh pool in a temp dir.
async fn fresh_pool(dir: &TempDir, name: &str) -> SqlitePool {
    let db_path = dir.path().join(format!("{name}.db"));
    init_pool(&db_path).await.unwrap()
}

// ===========================================================================
// Benchmark 1: compute_reverse with 100k ops in the log
// ===========================================================================

/// Seed 100 child blocks × 1000 edits each = 100k edit ops + 101 creates.
/// Then benchmark `compute_reverse` on the LAST op (worst-case: must walk
/// back through the log to find prior text).
fn bench_compute_reverse_100k_ops(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "reverse_100k"));

    let (_page_id, last_seq) = rt.block_on(seed_flat_page(&pool, 100, 1000));

    c.bench_function("compute_reverse_100k_ops", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            async move {
                reverse::compute_reverse(&pool, BENCH_DEVICE, last_seq)
                    .await
                    .unwrap()
            }
        })
    });
}

// ===========================================================================
// Benchmark 2: list_page_history with 100k ops (first page, limit=50)
// ===========================================================================

fn bench_list_page_history_100k_ops(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "page_history_100k"));

    let (page_id, _last_seq) = rt.block_on(seed_flat_page(&pool, 100, 1000));

    c.bench_function("list_page_history_100k_first_page", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            let page_id = page_id.clone();
            async move {
                let page = PageRequest::new(None, Some(50)).unwrap();
                pagination::list_page_history(&pool, &page_id, None, &page)
                    .await
                    .unwrap()
            }
        })
    });
}

// ===========================================================================
// Benchmark 3: list_page_history with deep nesting (10 levels)
// ===========================================================================

/// 10-level deep tree with 10 children per level (only the first child at
/// each level branches further). Total blocks ≈ 10 × 10 = ~100 blocks
/// (linear chain with 9 siblings at each level). Each block gets 10 edit ops.
fn bench_list_page_history_deep_nesting(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "page_history_deep"));

    let (root_page_id, _last_seq) = rt.block_on(seed_deep_page(&pool, 10, 10, 10));

    c.bench_function("list_page_history_deep_10_levels", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            let root_page_id = root_page_id.clone();
            async move {
                let page = PageRequest::new(None, Some(50)).unwrap();
                pagination::list_page_history(&pool, &root_page_id, None, &page)
                    .await
                    .unwrap()
            }
        })
    });
}

// ===========================================================================
// Benchmark 4: undo_page_op_inner at various depths
// ===========================================================================

/// Benchmark undo at depth=0, 10, 50, 100, 500.
///
/// Since `undo_page_op_inner` writes to the DB (appends a reverse op), each
/// iteration mutates state. To keep the benchmark meaningful we re-seed the
/// database for each depth group but accept the growing op log across
/// iterations within a depth. The query cost dominates the write cost, so
/// this still measures the read-heavy path accurately.
fn bench_undo_page_op_various_depths(c: &mut Criterion) {
    let mut group = c.benchmark_group("undo_page_op_depth");

    for depth in [0, 10, 50, 100, 500] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("undo_d{depth}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

        // Seed 100 blocks × 1000 edits = 100k edit ops.
        // We need at least `depth + 1` ops in the page history.
        let (page_id, _last_seq) = rt.block_on(seed_flat_page(&pool, 100, 1000));

        group.bench_function(format!("depth_{depth}"), |b| {
            b.to_async(&rt).iter(|| {
                let pool = pool.clone();
                let materializer_ref = &materializer;
                let page_id = page_id.clone();
                async move {
                    undo_page_op_inner(&pool, BENCH_DEVICE, materializer_ref, page_id, depth)
                        .await
                        .unwrap()
                }
            })
        });

        rt.block_on(async { materializer.shutdown() });
    }
    group.finish();
}

// ===========================================================================
// Benchmark 5: revert_ops_inner — batch revert 50 ops from 100k op database
// ===========================================================================

/// Benchmark batch-reverting 50 edit_block ops from a 100k op database.
///
/// Like undo, `revert_ops_inner` writes to the DB. We re-seed per benchmark
/// but accept growing state across iterations.
fn bench_revert_ops_batch_50(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt.block_on(fresh_pool(&dir, "revert_50"));
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

    let (_page_id, last_seq) = rt.block_on(seed_flat_page(&pool, 100, 1000));

    // Build 50 OpRefs targeting recent edit_block ops (from the end of the log).
    // Each op must be a distinct edit_block (not create_block or page create).
    // The last `num_blocks * ops_per_block` ops are edit_blocks, so the final 50
    // are safe targets.
    let ops: Vec<OpRef> = (0..50)
        .map(|i| OpRef {
            device_id: BENCH_DEVICE.to_string(),
            seq: last_seq - i,
        })
        .collect();

    c.bench_function("revert_ops_batch_50", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            let materializer_ref = &materializer;
            let ops = ops.clone();
            async move {
                revert_ops_inner(&pool, BENCH_DEVICE, materializer_ref, ops)
                    .await
                    .unwrap()
            }
        })
    });

    rt.block_on(async { materializer.shutdown() });
}

// ===========================================================================
// Benchmark 6: restore_page_to_op_inner — restore to a mid-point
// ===========================================================================

/// Seed N/2 child blocks, edit each once → N total ops (N/2 creates + N/2 edits).
/// Pick target_seq at the midpoint (the Nth op from the start = N/2).
/// Each iteration uses a fresh DB because restore is destructive.
fn bench_restore_page_to_op(c: &mut Criterion) {
    let mut group = c.benchmark_group("restore_page_to_op");

    for total_ops in [100, 500, 1000] {
        let num_blocks = total_ops / 2;

        group.bench_with_input(
            BenchmarkId::from_parameter(total_ops),
            &total_ops,
            |b, _| {
                let rt = Runtime::new().unwrap();
                b.iter_custom(|iters| {
                    let start = std::time::Instant::now();
                    for _ in 0..iters {
                        let dir = TempDir::new().unwrap();
                        let pool = rt.block_on(fresh_pool(&dir, "restore"));
                        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

                        // Seed: num_blocks children × 1 edit each = 2*num_blocks ops + 1 page create
                        let (_page_id, _last_seq) =
                            rt.block_on(seed_flat_page(&pool, num_blocks, 1));

                        // target_seq at midpoint: the Nth op (= num_blocks-th op, which is the
                        // last create_block before edits start; seq is 1-based, page create is seq=1,
                        // then creates are seq 2..num_blocks+1, edits are num_blocks+2..2*num_blocks+1)
                        let target_seq = (num_blocks as i64) + 1; // last create_block seq

                        let page_id = format!("PAGE{:020}", 0);
                        rt.block_on(async {
                            restore_page_to_op_inner(
                                &pool,
                                BENCH_DEVICE,
                                &materializer,
                                page_id,
                                BENCH_DEVICE.to_string(),
                                target_seq,
                            )
                            .await
                            .unwrap()
                        });

                        rt.block_on(async { materializer.shutdown() });
                    }
                    start.elapsed()
                });
            },
        );
    }
    group.finish();
}

// ===========================================================================
// Benchmark 7: redo_page_op_inner — redo at various DB sizes
// ===========================================================================

/// Setup: create page + block, edit block, undo (so there's something to redo).
/// Parameterize by total blocks in the DB (measures index pressure).
/// Each iteration: undo then redo (to always have something to redo).
fn bench_redo_page_op(c: &mut Criterion) {
    let mut group = c.benchmark_group("redo_page_op");

    for db_blocks in [100, 1000, 10_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("redo_{db_blocks}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

        // Seed db_blocks children (0 extra edits) to create index pressure
        let (page_id, _last_seq) = rt.block_on(seed_flat_page(&pool, db_blocks, 0));

        // Create one extra block + edit it so we have an edit op to undo/redo
        let target_block_id = format!("REDO_TARGET{:012}", 0);
        rt.block_on(async {
            let mut tx = pool.begin().await.unwrap();

            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'content', 'before', ?, ?)",
            )
            .bind(&target_block_id)
            .bind(&page_id)
            .bind(db_blocks as i64 + 1)
            .execute(&mut *tx)
            .await
            .unwrap();

            // create_block op
            let create_seq = _last_seq + 1;
            let create_json = format!(
                r#"{{"block_id":"{target_block_id}","block_type":"content","parent_id":"{page_id}","position":{},"content":"before"}}"#,
                db_blocks as i64 + 1
            );
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
                 VALUES (?, ?, 'fakehash', 'create_block', ?, '2025-01-15T13:00:00.000Z')",
            )
            .bind(BENCH_DEVICE)
            .bind(create_seq)
            .bind(&create_json)
            .execute(&mut *tx)
            .await
            .unwrap();

            // edit_block op
            let edit_seq = create_seq + 1;
            let edit_json = format!(
                r#"{{"block_id":"{target_block_id}","to_text":"after","prev_edit":null}}"#
            );
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
                 VALUES (?, ?, 'fakehash', 'edit_block', ?, '2025-01-15T13:00:01.000Z')",
            )
            .bind(BENCH_DEVICE)
            .bind(edit_seq)
            .bind(&edit_json)
            .execute(&mut *tx)
            .await
            .unwrap();

            sqlx::query("UPDATE blocks SET content = 'after' WHERE id = ?")
                .bind(&target_block_id)
                .execute(&mut *tx)
                .await
                .unwrap();

            tx.commit().await.unwrap();
        });

        group.bench_with_input(
            BenchmarkId::from_parameter(db_blocks),
            &db_blocks,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let materializer_ref = &materializer;
                    let page_id = page_id.clone();
                    async move {
                        // Undo the last edit so there's something to redo
                        let undo_result =
                            undo_page_op_inner(&pool, BENCH_DEVICE, materializer_ref, page_id, 0)
                                .await
                                .unwrap();

                        // Redo
                        redo_page_op_inner(
                            &pool,
                            BENCH_DEVICE,
                            materializer_ref,
                            undo_result.new_op_ref.device_id,
                            undo_result.new_op_ref.seq,
                        )
                        .await
                        .unwrap()
                    }
                })
            },
        );

        rt.block_on(async { materializer.shutdown() });
    }
    group.finish();
}

// ===========================================================================
// Benchmark 8: compute_edit_diff_inner — diff at various content sizes
// ===========================================================================

/// Seed a block, edit it with content of a given size, then benchmark
/// compute_edit_diff_inner. Parameterize by content size: short (50),
/// medium (500), long (5000) characters.
fn bench_compute_edit_diff(c: &mut Criterion) {
    let mut group = c.benchmark_group("compute_edit_diff");

    for (label, size) in [("short_50", 50), ("medium_500", 500), ("long_5000", 5000)] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("diff_{label}")));

        let block_id = format!("DIFFBLK{:016}", 0);
        let page_id = format!("DIFFPAGE{:016}", 0);

        // Generate content strings of the specified size
        let initial_content: String = "a".repeat(size);
        // Change roughly half the content so the diff is non-trivial
        let edited_content: String = "b".repeat(size / 2) + &"a".repeat(size - size / 2);

        let edit_seq: i64 = rt.block_on(async {
            let mut tx = pool.begin().await.unwrap();

            // Create page block
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, position) VALUES (?, 'page', 'Diff Page', 1)",
            )
            .bind(&page_id)
            .execute(&mut *tx)
            .await
            .unwrap();

            // Create page op
            let page_create_json = format!(
                r#"{{"block_id":"{page_id}","block_type":"page","parent_id":null,"position":1,"content":"Diff Page"}}"#
            );
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
                 VALUES (?, 1, 'fakehash', 'create_block', ?, '2025-01-15T12:00:00.000Z')",
            )
            .bind(BENCH_DEVICE)
            .bind(&page_create_json)
            .execute(&mut *tx)
            .await
            .unwrap();

            // Create child block
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'content', ?, ?, 1)",
            )
            .bind(&block_id)
            .bind(&initial_content)
            .bind(&page_id)
            .execute(&mut *tx)
            .await
            .unwrap();

            let create_json = format!(
                r#"{{"block_id":"{block_id}","block_type":"content","parent_id":"{page_id}","position":1,"content":"{initial_content}"}}"#
            );
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
                 VALUES (?, 2, 'fakehash', 'create_block', ?, '2025-01-15T12:00:01.000Z')",
            )
            .bind(BENCH_DEVICE)
            .bind(&create_json)
            .execute(&mut *tx)
            .await
            .unwrap();

            // Edit block op
            let edit_json = format!(
                r#"{{"block_id":"{block_id}","to_text":"{edited_content}","prev_edit":null}}"#
            );
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
                 VALUES (?, 3, 'fakehash', 'edit_block', ?, '2025-01-15T12:00:02.000Z')",
            )
            .bind(BENCH_DEVICE)
            .bind(&edit_json)
            .execute(&mut *tx)
            .await
            .unwrap();

            sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
                .bind(&edited_content)
                .bind(&block_id)
                .execute(&mut *tx)
                .await
                .unwrap();

            tx.commit().await.unwrap();
            3i64 // edit op is seq=3
        });

        group.bench_function(label, |b| {
            b.to_async(&rt).iter(|| {
                let pool = pool.clone();
                async move {
                    compute_edit_diff_inner(&pool, BENCH_DEVICE.to_string(), edit_seq)
                        .await
                        .unwrap()
                }
            })
        });
    }
    group.finish();
}

// ===========================================================================
// Harness
// ===========================================================================

criterion_group!(reverse_benches, bench_compute_reverse_100k_ops,);

criterion_group!(
    page_history_benches,
    bench_list_page_history_100k_ops,
    bench_list_page_history_deep_nesting,
);

criterion_group!(undo_benches, bench_undo_page_op_various_depths,);

criterion_group!(revert_benches, bench_revert_ops_batch_50,);

criterion_group!(restore_benches, bench_restore_page_to_op,);

criterion_group!(redo_benches, bench_redo_page_op,);

criterion_group!(diff_benches, bench_compute_edit_diff,);

criterion_main!(
    reverse_benches,
    page_history_benches,
    undo_benches,
    revert_benches,
    restore_benches,
    redo_benches,
    diff_benches,
);
