//! `apply_page_source` over generated pages on a real pool (#5140): saving a
//! page's own Document buffer by its line ids writes nothing (#5691), and
//! saving its blocks rearranged lands exactly that tree with the fewest moves. The pages come
//! from the render proptests' generator ([`arb_forest`]).

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

/// Save `text`, each line carrying the id `line_ids` gives, edited from
/// `base`.
async fn save(
    fx: &Fixture,
    (text, line_ids): (String, Vec<Option<String>>),
    base: &str,
) -> PageSourceReport {
    apply_page_source_inner(
        &fx.pool,
        DEV,
        &fx.materializer,
        &fx.page,
        text,
        base.to_owned(),
        SourceSaveFlags {
            merge: false,
            line_ids,
        },
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
    let mut data = load_page_export_data(&mut conn, &fx.page, PageRead::Buffer)
        .await
        .unwrap();
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
    (render_page_document(&data).0, children)
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

    /// The page's blocks shuffled and re-indented, each line keeping its id: the
    /// save lands exactly that tree, with moves only, and no more of them than
    /// the tree needs.
    #[test]
    fn a_rearranged_source_lands_its_tree_with_the_fewest_moves(
        (forest, order, levels) in arb_rearrangement()
    ) {
        Runtime::new().unwrap().block_on(async {
            let fx = fixture().await;
            let ids = create_forest(&fx, &forest).await;
            let base = get_page_buffer_inner(&fx.pool, &fx.page).await.unwrap().source;
            let (source, tree) = rearranged_source(&fx, &ids, &order, &levels).await;
            let expected_moves = fewest_moves(&fx.pool, &tree).await;
            let before = op_counts(&fx.pool).await;

            let report = save(&fx, anchor_free(&source), &base).await;

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
            let saved = get_page_buffer_inner(&fx.pool, &fx.page).await.unwrap().source;
            prop_assert_eq!(saved, source, "the page is now the rearranged tree");
            Ok(())
        })?;
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(CASES))]

    /// #5691 G1 — the page's own Document buffer, saved by its line ids, writes
    /// nothing, a task whose list style the buffer hides (D3) among the blocks
    /// the generator writes.
    #[test]
    fn saving_a_pages_own_document_by_its_line_ids_writes_nothing(forest in arb_forest()) {
        Runtime::new().unwrap().block_on(async {
            let fx = fixture().await;
            let ids = create_forest(&fx, &forest).await;
            write_metadata(&fx.pool, &ids, &forest).await;
            let buffer = get_page_buffer_inner(&fx.pool, &fx.page).await.unwrap();
            let before = op_counts(&fx.pool).await;

            let report = save(
                &fx,
                (buffer.text.clone(), buffer.line_ids.clone()),
                &buffer.source,
            )
            .await;

            let after = op_counts(&fx.pool).await;
            prop_assert_eq!(appended(&before, &after), BTreeMap::new(), "text:\n{}", buffer.text);
            prop_assert_eq!(
                (report.created, report.edited, report.moved, report.deleted),
                (0, 0, 0, 0),
                "text:\n{}",
                buffer.text
            );
            prop_assert_eq!((report.properties_set, report.properties_deleted), (0, 0));
            prop_assert!(report.names_created.is_empty());
            prop_assert!(
                report.warnings.iter().all(|warning| warning.contains("code fence")),
                "{:?}",
                report.warnings
            );
            Ok(())
        })?;
    }
}

/// D3 — a task with a list style shows as a task in a Document buffer. Saved
/// unedited, it keeps the style it hides; edited, in its text or its
/// checkbox, it loses it.
#[test]
fn a_tasks_hidden_list_style_goes_only_with_an_edit() {
    Runtime::new().unwrap().block_on(async {
        let fx = fixture().await;
        let task = |content: &str, style: &'static str| BlockSpec {
            level: 0,
            content: content.to_string(),
            todo_state: Some("TODO".to_string()),
            priority: None,
            scheduled_date: None,
            due_date: None,
            list_style: Some(style),
            properties: BTreeMap::new(),
        };
        let forest = [
            task("text", "ordered"),
            task("checkbox", "bullet"),
            task("kept", "ordered"),
        ];
        let ids = create_forest(&fx, &forest).await;
        write_metadata(&fx.pool, &ids, &forest).await;
        let styled = || async {
            sqlx::query_scalar::<_, String>(
                "SELECT block_id FROM block_properties WHERE key = 'listStyle' ORDER BY block_id",
            )
            .fetch_all(&fx.pool)
            .await
            .unwrap()
        };
        let buffer = get_page_buffer_inner(&fx.pool, &fx.page).await.unwrap();
        assert_eq!(buffer.text, "- [ ] text\n- [ ] checkbox\n- [ ] kept\n");

        let before = op_counts(&fx.pool).await;
        let report = save(
            &fx,
            (buffer.text.clone(), buffer.line_ids.clone()),
            &buffer.source,
        )
        .await;
        assert_eq!(
            appended(&before, &op_counts(&fx.pool).await),
            BTreeMap::new()
        );
        assert_eq!((report.edited, report.properties_deleted), (0, 0));
        let mut all = ids.clone();
        all.sort();
        assert_eq!(styled().await, all, "an unedited task keeps its style");

        let edited = buffer
            .text
            .replacen("- [ ] text", "- [ ] text edited", 1)
            .replacen("- [ ] checkbox", "- [/] checkbox", 1);
        let report = save(&fx, (edited, buffer.line_ids.clone()), &buffer.source).await;
        assert_eq!((report.edited, report.properties_deleted), (1, 2));
        assert_eq!(
            styled().await,
            [ids[2].clone()],
            "only the unedited task keeps it"
        );
    });
}

/// D3 — a property line the save changes, removes or adds on a task is an edit
/// of the block too, and takes the style the buffer hides with it.
#[test]
fn a_tasks_hidden_list_style_goes_with_an_edit_to_its_property_lines() {
    Runtime::new().unwrap().block_on(async {
        let fx = fixture().await;
        let k = || BTreeMap::from([("k".to_string(), ("v".to_string(), false))]);
        let task = |content: &str, style: &'static str, properties: BTreeMap<_, _>| BlockSpec {
            level: 0,
            content: content.to_string(),
            todo_state: Some("TODO".to_string()),
            priority: None,
            scheduled_date: None,
            due_date: None,
            list_style: Some(style),
            properties,
        };
        let forest = [
            task("changed", "ordered", k()),
            task("removed", "bullet", k()),
            task("added", "ordered", BTreeMap::new()),
            task("kept", "bullet", k()),
        ];
        let ids = create_forest(&fx, &forest).await;
        write_metadata(&fx.pool, &ids, &forest).await;
        let buffer = get_page_buffer_inner(&fx.pool, &fx.page).await.unwrap();
        assert_eq!(
            buffer.text,
            "- [ ] changed\n  k:: v\n- [ ] removed\n  k:: v\n- [ ] added\n- [ ] kept\n  k:: v\n"
        );

        let mut lines: Vec<(String, Option<String>)> = buffer
            .text
            .split('\n')
            .map(String::from)
            .zip(buffer.line_ids.iter().cloned())
            .collect();
        lines[1].0 = "  k:: w".to_string();
        lines.remove(3);
        lines.insert(4, ("  k:: v".to_string(), None));
        let text = lines
            .iter()
            .map(|(line, _)| line.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let line_ids = lines.iter().map(|(_, id)| id.clone()).collect();
        let report = save(&fx, (text, line_ids), &buffer.source).await;

        assert_eq!(report.edited, 0);
        assert_eq!((report.properties_set, report.properties_deleted), (2, 4));
        let styled = sqlx::query_scalar::<_, String>(
            "SELECT block_id FROM block_properties WHERE key = 'listStyle' ORDER BY block_id",
        )
        .fetch_all(&fx.pool)
        .await
        .unwrap();
        assert_eq!(styled, [ids[3].clone()], "only the untouched task keeps it");
    });
}

/// #5691 G2b — a page holding a block of every kind the Document dialect
/// writes: its own buffer, saved, appends no op.
#[test]
fn a_pages_own_document_with_every_kind_of_block_appends_no_op() {
    Runtime::new().unwrap().block_on(async {
        let fx = fixture().await;
        let block = |level: usize, content: &str| BlockSpec {
            level,
            content: content.to_string(),
            todo_state: None,
            priority: None,
            scheduled_date: None,
            due_date: None,
            list_style: None,
            properties: BTreeMap::new(),
        };
        let forest = [
            block(0, "## Findings"),
            block(0, "```sh\necho hi\n```"),
            block(0, "---"),
            BlockSpec {
                list_style: Some("bullet"),
                ..block(0, "bullet")
            },
            block(1, "plain child"),
            BlockSpec {
                list_style: Some("ordered"),
                ..block(0, "numbered")
            },
            BlockSpec {
                todo_state: Some("TODO".into()),
                ..block(0, "task")
            },
            block(0, ""),
            BlockSpec {
                priority: Some("2".into()),
                properties: BTreeMap::from([("note".into(), ("yes".into(), false))]),
                ..block(0, "properties")
            },
        ];
        let ids = create_forest(&fx, &forest).await;
        write_metadata(&fx.pool, &ids, &forest).await;
        let buffer = get_page_buffer_inner(&fx.pool, &fx.page).await.unwrap();
        assert_eq!(
            buffer.text,
            "## Findings\n\n```sh\necho hi\n```\n\n---\n\n- bullet\n  + plain child\n1. numbered\n\
             - [ ] task\n\n\\\n\nproperties\n  priority:: 2\n  note:: yes\n"
        );

        let before = op_counts(&fx.pool).await;
        let report = apply_page_source_inner(
            &fx.pool,
            DEV,
            &fx.materializer,
            &fx.page,
            buffer.text.clone(),
            buffer.source.clone(),
            SourceSaveFlags {
                merge: false,
                line_ids: buffer.line_ids.clone(),
            },
        )
        .await
        .unwrap();

        assert_eq!(
            appended(&before, &op_counts(&fx.pool).await),
            BTreeMap::new()
        );
        assert_eq!(
            (report.created, report.edited, report.moved, report.deleted),
            (0, 0, 0, 0)
        );
        assert_eq!((report.properties_set, report.properties_deleted), (0, 0));
    });
}
