//! `apply_page_source` over generated pages on a real pool (#5140): saving a
//! page's own source writes nothing, and saving its blocks rearranged lands
//! exactly that tree with the fewest moves. The pages come from the render
//! proptests' generator ([`arb_forest`]).

use std::collections::BTreeMap;

use proptest::prelude::*;
use tokio::runtime::Runtime;

use super::*;
use crate::commands::tests::common::{DEV, TEST_SPACE_ID, ensure_test_space, mark_block_as_space};
use crate::commands::{create_block_inner, create_page_in_space_inner};
use crate::db::init_pool;

const CASES: u32 = 24;

struct Fixture {
    pool: SqlitePool,
    materializer: Materializer,
    page: String,
    _dir: tempfile::TempDir,
}

/// An empty page in the test space, and the targets of the generator's refs:
/// two pages and a tag of that space.
async fn fixture() -> Fixture {
    let dir = tempfile::TempDir::new().unwrap();
    let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
    let materializer = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    let page = create_page_in_space_inner(
        &pool,
        DEV,
        &materializer,
        None,
        "Generated".into(),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap()
    .into_string();
    for (n, id) in REF_IDS.iter().enumerate() {
        let (block_type, content) = if n < 2 {
            ("page", format!("Page {n}"))
        } else {
            ("tag", format!("tag{n}"))
        };
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id, space_id) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(block_type)
        .bind(content)
        .bind((block_type == "page").then_some(id))
        .bind(TEST_SPACE_ID)
        .execute(&pool)
        .await
        .unwrap();
    }
    Fixture {
        pool,
        materializer,
        page,
        _dir: dir,
    }
}

/// `forest`'s blocks under the page through the create command, so the engine
/// holds the tree, in depth-first order. Returns their ids in that order.
async fn create_forest(fx: &Fixture, forest: &[BlockSpec]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let mut ancestors: Vec<String> = Vec::new();
    for spec in forest {
        ancestors.truncate(spec.level);
        let parent = ancestors.last().unwrap_or(&fx.page);
        let row = create_block_inner(
            &fx.pool,
            DEV,
            &fx.materializer,
            "content".into(),
            spec.content.clone(),
            Some(BlockId::from_trusted(parent)),
            None,
        )
        .await
        .unwrap();
        let id = row.id.into_string();
        ancestors.push(id.clone());
        ids.push(id);
    }
    ids
}

/// Each block's task columns and property rows, written to the tables: the
/// option lists the commands check would refuse the generator's arbitrary
/// task states, and no write of the save under test should reach them.
async fn write_metadata(pool: &SqlitePool, ids: &[String], forest: &[BlockSpec]) {
    for (id, spec) in ids.iter().zip(forest) {
        sqlx::query(
            "UPDATE blocks SET todo_state = ?, priority = ?, scheduled_date = ?, due_date = ? \
             WHERE id = ?",
        )
        .bind(&spec.todo_state)
        .bind(&spec.priority)
        .bind(&spec.scheduled_date)
        .bind(&spec.due_date)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
        let style = spec.list_style.map(|style| (style.to_string(), false));
        for (key, (value, is_ref)) in spec
            .properties
            .iter()
            .map(|(key, value)| (key.as_str(), value.clone()))
            .chain(style.map(|style| ("listStyle", style)))
        {
            let (text, reference) = if is_ref {
                (None, Some(value))
            } else {
                (Some(value), None)
            };
            sqlx::query(
                "INSERT INTO block_properties (block_id, key, value_text, value_ref) \
                 VALUES (?, ?, ?, ?)",
            )
            .bind(id)
            .bind(key)
            .bind(text)
            .bind(reference)
            .execute(pool)
            .await
            .unwrap();
        }
    }
}

async fn op_counts(pool: &SqlitePool) -> BTreeMap<String, i64> {
    sqlx::query_as::<_, (String, i64)>("SELECT op_type, COUNT(*) FROM op_log GROUP BY op_type")
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .collect()
}

/// The ops appended between two [`op_counts`], by type.
fn appended(
    before: &BTreeMap<String, i64>,
    after: &BTreeMap<String, i64>,
) -> BTreeMap<String, i64> {
    after
        .iter()
        .map(|(op, n)| (op.clone(), n - before.get(op).copied().unwrap_or(0)))
        .filter(|(_, n)| *n != 0)
        .collect()
}

async fn save(fx: &Fixture, source: &str, base: &str) -> PageSourceReport {
    apply_page_source_inner(
        &fx.pool,
        DEV,
        &fx.materializer,
        &fx.page,
        source.to_owned(),
        base.to_owned(),
        false,
    )
    .await
    .unwrap()
}

/// The page's rendered blocks rearranged: the `order`-th block of the page
/// at each place, at `levels` clamped to one below the block before it.
/// Returns the page's source rendered with that tree, and the tree as each
/// parent's children in order.
async fn rearranged_source(
    fx: &Fixture,
    ids: &[String],
    order: &[usize],
    levels: &[usize],
) -> (String, BTreeMap<String, Vec<String>>) {
    let mut conn = fx.pool.acquire().await.unwrap();
    let mut data = load_page_export_data(&mut conn, &fx.page).await.unwrap();
    data.name_snapshot = load_name_snapshot(&mut conn, &data).await.unwrap();
    let mut children: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut ancestors: Vec<String> = Vec::new();
    let mut previous: Option<usize> = None;
    let mut placed: HashMap<String, (String, i64)> = HashMap::new();
    for (&k, &level) in order.iter().zip(levels) {
        let level = previous.map_or(0, |p| level.min(p + 1));
        previous = Some(level);
        ancestors.truncate(level);
        let parent = ancestors.last().unwrap_or(&fx.page).clone();
        let siblings = children.entry(parent.clone()).or_default();
        siblings.push(ids[k].clone());
        placed.insert(
            ids[k].clone(),
            (parent, i64::try_from(siblings.len()).unwrap()),
        );
        ancestors.push(ids[k].clone());
    }
    for block in &mut data.descendants {
        let (parent, position) = placed[block.id.as_str()].clone();
        block.parent_id = Some(BlockId::from_trusted(&parent));
        block.position = Some(position);
    }
    (render_page_source(&data), children)
}

/// A level for each of `n` blocks, clamped where used to one below the block
/// before. Mostly flat, so that many blocks share a parent both before and
/// after a rearrangement, which is where the order of siblings is tested.
fn arb_levels(n: usize) -> impl Strategy<Value = Vec<usize>> {
    prop::collection::vec(prop_oneof![3 => Just(0usize), 2 => 1usize..=3], n)
}

/// A generated page at mostly flat levels, and its blocks' new order and
/// levels.
fn arb_rearrangement() -> impl Strategy<Value = (Vec<BlockSpec>, Vec<usize>, Vec<usize>)> {
    arb_forest().prop_flat_map(|forest| {
        let n = forest.len();
        let flattened = arb_levels(n).prop_map(move |levels| {
            let mut forest = forest.clone();
            let mut previous: Option<usize> = None;
            for (block, level) in forest.iter_mut().zip(levels) {
                block.level = previous.map_or(0, |p| level.min(p + 1));
                previous = Some(block.level);
            }
            forest
        });
        (
            flattened,
            Just((0..n).collect::<Vec<usize>>()).prop_shuffle(),
            arb_levels(n),
        )
    })
}

/// The moves the save promises: each block under a new parent, plus, for each
/// parent, the children it already had less the longest run of them the new
/// order keeps, found here by the quadratic recurrence.
async fn fewest_moves(pool: &SqlitePool, after: &BTreeMap<String, Vec<String>>) -> i64 {
    let mut moves = 0;
    for (parent, kids) in after {
        let before: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM blocks WHERE parent_id = ? AND deleted_at IS NULL \
             ORDER BY position, id",
        )
        .bind(parent)
        .fetch_all(pool)
        .await
        .unwrap();
        let stayed: Vec<usize> = kids
            .iter()
            .filter_map(|kid| before.iter().position(|id| id == kid))
            .collect();
        let mut run = vec![1; stayed.len()];
        for i in 0..stayed.len() {
            for j in 0..i {
                if stayed[j] < stayed[i] {
                    run[i] = run[i].max(run[j] + 1);
                }
            }
        }
        let longest = run.iter().copied().max().unwrap_or(0);
        moves += i64::try_from(kids.len() - longest).unwrap();
    }
    moves
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(CASES))]

    /// Every feature the generator writes, raw and humanised refs among them,
    /// renders to a buffer whose save appends no op.
    #[test]
    fn saving_a_pages_own_source_writes_nothing(forest in arb_forest()) {
        Runtime::new().unwrap().block_on(async {
            let fx = fixture().await;
            let ids = create_forest(&fx, &forest).await;
            write_metadata(&fx.pool, &ids, &forest).await;
            let source = get_page_source_inner(&fx.pool, &fx.page).await.unwrap();
            let before = op_counts(&fx.pool).await;

            let report = save(&fx, &source, &source).await;

            let after = op_counts(&fx.pool).await;
            prop_assert_eq!(appended(&before, &after), BTreeMap::new(), "source:\n{}", source);
            prop_assert_eq!(
                (report.created, report.edited, report.moved, report.deleted),
                (0, 0, 0, 0),
                "source:\n{}",
                source
            );
            prop_assert_eq!((report.properties_set, report.properties_deleted), (0, 0));
            prop_assert!(report.names_created.is_empty() && report.warnings.is_empty());
            Ok(())
        })?;
    }

    /// The page's blocks shuffled and re-indented: the save lands exactly that
    /// tree, with moves only, and no more of them than the tree needs.
    #[test]
    fn a_rearranged_source_lands_its_tree_with_the_fewest_moves(
        (forest, order, levels) in arb_rearrangement()
    ) {
        Runtime::new().unwrap().block_on(async {
            let fx = fixture().await;
            let ids = create_forest(&fx, &forest).await;
            let base = get_page_source_inner(&fx.pool, &fx.page).await.unwrap();
            let (source, tree) = rearranged_source(&fx, &ids, &order, &levels).await;
            let expected_moves = fewest_moves(&fx.pool, &tree).await;
            let before = op_counts(&fx.pool).await;

            let report = save(&fx, &source, &base).await;

            let after = op_counts(&fx.pool).await;
            let moves = [("move_block".to_string(), expected_moves)];
            prop_assert_eq!(
                appended(&before, &after),
                moves.into_iter().filter(|(_, n)| *n != 0).collect::<BTreeMap<_, _>>(),
                "base:\n{}\nsource:\n{}",
                base,
                source
            );
            prop_assert_eq!(i64::from(report.moved), expected_moves);
            let saved = get_page_source_inner(&fx.pool, &fx.page).await.unwrap();
            prop_assert_eq!(saved, source, "the page is now the rearranged tree");
            Ok(())
        })?;
    }
}
