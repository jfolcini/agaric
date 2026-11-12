//! The page's properties in the Edit as Markdown buffer (#5160 S8): YAML front
//! matter at its top, the export's form, written only when the page has
//! properties, aliases or tags. A save writes what the front matter changed as
//! the property drawer writes it, a key left out is deleted, and a line no
//! property is read from, or a value its definition refuses, refuses the save
//! by its line. Logseq's `key:: value` lines above the first bullet are read
//! too.

use crate::prelude::*;
use agaric_lib::commands::pages::{anchor_free, get_page_file_inner};

use super::page_cmd_tests::{
    buffer_lines, counts, dup_child, dup_page, dup_storage, last_seq, ops_after, page_source,
    plain, save_by_line, save_source, with,
};

const WORK: &str = "01J5160S8TAGW0RK0000000001";

/// Set the text property `key` on `block` through the property command.
async fn set_text(pool: &SqlitePool, mat: &Materializer, block: &BlockId, key: &str, value: &str) {
    set_property_inner(
        pool,
        DEV,
        mat,
        block.as_str().into(),
        key.into(),
        Some(value.into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
}

/// A page holding the block `body`, with `stage: open`, the alias `Home
/// base`, the tag `work`, and the `template` and `created_at` rows the drawer
/// does not show. Returns the page and its block.
async fn front_matter_page(pool: &SqlitePool, mat: &Materializer) -> (BlockId, BlockId) {
    let page = dup_page(pool, mat, "Front").await;
    let body = dup_child(pool, mat, &page, "body").await;
    set_text(pool, mat, &page, "stage", "open").await;
    set_page_aliases_inner(pool, DEV, mat, page.as_str(), vec!["Home base".into()])
        .await
        .unwrap();
    insert_block(pool, WORK, "tag", "work", None, Some(1)).await;
    assign_to_space(pool, WORK, TEST_SPACE_ID).await;
    add_tag_inner(pool, DEV, mat, page.clone(), BlockId::from_trusted(WORK))
        .await
        .unwrap();
    for key in ["template", "created_at"] {
        sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, 'x')")
            .bind(page.as_str())
            .bind(key)
            .execute(pool)
            .await
            .unwrap();
    }
    settle(mat).await;
    (page, body)
}

/// The names of the tags `page` holds, sorted.
async fn page_tags(pool: &SqlitePool, page: &BlockId) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT t.content FROM block_tags bt JOIN blocks t ON t.id = bt.tag_id \
         WHERE bt.block_id = ? ORDER BY t.content",
    )
    .bind(page.as_str())
    .fetch_all(pool)
    .await
    .unwrap()
}

/// The page's keys the drawer does not show: never written, so never deleted
/// by being left out.
async fn hidden_keys(pool: &SqlitePool, page: &BlockId) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT key FROM block_properties WHERE block_id = ? \
         AND key IN ('template', 'created_at') ORDER BY key",
    )
    .bind(page.as_str())
    .fetch_all(pool)
    .await
    .unwrap()
}

/// The export's front matter heads the buffer: aliases, tags, then the
/// properties the drawer shows, and a blank line before the first block.
/// A page with none has none (`get_page_buffer_writes_in_space_names`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_page_buffer_writes_the_pages_properties_as_front_matter() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, body) = front_matter_page(&pool, &mat).await;

    assert_eq!(
        page_source(&pool, &page).await,
        format!("---\naliases: [Home base]\ntags: [work]\nstage: open\n---\n\nbody ^{body}\n")
    );
}

/// A changed value is set, a new key added and a key left out deleted, as the
/// drawer writes them; the keys the buffer does not show stay.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_page_source_sets_adds_and_deletes_page_properties() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, _) = front_matter_page(&pool, &mat).await;
    set_text(&pool, &mat, &page, "drop", "me").await;
    settle(&mat).await;
    let base = page_source(&pool, &page).await;
    let source = with(
        &with(&base, "drop: me\n", ""),
        "stage: open\n",
        "stage: done\nowner: ann\n",
    );

    let report = save_source(&pool, &mat, &page, &source, &base)
        .await
        .unwrap();

    assert_eq!(counts(&report), [0, 0, 0, 0, 2, 1], "two set, one deleted");
    assert_eq!(
        dup_storage(&pool, &page).await,
        [
            "columns todo=None priority=None scheduled=None due=None",
            r#"owner text=Some("ann") num=None date=None ref=None bool=None"#,
            r#"stage text=Some("done") num=None date=None ref=None bool=None"#,
            r#"template text=Some("x") num=None date=None ref=None bool=None"#,
        ]
    );
    assert_eq!(hidden_keys(&pool, &page).await, ["created_at", "template"]);
}

/// The page's bookmark (#6544) is the sidebar's: the buffer does not show it,
/// so a save that changes the front matter keeps it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn page_buffer_hides_the_bookmark_and_a_save_keeps_it() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, body) = front_matter_page(&pool, &mat).await;
    set_property_inner(
        &pool,
        DEV,
        &mat,
        page.as_str().into(),
        "bookmark".into(),
        None,
        Some(2.0),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;
    let base = page_source(&pool, &page).await;
    assert_eq!(
        base,
        format!("---\naliases: [Home base]\ntags: [work]\nstage: open\n---\n\nbody ^{body}\n")
    );

    let source = with(&base, "stage: open\n", "stage: done\n");
    save_source(&pool, &mat, &page, &source, &base)
        .await
        .unwrap();

    let kept = sqlx::query_scalar::<_, Option<f64>>(
        "SELECT value_num FROM block_properties WHERE block_id = ? AND key = 'bookmark'",
    )
    .bind(page.as_str())
    .fetch_optional(&pool)
    .await
    .unwrap()
    .flatten();
    assert_eq!(kept, Some(2.0));
}

/// `aliases:` and `tags:` are the page's aliases and tags: an item added is
/// added, a tag no page of the space names is created, and an item left out is
/// removed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_page_source_writes_the_pages_aliases_and_tags() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, _) = front_matter_page(&pool, &mat).await;
    let base = page_source(&pool, &page).await;
    let source = with(
        &with(
            &base,
            "aliases: [Home base]",
            "aliases: [\"Base, the\", HQ]",
        ),
        "tags: [work]",
        "tags: [idea]",
    );

    let report = save_source(&pool, &mat, &page, &source, &base)
        .await
        .unwrap();

    assert_eq!(
        get_page_aliases_inner(&pool, page.as_str()).await.unwrap(),
        ["Base, the", "HQ"]
    );
    assert_eq!(page_tags(&pool, &page).await, ["idea"]);
    let created: Vec<(&str, Option<&str>)> = report
        .names_created
        .iter()
        .map(|row| (row.block_type.as_str(), row.content.as_deref()))
        .collect();
    assert_eq!(created, [("tag", Some("idea"))]);
    assert!(report.warnings.is_empty(), "{report:?}");
    assert_eq!(
        page_source(&pool, &page).await,
        source,
        "the page renders as saved"
    );
}

/// Typed into a page with none, front matter or Logseq's `key:: value` lines
/// above the first bullet become the page's properties, aliases and tags, and
/// the page then renders them as front matter.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_page_source_creates_the_pages_properties_from_either_form() {
    for (title, head) in [
        (
            "Yaml",
            "---\nstage: done\naliases: [Atlas]\ntags: [project]\n---\n",
        ),
        (
            "Logseq",
            "stage:: done\nalias:: Atlas\ntags:: [[project]]\n\n",
        ),
    ] {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let page = dup_page(&pool, &mat, title).await;
        let body = dup_child(&pool, &mat, &page, "body").await;
        settle(&mat).await;
        let base = page_source(&pool, &page).await;
        assert_eq!(base, format!("body ^{body}\n"), "{title}: none written");

        let report = save_source(&pool, &mat, &page, &format!("{head}{base}"), &base)
            .await
            .unwrap();

        assert_eq!(counts(&report), [0, 0, 0, 0, 1, 0], "{title}");
        assert_eq!(
            page_source(&pool, &page).await,
            format!("---\naliases: [Atlas]\ntags: [project]\nstage: done\n---\n\n{base}"),
            "{title}"
        );
    }
}

/// A value the property's definition refuses refuses the save, naming its
/// line counted from the `---`, and nothing is written.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_page_source_refuses_an_invalid_front_matter_value_by_its_line() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, _) = front_matter_page(&pool, &mat).await;
    create_test_property_def(&pool, "estimate".into(), "number".into(), None)
        .await
        .unwrap();
    let base = page_source(&pool, &page).await;
    let source = with(&base, "stage: open\n", "stage: done\nEstimate: soon\n");
    let before = last_seq(&pool).await;

    let err = save_source(&pool, &mat, &page, &source, &base)
        .await
        .unwrap_err();

    assert!(
        matches!(&err, AppError::Validation { message, .. }
            if message.starts_with("line 5: `Estimate: soon` cannot be saved: ")),
        "{err:?}"
    );
    assert_eq!(ops_after(&pool, before).await, Vec::<String>::new());
    assert_eq!(page_source(&pool, &page).await, base);
}

/// Front matter a line of which no property is read from refuses the save by
/// that line, and so does front matter that is never closed: neither is
/// dropped, nor saved as blocks.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_page_source_refuses_unreadable_front_matter_by_its_line() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, _) = front_matter_page(&pool, &mat).await;
    let base = page_source(&pool, &page).await;
    let before = last_seq(&pool).await;

    for (source, line) in [
        (
            with(&base, "stage: open\n", "stage: open\nnot a pair\n"),
            "line 5: ",
        ),
        (
            with(&base, "stage: open\n", "stage: open\nspace: Elsewhere\n"),
            "line 5: ",
        ),
        (
            with(&base, "stage: open\n", "stage: open\nstage: done\n"),
            "line 5: ",
        ),
        (base.replacen("---\n\n", "\n", 1), "line 1: "),
    ] {
        let err = save_source(&pool, &mat, &page, &source, &base)
            .await
            .unwrap_err();

        assert!(
            matches!(&err, AppError::Validation { message, .. } if message.starts_with(line)),
            "{source:?}: {err:?}"
        );
    }
    assert_eq!(ops_after(&pool, before).await, Vec::<String>::new());
}

/// A stale buffer merged writes only what it changed that the page does not
/// hold yet: its front matter is compared with the source the edit started
/// from, so a value, deletion or alias the page took since is kept, and a
/// change both sides made is not written again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_page_source_merge_keeps_the_front_matter_the_page_changed() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, _) = front_matter_page(&pool, &mat).await;
    set_text(&pool, &mat, &page, "owner", "ann").await;
    set_text(&pool, &mat, &page, "drop", "me").await;
    settle(&mat).await;
    let base = page_source(&pool, &page).await;
    set_text(&pool, &mat, &page, "owner", "bob").await;
    set_text(&pool, &mat, &page, "mood", "calm").await;
    delete_property_inner(&pool, DEV, &mat, page.as_str().into(), "drop".into())
        .await
        .unwrap();
    set_page_aliases_inner(
        &pool,
        DEV,
        &mat,
        page.as_str(),
        vec!["Home base".into(), "HQ".into()],
    )
    .await
    .unwrap();
    settle(&mat).await;
    let source = with(
        &with(
            &with(&base, "stage: open\n", "stage: done\nmood: calm\n"),
            "drop: me\n",
            "",
        ),
        "aliases: [Home base]",
        "aliases: [Home base, Den]",
    );
    let (text, line_ids) = anchor_free(&source);
    let before = last_seq(&pool).await;

    apply_page_source_inner(
        &pool,
        DEV,
        &mat,
        page.as_str(),
        text,
        base,
        SourceSaveFlags {
            merge: true,
            line_ids,
        },
    )
    .await
    .unwrap();
    settle(&mat).await;

    assert_eq!(
        ops_after(&pool, before).await,
        ["set_property", "add_page_alias"],
        "`stage` and `Den` alone: the page already holds `mood` and `HQ` and has no `drop`"
    );
    assert_eq!(
        dup_storage(&pool, &page).await,
        [
            "columns todo=None priority=None scheduled=None due=None",
            r#"mood text=Some("calm") num=None date=None ref=None bool=None"#,
            r#"owner text=Some("bob") num=None date=None ref=None bool=None"#,
            r#"stage text=Some("done") num=None date=None ref=None bool=None"#,
            r#"template text=Some("x") num=None date=None ref=None bool=None"#,
        ]
    );
    assert_eq!(
        get_page_aliases_inner(&pool, page.as_str()).await.unwrap(),
        ["Den", "Home base", "HQ"]
    );
}

/// A multi-line page property is the export's YAML block scalar in the front
/// matter, `key: |` and its lines indented: the page's own source reads it
/// back as it is, so saving it writes nothing, and an edited one is saved
/// with its line breaks and renders as typed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_multi_line_page_property_round_trips_through_the_front_matter() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, _) = front_matter_page(&pool, &mat).await;
    set_text(&pool, &mat, &page, "note", "two\n\nlines").await;
    settle(&mat).await;
    let base = page_source(&pool, &page).await;
    assert!(
        base.contains("\nnote: |\n  two\n  \n  lines\n"),
        "seed: a block scalar:\n{base}"
    );
    let before = last_seq(&pool).await;

    let unchanged = save_source(&pool, &mat, &page, &base, &base).await.unwrap();
    assert_eq!(counts(&unchanged), [0; 6]);
    assert_eq!(ops_after(&pool, before).await, Vec::<String>::new());

    let source = with(&base, "  lines\n", "  lines\n  and a third\n");
    let report = save_source(&pool, &mat, &page, &source, &base)
        .await
        .unwrap();

    assert_eq!(counts(&report), [0, 0, 0, 0, 1, 0]);
    let note: Option<String> = sqlx::query_scalar(
        "SELECT value_text FROM block_properties WHERE block_id = ? AND key = 'note'",
    )
    .bind(page.as_str())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(note.as_deref(), Some("two\n\nlines\nand a third"));
    assert_eq!(page_source(&pool, &page).await, source);
}

// ======================================================================
// The front matter on the line-ids path (#5160 A)
// ======================================================================

/// `get_page_buffer` keeps the front matter in `text` as written, each of its
/// lines carrying no id, and the first block's id on the line it starts on.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_page_buffer_keeps_the_front_matter_as_text_carrying_no_id() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, body) = front_matter_page(&pool, &mat).await;

    let buffer = get_page_buffer_inner(&pool, page.as_str()).await.unwrap();

    assert_eq!(
        buffer.text,
        "---\naliases: [Home base]\ntags: [work]\nstage: open\n---\n\nbody\n"
    );
    let mut ids = vec![None; 8];
    ids[6] = Some(body.into_string());
    assert_eq!(buffer.line_ids, ids);
}

/// A page with front matter saved through its own `get_page_buffer` text
/// writes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_page_source_by_line_ids_of_its_own_front_matter_writes_nothing() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, _) = front_matter_page(&pool, &mat).await;
    let (source, lines) = buffer_lines(&pool, &page).await;
    let before = last_seq(&pool).await;

    let report = save_by_line(&pool, &mat, &page, &lines, &source, false)
        .await
        .unwrap();

    assert_eq!(ops_after(&pool, before).await, Vec::<String>::new());
    assert_eq!(counts(&report), [0; 6]);
    assert!(
        report.warnings.is_empty() && report.names_created.is_empty(),
        "{report:?}"
    );
    assert_eq!(page_source(&pool, &page).await, source);
}

/// One save by line ids writes a front matter property and a block edited
/// together.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_page_source_by_line_ids_writes_the_front_matter_and_a_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, body) = front_matter_page(&pool, &mat).await;
    let (source, mut lines) = buffer_lines(&pool, &page).await;
    assert_eq!(lines[3], plain("stage: open"), "seed: line 4");
    lines[3].0 = "stage: done".into();
    lines[6].0 = "body, edited".into();
    let before = last_seq(&pool).await;

    let report = save_by_line(&pool, &mat, &page, &lines, &source, false)
        .await
        .unwrap();

    assert_eq!(counts(&report), [0, 1, 0, 0, 1, 0]);
    assert_eq!(
        ops_after(&pool, before).await,
        ["edit_block", "set_property"]
    );
    assert_eq!(
        page_source(&pool, &page).await,
        format!(
            "---\naliases: [Home base]\ntags: [work]\nstage: done\n---\n\nbody, edited ^{body}\n"
        )
    );
}

/// On the line-ids path too, a refusal or warning at a block below the front
/// matter names the block's line in the buffer, the front matter's lines
/// counted, and so does a refusal in the front matter, in its YAML form and in
/// Logseq's `key::` form.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_page_source_by_line_ids_names_lines_below_the_front_matter() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, _) = front_matter_page(&pool, &mat).await;
    let (source, lines) = buffer_lines(&pool, &page).await;
    let inserted = |at: usize, line: &str| {
        let mut edited = lines.clone();
        edited.insert(at, plain(line));
        edited
    };
    let mut logseq = vec![
        plain("alias:: Home base"),
        plain("tags:: work"),
        plain("stage:: open"),
    ];
    logseq.extend(lines[5..].iter().cloned());
    logseq.insert(5, plain("  todo_state:: BOGUS"));
    let before = last_seq(&pool).await;

    for (what, edited, line) in [
        (
            "a value its definition refuses",
            inserted(7, "  todo_state:: BOGUS"),
            7,
        ),
        (
            "a front matter line that is no pair",
            inserted(4, "not a pair"),
            5,
        ),
        ("a refused value under Logseq's lines", logseq, 5),
    ] {
        let result = save_by_line(&pool, &mat, &page, &edited, &source, false).await;

        assert!(
            matches!(&result, Err(AppError::Validation { message, .. })
                if message.starts_with(&format!("line {line}: "))),
            "{what} is refused at line {line}, got {result:?}"
        );
    }
    assert_eq!(ops_after(&pool, before).await, Vec::<String>::new());

    let mut copied = lines.clone();
    copied.insert(7, plain(""));
    copied.insert(8, lines[6].clone());
    let report = save_by_line(&pool, &mat, &page, &copied, &source, false)
        .await
        .unwrap();
    assert_eq!(
        report.warnings,
        ["line 9: a copy of the block on line 7; saved as a new block"]
    );
}

/// #6033 — Obsidian's older singular keys: an imported file's `alias:` is the
/// page's aliases and its `tag:` the page's tags, in either list form, and
/// neither is a text property.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_yaml_alias_and_tag_are_the_pages_aliases_and_tags() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    let md = "---\nalias: [Atlas, HQ]\ntag:\n  - project\n---\n- body\n";

    import_markdown_inner(
        &pool,
        DEV,
        &mat,
        _dir.path(),
        md.into(),
        Some("Singular.md".into()),
        TEST_SPACE_ID.into(),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let page: String = sqlx::query_scalar(
        "SELECT id FROM blocks WHERE content = 'Singular' AND block_type = 'page'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let page = BlockId::from_string(page).unwrap();
    assert_eq!(
        get_page_aliases_inner(&pool, page.as_str()).await.unwrap(),
        ["Atlas", "HQ"]
    );
    assert_eq!(page_tags(&pool, &page).await, ["project"]);
    let keys: Vec<String> = sqlx::query_scalar(
        "SELECT key FROM block_properties WHERE block_id = ? AND key IN ('alias', 'tag')",
    )
    .bind(page.as_str())
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(keys, Vec::<String>::new(), "no text property");
    mat.shutdown();
}

// ── ref-typed values as links (#6277 F3) ────────────────────────────────────

/// A page in the test space, `Holder`, whose front matter and block `held`
/// both hold `owner`, a ref to the page `Linked Target`; the page `Other
/// Target` is in the space too. Returns the page, the block and the two
/// targets.
async fn ref_page(pool: &SqlitePool, mat: &Materializer) -> [BlockId; 4] {
    let page = dup_page(pool, mat, "Holder").await;
    let target = dup_page(pool, mat, "Linked Target").await;
    let other = dup_page(pool, mat, "Other Target").await;
    create_test_property_def(pool, "owner".into(), "ref".into(), None)
        .await
        .unwrap();
    let block = dup_child(pool, mat, &page, "held").await;
    for holder in [&page, &block] {
        set_property_inner(
            pool,
            DEV,
            mat,
            holder.as_str().into(),
            "owner".into(),
            None,
            None,
            None,
            Some(target.as_str().into()),
            None,
            None,
        )
        .await
        .unwrap();
    }
    settle(mat).await;
    [page, block, target, other]
}

/// The block `owner` names on `holder`.
async fn owner(pool: &SqlitePool, holder: &str) -> Option<String> {
    sqlx::query_scalar(
        "SELECT value_ref FROM block_properties WHERE block_id = ? AND key = 'owner'",
    )
    .bind(holder)
    .fetch_optional(pool)
    .await
    .unwrap()
    .flatten()
}

/// Whether `md` writes `owner` as the link to `Linked Target` in its front
/// matter and on the block's line.
fn writes_the_link(md: &str) -> bool {
    md.contains("owner: \"[[Linked Target]]\"\n") && md.contains("\n  owner:: [[Linked Target]]\n")
}

/// The buffer writes the ref as a link: its own text saves as nothing, and a
/// link typed over it names the new target.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_ref_value_is_a_link_in_the_buffer_which_saves_back_to_its_target_6277() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [page, block, _, other] = ref_page(&pool, &mat).await;
    let base = page_source(&pool, &page).await;
    assert!(writes_the_link(&base), "{base}");
    let before = last_seq(&pool).await;

    save_source(&pool, &mat, &page, &base, &base).await.unwrap();
    assert_eq!(
        ops_after(&pool, before).await,
        Vec::<String>::new(),
        "its own text"
    );

    let edited = base.replace("[[Linked Target]]", "[[Other Target]]");
    save_source(&pool, &mat, &page, &edited, &base)
        .await
        .unwrap();
    for holder in [&page, &block] {
        assert_eq!(
            owner(&pool, holder.as_str()).await.as_deref(),
            Some(other.as_str())
        );
    }
}

/// The mirror's file writes the ref as a link, and the file imported over its
/// page writes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_ref_value_in_the_mirrors_file_reimports_as_nothing_6277() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [page, ..] = ref_page(&pool, &mat).await;
    let file = get_page_file_inner(&pool, page.as_str())
        .await
        .unwrap()
        .text;
    assert!(writes_the_link(&file), "{file}");
    let before = last_seq(&pool).await;

    let result = import_markdown_inner(
        &pool,
        DEV,
        &mat,
        dir.path(),
        file,
        Some("Holder.md".into()),
        TEST_SPACE_ID.into(),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    assert!(result.merged.is_some(), "the file merges into its page");
    assert_eq!(ops_after(&pool, before).await, Vec::<String>::new());
}

/// A copy writes the ref as a link, which the paste reads back as the same
/// target.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_ref_value_in_a_copy_pastes_as_the_same_target_6277() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [_, block, target, _] = ref_page(&pool, &mat).await;
    let copied = get_blocks_source_inner(&pool, vec![block.clone()], true)
        .await
        .unwrap();
    assert_eq!(copied, "held\n  owner:: [[Linked Target]]\n");

    let pasted = paste_blocks_inner(
        &pool,
        DEV,
        &mat,
        block.clone(),
        PasteInput::Text { text: copied },
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let [copy] = pasted.blocks.as_slice() else {
        panic!("one block pasted: {pasted:?}");
    };
    assert_eq!(
        owner(&pool, copy.id.as_str()).await.as_deref(),
        Some(target.as_str())
    );
}

/// An export writes the ref as a link, which an import reads back as the same
/// target, in the front matter and on the block's line, each naming its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_ref_value_in_an_export_imports_as_the_same_target_6277() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [page, block, target, other] = ref_page(&pool, &mat).await;
    // The block names another page than the front matter, so neither's name
    // reads back by the other's.
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.as_str().into(),
        "owner".into(),
        None,
        None,
        None,
        Some(other.as_str().into()),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;
    let md = export_page_markdown_inner(&pool, page.as_str())
        .await
        .unwrap();
    assert!(md.contains("owner: \"[[Linked Target]]\"\n"), "{md}");
    assert!(md.contains("\n  owner:: [[Other Target]]\n"), "{md}");

    let result = import_markdown_inner(
        &pool,
        DEV,
        &mat,
        dir.path(),
        md,
        Some("Copy.md".into()),
        TEST_SPACE_ID.into(),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    assert_eq!(result.warnings, Vec::<String>::new());
    // `Copy.md` is not titled `Holder`, so the export's `# Holder` line is a
    // heading block beside `held`.
    let imported: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM blocks WHERE parent_id = ? AND content = 'held' AND deleted_at IS NULL",
    )
    .bind(&result.page_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(imported.len(), 1, "the page's block");
    assert_eq!(
        owner(&pool, &result.page_id).await.as_deref(),
        Some(target.as_str())
    );
    assert_eq!(
        owner(&pool, &imported[0]).await.as_deref(),
        Some(other.as_str())
    );
}

/// A ref to a block that is no page has no title to link, so every surface
/// writes its id, which an import reads back as that block.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_ref_value_naming_a_block_is_written_and_imported_as_its_id_6277() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [page, block, ..] = ref_page(&pool, &mat).await;
    set_property_inner(
        &pool,
        DEV,
        &mat,
        page.as_str().into(),
        "owner".into(),
        None,
        None,
        None,
        Some(block.as_str().into()),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;
    let line = format!("owner: {block}\n");
    let buffer = page_source(&pool, &page).await;
    assert!(buffer.contains(&line), "{buffer}");
    let md = export_page_markdown_inner(&pool, page.as_str())
        .await
        .unwrap();
    assert!(md.contains(&line), "{md}");

    let result = import_markdown_inner(
        &pool,
        DEV,
        &mat,
        dir.path(),
        md,
        Some("Copy.md".into()),
        TEST_SPACE_ID.into(),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        owner(&pool, &result.page_id).await.as_deref(),
        Some(block.as_str())
    );
}
