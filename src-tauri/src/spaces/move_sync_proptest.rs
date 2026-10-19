//! #5712: whatever order a pull delivers the spaces' docs in, and wherever a
//! session stops, a peer ends with the moved and purged pages exactly as their
//! author has them.
//!
//! Device A runs a script of moves, edits and purges over two pages and three
//! spaces. Device B pulls in rounds: each round delivers the spaces in a random
//! order, and either completes (and sweeps), stops after a random prefix, or
//! crashes inside one import and replays its inbox the way boot does. B holds
//! rows no doc carries: a draft on each page's child, an open of each page,
//! and, on a page that never moves, a link to each page and a ref property to
//! the first.
//!
//! After every round, each SQL row of a page or block the script writes whose
//! block no engine holds waits in `sync_deferred_purges`. After a final complete round, B's rows and engines
//! equal A's, B's own rows exist exactly for the pages A did not purge, and
//! nothing waits.

use proptest::prelude::*;
use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

use super::tests::{deferred_purges, shared_rows};
use crate::materializer::Materializer;
use agaric_core::ulid::BlockId;
use agaric_engine::loro::snapshot::{rehydrate_registry, save_all_engines};
use agaric_store::space::SpaceId;

// What is left of the run is the cases themselves: each replays A's script
// and B's rounds through the real materializer and import path, and fewer
// cases leave the order and cut-point space thinner.
const CASES: u32 = 64;
const SPACES: usize = 3;
const PAGES: usize = 2;

#[derive(Debug, Clone)]
enum Op {
    Move { page: usize, to: usize },
    Edit { page: usize },
    Purge { page: usize },
}

/// How a pull session ends.
#[derive(Debug, Clone)]
enum Delivery {
    /// Every space's doc lands and the session sweeps.
    Whole,
    /// Only the first `n` docs land; nothing is swept.
    Cut(usize),
    /// The first `n` docs land, the next one's projection dies after its
    /// engine import, and boot replays the inbox.
    Crash(usize),
}

#[derive(Debug, Clone)]
struct Round {
    ops: Vec<Op>,
    order: Vec<usize>,
    delivery: Delivery,
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        3 => (0..PAGES, 0..SPACES).prop_map(|(page, to)| Op::Move { page, to }),
        1 => (0..PAGES).prop_map(|page| Op::Edit { page }),
        1 => (0..PAGES).prop_map(|page| Op::Purge { page }),
    ]
}

fn round() -> impl Strategy<Value = Round> {
    (
        prop::collection::vec(op(), 1..=3),
        Just((0..SPACES).collect::<Vec<_>>()).prop_shuffle(),
        prop_oneof![
            2 => Just(Delivery::Whole),
            1 => (0..SPACES).prop_map(Delivery::Cut),
            1 => (0..SPACES).prop_map(Delivery::Crash),
        ],
    )
        .prop_map(|(ops, order, delivery)| Round {
            ops,
            order,
            delivery,
        })
}

struct Vaults {
    pool_a: SqlitePool,
    mat_a: Materializer,
    pool_b: SqlitePool,
    mat_b: Materializer,
    spaces: Vec<BlockId>,
    pages: Vec<BlockId>,
    children: Vec<BlockId>,
    /// The space each page is in on A, `None` once A purged it.
    page_space: Vec<Option<usize>>,
    _dirs: (TempDir, TempDir),
}

async fn vault(template: &std::path::Path) -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("test.db");
    std::fs::copy(template, &path).unwrap();
    let pool = crate::db::init_pool(&path).await.unwrap();
    (pool, dir)
}

async fn built_vaults(template: &std::path::Path) -> Vaults {
    use crate::commands::pages::record_page_open_inner;
    use crate::commands::{
        create_block_inner, create_page_in_space_inner, create_property_def_inner,
        create_space_inner, set_property_inner,
    };

    let (pool_a, dir_a) = vault(template).await;
    let mat_a = Materializer::new(pool_a.clone());
    super::bootstrap::bootstrap_spaces(&pool_a, "device-A", &mat_a)
        .await
        .unwrap();
    let mut spaces = Vec::with_capacity(SPACES);
    for name in ["S0", "S1", "S2"] {
        spaces.push(
            create_space_inner(&pool_a, "device-A", &mat_a, name.into(), None)
                .await
                .unwrap(),
        );
    }
    let page_in = |content: &str, space: &BlockId| {
        create_page_in_space_inner(
            &pool_a,
            "device-A",
            &mat_a,
            None,
            content.into(),
            space.as_str().to_owned(),
        )
    };
    let child = |parent: &BlockId, content: String| {
        create_block_inner(
            &pool_a,
            "device-A",
            &mat_a,
            "content".into(),
            content,
            Some(parent.clone()),
            None,
        )
    };
    let mut pages = Vec::with_capacity(PAGES);
    let mut children = Vec::with_capacity(PAGES);
    // A new link or ref cannot cross spaces, so the pages start beside the
    // page that points at them.
    for i in 0..PAGES {
        let page = page_in(&format!("Page {i}"), &spaces[0]).await.unwrap();
        children.push(child(&page, format!("child {i}")).await.unwrap().id);
        pages.push(page);
    }
    let notes = page_in("Notes", &spaces[0]).await.unwrap();
    let note = child(&notes, format!("see [[{}]] and [[{}]]", pages[0], pages[1]))
        .await
        .unwrap()
        .id;
    create_property_def_inner(&pool_a, "related".into(), "ref".into(), None)
        .await
        .unwrap();
    set_property_inner(
        &pool_a,
        "device-A",
        &mat_a,
        note.as_str().into(),
        "related".into(),
        None,
        None,
        None,
        Some(pages[0].as_str().to_owned()),
        None,
        None,
    )
    .await
    .unwrap();
    mat_a.flush_background().await.unwrap();

    let (pool_b, dir_b) = vault(template).await;
    let mat_b = Materializer::new(pool_b.clone());
    super::bootstrap::bootstrap_spaces(&pool_b, "device-B", &mat_b)
        .await
        .unwrap();
    create_property_def_inner(&pool_b, "related".into(), "ref".into(), None)
        .await
        .unwrap();
    let v = Vaults {
        pool_a,
        mat_a,
        pool_b,
        mat_b,
        spaces,
        pages,
        children,
        page_space: vec![Some(0); PAGES],
        _dirs: (dir_a, dir_b),
    };
    v.deliver(&(0..SPACES).collect::<Vec<_>>(), &Delivery::Whole)
        .await;
    for (page, child) in v.pages.iter().zip(&v.children) {
        agaric_engine::draft::save_draft(&v.pool_b, "device-B", child.as_str(), "unsaved")
            .await
            .unwrap();
        record_page_open_inner(&v.pool_b, page.clone())
            .await
            .unwrap();
    }
    v
}

/// The state every case starts from, built once: the setup (spaces, pages,
/// the first full pull) cost three times the rounds it precedes.
struct Seed {
    dir: TempDir,
    spaces: Vec<BlockId>,
    pages: Vec<BlockId>,
    children: Vec<BlockId>,
}

async fn seed(template: &std::path::Path) -> Seed {
    let v = built_vaults(template).await;
    v.mat_a.flush_background().await.unwrap();
    v.mat_b.flush_background().await.unwrap();
    save_all_engines(&v.pool_a, &v.mat_a.loro_state().registry).await;
    save_all_engines(&v.pool_b, &v.mat_b.loro_state().registry).await;
    v.shutdown();
    v.pool_a.close().await;
    v.pool_b.close().await;
    let dir = TempDir::new().unwrap();
    std::fs::copy(v._dirs.0.path().join("test.db"), dir.path().join("a.db")).unwrap();
    std::fs::copy(v._dirs.1.path().join("test.db"), dir.path().join("b.db")).unwrap();
    Seed {
        dir,
        spaces: v.spaces,
        pages: v.pages,
        children: v.children,
    }
}

async fn vaults(seed: &Seed) -> Vaults {
    let (pool_a, dir_a) = vault(&seed.dir.path().join("a.db")).await;
    let (pool_b, dir_b) = vault(&seed.dir.path().join("b.db")).await;
    let mat_a = Materializer::new(pool_a.clone());
    let mat_b = Materializer::new(pool_b.clone());
    rehydrate_registry(&pool_a, &mat_a.loro_state().registry, "device-A").await;
    rehydrate_registry(&pool_b, &mat_b.loro_state().registry, "device-B").await;
    Vaults {
        mat_a,
        mat_b,
        pool_a,
        pool_b,
        spaces: seed.spaces.clone(),
        pages: seed.pages.clone(),
        children: seed.children.clone(),
        page_space: vec![Some(0); PAGES],
        _dirs: (dir_a, dir_b),
    }
}

impl Vaults {
    async fn run_on_a(&mut self, op: &Op) {
        match *op {
            Op::Move { page, to } => {
                if self.page_space[page].is_none_or(|at| at == to) {
                    return;
                }
                crate::commands::move_blocks_to_space_inner(
                    &self.pool_a,
                    "device-A",
                    &self.mat_a,
                    vec![self.pages[page].clone()],
                    self.spaces[to].as_str().to_owned(),
                )
                .await
                .unwrap();
                self.page_space[page] = Some(to);
            }
            Op::Edit { page } => {
                if self.page_space[page].is_none() {
                    return;
                }
                crate::commands::edit_block_inner(
                    &self.pool_a,
                    "device-A",
                    &self.mat_a,
                    self.children[page].clone(),
                    format!("edited at {}", crate::db::now_ms()),
                )
                .await
                .unwrap();
            }
            Op::Purge { page } => {
                if self.page_space[page].is_none() {
                    return;
                }
                let id = self.pages[page].clone();
                crate::commands::delete_block_inner(
                    &self.pool_a,
                    "device-A",
                    &self.mat_a,
                    id.clone(),
                )
                .await
                .unwrap();
                crate::commands::purge_block_inner(&self.pool_a, "device-A", &self.mat_a, id)
                    .await
                    .unwrap();
                self.page_space[page] = None;
            }
        }
        self.mat_a.flush_background().await.unwrap();
    }

    /// B imports A's doc for each space of `order`, as one session ending as
    /// `delivery` says.
    async fn deliver(&self, order: &[usize], delivery: &Delivery) {
        let landing = match *delivery {
            Delivery::Whole => order.len(),
            Delivery::Cut(n) | Delivery::Crash(n) => n,
        };
        for &space in &order[..landing] {
            self.import(space).await.unwrap();
        }
        match *delivery {
            Delivery::Whole => {
                let swept = agaric_sync::sync_protocol::loro_sync::sweep_deferred_purges(
                    &self.pool_b,
                    &self.mat_b.loro_state().registry,
                )
                .await
                .unwrap();
                self.mat_b
                    .enqueue_inbound_sync_rebuilds(&[], &swept)
                    .await
                    .unwrap();
            }
            Delivery::Cut(_) => {}
            Delivery::Crash(n) => self.crash_inside_import(order[n]).await,
        }
        self.mat_b.flush_inbound_rebuilds().await.unwrap();
    }

    /// B imports A's doc for `space`, with the fan-out a session runs after it.
    async fn import(&self, space: usize) -> Result<(), agaric_core::error::AppError> {
        use agaric_sync::sync_protocol::loro_sync::{ApplyOutcome, apply_remote};
        let msg = agaric_sync::sync_protocol::loro_sync::prepare_outgoing_for_pool(
            &self.pool_a,
            &self.mat_a.loro_state().registry,
            &SpaceId::from_trusted(self.spaces[space].as_str()),
            "device-A",
            None,
        )
        .await
        .unwrap()
        .expect("#1257 freshness gate must not refuse a consistent engine");
        let outcome = apply_remote(
            &self.pool_b,
            &self.mat_b.loro_state().registry,
            "device-B",
            msg,
        )
        .await?;
        let ApplyOutcome::Imported { changed_blocks, .. } = outcome else {
            panic!("a snapshot imports, got {outcome:?}");
        };
        self.mat_b
            .enqueue_inbound_sync_rebuilds(&changed_blocks, &[])
            .await
            .unwrap();
        Ok(())
    }

    /// The import of `space` dies after its engine import: its projection
    /// rolls back and leaves the inbox slot, which boot replays.
    async fn crash_inside_import(&self, space: usize) {
        sqlx::query(
            "CREATE TRIGGER crash_5712 BEFORE DELETE ON loro_sync_inbox \
             BEGIN SELECT RAISE(ABORT, 'crash inside the import'); END",
        )
        .execute(&self.pool_b)
        .await
        .unwrap();
        self.import(space)
            .await
            .expect_err("the import dies before its projection commits");
        sqlx::query("DROP TRIGGER crash_5712")
            .execute(&self.pool_b)
            .await
            .unwrap();
        agaric_sync::recovery::replay_sync_inbox(
            &self.pool_b,
            &self.mat_b.loro_state().registry,
            "device-B",
            &self.mat_b,
        )
        .await
        .unwrap();
    }

    /// The pages and blocks the script writes that B has a SQL row for and
    /// no engine of B's holds. (B's bootstrap spaces are such rows by
    /// design: no doc was ever written for them.)
    async fn unheld_rows_on_b(&self) -> Vec<String> {
        let written: Vec<&str> = self
            .pages
            .iter()
            .chain(&self.children)
            .map(BlockId::as_str)
            .collect();
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM blocks WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
        )
        .bind(serde_json::to_string(&written).unwrap())
        .fetch_all(&self.pool_b)
        .await
        .unwrap();
        let registry = &self.mat_b.loro_state().registry;
        ids.into_iter()
            .filter(|id| registry.spaces_containing(id).is_empty())
            .collect()
    }

    /// B's drafts and opens, as `(block, kind)` pairs, sorted.
    async fn b_only_rows(&self) -> Vec<(String, &'static str)> {
        let drafts: Vec<String> = sqlx::query_scalar("SELECT block_id FROM block_drafts")
            .fetch_all(&self.pool_b)
            .await
            .unwrap();
        let opens: Vec<String> = sqlx::query_scalar("SELECT page_id FROM page_opens")
            .fetch_all(&self.pool_b)
            .await
            .unwrap();
        let mut rows: Vec<(String, &'static str)> = drafts
            .into_iter()
            .map(|id| (id, "draft"))
            .chain(opens.into_iter().map(|id| (id, "open")))
            .collect();
        rows.sort_unstable();
        rows
    }

    /// The drafts and opens B must still hold: those on the pages A kept.
    fn expected_b_only_rows(&self) -> Vec<(String, &'static str)> {
        let mut rows: Vec<(String, &'static str)> = (0..PAGES)
            .filter(|&i| self.page_space[i].is_some())
            .flat_map(|i| {
                [
                    (self.children[i].as_str().to_owned(), "draft"),
                    (self.pages[i].as_str().to_owned(), "open"),
                ]
            })
            .collect();
        rows.sort_unstable();
        rows
    }

    fn engine_views(&self, mat: &Materializer, device: &str) -> Vec<Vec<String>> {
        self.spaces
            .iter()
            .map(|space| {
                let mut guard = mat
                    .loro_state()
                    .registry
                    .for_space(&SpaceId::from_trusted(space.as_str()), device)
                    .unwrap();
                let engine = guard.engine_mut();
                let mut live = engine.live_block_ids().unwrap();
                live.sort_unstable();
                live.iter()
                    .map(|id| format!("{:?}", engine.read_block(id).unwrap()))
                    .collect()
            })
            .collect()
    }

    fn shutdown(&self) {
        self.mat_a.shutdown();
        self.mat_b.shutdown();
    }
}

/// One case: A runs each round's script and B pulls it as the round says;
/// then B pulls everything once more, in full.
async fn run_case(seed: &Seed, rounds: &[Round]) {
    let mut v = vaults(seed).await;
    for (n, round) in rounds.iter().enumerate() {
        for op in &round.ops {
            v.run_on_a(op).await;
        }
        v.deliver(&round.order, &round.delivery).await;
        let unheld = v.unheld_rows_on_b().await;
        let deferred = deferred_purges(&v.pool_b).await;
        assert!(
            unheld.iter().all(|id| deferred.contains(id)),
            "round {n}: every row no engine holds waits to be swept; \
             unheld {unheld:?}, deferred {deferred:?}"
        );
    }
    v.deliver(&(0..SPACES).collect::<Vec<_>>(), &Delivery::Whole)
        .await;

    assert_eq!(
        shared_rows(&v.pool_b).await,
        shared_rows(&v.pool_a).await,
        "B's rows equal A's"
    );
    assert_eq!(
        v.engine_views(&v.mat_b, "device-B"),
        v.engine_views(&v.mat_a, "device-A"),
        "B's engines match A's"
    );
    assert_eq!(
        v.b_only_rows().await,
        v.expected_b_only_rows(),
        "B keeps its own rows on exactly the pages A kept"
    );
    assert_eq!(
        deferred_purges(&v.pool_b).await,
        Vec::<String>::new(),
        "nothing waits to be swept"
    );
    v.shutdown();
}

#[test]
fn a_peer_converges_whatever_order_and_end_its_pulls_take_5712() {
    // Migrating and setting up each case's two vaults from scratch cost more
    // than the rest of the case, so every case starts from copies of one pair
    // built here.
    let dir = TempDir::new().unwrap();
    let template = dir.path().join("template.db");
    Runtime::new().unwrap().block_on(async {
        crate::db::init_pool(&template).await.unwrap().close().await;
    });
    let seed = Runtime::new().unwrap().block_on(seed(&template));
    let mut runner = proptest::test_runner::TestRunner::new(ProptestConfig {
        cases: CASES,
        source_file: Some(file!()),
        ..ProptestConfig::default()
    });
    let result = runner.run(&prop::collection::vec(round(), 1..=3), |rounds| {
        Runtime::new().unwrap().block_on(run_case(&seed, &rounds));
        Ok(())
    });
    if let Err(failure) = result {
        panic!("{failure}\n{runner}");
    }
}
