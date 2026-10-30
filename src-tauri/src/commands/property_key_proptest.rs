//! #5841: renames and merges interleaved with sets and deletes.
//!
//! A script over three pages and the names in [`NAMES`] (`k0`, `k1`, `k2`
//! declared text) sets and deletes any name, declared or not, renames a
//! declared key onto any name the space does not use (one an earlier op may
//! have used), and merges one declared key into another. After every step
//! SQL equals the model, and the space's doc equals SQL. Then either:
//!
//! - P1: undoing every op, newest first, brings SQL back to the seed;
//! - P2: undoing one earlier set or delete writes its prior under the key the
//!   write's cell lives under now, and changes nothing else.
//!
//! The model keeps a cell per value slot a write touched, and moves cells as
//! each rename and merge happens: it never reads the op log.

use std::collections::{BTreeMap, BTreeSet};

use proptest::prelude::*;
use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

use crate::commands::tests::common::{
    DEV, TEST_SPACE_ID, ensure_test_space, init_pool_from_template, mark_block_as_space,
};
use crate::commands::{
    PropertyMergeCounts, capture_op_refs, create_page_in_space_inner, create_property_def_inner,
    delete_property_inner, merge_property_key_inner, preview_property_merge_inner,
    rename_property_key_inner, set_property_inner, undo_ops_inner,
};
use crate::materializer::Materializer;
use agaric_engine::loro::engine::PropertyValue;
use agaric_store::op::OpRef;
use agaric_store::space::SpaceId;

const CASES: u32 = 64;
const PAGES: usize = 3;
const NAMES: [&str; 5] = ["k0", "k1", "k2", "n0", "n1"];

/// `(page index, key)` → text value.
type Values = BTreeMap<(usize, String), String>;

/// Where a write's value slot is: a rename moves it with its key, and a merge
/// moves it with the value. A cell another key's value moved onto is
/// `shadowed`: the moved value is not its own, so it stays when that value
/// moves on.
#[derive(Debug, Clone)]
struct Cell {
    page: usize,
    key: String,
    shadowed: bool,
}

#[derive(Debug, Clone)]
struct Model {
    defs: BTreeSet<String>,
    values: Values,
    cells: Vec<Cell>,
}

impl Model {
    fn seed() -> Self {
        let values = seed_values();
        let cells = values
            .keys()
            .map(|(page, key)| Cell {
                page: *page,
                key: key.clone(),
                shadowed: false,
            })
            .collect();
        Model {
            defs: ["k0", "k1", "k2"].into_iter().map(str::to_owned).collect(),
            values,
            cells,
        }
    }

    /// The cell a write of `key` on `page` lands in: the slot's own, or a new
    /// one.
    fn cell_for(&mut self, page: usize, key: &str) -> usize {
        if let Some(i) = self
            .cells
            .iter()
            .position(|c| c.page == page && c.key == key && !c.shadowed)
        {
            return i;
        }
        self.cells.push(Cell {
            page,
            key: key.to_owned(),
            shadowed: false,
        });
        self.cells.len() - 1
    }

    fn used(&self, key: &str) -> bool {
        self.defs.contains(key) || self.values.keys().any(|(_, k)| k == key)
    }
}

/// A step as drawn; the model turns it into an op or skips it.
#[derive(Debug, Clone)]
struct Draw {
    kind: u8,
    page: usize,
    key: usize,
    other: usize,
}

/// What a step did, for the undo that follows the script.
#[derive(Debug, Clone)]
enum Step {
    /// A set or delete of `key` on `page`, which held `prior`, in `cell`.
    Write {
        op: OpRef,
        page: usize,
        key: String,
        cell: usize,
        prior: Option<String>,
    },
    /// A rename or a merge, as `change` says.
    Key { op: OpRef, change: String },
}

impl Step {
    fn op(&self) -> &OpRef {
        match self {
            Step::Write { op, .. } | Step::Key { op, .. } => op,
        }
    }
}

fn draw() -> impl Strategy<Value = Draw> {
    (0..4u8, 0..PAGES, 0..16usize, 0..16usize).prop_map(|(kind, page, key, other)| Draw {
        kind,
        page,
        key,
        other,
    })
}

struct Case {
    pool: SqlitePool,
    mat: Materializer,
    pages: Vec<String>,
    model: Model,
    next_value: usize,
    _dir: TempDir,
}

fn seed_values() -> Values {
    [
        (0, "k0", "s0"),
        (1, "k1", "s1"),
        (2, "k0", "s2"),
        (2, "k1", "s3"),
    ]
    .into_iter()
    .map(|(page, key, value)| ((page, key.to_owned()), value.to_owned()))
    .collect()
}

async fn set_text(case: &Case, page: usize, key: &str, value: &str) -> OpRef {
    capture_op_refs(set_property_inner(
        &case.pool,
        DEV,
        &case.mat,
        case.pages[page].as_str().into(),
        key.into(),
        Some(value.into()),
        None,
        None,
        None,
        None,
        None,
    ))
    .await
    .unwrap()
    .op_refs[0]
        .clone()
}

async fn new_case() -> Case {
    let dir = TempDir::new().unwrap();
    let pool = init_pool_from_template(&dir.path().join("test.db")).await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    for key in ["k0", "k1", "k2"] {
        create_property_def_inner(
            &pool,
            DEV,
            &mat,
            TEST_SPACE_ID,
            key.into(),
            "text".into(),
            None,
        )
        .await
        .unwrap();
    }
    let mut pages = Vec::with_capacity(PAGES);
    for title in ["P0", "P1", "P2"] {
        let page =
            create_page_in_space_inner(&pool, DEV, &mat, None, title.into(), TEST_SPACE_ID.into())
                .await
                .unwrap();
        pages.push(page.as_str().to_owned());
    }
    let model = Model::seed();
    let case = Case {
        pool,
        mat,
        pages,
        model,
        next_value: 0,
        _dir: dir,
    };
    for ((page, key), value) in seed_values() {
        set_text(&case, page, &key, &value).await;
    }
    case
}

/// SQL's values of the case's pages.
async fn sql_values(case: &Case) -> Values {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT block_id, key, value_text FROM block_properties \
         WHERE block_id IN (?, ?, ?)",
    )
    .bind(&case.pages[0])
    .bind(&case.pages[1])
    .bind(&case.pages[2])
    .fetch_all(&case.pool)
    .await
    .unwrap();
    let index = |id: &str| case.pages.iter().position(|p| p == id).unwrap();
    rows.into_iter()
        .map(|(block, key, value)| ((index(&block), key), value))
        .collect()
}

async fn sql_defs(case: &Case) -> BTreeSet<String> {
    sqlx::query_scalar::<_, String>("SELECT key FROM property_definitions WHERE space_id = ?")
        .bind(TEST_SPACE_ID)
        .fetch_all(&case.pool)
        .await
        .unwrap()
        .into_iter()
        .collect()
}

/// The space's doc's values of the case's pages, and its definitions.
fn doc_state(case: &Case) -> (Values, BTreeSet<String>) {
    let mut guard = case
        .mat
        .loro_state()
        .registry
        .for_space(&SpaceId::from_trusted(TEST_SPACE_ID), DEV)
        .unwrap();
    let engine = guard.engine_mut();
    let mut values = Values::new();
    for (page, id) in case.pages.iter().enumerate() {
        for (key, value) in engine.read_all_properties_typed(id).unwrap() {
            match value {
                PropertyValue::Str(text) => {
                    values.insert((page, key), text);
                }
                PropertyValue::Null => {}
                other => panic!("{key} on {page}: a text value, got {other:?}"),
            }
        }
    }
    let defs = engine
        .read_property_defs()
        .unwrap()
        .into_iter()
        .map(|(key, _)| key)
        .collect();
    (values, defs)
}

async fn assert_in_step(case: &Case, label: &str) {
    let sql = (sql_values(case).await, sql_defs(case).await);
    assert_eq!(
        sql.0, case.model.values,
        "{label}: SQL values equal the model"
    );
    assert_eq!(
        sql.1, case.model.defs,
        "{label}: SQL definitions equal the model"
    );
    assert_eq!(doc_state(case), sql, "{label}: the doc equals SQL");
}

fn nth_def(model: &Model, n: usize) -> Option<String> {
    let defs: Vec<&String> = model.defs.iter().collect();
    (!defs.is_empty()).then(|| defs[n % defs.len()].clone())
}

/// A set of any name on the page, or a delete of one the page holds.
async fn write_step(case: &mut Case, d: &Draw) -> Option<Step> {
    let key = if d.kind == 0 {
        NAMES[d.key % NAMES.len()].to_owned()
    } else {
        let held: Vec<&String> = case
            .model
            .values
            .keys()
            .filter(|(page, _)| *page == d.page)
            .map(|(_, key)| key)
            .collect();
        if held.is_empty() {
            return None;
        }
        held[d.key % held.len()].clone()
    };
    let prior = case.model.values.get(&(d.page, key.clone())).cloned();
    let cell = case.model.cell_for(d.page, &key);
    let op = if d.kind == 0 {
        let value = format!("v{}", case.next_value);
        case.next_value += 1;
        let op = set_text(case, d.page, &key, &value).await;
        case.model.values.insert((d.page, key.clone()), value);
        op
    } else {
        let deleted = capture_op_refs(delete_property_inner(
            &case.pool,
            DEV,
            &case.mat,
            case.pages[d.page].as_str().into(),
            key.clone(),
        ))
        .await
        .unwrap();
        case.model.values.remove(&(d.page, key.clone()));
        deleted.op_refs[0].clone()
    };
    Some(Step::Write {
        op,
        page: d.page,
        key,
        cell,
        prior,
    })
}

/// A rename onto a name the space neither declares nor holds a value under.
async fn rename_step(case: &mut Case, d: &Draw) -> Option<Step> {
    let old = nth_def(&case.model, d.key)?;
    let free: Vec<&str> = NAMES
        .into_iter()
        .filter(|name| !case.model.used(name))
        .collect();
    if free.is_empty() {
        return None;
    }
    let new = free[d.other % free.len()].to_owned();
    let renamed = capture_op_refs(rename_property_key_inner(
        &case.pool,
        DEV,
        &case.mat,
        TEST_SPACE_ID,
        old.clone(),
        new.clone(),
    ))
    .await
    .unwrap();
    let model = &mut case.model;
    model.defs.remove(&old);
    model.defs.insert(new.clone());
    for page in 0..PAGES {
        if let Some(value) = model.values.remove(&(page, old.clone())) {
            model.values.insert((page, new.clone()), value);
        }
    }
    // The new name holds no value, so its cells are emptied ones; a rename is
    // its own inverse on the two names, so they take the old one.
    for cell in &mut model.cells {
        if cell.key == old {
            cell.key.clone_from(&new);
        } else if cell.key == new {
            cell.key.clone_from(&old);
        }
    }
    Some(Step::Key {
        op: renamed.op_refs[0].clone(),
        change: format!("rename {old} to {new}"),
    })
}

async fn merge_step(case: &mut Case, d: &Draw) -> Option<Step> {
    let (from, into) = (nth_def(&case.model, d.key)?, nth_def(&case.model, d.other)?);
    if from == into {
        return None;
    }
    let holds = |page: usize, key: &str| case.model.values.contains_key(&(page, key.to_owned()));
    let moved: BTreeSet<usize> = (0..PAGES)
        .filter(|&p| holds(p, &from) && !holds(p, &into))
        .collect();
    let dropped = (0..PAGES)
        .filter(|&p| holds(p, &from) && holds(p, &into))
        .count();
    let counts = PropertyMergeCounts {
        moved: i64::try_from(moved.len()).unwrap(),
        dropped: i64::try_from(dropped).unwrap(),
    };
    let preview =
        preview_property_merge_inner(&case.pool, TEST_SPACE_ID, from.clone(), into.clone())
            .await
            .unwrap();
    assert_eq!(preview, counts, "the preview counts what the model does");
    let merged = capture_op_refs(merge_property_key_inner(
        &case.pool,
        DEV,
        &case.mat,
        TEST_SPACE_ID,
        from.clone(),
        into.clone(),
        counts,
    ))
    .await
    .unwrap();
    let model = &mut case.model;
    model.defs.remove(&from);
    for page in 0..PAGES {
        if let Some(value) = model.values.remove(&(page, from.clone()))
            && moved.contains(&page)
        {
            model.values.insert((page, into.clone()), value);
        }
    }
    for &page in &moved {
        for cell in model.cells.iter_mut().filter(|c| c.page == page) {
            if cell.key == into {
                cell.shadowed = true;
            } else if cell.key == from && cell.shadowed {
                cell.shadowed = false;
            } else if cell.key == from {
                cell.key.clone_from(&into);
            }
        }
    }
    Some(Step::Key {
        op: merged.op_refs[0].clone(),
        change: format!("merge {from} into {into}"),
    })
}

async fn run_script(case: &mut Case, draws: &[Draw]) -> Vec<Step> {
    let mut steps = Vec::new();
    for (i, d) in draws.iter().enumerate() {
        let step = match d.kind {
            0 | 1 => write_step(case, d).await,
            2 => rename_step(case, d).await,
            _ => merge_step(case, d).await,
        };
        if let Some(step) = step {
            let label = match &step {
                Step::Key { change, .. } => change.clone(),
                write @ Step::Write { .. } => format!("{write:?}"),
            };
            assert_in_step(case, &format!("step {i}: {label}")).await;
            steps.push(step);
        }
    }
    steps
}

/// P1: undoing every op, newest first, brings SQL and the doc back to the
/// seed.
async fn undo_all(case: &mut Case, steps: &[Step]) {
    for step in steps.iter().rev() {
        undo_ops_inner(&case.pool, DEV, &case.mat, vec![step.op().clone()])
            .await
            .unwrap_or_else(|e| panic!("undo {step:?}: {e}"));
    }
    case.model = Model::seed();
    assert_in_step(case, "after undoing everything").await;
}

/// P2: undoing one earlier set or delete writes its prior under the key its
/// cell lives under now, and changes nothing else.
async fn undo_one(case: &mut Case, steps: &[Step], pick: usize) {
    let writes: Vec<usize> = (0..steps.len())
        .filter(|&i| matches!(steps[i], Step::Write { .. }))
        .collect();
    if writes.is_empty() {
        return;
    }
    let index = writes[pick % writes.len()];
    let Step::Write {
        op,
        page,
        key: written,
        cell,
        prior,
    } = &steps[index]
    else {
        unreachable!("filtered to writes");
    };
    let key = case.model.cells[*cell].key.clone();
    undo_ops_inner(&case.pool, DEV, &case.mat, vec![op.clone()])
        .await
        .unwrap_or_else(|e| panic!("undo step {index}: {e}"));
    match prior {
        Some(value) => case
            .model
            .values
            .insert((*page, key.clone()), value.clone()),
        None => case.model.values.remove(&(*page, key.clone())),
    };
    let sql = sql_values(case).await;
    assert_eq!(
        sql, case.model.values,
        "undo of step {index} ({written} on page {page}), under {key} now"
    );
    assert_eq!(doc_state(case).0, sql, "the doc equals SQL after the undo");
}

#[test]
fn renames_and_merges_interleaved_with_writes_undo_cleanly_5841() {
    let mut runner = proptest::test_runner::TestRunner::new(ProptestConfig {
        cases: CASES,
        source_file: Some(file!()),
        ..ProptestConfig::default()
    });
    let strategy = (
        prop::collection::vec(draw(), 1..=10),
        any::<bool>(),
        any::<usize>(),
    );
    let result = runner.run(&strategy, |(draws, all, pick)| {
        Runtime::new().unwrap().block_on(async {
            let mut case = new_case().await;
            let steps = run_script(&mut case, &draws).await;
            if all {
                undo_all(&mut case, &steps).await;
            } else {
                undo_one(&mut case, &steps, pick).await;
            }
        });
        Ok(())
    });
    if let Err(failure) = result {
        panic!("{failure}\n{runner}");
    }
}
