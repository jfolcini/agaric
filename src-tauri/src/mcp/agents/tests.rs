//! The agent gate at tool dispatch (#5667): mode, spaces, revoke, the
//! throttled `last_used_ms`, and the cross-space gaps the design accepts.
//!
//! Calls go through `RmcpAdapter::dispatch_tool_call` over the registry the
//! agent's mode picks, as `handle_connection` builds it; the handshake that
//! picks it is in `server/tests_rmcp.rs`.

use std::sync::{Arc, Mutex};

use rmcp::model::ErrorData;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tempfile::TempDir;

use super::{AgentStore, ConnectedAgent, McpAgent, McpAgentMode, SPACE_ARGS, insert_agent};
use crate::commands::{
    create_block_inner, create_block_inner_with_space, create_space_inner, edit_block_inner,
    move_blocks_to_space_inner,
};
use crate::materializer::Materializer;
use crate::mcp::activity::{ActivityContext, ActivityResult, ActivityRing, RecordingEmitter};
use crate::mcp::rmcp_adapter::{RmcpAdapter, tool_result_json};
use crate::mcp::tools_ro::ReadOnlyTools;
use crate::mcp::tools_rw::ReadWriteTools;
use agaric_core::ulid::BlockId;
use agaric_store::space::{SpaceId, SpaceScope};

const DEV: &str = "dev-5667";
const A: usize = 0;
const B: usize = 1;
const C: usize = 2;

/// Three spaces, A, B and C, each with one page titled `Page A` and so on,
/// and the registries a connection is served by.
struct Vault {
    pool: SqlitePool,
    mat: Materializer,
    spaces: [String; 3],
    pages: [String; 3],
    read_only: Arc<ReadOnlyTools>,
    read_write: Arc<ReadWriteTools>,
    ring: Arc<Mutex<ActivityRing>>,
    _dir: TempDir,
}

impl Vault {
    async fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("t.db"))
            .await
            .unwrap();
        let mat = Materializer::new(pool.clone());
        let mut spaces = Vec::new();
        let mut pages = Vec::new();
        for label in ["A", "B", "C"] {
            let space = create_space_inner(&pool, DEV, &mat, format!("Space {label}"), None)
                .await
                .unwrap()
                .into_string();
            let page = page_in(&pool, &mat, &space, &format!("Page {label}")).await;
            spaces.push(space);
            pages.push(page);
        }
        mat.flush_background().await.unwrap();
        Self {
            read_only: Arc::new(ReadOnlyTools::new(
                pool.clone(),
                pool.clone(),
                mat.clone(),
                DEV.into(),
            )),
            read_write: Arc::new(ReadWriteTools::new(
                pool.clone(),
                pool.clone(),
                mat.clone(),
                DEV.into(),
            )),
            spaces: spaces.try_into().unwrap(),
            pages: pages.try_into().unwrap(),
            ring: Arc::new(Mutex::new(ActivityRing::new())),
            pool,
            mat,
            _dir: dir,
        }
    }

    /// An agent on the spaces at `spaces` (`None`: every space).
    async fn agent(&self, name: &str, mode: McpAgentMode, spaces: Option<&[usize]>) -> McpAgent {
        let space_ids = spaces.map(|ix| ix.iter().map(|&i| self.spaces[i].clone()).collect());
        insert_agent(&self.pool, name, mode, space_ids)
            .await
            .unwrap()
            .expect("the name is free")
    }

    async fn connect(&self, agent: &McpAgent) -> ConnectedAgent {
        AgentStore::new(self.pool.clone(), self.pool.clone())
            .connect(&agent.token)
            .await
            .unwrap()
            .expect("the token is live")
    }

    /// One call on `agent`'s connection, served by the registry its mode
    /// picks.
    async fn call_as(
        &self,
        agent: &ConnectedAgent,
        tool: &str,
        args: Value,
    ) -> Result<Value, ErrorData> {
        let activity = Some(ActivityContext::new(
            self.ring.clone(),
            Arc::new(RecordingEmitter::new()),
        ));
        let result = match agent.mode {
            McpAgentMode::ReadOnly => {
                RmcpAdapter::new(self.read_only.clone(), activity, agent.clone())
                    .dispatch_tool_call(tool.to_owned(), args)
                    .await
            }
            McpAgentMode::ReadWrite => {
                RmcpAdapter::new(self.read_write.clone(), activity, agent.clone())
                    .dispatch_tool_call(tool.to_owned(), args)
                    .await
            }
        };
        result.map(|result| tool_result_json(&result))
    }

    async fn call(&self, agent: &McpAgent, tool: &str, args: Value) -> Result<Value, ErrorData> {
        let connected = self.connect(agent).await;
        self.call_as(&connected, tool, args).await
    }

    /// A content block under `parent`, written as the user.
    async fn block_under(&self, parent: &str, content: &str) -> String {
        let block = create_block_inner(
            &self.pool,
            DEV,
            &self.mat,
            "content".into(),
            content.into(),
            Some(BlockId::from_trusted(parent)),
            None,
        )
        .await
        .unwrap();
        self.mat.flush_background().await.unwrap();
        block.id.into_string()
    }
}

async fn page_in(pool: &SqlitePool, mat: &Materializer, space: &str, title: &str) -> String {
    create_block_inner_with_space(
        pool,
        DEV,
        mat,
        "page".into(),
        title.into(),
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(space)),
        None,
    )
    .await
    .unwrap()
    .id
    .into_string()
}

/// The call was refused before it ran, for naming `space`.
fn assert_space_refused(result: Result<Value, ErrorData>, space: &str) {
    let error = result.expect_err("a space outside the agent's is refused");
    assert_eq!(error.code.0, -32602, "{error:?}");
    assert!(
        error.message.contains("may not use space") && error.message.contains(space),
        "the refusal names the space: {}",
        error.message,
    );
}

fn space_ids(listed: &Value) -> Vec<&str> {
    listed
        .as_array()
        .expect("list_spaces answers an array")
        .iter()
        .map(|row| row["id"].as_str().unwrap())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn space_outside_the_agent_is_refused_5667() {
    let v = Vault::new().await;
    let agent = v.agent("Reader", McpAgentMode::ReadOnly, Some(&[A])).await;

    let own = v
        .call(
            &agent,
            "get_page",
            json!({ "page_id": v.pages[A], "space_id": v.spaces[A] }),
        )
        .await
        .expect("its own space");
    assert_eq!(own["page"]["id"], v.pages[A]);

    assert_space_refused(
        v.call(
            &agent,
            "get_page",
            json!({ "page_id": v.pages[B], "space_id": v.spaces[B] }),
        )
        .await,
        &v.spaces[B],
    );
}

/// Reads, writes, search, backlinks, lookups by id and by title, and the
/// tools without a space.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restricted_agent_neither_reads_nor_writes_outside_its_spaces_5667() {
    let v = Vault::new().await;
    v.block_under(&v.pages[B], "needle in B").await;
    let agent = v.agent("Writer", McpAgentMode::ReadWrite, Some(&[A])).await;
    let b = v.spaces[B].as_str();

    for (tool, args) in [
        ("search", json!({ "query": "needle", "space_id": b })),
        (
            "list_backlinks",
            json!({ "block_id": v.pages[B], "space_id": b }),
        ),
        (
            "get_block",
            json!({ "block_id": v.pages[B], "space_id": b }),
        ),
        (
            "page_history",
            json!({ "page_id": "Page B", "space_id": b }),
        ),
        ("list_pages", json!({ "space_id": b })),
        ("create_page", json!({ "title": "Sneaky", "space_id": b })),
        (
            "append_block",
            json!({ "parent_id": v.pages[B], "content": "x", "space_id": b }),
        ),
    ] {
        assert_space_refused(v.call(&agent, tool, args).await, b);
    }

    // Named in its own space, a page of another one is not found there.
    let by_title = v
        .call(
            &agent,
            "page_history",
            json!({ "page_id": "Page B", "space_id": v.spaces[A] }),
        )
        .await
        .expect_err("Page B is not in space A");
    assert_eq!(by_title.code.0, -32602, "{by_title:?}");
    let search = v
        .call(
            &agent,
            "search",
            json!({ "query": "needle", "space_id": v.spaces[A] }),
        )
        .await
        .expect("search in its own space");
    assert_eq!(search["items"], json!([]), "B's block is not found from A");

    // Property definitions are per space (#5841), behind the same gate.
    v.call(
        &agent,
        "list_property_defs",
        json!({ "space_id": v.spaces[A] }),
    )
    .await
    .expect("its own space's definitions");
    assert_space_refused(
        v.call(
            &agent,
            "list_property_defs",
            json!({ "space_id": v.spaces[B] }),
        )
        .await,
        &v.spaces[B],
    );
    assert_eq!(
        space_ids(&v.call(&agent, "list_spaces", json!({})).await.unwrap()),
        [v.spaces[A].as_str()],
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_to_a_disallowed_space_is_refused_5667() {
    let v = Vault::new().await;
    let agent = v.agent("Mover", McpAgentMode::ReadWrite, Some(&[A])).await;

    assert_space_refused(
        v.call(
            &agent,
            "move_page_to_space",
            json!({
                "page_id": v.pages[A],
                "space_id": v.spaces[A],
                "target_space_id": v.spaces[B],
            }),
        )
        .await,
        &v.spaces[B],
    );

    let space: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
        .bind(&v.pages[A])
        .fetch_one(&v.pool)
        .await
        .unwrap();
    assert_eq!(
        space.as_deref(),
        Some(v.spaces[A].as_str()),
        "the page stays in A"
    );
}

/// The tools uppercase a ULID argument; the gate reads it the same way.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lowercase_space_id_checks_like_the_handler_5667() {
    let v = Vault::new().await;
    let agent = v.agent("Reader", McpAgentMode::ReadOnly, Some(&[A])).await;

    v.call(
        &agent,
        "list_pages",
        json!({ "space_id": v.spaces[A].to_lowercase() }),
    )
    .await
    .expect("its own space, spelled in lowercase");
    assert_space_refused(
        v.call(
            &agent,
            "list_pages",
            json!({ "space_id": v.spaces[B].to_lowercase() }),
        )
        .await,
        &v.spaces[B],
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_spaces_lists_only_the_agents_spaces_5667() {
    let v = Vault::new().await;
    let all: Vec<String> = sqlx::query_scalar(
        "SELECT s.id FROM spaces s JOIN blocks b ON b.id = s.id AND b.deleted_at IS NULL",
    )
    .fetch_all(&v.pool)
    .await
    .unwrap();

    let one = v.agent("One", McpAgentMode::ReadOnly, Some(&[B])).await;
    assert_eq!(
        space_ids(&v.call(&one, "list_spaces", json!({})).await.unwrap()),
        [v.spaces[B].as_str()],
    );

    let every = v.agent("Every", McpAgentMode::ReadOnly, None).await;
    let mut listed: Vec<String> =
        space_ids(&v.call(&every, "list_spaces", json!({})).await.unwrap())
            .into_iter()
            .map(str::to_owned)
            .collect();
    listed.sort();
    let mut all = all;
    all.sort();
    assert_eq!(listed, all, "an agent on every space lists every space");
    assert_eq!(all.len(), 3, "the vault's three spaces");
}

/// Every argument that names a space is one the gate reads, and required,
/// so a tool cannot run in a space the gate never saw.
#[test]
fn space_args_cover_every_tool_schema_5667() {
    let mut spaceless = Vec::new();
    for tool in crate::mcp::tools_rw::list_tool_descriptions() {
        let properties = tool.input_schema["properties"]
            .as_object()
            .unwrap_or_else(|| panic!("{}: no properties", tool.name));
        let required: Vec<&str> = tool.input_schema["required"]
            .as_array()
            .map(|r| r.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let named: Vec<&String> = properties
            .keys()
            .filter(|key| key.ends_with("space_id"))
            .collect();
        for key in &named {
            assert!(
                SPACE_ARGS.contains(&key.as_str()),
                "{}: `{key}` names a space the gate does not read",
                tool.name,
            );
            assert!(
                required.contains(&key.as_str()),
                "{}: `{key}` is optional, so the tool can run in a space the gate never saw",
                tool.name,
            );
        }
        if named.is_empty() {
            spaceless.push(tool.name);
        }
    }
    assert_eq!(spaceless, ["list_spaces"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoked_agent_is_refused_on_its_next_call_5667() {
    let v = Vault::new().await;
    let agent = v.agent("Gone", McpAgentMode::ReadOnly, None).await;
    let connected = v.connect(&agent).await;
    let args = || json!({ "space_id": v.spaces[A] });

    v.call_as(&connected, "list_pages", args())
        .await
        .expect("live");
    assert!(super::delete_agent(&v.pool, &agent.id).await.unwrap());

    let error = v
        .call_as(&connected, "list_pages", args())
        .await
        .expect_err("revoked while connected");
    assert_eq!(error.code.0, -32001, "{error:?}");
    assert!(
        error.message.contains("'Gone' was revoked"),
        "the refusal names the agent: {}",
        error.message,
    );
    let last = v.ring.lock().unwrap().entries().back().cloned().unwrap();
    assert_eq!(last.tool_name, "list_pages");
    assert_eq!(last.agent_name.as_deref(), Some("Gone"));
    assert!(
        matches!(last.result, ActivityResult::Err(_)),
        "the refusal reaches the activity feed: {:?}",
        last.result,
    );
}

async fn last_used(pool: &SqlitePool, id: &str) -> Option<i64> {
    sqlx::query_scalar("SELECT last_used_ms FROM mcp_agents WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn last_used_is_stamped_by_a_call_5667() {
    let v = Vault::new().await;
    let agent = v.agent("Stamp", McpAgentMode::ReadOnly, None).await;
    assert_eq!(last_used(&v.pool, &agent.id).await, None, "never used");

    let before = crate::db::now_ms();
    v.call(&agent, "list_spaces", json!({})).await.unwrap();

    let stamped = last_used(&v.pool, &agent.id).await.expect("stamped");
    assert!(
        stamped >= before,
        "stamped at the call: {stamped} < {before}"
    );
}

/// A burst of calls costs one `last_used_ms` write, and a stamp older than
/// the resolution is renewed. Writes are counted by a trigger on the row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_burst_of_calls_stamps_last_used_once_5667() {
    let v = Vault::new().await;
    sqlx::query("CREATE TABLE stamp_writes (n INTEGER NOT NULL)")
        .execute(&v.pool)
        .await
        .unwrap();
    sqlx::query(
        "CREATE TRIGGER count_stamps AFTER UPDATE OF last_used_ms ON mcp_agents \
         BEGIN INSERT INTO stamp_writes VALUES (1); END",
    )
    .execute(&v.pool)
    .await
    .unwrap();
    let writes = || async {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM stamp_writes")
            .fetch_one(&v.pool)
            .await
            .unwrap()
    };
    let agent = v.agent("Burst", McpAgentMode::ReadOnly, None).await;
    let connected = v.connect(&agent).await;

    for _ in 0..100 {
        v.call_as(&connected, "list_spaces", json!({}))
            .await
            .unwrap();
    }
    assert_eq!(writes().await, 1, "100 calls, one write");

    let stale = crate::db::now_ms() - super::LAST_USED_RESOLUTION_MS - 1_000;
    sqlx::query("UPDATE mcp_agents SET last_used_ms = ? WHERE id = ?")
        .bind(stale)
        .bind(&agent.id)
        .execute(&v.pool)
        .await
        .unwrap();
    v.call_as(&connected, "list_spaces", json!({}))
        .await
        .unwrap();
    assert_eq!(writes().await, 3, "the backdate, then one renewal");
    assert!(last_used(&v.pool, &agent.id).await.unwrap() > stale);
}

// ── The gaps design § 5 accepts, pinned as documented ──────────────────
//
// Each shows at most a title or an id from a space the agent may not use,
// and only through a link the user wrote.

/// A block of page A links `Linked`, which then moves to B with `Other`,
/// whose child links it too. A link written across spaces is refused, so a
/// move is how one arises. Returns (the link in A, `Linked`).
async fn link_that_crosses_to_b(v: &Vault) -> (String, String) {
    let linked = page_in(&v.pool, &v.mat, &v.spaces[A], "Linked").await;
    let other = page_in(&v.pool, &v.mat, &v.spaces[A], "Other").await;
    let link = format!("see [[{linked}]]");
    let from_a = v.block_under(&v.pages[A], &link).await;
    v.block_under(&other, &link).await;
    move_blocks_to_space_inner(
        &v.pool,
        DEV,
        &v.mat,
        vec![
            BlockId::from_trusted(&linked),
            BlockId::from_trusted(&other),
        ],
        v.spaces[B].clone(),
    )
    .await
    .unwrap();
    v.mat.flush_background().await.unwrap();
    (from_a, linked)
}

/// Gap 1: Markdown names a linked page of another space by its title.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gap_markdown_names_a_linked_page_of_another_space_5667() {
    let v = Vault::new().await;
    link_that_crosses_to_b(&v).await;
    let agent = v.agent("Reader", McpAgentMode::ReadOnly, Some(&[A])).await;

    let page = v
        .call(
            &agent,
            "get_page_markdown",
            json!({ "page_id": v.pages[A], "space_id": v.spaces[A] }),
        )
        .await
        .unwrap();
    assert!(
        page["markdown"].as_str().unwrap().contains("[[Linked]]"),
        "the link reads as the title of B's page: {page}",
    );
}

/// Gap 2: a block's history keeps the text it had in its old space.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gap_history_keeps_a_moved_blocks_text_from_its_old_space_5667() {
    let v = Vault::new().await;
    let moving = page_in(&v.pool, &v.mat, &v.spaces[B], "Moving").await;
    let block = v.block_under(&moving, "drafted in B").await;
    edit_block_inner(
        &v.pool,
        DEV,
        &v.mat,
        BlockId::from_trusted(&block),
        "final".into(),
    )
    .await
    .unwrap();
    move_blocks_to_space_inner(
        &v.pool,
        DEV,
        &v.mat,
        vec![BlockId::from_trusted(&moving)],
        v.spaces[A].clone(),
    )
    .await
    .unwrap();
    v.mat.flush_background().await.unwrap();
    let agent = v.agent("Reader", McpAgentMode::ReadOnly, Some(&[A])).await;

    let history = v
        .call(
            &agent,
            "block_history",
            json!({ "block_id": block, "space_id": v.spaces[A] }),
        )
        .await
        .unwrap();
    assert!(
        history.to_string().contains("drafted in B"),
        "the text written in B shows: {history}",
    );
}

/// Gap 3: backlinks accept a target in another space; the sources stay in
/// the agent's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gap_backlinks_take_a_target_in_another_space_5667() {
    let v = Vault::new().await;
    let (from_a, linked) = link_that_crosses_to_b(&v).await;
    let agent = v.agent("Reader", McpAgentMode::ReadOnly, Some(&[A])).await;

    let backlinks = v
        .call(
            &agent,
            "list_backlinks",
            json!({ "block_id": linked, "space_id": v.spaces[A] }),
        )
        .await
        .unwrap();
    let sources: Vec<&str> = backlinks["groups"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|group| group["blocks"].as_array().unwrap())
        .map(|block| block["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        sources,
        [from_a.as_str()],
        "only the source in A: {backlinks}"
    );
}

/// Gap 4: a block of another space is refused with that space's id.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gap_a_refusal_names_the_targets_space_5667() {
    let v = Vault::new().await;
    let agent = v.agent("Reader", McpAgentMode::ReadOnly, Some(&[A])).await;

    let error = v
        .call(
            &agent,
            "get_block",
            json!({ "block_id": v.pages[B], "space_id": v.spaces[A] }),
        )
        .await
        .expect_err("B's page is not in A");
    assert!(
        error.message.contains(&v.spaces[B]),
        "the refusal names B: {}",
        error.message,
    );
    assert_space_refused(
        v.call(
            &agent,
            "get_block",
            json!({ "block_id": v.pages[B], "space_id": v.spaces[B] }),
        )
        .await,
        &v.spaces[B],
    );
}

/// Gap 5: an argument may name a block of another space; what is read or
/// written stays in the agent's space. A ref-typed property naming another
/// space's block is refused outright (`validate_ref_property_cross_space`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gap_ids_of_another_space_in_arguments_stay_in_scope_5667() {
    let v = Vault::new().await;
    v.block_under(&v.pages[B], "needle under B").await;
    let in_a = v.block_under(&v.pages[A], "in A").await;
    let agent = v.agent("Writer", McpAgentMode::ReadWrite, Some(&[A])).await;

    let found = v
        .call(
            &agent,
            "search",
            json!({ "query": "needle", "parent_id": v.pages[B], "space_id": v.spaces[A] }),
        )
        .await
        .expect("a parent in another space is taken");
    assert_eq!(found["items"], json!([]), "nothing of B is found");

    let error = v
        .call(
            &agent,
            "set_property",
            json!({ "block_id": in_a, "key": "related", "value_ref": v.pages[B], "space_id": v.spaces[A] }),
        )
        .await
        .expect_err("a ref to another space's block is refused");
    assert_eq!(error.code.0, -32602, "{error:?}");
}

// ── The property: a call runs exactly when mode and spaces allow it ────

/// One generated call: a tool and the spaces its arguments name.
#[derive(Debug, Clone)]
enum Call {
    ListPages(usize),
    GetPage(usize),
    Search(usize),
    GetPageMarkdown(usize),
    ListSpaces,
    CreatePage(usize),
    AppendBlock(usize),
    MovePage { from: usize, to: usize },
}

impl Call {
    fn writes(&self) -> bool {
        matches!(
            self,
            Self::CreatePage(_) | Self::AppendBlock(_) | Self::MovePage { .. }
        )
    }

    fn spaces(&self) -> Vec<usize> {
        match *self {
            Self::ListSpaces => vec![],
            Self::MovePage { from, to } => vec![from, to],
            Self::ListPages(s)
            | Self::GetPage(s)
            | Self::Search(s)
            | Self::GetPageMarkdown(s)
            | Self::CreatePage(s)
            | Self::AppendBlock(s) => vec![s],
        }
    }
}

fn call_strategy() -> impl proptest::strategy::Strategy<Value = Call> {
    use proptest::prelude::*;
    let space = 0..3usize;
    prop_oneof![
        space.clone().prop_map(Call::ListPages),
        space.clone().prop_map(Call::GetPage),
        space.clone().prop_map(Call::Search),
        space.clone().prop_map(Call::GetPageMarkdown),
        Just(Call::ListSpaces),
        space.clone().prop_map(Call::CreatePage),
        space.clone().prop_map(Call::AppendBlock),
        (space.clone(), 1..3usize).prop_map(|(from, step)| Call::MovePage {
            from,
            to: (from + step) % 3,
        }),
    ]
}

impl Vault {
    /// `call`'s tool and arguments; a move gets a fresh page to move.
    async fn tool_call(&self, call: &Call, n: usize) -> (&'static str, Value) {
        let s = |i: usize| (self.spaces[i].clone(), self.pages[i].clone());
        match *call {
            Call::ListPages(i) => ("list_pages", json!({ "space_id": s(i).0 })),
            Call::GetPage(i) => ("get_page", json!({ "page_id": s(i).1, "space_id": s(i).0 })),
            Call::Search(i) => ("search", json!({ "query": "page", "space_id": s(i).0 })),
            Call::GetPageMarkdown(i) => (
                "get_page_markdown",
                json!({ "page_id": s(i).1, "space_id": s(i).0 }),
            ),
            Call::ListSpaces => ("list_spaces", json!({})),
            Call::CreatePage(i) => (
                "create_page",
                json!({ "title": format!("Generated {n}"), "space_id": s(i).0 }),
            ),
            Call::AppendBlock(i) => (
                "append_block",
                json!({ "parent_id": s(i).1, "content": format!("line {n}"), "space_id": s(i).0 }),
            ),
            Call::MovePage { from, to } => {
                let page = page_in(
                    &self.pool,
                    &self.mat,
                    &self.spaces[from],
                    &format!("Moved {n}"),
                )
                .await;
                self.mat.flush_background().await.unwrap();
                (
                    "move_page_to_space",
                    json!({ "page_id": page, "space_id": s(from).0, "target_space_id": s(to).0 }),
                )
            }
        }
    }

    async fn check_case(
        &self,
        n: usize,
        mode: McpAgentMode,
        allowed: Option<Vec<usize>>,
        call: Call,
    ) -> Result<(), proptest::test_runner::TestCaseError> {
        use proptest::prop_assert_eq;

        let agent = self
            .agent(&format!("agent {n}"), mode, allowed.as_deref())
            .await;
        let (tool, args) = self.tool_call(&call, n).await;
        let space_ok = call
            .spaces()
            .iter()
            .all(|s| allowed.as_ref().is_none_or(|a| a.contains(s)));
        let mode_ok = !call.writes() || mode == McpAgentMode::ReadWrite;

        let result = self.call(&agent, tool, args).await;
        match (&result, space_ok, mode_ok) {
            (Ok(value), true, true) => {
                if let Call::ListSpaces = call {
                    let mut expected: Vec<&str> = match &allowed {
                        Some(ix) => ix.iter().map(|&i| self.spaces[i].as_str()).collect(),
                        None => self.spaces.iter().map(String::as_str).collect(),
                    };
                    expected.sort_unstable();
                    let mut listed = space_ids(value);
                    listed.sort_unstable();
                    prop_assert_eq!(listed, expected);
                }
            }
            (Err(error), false, _) => {
                prop_assert_eq!(error.code.0, -32602, "space refusal: {:?}", error);
            }
            (Err(error), true, false) => {
                prop_assert_eq!(error.code.0, -32001, "unknown tool: {:?}", error);
            }
            _ => {
                return Err(proptest::test_runner::TestCaseError::fail(format!(
                    "{call:?} by a {mode:?} agent on {allowed:?}: {result:?}"
                )));
            }
        }
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_call_runs_exactly_when_mode_and_spaces_allow_it_5667() {
    use proptest::prelude::*;
    use proptest::test_runner::{Config, TestRunner};

    let v = Vault::new().await;
    let counter = std::sync::atomic::AtomicUsize::new(0);
    let mode = prop_oneof![Just(McpAgentMode::ReadOnly), Just(McpAgentMode::ReadWrite)];
    let allowed = proptest::option::of(proptest::sample::subsequence(vec![A, B, C], 1..=3));
    let mut runner = TestRunner::new(Config {
        cases: 128,
        failure_persistence: None,
        ..Config::default()
    });
    runner
        .run(
            &(mode, allowed, call_strategy()),
            |(mode, allowed, call)| {
                let n = counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::current().block_on(v.check_case(n, mode, allowed, call))
                })
            },
        )
        .unwrap();
}
