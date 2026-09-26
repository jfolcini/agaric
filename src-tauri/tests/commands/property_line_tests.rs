//! `key:: value` lines on the markdown surfaces (#5160 Phase 4b): the
//! recurrence rule as property lines (P4), a line with no value clearing the
//! property in Edit as Markdown (P7), key spelling folded to the reserved key
//! or definition (D13), and a refused value kept as text on import and paste
//! while Edit as Markdown refuses the save naming the line (D11).

use crate::prelude::*;

use super::page_cmd_tests::{
    counts, dup_child, dup_children, dup_page, dup_storage, page_source, paste_text, save_source,
    with,
};

/// A value [`set`] writes, in the column its type takes.
enum Value<'a> {
    Text(&'a str),
    Num(f64),
    Date(&'a str),
    Ref(&'a BlockId),
}

/// Set `key` on `block` through the property command.
async fn set(pool: &SqlitePool, mat: &Materializer, block: &BlockId, key: &str, value: Value<'_>) {
    let (text, num, date, reference) = match value {
        Value::Text(text) => (Some(text.to_owned()), None, None, None),
        Value::Num(num) => (None, Some(num), None, None),
        Value::Date(date) => (None, None, Some(date.to_owned()), None),
        Value::Ref(id) => (None, None, None, Some(id.as_str().to_owned())),
    };
    set_property_inner(
        pool,
        DEV,
        mat,
        block.as_str().into(),
        key.into(),
        text,
        num,
        date,
        reference,
        None,
        None,
    )
    .await
    .unwrap();
}

/// A task on `page` repeating weekly, four times at most, until the end of
/// 2026, as the recurrence flow leaves it after its first completion.
async fn repeating_task(pool: &SqlitePool, mat: &Materializer, page: &BlockId) -> BlockId {
    let task = dup_child(pool, mat, page, "water the plants").await;
    set_todo_state_inner(pool, DEV, mat, task.as_str().into(), Some("TODO".into()))
        .await
        .unwrap();
    set(pool, mat, &task, "repeat", Value::Text("+1w")).await;
    set(pool, mat, &task, "repeat-until", Value::Date("2026-12-31")).await;
    set(pool, mat, &task, "repeat-count", Value::Num(4.0)).await;
    set(pool, mat, &task, "repeat-seq", Value::Num(1.0)).await;
    set(
        pool,
        mat,
        &task,
        "repeat-origin",
        Value::Text(task.as_str()),
    )
    .await;
    settle(mat).await;
    task
}

async fn import(
    pool: &SqlitePool,
    mat: &Materializer,
    dir: &std::path::Path,
    md: &str,
    file: &str,
) -> agaric_engine::import::ImportResult {
    let result = import_markdown_inner(
        pool,
        DEV,
        mat,
        dir,
        md.into(),
        Some(file.into()),
        TEST_SPACE_ID.into(),
        None,
    )
    .await
    .unwrap();
    settle(mat).await;
    result
}

/// The live page titled `title`.
async fn page_titled(pool: &SqlitePool, title: &str) -> BlockId {
    let id: String = sqlx::query_scalar(
        "SELECT id FROM blocks WHERE block_type = 'page' AND content = ? AND deleted_at IS NULL",
    )
    .bind(title)
    .fetch_one(pool)
    .await
    .unwrap();
    BlockId::from_trusted(&id)
}

/// The ids of `parent`'s live children in sibling order.
async fn child_ids(pool: &SqlitePool, parent: &BlockId) -> Vec<BlockId> {
    dup_children(pool, parent)
        .await
        .into_iter()
        .map(|(id, _)| BlockId::from_trusted(&id))
        .collect()
}

fn reviewer_row(target: &BlockId) -> String {
    format!(
        "reviewer text=None num=None date=None ref={:?} bool=None",
        Some(target.as_str())
    )
}

/// What the recurrence rule stores, in `dup_storage` order.
const RULE_ROWS: [&str; 3] = [
    r#"repeat text=Some("+1w") num=None date=None ref=None bool=None"#,
    "repeat-count text=None num=Some(4.0) date=None ref=None bool=None",
    r#"repeat-until text=None num=None date=Some("2026-12-31") ref=None bool=None"#,
];

/// Edit as Markdown shows a repeating task's rule as `repeat`, `repeat-count`
/// and `repeat-until` lines and saves an edit to them; `repeat-seq` and
/// `repeat-origin`, which describe one occurrence, stay hidden and untouched.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn page_source_renders_and_reads_the_recurrence_lines() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Chores").await;
    let task = repeating_task(&pool, &mat, &page).await;
    let base = page_source(&pool, &page).await;
    let rule = "  repeat:: +1w\n  repeat-count:: 4\n  repeat-until:: 2026-12-31\n";
    assert!(
        base.contains(&format!("- [ ] water the plants ^{task}\n{rule}")),
        "{base}"
    );
    assert!(
        !base.contains("repeat-seq") && !base.contains("repeat-origin"),
        "{base}"
    );

    let source = with(
        &with(&base, "  repeat:: +1w\n", "  repeat:: +2w\n"),
        "  repeat-count:: 4\n",
        "",
    );
    let report = save_source(&pool, &mat, &page, &source, &base, false)
        .await
        .unwrap();

    assert_eq!(counts(&report), [0, 0, 0, 0, 1, 1], "one set, one deleted");
    let stored = dup_storage(&pool, &task).await;
    assert_eq!(
        stored[1..],
        [
            r#"repeat text=Some("+2w") num=None date=None ref=None bool=None"#.to_owned(),
            format!(
                "repeat-origin text={:?} num=None date=None ref=None bool=None",
                Some(task.as_str())
            ),
            "repeat-seq text=None num=Some(1.0) date=None ref=None bool=None".to_owned(),
            RULE_ROWS[2].to_owned(),
        ],
        "the rule is the buffer's; the occurrence's bookkeeping is untouched"
    );
}

/// `key::` and `key:: ` both delete the property (#5160 P7): no raw error
/// code, no line appended as text, and the block keeps its anchor.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_page_source_a_line_with_no_value_deletes_the_property() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Clear").await;
    let block = dup_child(&pool, &mat, &page, "has both").await;
    set_priority_inner(&pool, DEV, &mat, block.as_str().into(), Some("2".into()))
        .await
        .unwrap();
    set(&pool, &mat, &block, "note", Value::Text("open")).await;
    settle(&mat).await;
    let base = page_source(&pool, &page).await;
    let source = with(
        &with(&base, "  priority:: 2\n", "  priority::\n"),
        "  note:: open\n",
        "  note:: \n",
    );

    let report = save_source(&pool, &mat, &page, &source, &base, false)
        .await
        .unwrap();

    assert_eq!(counts(&report), [0, 0, 0, 0, 0, 2], "both are deleted");
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    assert_eq!(
        dup_storage(&pool, &block).await,
        vec!["columns todo=None priority=None scheduled=None due=None"]
    );
    assert_eq!(
        dup_children(&pool, &page).await,
        vec![(block.clone().into_string(), "has both".to_owned())],
        "the block keeps its text and its id"
    );
    assert_eq!(
        page_source(&pool, &page).await,
        format!("- has both ^{block}\n")
    );
}

/// A key names the reserved key or definition it folds to, whatever its case
/// or `-`/`_` (#5160 D13), and is written back canonical; `due` is its own
/// definition, not `due_date`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_page_source_folds_a_key_to_its_canonical_spelling() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Spelling").await;
    let block = dup_child(&pool, &mat, &page, "task").await;
    settle(&mat).await;
    let base = page_source(&pool, &page).await;
    let line = format!("- task ^{block}\n");
    let typed = "  Priority:: 2\n  due-date:: 2026-05-01\n  Scheduled_Date:: 2026-04-01\n  \
                 REPEAT:: +1d\n  due:: 2026-06-01\n";
    let source = with(&base, &line, &format!("{line}{typed}"));

    let report = save_source(&pool, &mat, &page, &source, &base, false)
        .await
        .unwrap();

    assert_eq!(counts(&report), [0, 0, 0, 0, 5, 0]);
    assert_eq!(
        dup_storage(&pool, &block).await,
        vec![
            r#"columns todo=None priority=Some("2") scheduled=Some("2026-04-01") due=Some("2026-05-01")"#.to_owned(),
            r#"due text=None num=None date=Some("2026-06-01") ref=None bool=None"#.to_owned(),
            r#"repeat text=Some("+1d") num=None date=None ref=None bool=None"#.to_owned(),
        ]
    );
    assert_eq!(
        page_source(&pool, &page).await,
        format!(
            "- task ^{block}\n  priority:: 2\n  scheduled_date:: 2026-04-01\n  \
             due_date:: 2026-05-01\n  due:: 2026-06-01\n  repeat:: +1d\n"
        ),
        "written back canonical"
    );

    let saved = page_source(&pool, &page).await;
    let refused = with(
        &saved,
        "  due_date:: 2026-05-01\n",
        "  Due-Date:: tomorrow\n",
    );
    let result = save_source(&pool, &mat, &page, &refused, &saved, false).await;
    assert!(
        matches!(&result, Err(AppError::Validation { message, .. })
            if message.contains("`due_date:: tomorrow`")),
        "a refused value refuses the save naming the line: {result:?}"
    );
}

/// A key its block already holds as written names that property, whatever it
/// folds to (D13): a save that leaves such a line alone leaves the property
/// alone, and one that edits its value keeps its key. Keys were stored as
/// typed before D13, so an older `Priority` or `due-date` is a property of
/// its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_page_source_leaves_a_key_held_in_another_spelling_as_it_is() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Older").await;
    let block = dup_child(&pool, &mat, &page, "imported").await;
    let other = dup_child(&pool, &mat, &page, "other").await;
    set(&pool, &mat, &block, "due_date", Value::Date("2026-01-01")).await;
    set(&pool, &mat, &block, "due-date", Value::Text("2026-02-02")).await;
    set(&pool, &mat, &block, "Priority", Value::Text("high")).await;
    settle(&mat).await;
    let stored = dup_storage(&pool, &block).await;
    let base = page_source(&pool, &page).await;
    let line = format!("- other ^{other}\n");
    let source = with(&base, &line, &format!("- other, edited ^{other}\n"));

    let report = save_source(&pool, &mat, &page, &source, &base, false)
        .await
        .unwrap();

    assert_eq!(counts(&report), [0, 1, 0, 0, 0, 0], "only the text changes");
    assert_eq!(dup_storage(&pool, &block).await, stored);

    let saved = page_source(&pool, &page).await;
    let edited = with(&saved, "  Priority:: high\n", "  Priority:: low\n");
    save_source(&pool, &mat, &page, &edited, &saved, false)
        .await
        .unwrap();
    assert_eq!(
        dup_storage(&pool, &block).await[1..],
        [
            r#"Priority text=Some("low") num=None date=None ref=None bool=None"#,
            r#"due-date text=Some("2026-02-02") num=None date=None ref=None bool=None"#,
        ]
    );
}

/// A key that folds to two definitions names neither: it stays as typed
/// (D13), so `Due-Date::` with a `due-date` definition beside `due_date` is a
/// property of its own, not a guess between them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_keeps_a_key_two_definitions_fold_to_as_typed() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    create_property_def_inner(&pool, "due-date".into(), "text".into(), None)
        .await
        .unwrap();

    let result = import(
        &pool,
        &mat,
        dir.path(),
        "- task\n  Due-Date:: soon\n",
        "Tie.md",
    )
    .await;

    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    let page = page_titled(&pool, "Tie").await;
    assert_eq!(
        dup_storage(&pool, &child_ids(&pool, &page).await[0]).await,
        [
            NO_COLUMNS,
            r#"Due-Date text=Some("soon") num=None date=None ref=None bool=None"#,
        ]
    );
}

/// A `repeat` rule the recurrence engine cannot read is refused as any other
/// refused value is (P4, D11): Edit as Markdown refuses the save naming the
/// line, and an import keeps the line as text with a warning.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_repeat_rule_the_engine_cannot_read_is_refused() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Rules").await;
    let block = dup_child(&pool, &mat, &page, "task").await;
    settle(&mat).await;
    let base = page_source(&pool, &page).await;
    let line = format!("- task ^{block}\n");
    let typed = with(&base, &line, &format!("{line}  repeat:: every tuesday\n"));

    let result = save_source(&pool, &mat, &page, &typed, &base, false).await;

    assert!(
        matches!(&result, Err(AppError::Validation { message, .. })
            if message.contains("`repeat:: every tuesday`")),
        "{result:?}"
    );
    assert_eq!(dup_storage(&pool, &block).await, [NO_COLUMNS]);

    let md = "- task\n  repeat:: every tuesday\n";
    let result = import(&pool, &mat, dir.path(), md, "Rules copy.md").await;
    let copy = page_titled(&pool, "Rules copy").await;
    let imported = &dup_children(&pool, &copy).await[0];
    assert_eq!(imported.1, "task\nrepeat:: every tuesday");
    let named = result
        .warnings
        .iter()
        .filter(|w| w.contains("`repeat:: every tuesday`"))
        .count();
    assert_eq!(named, 1, "{:?}", result.warnings);
}

/// A ref value written as a block id names a live block of the anchor's space
/// (D11): a block copied with a ref into another space and pasted there keeps
/// that line as text with a warning, and the rest of the paste goes through.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paste_blocks_keeps_a_ref_id_of_another_space_as_text() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Refs").await;
    ensure_test_space_b(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_B_ID).await;
    let elsewhere = create_page_in_space_inner(
        &pool,
        DEV,
        &mat,
        None,
        "Elsewhere".into(),
        TEST_SPACE_B_ID.into(),
    )
    .await
    .unwrap();
    create_property_def_inner(&pool, "reviewer".into(), "ref".into(), None)
        .await
        .unwrap();
    let anchor = dup_child(&pool, &mat, &page, "anchor").await;
    settle(&mat).await;
    let text = format!("- copied\n  reviewer:: {elsewhere}\n");

    let pasted = paste_blocks_inner(&pool, DEV, &mat, anchor, paste_text(&text), None)
        .await
        .unwrap();
    settle(&mat).await;

    assert_eq!(pasted.warnings.len(), 1, "{:?}", pasted.warnings);
    assert!(
        pasted.warnings[0].contains("another space"),
        "{:?}",
        pasted.warnings
    );
    let copy = &pasted.blocks[0].id;
    assert_eq!(
        dup_children(&pool, &page).await[1],
        (
            copy.clone().into_string(),
            format!("copied\nreviewer:: {elsewhere}")
        )
    );
    assert_eq!(dup_storage(&pool, copy).await, [NO_COLUMNS]);
}

/// An import reads keys as the buffer does (D13).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_folds_a_key_to_its_canonical_spelling() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    let md = "- task\n  Priority:: 1\n  due-date:: 2026-05-01\n  Scheduled_Date:: 2026-04-01\n  \
              due:: 2026-06-01\n  Owner:: ann\n";

    let result = import(&pool, &mat, dir.path(), md, "Folded.md").await;

    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    let page = page_titled(&pool, "Folded").await;
    let task = &child_ids(&pool, &page).await[0];
    assert_eq!(
        dup_storage(&pool, task).await,
        vec![
            r#"columns todo=None priority=Some("1") scheduled=Some("2026-04-01") due=Some("2026-05-01")"#.to_owned(),
            r#"Owner text=Some("ann") num=None date=None ref=None bool=None"#.to_owned(),
            r#"due text=None num=None date=Some("2026-06-01") ref=None bool=None"#.to_owned(),
        ],
        "a key no definition folds to stays as typed"
    );
}

/// A ref value is a page by `[[Title]]` or by a plain title, as a typed name
/// resolves (#5160 D11); a title two pages tie on, or none has, stays text in
/// its block with a warning naming the line.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_resolves_a_ref_value_by_title() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let alice = dup_page(&pool, &mat, "Alice").await;
    dup_page(&pool, &mat, "Twin").await;
    dup_page(&pool, &mat, "twin").await;
    create_property_def_inner(&pool, "reviewer".into(), "ref".into(), None)
        .await
        .unwrap();
    let md = "- a\n  reviewer:: [[Alice]]\n- b\n  reviewer:: alice\n- c\n  reviewer:: TWIN\n\
              - d\n  reviewer:: Nobody\n";

    let result = import(&pool, &mat, dir.path(), md, "Reviews.md").await;

    let page = page_titled(&pool, "Reviews").await;
    let children = dup_children(&pool, &page).await;
    let contents: Vec<&str> = children.iter().map(|(_, c)| c.as_str()).collect();
    assert_eq!(
        contents,
        ["a", "b", "c\nreviewer:: TWIN", "d\nreviewer:: Nobody"]
    );
    let ids = child_ids(&pool, &page).await;
    for id in &ids[..2] {
        assert_eq!(dup_storage(&pool, id).await[1], reviewer_row(&alice));
    }
    for id in &ids[2..] {
        assert_eq!(dup_storage(&pool, id).await.len(), 1, "nothing is stored");
    }
    let named: Vec<&String> = result
        .warnings
        .iter()
        .filter(|w| w.contains("`reviewer:: TWIN`") || w.contains("`reviewer:: Nobody`"))
        .collect();
    assert_eq!(named.len(), 2, "{:?}", result.warnings);
}

/// Export → Import keeps a body ref property, written as its target's title,
/// and a repeating task's rule (#5160 P4).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn export_then_import_keeps_a_ref_property_and_the_recurrence_rule() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let alice = dup_page(&pool, &mat, "Alice").await;
    create_property_def_inner(&pool, "reviewer".into(), "ref".into(), None)
        .await
        .unwrap();
    let page = dup_page(&pool, &mat, "Weekly").await;
    let task = repeating_task(&pool, &mat, &page).await;
    set(&pool, &mat, &task, "reviewer", Value::Ref(&alice)).await;
    settle(&mat).await;
    let md = export_page_markdown_inner(&pool, page.as_str())
        .await
        .unwrap();
    assert!(md.contains("  reviewer:: Alice\n"), "{md}");

    let result = import(&pool, &mat, dir.path(), &md, "Weekly copy.md").await;

    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    let copy = page_titled(&pool, "Weekly copy").await;
    // The export's `# Weekly` names another page, so it stays a heading, and
    // owns the task (D16).
    let heading = &child_ids(&pool, &copy).await[0];
    let imported = &child_ids(&pool, heading).await[0];
    let stored = dup_storage(&pool, imported).await;
    assert_eq!(
        stored,
        vec![
            r#"columns todo=Some("TODO") priority=None scheduled=None due=None"#.to_owned(),
            RULE_ROWS[0].to_owned(),
            RULE_ROWS[1].to_owned(),
            RULE_ROWS[2].to_owned(),
            reviewer_row(&alice),
        ]
    );
}

/// A paste reads its property lines as an import does (#5160 D11, D13): a
/// value a definition refuses stays text in its block with a warning naming
/// it, a ref value is a page by its title, and a key folds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paste_blocks_keeps_a_refused_value_as_text_with_a_warning() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Paste").await;
    let alice = dup_page(&pool, &mat, "Alice").await;
    create_property_def_inner(&pool, "reviewer".into(), "ref".into(), None)
        .await
        .unwrap();
    let anchor = dup_child(&pool, &mat, &page, "anchor").await;
    settle(&mat).await;
    let text = "- a\n  priority:: high\n- b\n  due:: tomorrow\n- c\n  Priority:: 1\n  \
                reviewer:: Alice\n- d\n  key:: \n";

    let pasted = paste_blocks_inner(&pool, DEV, &mat, anchor.clone(), paste_text(text), None)
        .await
        .unwrap();
    settle(&mat).await;

    assert_eq!(
        pasted.warnings.len(),
        2,
        "one per refused line: {:?}",
        pasted.warnings
    );
    assert!(
        pasted.warnings[0].contains("`priority:: high`"),
        "{:?}",
        pasted.warnings
    );
    assert!(
        pasted.warnings[1].contains("`due:: tomorrow`"),
        "{:?}",
        pasted.warnings
    );
    let contents: Vec<String> = dup_children(&pool, &page)
        .await
        .into_iter()
        .map(|(_, content)| content)
        .collect();
    assert_eq!(
        contents,
        [
            "anchor",
            "a\npriority:: high",
            "b\ndue:: tomorrow",
            "c",
            "d\nkey:: "
        ]
    );
    let ids = child_ids(&pool, &page).await;
    assert_eq!(
        dup_storage(&pool, &ids[1]).await,
        vec!["columns todo=None priority=None scheduled=None due=None"]
    );
    assert_eq!(
        dup_storage(&pool, &ids[3]).await,
        vec![
            r#"columns todo=None priority=Some("1") scheduled=None due=None"#.to_owned(),
            reviewer_row(&alice),
        ]
    );
}

/// Copy → paste keeps a repeating task repeating (#5160 P4): the clipboard
/// writes the rule's lines and the paste reads them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn copy_then_paste_keeps_a_repeating_task_repeating() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Copy").await;
    let task = repeating_task(&pool, &mat, &page).await;
    let copied = get_blocks_source_inner(&pool, vec![task.clone()], true)
        .await
        .unwrap();

    let pasted = paste_blocks_inner(&pool, DEV, &mat, task.clone(), paste_text(&copied), None)
        .await
        .unwrap();
    settle(&mat).await;

    assert!(pasted.warnings.is_empty(), "{:?}", pasted.warnings);
    let copy = &pasted.blocks[0].id;
    assert_ne!(copy, &task);
    let stored = dup_storage(&pool, copy).await;
    assert_eq!(
        stored,
        vec![
            r#"columns todo=Some("TODO") priority=None scheduled=None due=None"#.to_owned(),
            RULE_ROWS[0].to_owned(),
            RULE_ROWS[1].to_owned(),
            RULE_ROWS[2].to_owned(),
        ],
        "the copy carries the rule, not the original's occurrence"
    );
}

/// Import `md` as `Tasks.md` with `key`'s options narrowed to `options`, and
/// return the import's warnings and the page's blocks as `(content, columns)`.
async fn import_with_options(
    md: &str,
    key: &str,
    options: &str,
) -> (Vec<String>, Vec<(String, String)>) {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    update_property_def_options_inner(&pool, key.into(), options.into())
        .await
        .unwrap();
    let result = import(&pool, &mat, dir.path(), md, "Tasks.md").await;
    let page = page_titled(&pool, "Tasks").await;
    let mut blocks = Vec::new();
    for (id, content) in dup_children(&pool, &page).await {
        let columns = dup_storage(&pool, &BlockId::from_trusted(&id)).await;
        blocks.push((content, columns[0].clone()));
    }
    (result.warnings, blocks)
}

const NO_COLUMNS: &str = "columns todo=None priority=None scheduled=None due=None";

/// A checkbox whose state the narrowed `todo_state` options refuse stays in
/// the block's text with a warning naming it (#5160 D11); the file imports.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_keeps_a_refused_checkbox_as_text() {
    let (warnings, blocks) =
        import_with_options("- [/] x\n- [x] y\n", "todo_state", r#"["TODO","DONE"]"#).await;

    assert_eq!(
        blocks,
        [
            ("[/] x".to_owned(), NO_COLUMNS.to_owned()),
            (
                "y".to_owned(),
                r#"columns todo=Some("DONE") priority=None scheduled=None due=None"#.to_owned()
            ),
        ]
    );
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(
        warnings[0].starts_with("`[/]` was kept as text"),
        "{warnings:?}"
    );
}

/// A Logseq task keyword whose state the options refuse stays in the text as
/// written (D7, D11).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_keeps_a_refused_task_keyword_as_text() {
    let (warnings, blocks) =
        import_with_options("- NOW x\n", "todo_state", r#"["TODO","DONE"]"#).await;

    assert_eq!(blocks, [("NOW x".to_owned(), NO_COLUMNS.to_owned())]);
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(
        warnings[0].starts_with("`NOW` was kept as text"),
        "{warnings:?}"
    );
}

/// An Org priority cookie the options do not reach stays in the text, and
/// the task keyword before it is still read (D7, D11).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_keeps_a_refused_priority_cookie_as_text() {
    let (warnings, blocks) =
        import_with_options("- TODO [#C] x\n- [#A] y\n", "priority", r#"["High","Low"]"#).await;

    assert_eq!(
        blocks,
        [
            (
                "[#C] x".to_owned(),
                r#"columns todo=Some("TODO") priority=None scheduled=None due=None"#.to_owned()
            ),
            (
                "y".to_owned(),
                r#"columns todo=None priority=Some("High") scheduled=None due=None"#.to_owned()
            ),
        ]
    );
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(
        warnings[0].starts_with("`[#C]` was kept as text"),
        "{warnings:?}"
    );
}

/// A pasted checkbox the options refuse stays in the pasted block's text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn paste_blocks_keeps_a_refused_checkbox_as_text() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Paste").await;
    let anchor = dup_child(&pool, &mat, &page, "anchor").await;
    update_property_def_options_inner(&pool, "todo_state".into(), r#"["TODO","DONE"]"#.into())
        .await
        .unwrap();
    settle(&mat).await;

    let pasted = paste_blocks_inner(&pool, DEV, &mat, anchor, paste_text("- [/] x\n"), None)
        .await
        .unwrap();
    settle(&mat).await;

    assert_eq!(pasted.warnings.len(), 1, "{:?}", pasted.warnings);
    let copy = &pasted.blocks[0].id;
    assert_eq!(
        dup_children(&pool, &page).await[1],
        (copy.clone().into_string(), "[/] x".to_owned())
    );
    assert_eq!(dup_storage(&pool, copy).await, vec![NO_COLUMNS]);
}

/// A front-matter value its definition refuses is skipped with a warning
/// naming it (D11): front matter has no block to keep it in as text, and the
/// rest of the file imports.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_markdown_skips_a_refused_front_matter_value_with_a_warning() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    let md = "---\npriority: 99\nStatus: active\n---\n- body\n";

    let result = import(&pool, &mat, dir.path(), md, "Front.md").await;

    assert_eq!(result.blocks_created, 1);
    let skipped: Vec<&String> = result
        .warnings
        .iter()
        .filter(|w| w.contains("`priority: 99`"))
        .collect();
    assert_eq!(skipped.len(), 1, "{:?}", result.warnings);
    let page = page_titled(&pool, "Front").await;
    let stored = dup_storage(&pool, &page).await;
    assert_eq!(stored[0], NO_COLUMNS, "the page has no priority");
    assert!(
        stored.contains(
            &r#"status text=Some("active") num=None date=None ref=None bool=None"#.to_owned()
        ),
        "a key folds in front matter too: {stored:?}"
    );
}
