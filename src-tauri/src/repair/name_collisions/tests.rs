//! The collision pass across two devices (#6278 I3).
//!
//! Each device is a pool, a `Materializer` with its own `LoroState`, and the
//! app's own commands; a sync ships one space's doc the way the catch-up does.
//! No process-global state: neither shape in `src-tauri/tests/AGENTS.md`
//! § "Process-global state".

use std::sync::Arc;

use sqlx::SqlitePool;
use tempfile::TempDir;

use super::*;
use crate::commands::{
    add_tag_inner, create_block_inner, create_block_inner_with_space, create_page_in_space_inner,
    create_space_inner, move_blocks_to_space_inner,
};
use crate::db::init_pool;
use crate::mcp::view_notify::RecordingViewChangeEmitter;
use crate::spaces::{SPACE_WORK_ULID, SpacePlacementSink};
use agaric_store::space::SpaceScope;
use agaric_sync::sync_events::{RecordingEventSink, SyncEvent, SyncEventSink};
use agaric_sync::sync_protocol::loro_sync::{
    ApplyOutcome, apply_remote, prepare_outgoing_for_pool,
};

struct Device {
    id: &'static str,
    pool: SqlitePool,
    mat: Materializer,
    _dir: TempDir,
}

async fn device(id: &'static str) -> Device {
    let dir = TempDir::new().unwrap();
    let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
    let mat = Materializer::new(pool.clone());
    crate::spaces::bootstrap_spaces(&pool, id, &mat)
        .await
        .unwrap();
    Device {
        id,
        pool,
        mat,
        _dir: dir,
    }
}

impl Device {
    async fn pass(&self) -> NameCollisionRepair {
        repair_name_collisions(&self.pool, &self.pool, self.id, &self.mat).await
    }

    async fn page(&self, space: &str, title: &str) -> String {
        create_page_in_space_inner(
            &self.pool,
            self.id,
            &self.mat,
            None,
            title.to_owned(),
            space.to_owned(),
        )
        .await
        .unwrap()
        .into_string()
    }

    async fn tag(&self, space: &str, name: &str) -> String {
        let scope = SpaceScope::Active(SpaceId::from_trusted(space));
        create_block_inner_with_space(
            &self.pool,
            self.id,
            &self.mat,
            "tag".into(),
            name.into(),
            None,
            None,
            &scope,
            None,
        )
        .await
        .unwrap()
        .id
        .into_string()
    }

    async fn block(&self, parent: &str, content: &str) -> String {
        create_block_inner(
            &self.pool,
            self.id,
            &self.mat,
            "content".into(),
            content.into(),
            Some(BlockId::from_trusted(parent)),
            None,
        )
        .await
        .unwrap()
        .id
        .into_string()
    }

    /// One block of `content` on each of two pages of `space`, as `(inside,
    /// outside, outside_page)` with the larger id outside: a merge walks ids in
    /// order, so one with no guard reaches the inside block first and a
    /// partial merge shows.
    async fn two_blocks(&self, space: &str, content: &str) -> (String, String, String) {
        let first_page = self.page(space, "First").await;
        let second_page = self.page(space, "Second").await;
        let first = self.block(&first_page, content).await;
        let second = self.block(&second_page, content).await;
        if first < second {
            (first, second, second_page)
        } else {
            (second, first, first_page)
        }
    }

    /// Move `page`, with its blocks, to the Work space.
    async fn move_to_work(&self, page: &str) {
        move_blocks_to_space_inner(
            &self.pool,
            self.id,
            &self.mat,
            vec![BlockId::from_trusted(page)],
            SPACE_WORK_ULID.to_owned(),
            &[],
        )
        .await
        .unwrap();
    }

    async fn add_tag(&self, block: &str, tag: &str) {
        add_tag_inner(
            &self.pool,
            self.id,
            &self.mat,
            BlockId::from_trusted(block),
            BlockId::from_trusted(tag),
        )
        .await
        .unwrap();
    }

    async fn content(&self, id: &str) -> String {
        sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    async fn deleted(&self, id: &str) -> bool {
        sqlx::query_scalar::<_, Option<i64>>("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .unwrap()
            .is_some()
    }

    async fn tags_of(&self, id: &str) -> Vec<String> {
        sqlx::query_scalar("SELECT tag_id FROM block_tags WHERE block_id = ? ORDER BY tag_id")
            .bind(id)
            .fetch_all(&self.pool)
            .await
            .unwrap()
    }

    async fn op_count(&self) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// `(op_type, origin)` of every op past `seq`, in order.
    async fn ops_after(&self, seq: i64) -> Vec<(String, String)> {
        sqlx::query_as("SELECT op_type, origin FROM op_log WHERE seq > ? ORDER BY seq")
            .bind(seq)
            .fetch_all(&self.pool)
            .await
            .unwrap()
    }

    async fn head(&self) -> i64 {
        sqlx::query_scalar("SELECT COALESCE(MAX(seq), 0) FROM op_log")
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// The integrity check's engine divergences.
    async fn engine_drift(&self) -> Vec<(String, String)> {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 11, 4).unwrap();
        crate::reconciliation_oracle::reconcile_all(&self.pool, self.mat.loro_state(), None, today)
            .await
            .unwrap()
            .into_iter()
            .filter(|d| d.artefact.starts_with("engine."))
            .map(|d| (d.artefact.to_owned(), d.key))
            .collect()
    }
}

/// Ship `space`'s doc from `from` to `to`, then `to`'s post-import rebuilds,
/// as a session does.
async fn sync(from: &Device, to: &Device, space: &str) {
    from.mat.flush_background().await.unwrap();
    let message = prepare_outgoing_for_pool(
        &from.pool,
        &from.mat.loro_state().registry,
        &SpaceId::from_trusted(space),
        from.id,
        None,
    )
    .await
    .unwrap()
    .expect("the freshness gate must not refuse a consistent engine");
    let outcome = apply_remote(&to.pool, &to.mat.loro_state().registry, to.id, message)
        .await
        .unwrap();
    let ApplyOutcome::Imported { changed_blocks, .. } = outcome else {
        panic!("a snapshot imports, got {outcome:?}");
    };
    to.mat
        .enqueue_inbound_sync_rebuilds(&changed_blocks, &[])
        .await
        .unwrap();
    to.mat.flush_inbound_rebuilds().await.unwrap();
}

async fn sync_both(a: &Device, b: &Device, space: &str) {
    sync(a, b, space).await;
    sync(b, a, space).await;
}

/// Two devices that share a space A created, each having made what `make`
/// makes in it while the other could not see it, then synced both ways.
struct Pair {
    a: Device,
    b: Device,
    space: String,
}

async fn pair() -> Pair {
    let a = device("device-A").await;
    let b = device("device-B").await;
    let space = create_space_inner(&a.pool, a.id, &a.mat, "Research".into(), None)
        .await
        .unwrap()
        .into_string();
    sync(&a, &b, &space).await;
    Pair { a, b, space }
}

impl Pair {
    /// `(creator, other)`: the device that made the larger of `ids`, the
    /// later member of a tie, and the device that did not. The ids are
    /// minted in the same millisecond often enough that creation order is
    /// not id order, so every test reads it from the ids.
    fn creator_of_later(&self, id_a: &str, id_b: &str) -> (&Device, &Device) {
        if id_b > id_a {
            (&self.b, &self.a)
        } else {
            (&self.a, &self.b)
        }
    }

    fn shutdown(&self) {
        self.a.mat.shutdown();
        self.b.mat.shutdown();
    }
}

/// Each device titles a page of the shared space under one fold while the
/// other cannot see it. Returns `(page_a, page_b)`.
async fn page_tie(pair: &Pair, title_a: &str, title_b: &str) -> (String, String) {
    let page_a = pair.a.page(&pair.space, title_a).await;
    let page_b = pair.b.page(&pair.space, title_b).await;
    sync_both(&pair.a, &pair.b, &pair.space).await;
    (page_a, page_b)
}

/// Each device names a tag of the shared space under one fold while the other
/// cannot see it. Returns `(tag_a, tag_b)`.
async fn tag_tie(pair: &Pair, name_a: &str, name_b: &str) -> (String, String) {
    let tag_a = pair.a.tag(&pair.space, name_a).await;
    let tag_b = pair.b.tag(&pair.space, name_b).await;
    sync_both(&pair.a, &pair.b, &pair.space).await;
    (tag_a, tag_b)
}

/// The tie's later page is renamed by the device that created it and by no
/// other, and both devices end with the same two titles: the holder's as it
/// was, the later one with one ` (2)`. Two renames would be two text
/// splices, and the merge would read `foo (2) (2)`. A second run on either
/// device writes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_the_later_pages_creator_renames_it_and_both_devices_converge() {
    let pair = pair().await;
    let (page_a, page_b) = page_tie(&pair, "Foo", "foo").await;
    let (creator, other) = pair.creator_of_later(&page_a, &page_b);
    let (keeper, later) = if page_a < page_b {
        (&page_a, &page_b)
    } else {
        (&page_b, &page_a)
    };
    let title_of = |id: &str| if id == page_a { "Foo" } else { "foo" };
    let renamed_to = format!("{} (2)", title_of(later));

    // Each device runs the pass after its own sync.
    let head = creator.head().await;
    let by_creator = creator.pass().await;
    let rename_ops = creator.ops_after(head).await;
    let by_other = other.pass().await;
    sync_both(&pair.a, &pair.b, &pair.space).await;

    for device in [&pair.a, &pair.b] {
        assert_eq!(
            (device.content(keeper).await, device.content(later).await),
            (title_of(keeper).to_owned(), renamed_to.clone()),
            "{}: the holder keeps its title and the later page carries one suffix",
            device.id
        );
    }
    assert_eq!(
        by_creator.renamed,
        vec![PageRenamed {
            page_id: later.clone(),
            from: title_of(later).to_owned(),
            to: renamed_to.clone(),
        }],
        "the creator renames the later page and reports it for its notice"
    );
    assert_eq!(by_other.renamed, vec![], "the other device renames nothing");

    assert_eq!(
        rename_ops,
        vec![("edit_block".to_owned(), Actor::Housekeeping.origin_tag())],
        "the rename is one EditBlock, appended as housekeeping"
    );

    let ops = (pair.a.op_count().await, pair.b.op_count().await);
    for device in [&pair.a, &pair.b] {
        assert_eq!(
            device.pass().await.renamed,
            vec![],
            "{}: a second run renames nothing",
            device.id
        );
    }
    assert_eq!(
        (pair.a.op_count().await, pair.b.op_count().await),
        ops,
        "a second run writes no op on either device"
    );
    pair.shutdown();
}

/// A tie whose later page was made by a device that never runs the pass (it
/// is gone) stays as it is: no other device renames it, and nothing is
/// written.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tie_whose_creator_is_absent_stays() {
    let pair = pair().await;
    let (page_a, page_b) = page_tie(&pair, "Untitled", "Untitled").await;
    let (_gone, survivor) = pair.creator_of_later(&page_a, &page_b);
    let ops = survivor.op_count().await;

    let report = survivor.pass().await;

    assert_eq!(report.renamed, vec![], "only the creator renames");
    assert_eq!(
        (
            survivor.content(&page_a).await,
            survivor.content(&page_b).await
        ),
        ("Untitled".to_owned(), "Untitled".to_owned()),
        "both pages keep their title"
    );
    assert_eq!(survivor.op_count().await, ops, "nothing is written");
    pair.shutdown();
}

/// The first free name skips a `Title (n)` another page holds as its title or
/// as an alias, folded.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_rename_takes_the_first_name_no_page_holds() {
    let pair = pair().await;
    let (page_a, page_b) = page_tie(&pair, "Plan", "Plan").await;
    let (creator, _) = pair.creator_of_later(&page_a, &page_b);
    let later = page_a.clone().max(page_b.clone());
    creator.page(&pair.space, "plan (2)").await;
    let aliased = creator.page(&pair.space, "Elsewhere").await;
    crate::commands::set_page_aliases_inner(
        &creator.pool,
        creator.id,
        &creator.mat,
        &aliased,
        vec!["PLAN (3)".to_owned()],
    )
    .await
    .unwrap();

    let report = creator.pass().await;

    assert_eq!(
        report
            .renamed
            .iter()
            .map(|r| r.to.as_str())
            .collect::<Vec<_>>(),
        vec!["Plan (4)"],
        "(2) is a title and (3) an alias of another page"
    );
    assert_eq!(creator.content(&later).await, "Plan (4)");
    pair.shutdown();
}

/// Two same-named tags: the later tag's creator gives the keeper to each
/// block holding the later tag, rewrites `#[LATER]` in each block naming it,
/// and deletes the emptied tag, as housekeeping ops the engine agrees with. A
/// second run writes nothing, and the other device converges on the merge.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_later_tags_creator_merges_it_into_the_keeper() {
    let pair = pair().await;
    let tag_a = pair.a.tag(&pair.space, "project").await;
    let tag_b = pair.b.tag(&pair.space, "Project").await;
    sync_both(&pair.a, &pair.b, &pair.space).await;
    let (creator, other) = pair.creator_of_later(&tag_a, &tag_b);
    let (keeper, later) = if tag_a < tag_b {
        (&tag_a, &tag_b)
    } else {
        (&tag_b, &tag_a)
    };
    let page = creator.page(&pair.space, "Notes").await;
    let held = [
        creator.block(&page, "one").await,
        creator.block(&page, "two").await,
    ];
    let both = creator.block(&page, "both").await;
    let named = creator
        .block(&page, &format!("see #[{later}] and #[{later}]"))
        .await;
    for block in held.iter().chain([&both]) {
        creator.add_tag(block, later).await;
    }
    creator.add_tag(&both, keeper).await;
    let head = creator.head().await;

    let report = repair_in_chunks(&creator.pool, &creator.pool, creator.id, &creator.mat, 1).await;
    creator.mat.flush_background().await.unwrap();

    for block in held.iter().chain([&both]) {
        assert_eq!(
            creator.tags_of(block).await,
            vec![keeper.clone()],
            "a holder of the later tag holds the keeper instead"
        );
    }
    assert_eq!(
        creator.content(&named).await,
        format!("see #[{keeper}] and #[{keeper}]"),
        "every inline ref names the keeper"
    );
    assert!(creator.deleted(later).await, "the emptied tag is deleted");
    assert_eq!(report.tags_merged, 1);
    let mut ops: Vec<String> = creator
        .ops_after(head)
        .await
        .into_iter()
        .map(|(op_type, origin)| {
            assert_eq!(
                origin,
                Actor::Housekeeping.origin_tag(),
                "{op_type} is housekeeping"
            );
            op_type
        })
        .collect();
    ops.sort_unstable();
    assert_eq!(
        ops,
        [
            "add_tag",
            "add_tag",
            "delete_block",
            "edit_block",
            "remove_tag",
            "remove_tag",
            "remove_tag"
        ],
        "AddTag for the two holders without the keeper, RemoveTag for all three, \
         one EditBlock, one DeleteBlock"
    );
    assert_eq!(
        creator.engine_drift().await,
        vec![],
        "the engine agrees with SQL"
    );

    let written = creator.op_count().await;
    assert_eq!(creator.pass().await.tags_merged, 0);
    assert_eq!(
        creator.op_count().await,
        written,
        "a second run writes nothing"
    );

    sync(creator, other, &pair.space).await;
    assert!(
        other.deleted(later).await,
        "the merge reaches the other device"
    );
    assert_eq!(other.tags_of(&held[0]).await, vec![keeper.clone()]);
    pair.shutdown();
}

/// A merge moves its holders a chunk per transaction: a chunk that fails
/// rolls back alone, the ones before it stay, the tag is kept while anything
/// still holds it, and the next run finishes the merge.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_chunk_keeps_the_ones_before_it_and_the_next_run_finishes() {
    let pair = pair().await;
    let tag_a = pair.a.tag(&pair.space, "ideas").await;
    let tag_b = pair.b.tag(&pair.space, "Ideas").await;
    sync_both(&pair.a, &pair.b, &pair.space).await;
    let (creator, _) = pair.creator_of_later(&tag_a, &tag_b);
    let (keeper, later) = if tag_a < tag_b {
        (&tag_a, &tag_b)
    } else {
        (&tag_b, &tag_a)
    };
    let page = creator.page(&pair.space, "Inbox").await;
    let mut holders = Vec::new();
    for text in ["a", "b", "c"] {
        let block = creator.block(&page, text).await;
        creator.add_tag(&block, later).await;
        holders.push(block);
    }
    holders.sort_unstable();
    // dynamic-sql: test-only trigger DDL keyed on the fixture's id.
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "CREATE TRIGGER fail_last_chunk BEFORE INSERT ON op_log \
         WHEN NEW.op_type = 'remove_tag' AND NEW.block_id = '{}' \
         BEGIN SELECT RAISE(ABORT, 'injected chunk failure'); END",
        holders[2]
    )))
    .execute(&creator.pool)
    .await
    .unwrap();

    let report = repair_in_chunks(&creator.pool, &creator.pool, creator.id, &creator.mat, 1).await;

    assert_eq!(report.tags_merged, 0, "the merge did not finish");
    for holder in &holders[..2] {
        assert_eq!(
            creator.tags_of(holder).await,
            vec![keeper.clone()],
            "a committed chunk stays"
        );
    }
    assert_eq!(
        creator.tags_of(&holders[2]).await,
        vec![later.clone()],
        "the failed chunk rolled back whole: no keeper, the later tag kept"
    );
    assert!(
        !creator.deleted(later).await,
        "a tag still held is not deleted"
    );
    assert_eq!(
        creator.engine_drift().await,
        vec![],
        "the engine rolled back with SQL"
    );

    sqlx::query("DROP TRIGGER fail_last_chunk")
        .execute(&creator.pool)
        .await
        .unwrap();
    let report = repair_in_chunks(&creator.pool, &creator.pool, creator.id, &creator.mat, 1).await;

    assert_eq!(report.tags_merged, 1);
    assert_eq!(creator.tags_of(&holders[2]).await, vec![keeper.clone()]);
    assert!(creator.deleted(later).await);
    pair.shutdown();
}

/// A block of another space holds the later tag: the keeper cannot be applied
/// there (a tag may not cross spaces), so the tie is left whole. A merge that
/// went as far as it could would move the inside holder and leave the later tag
/// live and held, and fail on the outside one at every run.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tie_whose_later_tag_a_block_of_another_space_holds_is_left_whole() {
    let pair = pair().await;
    let (tag_a, tag_b) = tag_tie(&pair, "ideas", "Ideas").await;
    let (creator, _) = pair.creator_of_later(&tag_a, &tag_b);
    let later = tag_a.clone().max(tag_b.clone());
    let (inside, outside, outside_page) = creator.two_blocks(&pair.space, "held").await;
    creator.add_tag(&inside, &later).await;
    creator.add_tag(&outside, &later).await;
    creator.move_to_work(&outside_page).await;
    assert_eq!(
        creator.tags_of(&outside).await,
        vec![later.clone()],
        "fixture: the moved block still holds the tag"
    );
    let ops = creator.op_count().await;

    let report = repair_in_chunks(&creator.pool, &creator.pool, creator.id, &creator.mat, 1).await;

    assert_eq!(report.tags_merged, 0, "the tie is not merged");
    for holder in [&inside, &outside] {
        assert_eq!(
            creator.tags_of(holder).await,
            vec![later.clone()],
            "no holder moves, the one in the tag's own space included"
        );
    }
    assert!(!creator.deleted(&later).await, "the later tag stays");
    assert_eq!(creator.op_count().await, ops, "nothing is written");
    pair.shutdown();
}

/// A block of another space names the later tag: an edit naming the keeper
/// there is refused, so the tie is left whole, as for a holder.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tie_whose_later_tag_a_block_of_another_space_names_is_left_whole() {
    let pair = pair().await;
    let (tag_a, tag_b) = tag_tie(&pair, "ideas", "Ideas").await;
    let (creator, _) = pair.creator_of_later(&tag_a, &tag_b);
    let later = tag_a.clone().max(tag_b.clone());
    let text = format!("see #[{later}]");
    let (inside, outside, outside_page) = creator.two_blocks(&pair.space, &text).await;
    creator.move_to_work(&outside_page).await;
    let ops = creator.op_count().await;

    let report = repair_in_chunks(&creator.pool, &creator.pool, creator.id, &creator.mat, 1).await;

    assert_eq!(report.tags_merged, 0, "the tie is not merged");
    for block in [&inside, &outside] {
        assert_eq!(
            creator.content(block).await,
            text,
            "no reference is rewritten, the one in the tag's own space included"
        );
    }
    assert!(!creator.deleted(&later).await, "the later tag stays");
    assert_eq!(creator.op_count().await, ops, "nothing is written");
    pair.shutdown();
}

/// A run that raced another finds the tie already merged: each transaction
/// reads the tie again, so the stale run changes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stale_tie_is_a_no_op() {
    let pair = pair().await;
    let (tag_a, tag_b) = tag_tie(&pair, "ideas", "Ideas").await;
    let (creator, _) = pair.creator_of_later(&tag_a, &tag_b);
    let tie = TagTie {
        space_id: pair.space.clone(),
        keeper: tag_a.clone().min(tag_b.clone()),
        later: tag_a.clone().max(tag_b.clone()),
    };
    let page = creator.page(&pair.space, "Notes").await;
    let held = creator.block(&page, "one").await;
    creator.add_tag(&held, &tie.later).await;
    let merged = merge_tag(
        &creator.pool,
        creator.id,
        &creator.mat,
        &tie,
        TAG_MERGE_CHUNK,
    )
    .await;
    assert!(
        matches!(merged, Ok(true)),
        "the first run merges: {merged:?}"
    );
    let ops = creator.op_count().await;

    let stale = merge_tag(
        &creator.pool,
        creator.id,
        &creator.mat,
        &tie,
        TAG_MERGE_CHUNK,
    )
    .await;

    assert!(
        matches!(stale, Ok(false)),
        "the stale run finds it gone: {stale:?}"
    );
    assert_eq!(
        creator.op_count().await,
        ops,
        "the stale run writes nothing"
    );
    pair.shutdown();
}

/// A sync session's post-sync task merges the duplicate journal day the
/// session completed and renames the later page of a tie this device made,
/// then tells the views to reload everything and sends the renames as its
/// notice.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sync_session_merges_journal_days_and_renames_through_its_sink() {
    let pair = pair().await;
    let day = "2026-11-04";
    let day_a = pair.a.page(&pair.space, day).await;
    let day_b = pair.b.page(&pair.space, day).await;
    pair.a.block(&day_a, "from A").await;
    pair.b.block(&day_b, "from B").await;
    let (page_a, page_b) = page_tie(&pair, "Meeting", "meeting").await;
    let (device, _) = pair.creator_of_later(&page_a, &page_b);
    let later = page_a.clone().max(page_b.clone());
    let from = device.content(&later).await;
    let children_of = |pages: [&String; 2]| {
        let pool = device.pool.clone();
        let pages = serde_json::to_string(&pages).unwrap();
        async move {
            let mut ids: Vec<String> = sqlx::query_scalar(
                "SELECT id FROM blocks WHERE deleted_at IS NULL \
                 AND parent_id IN (SELECT value FROM json_each(?))",
            )
            .bind(pages)
            .fetch_all(&pool)
            .await
            .unwrap();
            ids.sort_unstable();
            ids
        }
    };
    let notes = children_of([&day_a, &day_b]).await;
    assert_eq!(notes.len(), 2, "fixture: each day holds its device's block");
    let view = Arc::new(RecordingViewChangeEmitter::new());
    let sink = SpacePlacementSink::new(
        Arc::new(RecordingEventSink(std::sync::Mutex::new(Vec::new()))),
        device.pool.clone(),
        device.pool.clone(),
        device.id.into(),
        device.mat.clone(),
        view.clone(),
    );

    sink.on_sync_event(SyncEvent::Complete {
        remote_device_id: "PEER".into(),
        ops_received: 1,
        ops_sent: 0,
        changed_page_ids: vec![later.clone()],
        changed_blocks: None,
    });
    let task = sink.last_task.lock().unwrap().take().expect("spawned");
    task.await.unwrap();

    let days: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM blocks WHERE block_type = 'page' AND content = ? \
         AND space_id = ? AND deleted_at IS NULL",
    )
    .bind(day)
    .bind(&pair.space)
    .fetch_all(&device.pool)
    .await
    .unwrap();
    let keeper_day = day_a.clone().min(day_b.clone());
    assert_eq!(days, vec![keeper_day.clone()], "one live page for the day");
    assert_eq!(
        children_of([&keeper_day, &keeper_day]).await,
        notes,
        "both days' blocks are on the kept page"
    );
    assert_eq!(
        view.pages_renamed(),
        vec![vec![PageRenamed {
            page_id: later.clone(),
            from: from.clone(),
            to: format!("{from} (2)"),
        }]],
        "the rename is the notice"
    );
    assert_eq!(
        view.blocks_changed(),
        vec![Vec::<String>::new()],
        "a repair reloads every view"
    );
    assert_eq!(
        view.local_ops_appended(),
        vec![true],
        "a repair's ops are this device's own (#6541)"
    );
    pair.shutdown();
}

/// Boot runs the pass beside the journal repair, for a tie a vault already
/// carries.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn boot_renames_a_tie_the_vault_carries() {
    let pair = pair().await;
    let (page_a, page_b) = page_tie(&pair, "Draft", "DRAFT").await;
    let (creator, _) = pair.creator_of_later(&page_a, &page_b);
    let later = page_a.clone().max(page_b.clone());
    let from = creator.content(&later).await;

    crate::repair::repair_unreachable_content_at_boot(
        &creator.pool,
        &creator.pool,
        creator.id,
        &creator.mat,
    )
    .await;

    assert_eq!(
        creator.content(&later).await,
        format!("{from} (2)"),
        "the boot pass renamed the later page"
    );
    pair.shutdown();
}

/// Two devices' pages for one journal day are the journal merge's: the pass
/// never renames one, which would take it out of that merge and out of the
/// journal for good.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_duplicate_journal_day_is_left_to_the_journal_merge() {
    let pair = pair().await;
    let (day_a, day_b) = page_tie(&pair, "2026-11-04", "2026-11-04").await;
    let (creator, _) = pair.creator_of_later(&day_a, &day_b);
    let ops = creator.op_count().await;

    let report = creator.pass().await;

    assert_eq!(report.renamed, vec![], "no journal day is renamed");
    assert_eq!(creator.op_count().await, ops, "nothing is written");
    pair.shutdown();
}

#[test]
fn a_journal_title_is_the_journal_repairs_digit_mask() {
    for (title, journal) in [
        ("2026-11-04", true),
        ("0000-00-00", true),
        ("2026-11-4", false),
        ("2026-11-04 ", false),
        ("2026/11/04", false),
        ("note-on-me", false),
        ("２026-11-04", false),
    ] {
        assert_eq!(is_journal_title(title), journal, "{title:?}");
    }
}
