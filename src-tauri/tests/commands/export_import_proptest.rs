//! #6277 G6 T2 — a space exported as the ZIP writes it and folder-imported
//! into an empty pool is the same space: the trees are isomorphic up to an id
//! renaming, and exporting the restore writes the export again (decision 8).
//!
//! Each case seeds a space through the commands a user's edits run, with
//! front matter (a typed property, an alias, a tag, the template flag), block
//! properties of every typed kind and a multi-line one, tasks and their done
//! dates, list styles, refs and embeds across pages, inline and block-scoped
//! files, and titles a file path cannot carry (`a:b`, a namespace). It
//! renders every page with the export, lays the files out as the ZIP does
//! (`assets/<id>/<name>`), restores the property definitions as
//! `.agaric/space.json` does, and imports the notes as one folder pick.

use std::collections::{BTreeMap, HashMap};

use agaric_engine::import::{ImportDialect, VaultFile};
use proptest::prelude::*;
use tokio::runtime::Runtime;

use crate::prelude::*;

// A case seeds and restores two pools through the real commands, so the
// cases are few; each one is a whole space.
const CASES: u32 = 16;

const TITLES: [&str; 4] = ["Alpha", "Ns/Beta", "a:b", "Gamma Delta"];
const WORDS: [&str; 5] = ["milk", "eggs", "plan", "Ünï", "ship"];
const PNG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// The property definitions a case's space holds, as `.agaric/space.json`
/// carries them.
const DEFINITIONS: [(&str, &str); 3] = [("effort", "number"), ("due_on", "date"), ("owner", "ref")];

#[derive(Debug, Clone, Copy)]
enum Kind {
    Plain,
    Bullet,
    Ordered,
    Todo,
    Done,
}

/// A value of the block property it names.
#[derive(Debug, Clone)]
enum Prop {
    Text,
    MultiLine,
    Number(i64),
    Date,
    /// A ref to the page of this index.
    Owner(usize),
}

/// What a block's text points at, by index into the case's blocks or pages.
#[derive(Debug, Clone, Copy)]
enum Pointer {
    BlockRef(usize),
    BlockEmbed(usize),
    PageLink(usize),
}

#[derive(Debug, Clone, Copy)]
enum File {
    Scoped,
    Inline,
}

#[derive(Debug, Clone)]
struct BlockSpec {
    level: usize,
    words: Vec<usize>,
    kind: Kind,
    pointer: Option<Pointer>,
    prop: Option<Prop>,
    file: Option<File>,
}

#[derive(Debug, Clone)]
struct PageSpec {
    blocks: Vec<BlockSpec>,
    alias: bool,
    tag: bool,
    template: bool,
    effort: Option<i64>,
    own_file: bool,
}

fn arb_kind() -> impl Strategy<Value = Kind> {
    prop_oneof![
        3 => Just(Kind::Plain),
        1 => Just(Kind::Bullet),
        1 => Just(Kind::Ordered),
        1 => Just(Kind::Todo),
        1 => Just(Kind::Done),
    ]
}

fn arb_prop() -> impl Strategy<Value = Prop> {
    prop_oneof![
        Just(Prop::Text),
        Just(Prop::MultiLine),
        (0i64..100).prop_map(Prop::Number),
        Just(Prop::Date),
        (0usize..4).prop_map(Prop::Owner),
    ]
}

fn arb_pointer() -> impl Strategy<Value = Pointer> {
    prop_oneof![
        (0usize..32).prop_map(Pointer::BlockRef),
        (0usize..32).prop_map(Pointer::BlockEmbed),
        (0usize..4).prop_map(Pointer::PageLink),
    ]
}

fn arb_block() -> impl Strategy<Value = BlockSpec> {
    (
        0usize..3,
        prop::collection::vec(0..WORDS.len(), 1..3),
        arb_kind(),
        prop::option::weighted(0.3, arb_pointer()),
        prop::option::weighted(0.3, arb_prop()),
        prop::option::weighted(0.2, prop_oneof![Just(File::Scoped), Just(File::Inline)]),
    )
        .prop_map(|(level, words, kind, pointer, prop, file)| BlockSpec {
            level,
            words,
            kind,
            pointer,
            prop,
            file,
        })
}

fn arb_page() -> impl Strategy<Value = PageSpec> {
    (
        prop::collection::vec(arb_block(), 1..5),
        any::<bool>(),
        any::<bool>(),
        prop::bool::weighted(0.3),
        prop::option::of(0i64..10),
        prop::bool::weighted(0.3),
    )
        .prop_map(|(mut blocks, alias, tag, template, effort, own_file)| {
            // Each block at most one level below the one before it.
            let mut previous: Option<usize> = None;
            for block in &mut blocks {
                block.level = previous.map_or(0, |p| block.level.min(p + 1));
                previous = Some(block.level);
            }
            PageSpec {
                blocks,
                alias,
                tag,
                template,
                effort,
                own_file,
            }
        })
}

fn arb_space() -> impl Strategy<Value = Vec<PageSpec>> {
    prop::collection::vec(arb_page(), 2..=3)
}

async fn set(
    pool: &SqlitePool,
    mat: &Materializer,
    block: &BlockId,
    key: &str,
    value: (Option<String>, Option<f64>, Option<String>, Option<String>),
) {
    let (text, num, date, reference) = value;
    set_property_inner(
        pool,
        DEV,
        mat,
        block.as_str().to_string().into(),
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

async fn attach(
    pool: &SqlitePool,
    mat: &Materializer,
    dir: &std::path::Path,
    block: &BlockId,
    file: File,
    n: usize,
) -> String {
    let (name, mime, bytes) = match file {
        File::Inline => (format!("pic-{n}.png"), "image/png", PNG.to_vec()),
        File::Scoped => (
            format!("doc {n}.pdf"),
            "application/pdf",
            b"%PDF-1".to_vec(),
        ),
    };
    add_attachment_with_bytes_inner(pool, DEV, mat, dir, block.clone(), name, mime.into(), bytes)
        .await
        .unwrap()
        .id
        .into_string()
}

/// The space `space` describes, made in `pool`'s test space as a user's edits
/// make it.
async fn seed(pool: &SqlitePool, mat: &Materializer, dir: &std::path::Path, space: &[PageSpec]) {
    ensure_test_space(pool).await;
    mark_block_as_space(pool, TEST_SPACE_ID).await;
    for (key, value_type) in DEFINITIONS {
        create_property_def_inner(
            pool,
            DEV,
            mat,
            TEST_SPACE_ID,
            key.into(),
            value_type.into(),
            None,
        )
        .await
        .unwrap();
    }
    const TAG: &str = "01J6277G6TAGW0RK000000000T";
    insert_block(pool, TAG, "tag", "work", None, Some(1)).await;
    assign_to_space(pool, TAG, TEST_SPACE_ID).await;

    let mut pages = Vec::new();
    for title in TITLES.iter().take(space.len()) {
        let page =
            create_page_in_space_inner(pool, DEV, mat, None, (*title).into(), TEST_SPACE_ID.into())
                .await
                .unwrap();
        pages.push(page);
    }
    let mut blocks = Vec::new();
    let mut files = 0;
    for (p, spec) in space.iter().enumerate() {
        let page = &pages[p];
        let mut ancestors: Vec<BlockId> = Vec::new();
        for block in &spec.blocks {
            ancestors.truncate(block.level);
            let parent = ancestors.last().unwrap_or(page).clone();
            let text: Vec<&str> = block.words.iter().map(|w| WORDS[*w]).collect();
            let row = create_block_inner(
                pool,
                DEV,
                mat,
                "content".into(),
                text.join(" "),
                Some(parent),
                None,
            )
            .await
            .unwrap();
            ancestors.push(row.id.clone());
            blocks.push(row.id);
        }
        if spec.alias {
            set_page_aliases_inner(pool, DEV, mat, page.as_str(), vec![format!("Alias {p}")])
                .await
                .unwrap();
        }
        if spec.tag {
            add_tag_inner(pool, DEV, mat, page.clone(), BlockId::from_trusted(TAG))
                .await
                .unwrap();
        }
        if spec.template {
            set(
                pool,
                mat,
                page,
                "template",
                (Some("true".into()), None, None, None),
            )
            .await;
        }
        if let Some(effort) = spec.effort {
            set(
                pool,
                mat,
                page,
                "effort",
                (None, Some(effort as f64), None, None),
            )
            .await;
        }
        if spec.own_file {
            files += 1;
            attach(pool, mat, dir, page, File::Scoped, files).await;
        }
    }

    let specs: Vec<&BlockSpec> = space.iter().flat_map(|page| &page.blocks).collect();
    for (b, spec) in specs.iter().enumerate() {
        let id = &blocks[b];
        let mut text: String = spec
            .words
            .iter()
            .map(|w| WORDS[*w])
            .collect::<Vec<_>>()
            .join(" ");
        match spec.pointer {
            Some(Pointer::BlockRef(to)) if blocks.len() > 1 => {
                let to = &blocks[(b + 1 + to % (blocks.len() - 1)) % blocks.len()];
                text = format!("{text} (({to}))");
            }
            Some(Pointer::BlockEmbed(to)) if blocks.len() > 1 => {
                let to = &blocks[(b + 1 + to % (blocks.len() - 1)) % blocks.len()];
                text = format!("{{{{embed (({to}))}}}}");
            }
            Some(Pointer::PageLink(to)) => {
                text = format!("{text} [[{}]]", pages[to % pages.len()]);
            }
            _ => {}
        }
        if let Some(File::Inline) = spec.file {
            files += 1;
            let att = attach(pool, mat, dir, id, File::Inline, files).await;
            text = format!("{text} ![pic](attachment:{att})");
        }
        edit_block_inner(pool, DEV, mat, id.clone(), text)
            .await
            .unwrap();
        if let Some(File::Scoped) = spec.file {
            files += 1;
            attach(pool, mat, dir, id, File::Scoped, files).await;
        }
        match spec.kind {
            Kind::Plain => {}
            Kind::Bullet => {
                set(
                    pool,
                    mat,
                    id,
                    "listStyle",
                    (Some("bullet".into()), None, None, None),
                )
                .await;
            }
            Kind::Ordered => {
                set(
                    pool,
                    mat,
                    id,
                    "listStyle",
                    (Some("ordered".into()), None, None, None),
                )
                .await;
            }
            Kind::Todo | Kind::Done => {
                let state = if matches!(spec.kind, Kind::Todo) {
                    "TODO"
                } else {
                    "DONE"
                };
                set_todo_state_inner(
                    pool,
                    DEV,
                    mat,
                    id.as_str().to_string().into(),
                    Some(state.into()),
                )
                .await
                .unwrap();
            }
        }
        match &spec.prop {
            None => {}
            Some(Prop::Text) => {
                set(
                    pool,
                    mat,
                    id,
                    "note",
                    (Some("plain words".into()), None, None, None),
                )
                .await;
            }
            Some(Prop::MultiLine) => {
                let value = Some("first line\nsecond line".into());
                set(pool, mat, id, "note", (value, None, None, None)).await;
            }
            Some(Prop::Number(n)) => {
                set(pool, mat, id, "effort", (None, Some(*n as f64), None, None)).await;
            }
            Some(Prop::Date) => {
                set(
                    pool,
                    mat,
                    id,
                    "due_on",
                    (None, None, Some("2026-06-01".into()), None),
                )
                .await;
            }
            Some(Prop::Owner(to)) => {
                let owner = pages[to % pages.len()].as_str().to_string();
                set(pool, mat, id, "owner", (None, None, None, Some(owner))).await;
            }
        }
    }
    settle(mat).await;
}

/// Every live page of the test space but the space itself, title first.
async fn space_pages(pool: &SqlitePool) -> Vec<(String, String)> {
    sqlx::query_as(
        "SELECT id, content FROM blocks WHERE block_type = 'page' AND deleted_at IS NULL \
         AND space_id = ?1 AND id != ?1 ORDER BY content",
    )
    .bind(TEST_SPACE_ID)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// The ZIP's files for the space in `pool`: each page's export, its title line
/// dropped and each `attachment:<id>` pointing at `assets/<id>/<name>`, under
/// the title the import is given back (`.agaric/space.json`), and the
/// attachments' bytes at those paths.
async fn export_zip(
    pool: &SqlitePool,
    dir: &std::path::Path,
) -> (Vec<(String, String)>, Vec<VaultFile>) {
    let attachments: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, filename, fs_path FROM attachments WHERE deleted_at IS NULL ORDER BY id",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    let mut notes = Vec::new();
    for (page, title) in space_pages(pool).await {
        let md = export_page_markdown_inner(pool, &page).await.unwrap();
        let mut md = md.replacen(&format!("# {title}\n\n"), "", 1);
        let up = "../".repeat(title.matches('/').count());
        for (id, name, _) in &attachments {
            md = md.replace(
                &format!("attachment:{id}"),
                &format!("<{up}assets/{id}/{name}>"),
            );
        }
        notes.push((format!("{title}.md"), md));
    }
    let files = attachments
        .iter()
        .map(|(id, name, fs_path)| VaultFile {
            path: format!("assets/{id}/{name}"),
            bytes: std::fs::read(dir.join(fs_path)).unwrap().into(),
        })
        .collect();
    (notes, files)
}

/// Import `notes` as one folder pick carrying `files` into `pool`'s test
/// space, its definitions restored first, then end it as the Data tab does.
async fn restore(
    pool: &SqlitePool,
    mat: &Materializer,
    dir: &std::path::Path,
    notes: &[(String, String)],
    files: &[VaultFile],
) -> Vec<String> {
    ensure_test_space(pool).await;
    mark_block_as_space(pool, TEST_SPACE_ID).await;
    for (key, value_type) in DEFINITIONS {
        create_property_def_inner(
            pool,
            DEV,
            mat,
            TEST_SPACE_ID,
            key.into(),
            value_type.into(),
            None,
        )
        .await
        .unwrap();
    }
    let paths: Vec<String> = notes.iter().map(|(path, _)| path.clone()).collect();
    let (mut anchors, mut deferred, mut warnings) = (Vec::new(), Vec::new(), Vec::new());
    for (path, md) in notes {
        let result = import_markdown_with_progress(
            pool,
            DEV,
            mat,
            dir,
            md.clone(),
            Some(path.clone()),
            TEST_SPACE_ID.into(),
            ImportDialect::Markdown,
            Some(files.to_vec()),
            Some(paths.clone()),
            None,
        )
        .await
        .unwrap();
        settle(mat).await;
        anchors.extend(result.anchors);
        deferred.extend(result.deferred.iter().map(|id| BlockId::from_trusted(id)));
        warnings.extend(result.warnings);
    }
    let end = link_import_anchors_inner(pool, DEV, mat, TEST_SPACE_ID, &anchors, &deferred)
        .await
        .unwrap();
    settle(mat).await;
    warnings.extend(end);
    warnings
}

/// A name for every id the space's text can hold that does not depend on the
/// id: a page by its title, a block by its title and its index path, an
/// attachment by its owner's name and its file name, a tag by its name.
async fn names(pool: &SqlitePool) -> HashMap<String, String> {
    let mut names = HashMap::new();
    for (page, title) in space_pages(pool).await {
        names.insert(page.clone(), format!("P[{title}]"));
        let mut stack = vec![(page, format!("B[{title}]"))];
        while let Some((parent, path)) = stack.pop() {
            let children: Vec<String> = sqlx::query_scalar(
                "SELECT id FROM blocks WHERE parent_id = ? AND deleted_at IS NULL \
                 AND block_type = 'content' ORDER BY position, id",
            )
            .bind(&parent)
            .fetch_all(pool)
            .await
            .unwrap();
            for (i, child) in children.into_iter().enumerate() {
                let child_path = format!("{path}.{i}");
                names.insert(child.clone(), child_path.clone());
                stack.push((child, child_path));
            }
        }
    }
    let tags: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, content FROM blocks WHERE block_type = 'tag' AND deleted_at IS NULL",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    for (id, name) in tags {
        names.insert(id, format!("T[{name}]"));
    }
    let attachments: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id, block_id, filename FROM attachments WHERE deleted_at IS NULL")
            .fetch_all(pool)
            .await
            .unwrap();
    for (id, owner, filename) in attachments {
        let owner = names.get(&owner).cloned().unwrap_or_else(|| "?".into());
        names.insert(id, format!("A[{owner}/{filename}]"));
    }
    names
}

/// `text` with every id `names` knows replaced by its name.
fn renamed(text: &str, names: &HashMap<String, String>) -> String {
    let mut out = text.to_string();
    let mut ids: Vec<&String> = names.keys().collect();
    ids.sort_by_key(|id| std::cmp::Reverse(id.len()));
    for id in ids {
        out = out.replace(id.as_str(), &names[id]);
    }
    out
}

type BlockColumns = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

type PropertyRow = (
    String,
    String,
    Option<String>,
    Option<f64>,
    Option<String>,
    Option<String>,
    Option<i64>,
);

/// The space in `pool` with every id renamed ([`names`]): each page's and
/// block's text, columns, properties, aliases, tags and files, keyed by name.
async fn snapshot(pool: &SqlitePool) -> BTreeMap<String, Vec<String>> {
    let names = names(pool).await;
    let mut snapshot: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, name) in &names {
        if !name.starts_with("P[") && !name.starts_with("B[") {
            continue;
        }
        let entry = snapshot.entry(name.clone()).or_default();
        let row: BlockColumns = sqlx::query_as(
            "SELECT content, todo_state, priority, scheduled_date, due_date \
                 FROM blocks WHERE id = ?",
        )
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap();
        entry.push(renamed(&format!("{row:?}"), &names));
        let properties: Vec<PropertyRow> = sqlx::query_as(
            "SELECT block_id, key, value_text, value_num, value_date, value_ref, value_bool \
             FROM block_properties WHERE block_id = ? AND key != 'created_at' ORDER BY key",
        )
        .bind(id)
        .fetch_all(pool)
        .await
        .unwrap();
        for (_, key, text, num, date, reference, boolean) in properties {
            let value = format!("{text:?} {num:?} {date:?} {reference:?} {boolean:?}");
            entry.push(format!("prop {key} = {}", renamed(&value, &names)));
        }
        let aliases: Vec<String> =
            sqlx::query_scalar("SELECT alias FROM page_aliases WHERE page_id = ? ORDER BY alias")
                .bind(id)
                .fetch_all(pool)
                .await
                .unwrap();
        entry.extend(aliases.into_iter().map(|alias| format!("alias {alias}")));
        let tags: Vec<String> = sqlx::query_scalar(
            "SELECT t.content FROM block_tags bt JOIN blocks t ON t.id = bt.tag_id \
             WHERE bt.block_id = ? ORDER BY t.content",
        )
        .bind(id)
        .fetch_all(pool)
        .await
        .unwrap();
        entry.extend(tags.into_iter().map(|tag| format!("tag {tag}")));
        let files: Vec<(String, String, i64)> = sqlx::query_as(
            "SELECT filename, mime_type, size_bytes FROM attachments \
             WHERE block_id = ? AND deleted_at IS NULL ORDER BY filename",
        )
        .bind(id)
        .fetch_all(pool)
        .await
        .unwrap();
        entry.extend(files.into_iter().map(|file| format!("file {file:?}")));
    }
    snapshot
}

/// Each page's export with every id renamed, by title.
async fn renamed_exports(pool: &SqlitePool) -> BTreeMap<String, String> {
    let names = names(pool).await;
    let mut exports = BTreeMap::new();
    for (page, title) in space_pages(pool).await {
        let md = export_page_markdown_inner(pool, &page).await.unwrap();
        exports.insert(title, renamed(&md, &names));
    }
    exports
}

async fn run_case(space: Vec<PageSpec>) -> Result<(), TestCaseError> {
    let (source, source_dir) = test_pool().await;
    let source_mat = Materializer::new(source.clone());
    seed(&source, &source_mat, source_dir.path(), &space).await;
    let (notes, files) = export_zip(&source, source_dir.path()).await;

    let (target, target_dir) = test_pool().await;
    let target_mat = Materializer::new(target.clone());
    let warnings = restore(&target, &target_mat, target_dir.path(), &notes, &files).await;

    prop_assert_eq!(warnings, Vec::<String>::new(), "notes: {:#?}", notes);
    prop_assert_eq!(
        snapshot(&target).await,
        snapshot(&source).await,
        "notes: {:#?}",
        notes
    );
    prop_assert_eq!(
        renamed_exports(&target).await,
        renamed_exports(&source).await,
        "notes: {:#?}",
        notes
    );
    source_mat.shutdown();
    target_mat.shutdown();
    Ok(())
}

#[test]
fn a_restored_export_is_the_space_it_was_exported_from() {
    proptest!(ProptestConfig::with_cases(CASES), |(space in arb_space())| {
        Runtime::new().unwrap().block_on(run_case(space))?;
    });
}
