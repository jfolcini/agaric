//! #6278 I1 — one name key (`agaric_core::tag_norm::name_key`: trim, Unicode
//! case, NFC) on every write path that names a page or a tag in a space. A
//! create resolves to the page that holds the name; a rename, restore, undo
//! or move onto it is refused; and a page title and another page's alias in
//! one space never hold one name.

use crate::prelude::*;
use agaric_core::error::ValidationCode;
use agaric_store::op::OpRef;

/// The holder's title, NFC.
const CAFE: &str = "Caf\u{e9}";
/// Spellings that are one name with [`CAFE`]: another case, NFD, a trailing
/// space.
const RESPELLINGS: [&str; 3] = ["caf\u{e9}", "Cafe\u{301}", "Caf\u{e9} "];

struct Vault {
    pool: SqlitePool,
    mat: Materializer,
    _dir: tempfile::TempDir,
    a: String,
    b: String,
}

async fn vault() -> Vault {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let a = create_space_inner(&pool, DEV, &mat, "A".into(), None)
        .await
        .unwrap()
        .into_string();
    let b = create_space_inner(&pool, DEV, &mat, "B".into(), None)
        .await
        .unwrap()
        .into_string();
    Vault {
        pool,
        mat,
        _dir: dir,
        a,
        b,
    }
}

impl Vault {
    async fn create(&self, space: &str, title: &str) -> Result<BlockId, AppError> {
        let created = create_page_in_space_inner(
            &self.pool,
            DEV,
            &self.mat,
            None,
            title.into(),
            space.into(),
        )
        .await;
        settle(&self.mat).await;
        created
    }

    async fn page(&self, space: &str, title: &str) -> BlockId {
        self.create(space, title).await.expect("create the page")
    }

    async fn tag(&self, name: &str) -> BlockRow {
        let tag = create_block_inner_with_space(
            &self.pool,
            DEV,
            &self.mat,
            "tag".into(),
            name.into(),
            None,
            None,
            &SpaceScope::Active(SpaceId::from_trusted(&self.a)),
            None,
        )
        .await
        .expect("create the tag");
        settle(&self.mat).await;
        tag
    }

    /// A tag of space A named `name` as one from before #6278 I4 may be: made
    /// by the plain create, which runs no name rule, and stamped into A.
    async fn tag_named_before_the_rule(&self, name: &str) -> BlockId {
        let tag = create_block_inner(
            &self.pool,
            DEV,
            &self.mat,
            "tag".into(),
            name.into(),
            None,
            None,
        )
        .await
        .expect("create the tag");
        assign_to_space(&self.pool, tag.id.as_str(), &self.a).await;
        settle(&self.mat).await;
        tag.id
    }

    async fn rename(&self, block: &BlockId, to: &str) -> Result<BlockRow, AppError> {
        let renamed = edit_block_inner(&self.pool, DEV, &self.mat, block.clone(), to.into()).await;
        settle(&self.mat).await;
        renamed
    }

    async fn set_aliases(&self, page: &BlockId, aliases: &[&str]) -> Result<Vec<String>, AppError> {
        let aliases = aliases.iter().map(|&a| a.to_owned()).collect();
        let set = set_page_aliases_inner(&self.pool, DEV, &self.mat, page.as_str(), aliases).await;
        settle(&self.mat).await;
        set
    }

    async fn trashed(&self, space: &str, title: &str) -> (BlockId, i64) {
        let page = self.page(space, title).await;
        let deleted = delete_block_inner(&self.pool, DEV, &self.mat, page.clone())
            .await
            .expect("trash the page");
        settle(&self.mat).await;
        (page, deleted.deleted_at)
    }

    async fn content(&self, block: &BlockId) -> String {
        sqlx::query_scalar::<_, String>("SELECT content FROM blocks WHERE id = ?")
            .bind(block.as_str())
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    async fn is_live(&self, block: &BlockId) -> bool {
        sqlx::query_scalar::<_, Option<i64>>("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(block.as_str())
            .fetch_one(&self.pool)
            .await
            .unwrap()
            .is_none()
    }

    async fn space_of(&self, block: &BlockId) -> String {
        sqlx::query_scalar::<_, String>("SELECT space_id FROM blocks WHERE id = ?")
            .bind(block.as_str())
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    async fn ops(&self) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM op_log")
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// The newest op `op_type` appended for `block`.
    async fn last_op(&self, block: &BlockId, op_type: &str) -> OpRef {
        let seq = sqlx::query_scalar::<_, i64>(
            "SELECT MAX(seq) FROM op_log WHERE block_id = ? AND op_type = ?",
        )
        .bind(block.as_str())
        .bind(op_type)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        OpRef {
            device_id: DEV.into(),
            seq,
        }
    }
}

/// Refused with `code`, for the reason `what` names.
fn assert_refused<T: std::fmt::Debug>(
    result: Result<T, AppError>,
    code: ValidationCode,
    what: &str,
) {
    let err = result.expect_err(what);
    assert_eq!(err.validation_code(), Some(code), "{what}: got {err:?}");
}

/// A create naming a title the space holds under another spelling is that
/// page: its id back, no op appended. The rule is per space.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_create_resolves_to_the_page_whose_title_is_the_same_name() {
    let v = vault().await;
    let holder = v.page(&v.a, CAFE).await;
    let ops = v.ops().await;

    for spelling in RESPELLINGS {
        assert_eq!(
            v.page(&v.a, spelling).await,
            holder,
            "{spelling:?} names the page {CAFE:?}"
        );
        let picked = create_block_inner_with_space(
            &v.pool,
            DEV,
            &v.mat,
            "page".into(),
            spelling.into(),
            None,
            None,
            &SpaceScope::Active(SpaceId::from_trusted(&v.a)),
            None,
        )
        .await
        .expect("the picker's and MCP's create");
        assert_eq!(picked.id, holder, "{spelling:?} through create_block too");
    }
    assert_eq!(v.ops().await, ops, "no op was appended");

    let elsewhere = v.page(&v.b, "caf\u{e9}").await;
    assert_ne!(elsewhere, holder, "another space holds its own names");
}

/// A create naming another page's alias is refused: the alias already names
/// that page there, and nothing is appended.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_create_naming_another_pages_alias_is_refused() {
    let v = vault().await;
    let planning = v.page(&v.a, "Planning").await;
    v.set_aliases(&planning, &["Roadmap"]).await.unwrap();
    let ops = v.ops().await;

    assert_refused(
        v.create(&v.a, "roadmap ").await,
        ValidationCode::DuplicatePageTitle,
        "`Roadmap` is Planning's alias",
    );
    assert_eq!(v.ops().await, ops, "no op was appended");
    v.page(&v.b, "roadmap").await;
}

/// A rename onto another spelling of a title, or onto another page's alias, is
/// refused and writes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rename_onto_another_pages_title_or_alias_is_refused() {
    let v = vault().await;
    let holder = v.page(&v.a, CAFE).await;
    v.set_aliases(&holder, &["Roadmap"]).await.unwrap();
    let other = v.page(&v.a, "Other").await;
    let ops = v.ops().await;

    for name in RESPELLINGS.into_iter().chain(["roadmap"]) {
        assert_refused(
            v.rename(&other, name).await,
            ValidationCode::DuplicatePageTitle,
            &format!("{name:?} is the holder's"),
        );
    }
    assert_eq!(v.content(&other).await, "Other", "the title stays");
    assert_eq!(v.ops().await, ops, "no op was appended");
}

/// The page itself holds no clash: it may respell its own title or take its
/// own alias as its title.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_may_respell_its_title_or_take_its_own_alias() {
    let v = vault().await;
    let page = v.page(&v.a, CAFE).await;
    v.set_aliases(&page, &["Roadmap"]).await.unwrap();

    v.rename(&page, "CAFE\u{301} ")
        .await
        .expect("a respelling of its own title");
    v.rename(&page, "roadmap")
        .await
        .expect("its own alias as its title");
    assert_eq!(v.content(&page).await, "roadmap");
}

/// An alias naming another page's title in the space is refused whole; the
/// page's own title is no clash, and another space's titles are none either.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_alias_naming_another_pages_title_is_refused() {
    let v = vault().await;
    let holder = v.page(&v.a, CAFE).await;
    let other = v.page(&v.a, "Other").await;
    let ops = v.ops().await;

    for spelling in RESPELLINGS {
        assert_refused(
            v.set_aliases(&other, &["fresh", spelling]).await,
            ValidationCode::DuplicatePageAlias,
            &format!("{spelling:?} is the holder's title"),
        );
    }
    assert_eq!(v.ops().await, ops, "nothing was written");
    assert_eq!(
        get_page_aliases_inner(&v.pool, other.as_str())
            .await
            .unwrap(),
        Vec::<String>::new()
    );

    v.set_aliases(&holder, &["caf\u{e9}"])
        .await
        .expect("its own title");
    let in_b = v.page(&v.b, "Other").await;
    v.set_aliases(&in_b, &["Cafe\u{301}"])
        .await
        .expect("A's titles are not B's");
}

/// The undo of an alias removal re-adds it, refused once another page of the
/// space has taken the name as its title.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_of_an_alias_removal_onto_a_taken_name_is_refused() {
    let v = vault().await;
    let planning = v.page(&v.a, "Planning").await;
    v.set_aliases(&planning, &["Roadmap"]).await.unwrap();
    v.set_aliases(&planning, &[]).await.unwrap();
    let removal = v.last_op(&planning, "remove_page_alias").await;
    v.page(&v.a, "roadmap").await;
    let ops = v.ops().await;

    assert_refused(
        undo_op_inner(&v.pool, DEV, &v.mat, removal).await,
        ValidationCode::DuplicatePageAlias,
        "`roadmap` is another page's title now",
    );
    assert_eq!(v.ops().await, ops, "no op was appended");
}

/// A restore bringing back another spelling of a live title is refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restore_onto_another_spelling_of_a_live_title_is_refused() {
    let v = vault().await;
    let mut trashed = Vec::new();
    for spelling in RESPELLINGS {
        trashed.push(v.trashed(&v.a, spelling).await);
    }
    v.page(&v.a, CAFE).await;

    for (page, deleted_at) in trashed {
        assert_refused(
            restore_block_inner(&v.pool, DEV, &v.mat, page.clone(), deleted_at).await,
            ValidationCode::DuplicatePageTitle,
            "the space holds the name",
        );
        assert!(!v.is_live(&page).await, "the page stays in the trash");
    }
}

/// A move into a space holding another spelling of the page's title is
/// refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_onto_another_spelling_of_a_title_is_refused() {
    let v = vault().await;
    v.page(&v.a, CAFE).await;
    for spelling in RESPELLINGS {
        let page = v.page(&v.b, spelling).await;
        assert_refused(
            move_blocks_to_space_inner(&v.pool, DEV, &v.mat, vec![page.clone()], v.a.clone(), &[])
                .await,
            ValidationCode::DuplicatePageTitle,
            "A holds the name",
        );
        assert_eq!(v.space_of(&page).await, v.b, "the page stays in B");
    }
}

/// A page brings its aliases with it: a restore or a move is refused when one
/// of them names a page the space holds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restore_or_move_bringing_an_alias_onto_a_title_is_refused() {
    let v = vault().await;
    let trashed = v.page(&v.a, "Planning").await;
    v.set_aliases(&trashed, &["Roadmap"]).await.unwrap();
    let deleted_at = delete_block_inner(&v.pool, DEV, &v.mat, trashed.clone())
        .await
        .unwrap()
        .deleted_at;
    let moved = v.page(&v.b, "Plans").await;
    v.set_aliases(&moved, &["Agenda"]).await.unwrap();
    v.page(&v.a, "roadmap").await;
    v.page(&v.a, "agenda ").await;

    assert_refused(
        restore_block_inner(&v.pool, DEV, &v.mat, trashed.clone(), deleted_at).await,
        ValidationCode::DuplicatePageTitle,
        "the restored page's alias `Roadmap` is a title in A",
    );
    assert!(!v.is_live(&trashed).await, "the page stays in the trash");
    assert_refused(
        move_blocks_to_space_inner(&v.pool, DEV, &v.mat, vec![moved.clone()], v.a.clone(), &[])
            .await,
        ValidationCode::DuplicatePageTitle,
        "the moved page's alias `Agenda` is a title in A",
    );
    assert_eq!(v.space_of(&moved).await, v.b, "the page stays in B");
}

/// The undo of a rename puts a title back, refused once another page holds
/// another spelling of it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_of_a_rename_onto_another_spelling_of_a_title_is_refused() {
    let v = vault().await;
    let page = v.page(&v.a, "caf\u{e9}").await;
    v.rename(&page, "Other").await.unwrap();
    let rename = v.last_op(&page, "edit_block").await;
    v.page(&v.a, CAFE).await;
    let ops = v.ops().await;

    assert_refused(
        undo_op_inner(&v.pool, DEV, &v.mat, rename).await,
        ValidationCode::DuplicatePageTitle,
        "the space holds the name",
    );
    assert_eq!(v.content(&page).await, "Other");
    assert_eq!(v.ops().await, ops, "no op was appended");
}

/// A tag name compares trimmed too, whichever spelling the tag was stored
/// under: a create of either spelling resolves to the other's tag, and a
/// rename onto it is refused. A new name holds no whitespace (#6278 I4), so
/// the padded tag is one from before that rule, seeded below the name checks.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tag_name_is_one_name_with_its_padded_spelling() {
    let v = vault().await;
    let work = v.tag("work").await;
    let padded = v.tag_named_before_the_rule(" Padded ").await;
    let other = v.tag("other").await;
    let ops = v.ops().await;

    assert_eq!(
        v.tag(" Work ").await.id,
        work.id,
        "the padded name is `work`"
    );
    assert_eq!(
        v.tag("padded").await.id,
        padded,
        "`padded` is the stored ` Padded `"
    );
    assert_eq!(v.ops().await, ops, "no op was appended");
    for name in ["WORK", "PADDED"] {
        assert_refused(
            v.rename(&other.id, name).await,
            ValidationCode::DuplicatePageTitle,
            &format!("{name:?} is taken"),
        );
    }
}

/// #6527 — `resolve_page_title` answers what the New page dialog found by
/// listing every page of the space and taking the first titled under the
/// name's key: the page and its title as written, or no page and the trimmed
/// name. An alias, a trashed title and another space's title are no page.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resolve_page_title_answers_as_listing_then_finding_did_6527() {
    use agaric_core::tag_norm::name_key;
    let v = vault().await;
    let cafe = v.page(&v.a, CAFE).await;
    let roadmap = v.page(&v.a, "Roadmap").await;
    v.set_aliases(&roadmap, &["plans"]).await.unwrap();
    v.trashed(&v.a, "Gone").await;
    v.page(&v.b, "Elsewhere").await;
    let listed = list_all_pages_in_space_inner(&v.pool, &v.a, None)
        .await
        .unwrap();

    let probes: [(&str, Option<&BlockId>); 9] = [
        (CAFE, Some(&cafe)),
        (RESPELLINGS[0], Some(&cafe)),
        (RESPELLINGS[1], Some(&cafe)),
        (RESPELLINGS[2], Some(&cafe)),
        ("  ROADMAP ", Some(&roadmap)),
        ("plans", None),
        ("Gone", None),
        ("Elsewhere", None),
        (" Nothing yet ", None),
    ];
    for (probe, page) in probes {
        let found = listed.iter().find(|row| {
            row.content
                .as_deref()
                .is_some_and(|title| name_key(title) == name_key(probe))
        });
        let expected = ResolvedPageTitle {
            title: found.map_or_else(
                || probe.trim().to_owned(),
                |row| row.content.clone().unwrap(),
            ),
            page_id: found.map(|row| row.id.as_str().to_owned()),
        };
        assert_eq!(
            expected.page_id.as_deref(),
            page.map(BlockId::as_str),
            "{probe:?}"
        );
        assert_eq!(
            resolve_page_title_inner(&v.pool, &v.a, probe)
                .await
                .unwrap(),
            expected,
            "{probe:?}"
        );
    }
}

/// Two live pages holding one title (from before titles were unique per
/// space): the answer is the page a create of that title opens.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resolve_page_title_answers_the_page_a_create_opens_among_tied_titles_6527() {
    let v = vault().await;
    for title in ["Tied", "tied"] {
        let page = create_block_inner(
            &v.pool,
            DEV,
            &v.mat,
            "page".into(),
            title.into(),
            None,
            None,
        )
        .await
        .unwrap();
        assign_to_space(&v.pool, page.id.as_str(), &v.a).await;
    }
    settle(&v.mat).await;

    let resolved = resolve_page_title_inner(&v.pool, &v.a, "TIED")
        .await
        .unwrap();
    let opened = v.page(&v.a, "TIED").await;
    assert_eq!(resolved.page_id.as_deref(), Some(opened.as_str()));
    assert_eq!(resolved.title, v.content(&opened).await);
}

/// #6527 — a blank title takes the first free `Untitled N` under the key a
/// create resolves a title by, numbered as the New page dialog numbered it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resolve_page_title_numbers_a_blank_title_past_the_taken_untitled_6527() {
    let v = vault().await;
    let cases: [(&[&str], &str); 7] = [
        (&[], "Untitled"),
        (&["Groceries"], "Untitled"),
        (&["Untitled"], "Untitled 2"),
        (&["Untitled", "Untitled 2"], "Untitled 3"),
        (&["Untitled 2"], "Untitled"),
        (&["untitled "], "Untitled 2"),
        (&["UNTITLED", "untitled 2"], "Untitled 3"),
    ];
    for (n, (titles, free)) in cases.into_iter().enumerate() {
        let space = create_space_inner(&v.pool, DEV, &v.mat, format!("Space {n}"), None)
            .await
            .unwrap()
            .into_string();
        for title in titles {
            v.page(&space, title).await;
        }
        for blank in ["", "  "] {
            assert_eq!(
                resolve_page_title_inner(&v.pool, &space, blank)
                    .await
                    .unwrap(),
                ResolvedPageTitle {
                    title: (*free).to_owned(),
                    page_id: None,
                },
                "{titles:?}, {blank:?}"
            );
        }
    }
}

/// Measurement (#6278): what the name check costs a page rename and a page
/// create in a space of `PAGES` pages, some holding aliases. Each is timed
/// against the same command on a block that pays no name check: a content
/// edit, and a content block's create. Then a batch restore of `BATCH` pages,
/// which checks them all. Prints the times; asserts nothing about them.
///
/// `cargo nextest run --workspace --run-ignored=only -E 'test(page_name_check_cost_at_10k_pages)' --no-capture`
#[ignore = "measurement: seeds 10k pages"]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn page_name_check_cost_at_10k_pages() {
    const PAGES: usize = 10_000;
    const SAMPLES: usize = 21;
    const BATCH: usize = 50;
    let v = vault().await;
    seed_pages(&v, PAGES).await;
    let renamed = v.page(&v.a, "Renamed 0").await;
    let content = create_block_inner(
        &v.pool,
        DEV,
        &v.mat,
        "content".into(),
        "text".into(),
        Some(renamed.clone()),
        None,
    )
    .await
    .unwrap();
    settle(&v.mat).await;

    // Each command is timed alone; the background work it dispatches settles
    // outside the timer.
    let (pool, mat) = (&v.pool, &v.mat);
    let mut rename = Vec::new();
    let mut edit = Vec::new();
    let mut create = Vec::new();
    let mut create_content = Vec::new();
    for i in 1..=SAMPLES {
        let t = std::time::Instant::now();
        edit_block_inner(pool, DEV, mat, renamed.clone(), format!("Renamed {i}"))
            .await
            .unwrap();
        rename.push(t.elapsed());
        settle(mat).await;
        let t = std::time::Instant::now();
        edit_block_inner(pool, DEV, mat, content.id.clone(), format!("text {i}"))
            .await
            .unwrap();
        edit.push(t.elapsed());
        settle(mat).await;
        let t = std::time::Instant::now();
        create_page_in_space_inner(pool, DEV, mat, None, format!("Created {i}"), v.a.clone())
            .await
            .unwrap();
        create.push(t.elapsed());
        settle(mat).await;
        let t = std::time::Instant::now();
        create_block_inner(
            pool,
            DEV,
            mat,
            "content".into(),
            format!("child {i}"),
            Some(renamed.clone()),
            None,
        )
        .await
        .unwrap();
        create_content.push(t.elapsed());
        settle(mat).await;
    }
    let median = |samples: &mut Vec<std::time::Duration>| {
        samples.sort_unstable();
        samples[samples.len() / 2]
    };
    eprintln!(
        "[PERF] {PAGES} pages: rename {:?} vs content edit {:?}; page create {:?} vs content \
         create {:?} (medians of {SAMPLES})",
        median(&mut rename),
        median(&mut edit),
        median(&mut create),
        median(&mut create_content),
    );

    // A batch restore checks every page it revives; it should read the
    // space's names once, not once per page.
    let mut trashed = Vec::new();
    for i in 0..BATCH {
        let page =
            create_page_in_space_inner(pool, DEV, mat, None, format!("Batch {i}"), v.a.clone())
                .await
                .unwrap();
        delete_block_inner(pool, DEV, mat, page.clone())
            .await
            .unwrap();
        trashed.push(page);
    }
    settle(mat).await;
    let t = std::time::Instant::now();
    restore_blocks_by_ids_inner(pool, DEV, mat, trashed)
        .await
        .unwrap();
    eprintln!(
        "[PERF] {PAGES} pages: restore of {BATCH} pages {:?}",
        t.elapsed()
    );
}

/// `count` live pages in space A, every tenth holding an alias, through
/// chunked multi-row INSERTs: the name check reads `blocks` and
/// `page_aliases`, nothing derived.
async fn seed_pages(v: &Vault, count: usize) {
    let ids: Vec<String> = (0..count).map(|i| format!("01PAGE{i:020}")).collect();
    for chunk in ids.chunks(200) {
        let mut sql = String::from(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES ",
        );
        sql.push_str(&vec!["(?, 'page', ?, NULL, 1, ?, ?)"; chunk.len()].join(","));
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for id in chunk {
            q = q
                .bind(id)
                .bind(format!("Seeded p\u{e4}ge {id}"))
                .bind(id)
                .bind(&v.a);
        }
        q.execute(&v.pool).await.unwrap();
    }
    for id in ids.iter().step_by(10) {
        sqlx::query("INSERT INTO page_aliases (page_id, alias) VALUES (?, ?)")
            .bind(id)
            .bind(format!("alias {id}"))
            .execute(&v.pool)
            .await
            .unwrap();
    }
}
