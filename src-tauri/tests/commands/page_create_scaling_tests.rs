//! #6527 — a new page sends SQL its own rank, whatever its space already
//! holds.
//!
//! Every page and tag of a space is a root child of its doc, so a create that
//! re-sends every root rank to SQL makes a folder import quadratic.
//!
//! The count test reads `reproject_call_spy`, a process-global counter, so it
//! needs nextest's process per test
//! (`src-tauri/tests/AGENTS.md` § "Process-global state").

use crate::prelude::*;
use agaric_engine::loro::projection::reproject_call_spy;

struct Vault {
    pool: SqlitePool,
    mat: Materializer,
    _dir: tempfile::TempDir,
    space: String,
}

async fn vault() -> Vault {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let space = create_space_inner(&pool, DEV, &mat, "Vault".into(), None)
        .await
        .unwrap()
        .into_string();
    settle(&mat).await;
    Vault {
        pool,
        mat,
        _dir: dir,
        space,
    }
}

impl Vault {
    async fn create_page(&self, title: &str) -> String {
        let id = create_page_in_space_inner(
            &self.pool,
            DEV,
            &self.mat,
            None,
            title.into(),
            self.space.clone(),
        )
        .await
        .unwrap()
        .into_string();
        settle(&self.mat).await;
        id
    }

    /// The doc's root blocks with their SQL rank, in SQL sibling order. The
    /// space's own block is one of them, and the first: it was there before
    /// any page.
    async fn root_ranks(&self) -> Vec<(String, i64)> {
        sqlx::query_as(
            "SELECT id, position FROM blocks \
             WHERE parent_id IS NULL AND (space_id = ?1 OR id = ?1) \
             ORDER BY position, id",
        )
        .bind(&self.space)
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_page_sends_its_own_rank_alone_6527() {
    let v = vault().await;
    let mut pages = Vec::new();
    for i in 0..5 {
        pages.push(v.create_page(&format!("Page {i}")).await);
    }

    reproject_call_spy::reset();
    pages.push(v.create_page("Page 5").await);

    assert_eq!(
        reproject_call_spy::ids(),
        1,
        "the new page's own rank, not the space's block and the five pages before it"
    );
    pages.insert(0, v.space.clone());
    let expected: Vec<(String, i64)> = pages.into_iter().zip(1..).collect();
    assert_eq!(v.root_ranks().await, expected);
}

/// A purge reprojects nothing, so it leaves a gap in its group's ranks. The
/// next create must not write its page onto a rank a sibling still holds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_page_after_a_purged_one_closes_the_rank_gap_6527() {
    let v = vault().await;
    let mut pages = Vec::new();
    for i in 0..4 {
        pages.push(v.create_page(&format!("Page {i}")).await);
    }
    let gone = pages.remove(1);
    let gone = BlockId::from_trusted(&gone);
    delete_block_inner(&v.pool, DEV, &v.mat, gone.clone())
        .await
        .unwrap();
    purge_block_inner(&v.pool, DEV, &v.mat, gone).await.unwrap();
    settle(&v.mat).await;

    pages.push(v.create_page("After the purge").await);

    pages.insert(0, v.space.clone());
    let expected: Vec<(String, i64)> = pages.into_iter().zip(1..).collect();
    assert_eq!(v.root_ranks().await, expected);
}
