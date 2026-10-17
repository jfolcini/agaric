// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

//! Criterion benchmark for MCP tool dispatch with and without the agent gate
//! (#5667) on a 100K-block vault.
//!
//! `with_gate` is what every `tools/call` pays since agents: the agent's row
//! re-read by id, the space check on its arguments, and the throttled
//! `last_used_ms` stamp (`ConnectedAgent::authorize`), then the tool.
//! `without_gate` is the tool alone. `connect` is the token lookup a
//! connection pays once. The tools are a cheap read (`get_block`) and a
//! typical one (`list_pages`); the agent is limited to two spaces so the
//! check compares ids rather than returning early.

use criterion::{Criterion, criterion_group};

use agaric_core::ulid::BlockId;
use agaric_lib::db::init_pool;
use agaric_lib::materializer::Materializer;
use agaric_lib::mcp::agents::{AgentStore, McpAgentMode, insert_agent};
use agaric_lib::mcp::registry::ToolRegistry;
use agaric_lib::mcp::tools_rw::ReadWriteTools;
use agaric_store::cache::rebuild_pages_cache;
use agaric_store::task_locals::{Actor, ActorContext};

use serde_json::{Value, json};
use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

const SPACE_ID: &str = "01TESTSPACE000000000000001";
const OTHER_SPACE_ID: &str = "01TESTSPACE000000000000002";
const PAGES: usize = 100;
const BLOCKS_PER_PAGE: usize = 1_000;

/// A space: its `page` block and its `spaces` row (migration 0089's FK).
async fn ensure_space(pool: &SqlitePool, id: &str) {
    sqlx::query(
        "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?1, 'page', 'BenchSpace', NULL, NULL, ?1)",
    )
    .bind(id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

/// `PAGES` pages of `BLOCKS_PER_PAGE` content blocks in `SPACE_ID`, in one
/// transaction. Returns a content block's id.
async fn seed_vault(pool: &SqlitePool) -> String {
    ensure_space(pool, SPACE_ID).await;
    ensure_space(pool, OTHER_SPACE_ID).await;
    let mut tx = pool.begin().await.unwrap();
    let mut block = String::new();
    for p in 0..PAGES {
        let page_id = BlockId::new().into_string();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position, page_id, space_id) \
             VALUES (?1, 'page', ?2, ?3, ?1, ?4)",
        )
        .bind(&page_id)
        .bind(format!("Bench page {p}"))
        .bind(p as i64 + 1)
        .bind(SPACE_ID)
        .execute(&mut *tx)
        .await
        .unwrap();
        for i in 0..BLOCKS_PER_PAGE {
            let id = BlockId::new().into_string();
            sqlx::query(
                "INSERT INTO blocks \
                 (id, block_type, content, parent_id, position, page_id, space_id) \
                 VALUES (?1, 'content', ?2, ?3, ?4, ?3, ?5)",
            )
            .bind(&id)
            .bind(format!("Block {i} of page {p}, a few words of content."))
            .bind(&page_id)
            .bind(i as i64 + 1)
            .bind(SPACE_ID)
            .execute(&mut *tx)
            .await
            .unwrap();
            block = id;
        }
    }
    tx.commit().await.unwrap();
    // `list_pages` reads the page rows the materializer keeps.
    rebuild_pages_cache(pool).await.unwrap();
    block
}

fn agent_ctx() -> ActorContext {
    ActorContext {
        actor: Actor::Agent {
            name: "Bench".to_owned(),
        },
        request_id: "bench".to_owned(),
    }
}

fn bench_mcp_dispatch(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt
        .block_on(init_pool(&dir.path().join("mcp_dispatch.db")))
        .unwrap();
    let block = rt.block_on(seed_vault(&pool));
    // `Materializer::new` spawns onto the runtime it is called in.
    let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
    let tools = ReadWriteTools::new(
        pool.clone(),
        pool.clone(),
        materializer.clone(),
        "bench".into(),
    );
    let agent = rt
        .block_on(insert_agent(
            &pool,
            "Bench",
            McpAgentMode::ReadWrite,
            Some(vec![SPACE_ID.to_owned(), OTHER_SPACE_ID.to_owned()]),
        ))
        .unwrap()
        .unwrap();
    let store = AgentStore::new(pool.clone(), pool.clone());
    let connected = rt.block_on(store.connect(&agent.token)).unwrap().unwrap();
    let ctx = agent_ctx();
    let calls: [(&str, Value); 2] = [
        (
            "get_block",
            json!({ "block_id": block, "space_id": SPACE_ID }),
        ),
        ("list_pages", json!({ "space_id": SPACE_ID, "limit": 50 })),
    ];

    // Shape probe: a fixture that degrades into an error or an empty page
    // would look like a speedup.
    let blocks: i64 = rt
        .block_on(sqlx::query_scalar("SELECT COUNT(*) FROM blocks").fetch_one(&pool))
        .unwrap();
    assert!(
        blocks > (PAGES * BLOCKS_PER_PAGE) as i64,
        "a 100K-block vault"
    );
    let read = rt
        .block_on(tools.call_tool("get_block", calls[0].1.clone(), &ctx))
        .unwrap();
    assert_eq!(read["id"], block, "get_block reads the seeded block");
    let listed = rt
        .block_on(tools.call_tool("list_pages", calls[1].1.clone(), &ctx))
        .unwrap();
    assert_eq!(
        listed["items"].as_array().map(Vec::len),
        Some(50),
        "a full page of pages"
    );
    rt.block_on(connected.authorize(&calls[0].1)).unwrap();

    let mut group = c.benchmark_group("mcp_dispatch");
    for (tool, args) in &calls {
        group.bench_function(format!("{tool}/without_gate"), |b| {
            b.to_async(&rt)
                .iter(|| async { tools.call_tool(tool, args.clone(), &ctx).await.unwrap() });
        });
        group.bench_function(format!("{tool}/with_gate"), |b| {
            b.to_async(&rt).iter(|| async {
                connected.authorize(args).await.unwrap();
                tools.call_tool(tool, args.clone(), &ctx).await.unwrap()
            });
        });
    }
    group.bench_function("connect", |b| {
        b.to_async(&rt)
            .iter(|| async { store.connect(&agent.token).await.unwrap().unwrap() });
    });
    group.finish();
    materializer.shutdown();
}

criterion_group!(mcp_dispatch_benches, bench_mcp_dispatch);
