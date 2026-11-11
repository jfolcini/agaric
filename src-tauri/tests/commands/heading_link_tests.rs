//! #6277 F4 — a ref to a heading whose text is unique on its page is written
//! `[[Title#Heading]]`, and a whole-block embed of one `![[Title#Heading]]`,
//! on its own page too; a heading that repeats on its page, or whose text the
//! link would not carry, keeps `[[Title#^id]]`. Each surface reads the links
//! back as the refs it stored: export → import, buffer → save, copy → paste
//! and the mirror's file → re-import.

use crate::prelude::*;

use super::page_cmd_tests::{
    counts, dup_child, dup_children, dup_page, import_folder, page_source, paste, paste_text,
    save_source, with,
};

/// The page "Other" holding a unique heading, a heading twice and a heading
/// holding a colon, and the page "Notes" holding a unique heading of its own,
/// a block referring to each, and an embed of Other's unique heading.
struct Headings {
    notes: BlockId,
    other: BlockId,
    intro: BlockId,
    dup: BlockId,
    colon: BlockId,
    own: BlockId,
    /// The block holding the refs, then the embed.
    blocks: [BlockId; 2],
}

async fn headings(pool: &SqlitePool, mat: &Materializer) -> Headings {
    let other = dup_page(pool, mat, "Other").await;
    let intro = dup_child(pool, mat, &other, "## Intro").await;
    let dup = dup_child(pool, mat, &other, "## Dup").await;
    dup_child(pool, mat, &other, "### dup").await;
    let colon = dup_child(pool, mat, &other, "## Day 1: plan").await;
    let notes = dup_page(pool, mat, "Notes").await;
    let own = dup_child(pool, mat, &notes, "# Own heading").await;
    let refs = dup_child(
        pool,
        mat,
        &notes,
        &format!("see (({intro})), (({dup})), (({colon})) and (({own}))"),
    )
    .await;
    let embed = dup_child(pool, mat, &notes, &format!("{{{{embed (({intro}))}}}}")).await;
    settle(mat).await;
    Headings {
        notes,
        other,
        intro,
        dup,
        colon,
        own,
        blocks: [refs, embed],
    }
}

/// What `headings` stores under Notes.
fn stored(h: &Headings) -> Vec<String> {
    let (intro, dup, colon, own) = (&h.intro, &h.dup, &h.colon, &h.own);
    vec![
        "# Own heading".to_owned(),
        format!("see (({intro})), (({dup})), (({colon})) and (({own}))"),
        format!("{{{{embed (({intro}))}}}}"),
    ]
}

/// The refs line as written: a unique heading by its text, its own page's
/// included, the others by id.
fn written_refs(h: &Headings) -> String {
    let (dup, colon) = (&h.dup, &h.colon);
    format!("see [[Other#Intro]], [[Other#^{dup}]], [[Other#^{colon}]] and [[Notes#Own heading]]")
}

/// The contents under `page`, in document order.
async fn contents(pool: &SqlitePool, page: &BlockId) -> Vec<String> {
    dup_children(pool, page)
        .await
        .into_iter()
        .map(|(_, content)| content)
        .collect()
}

/// Edit as Markdown writes a unique heading's ref and embed by its text; the
/// buffer saved as it was changes nothing, and edited, the link saves as the
/// ref it names.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_buffer_writes_a_heading_ref_by_its_heading_and_saves_it_back() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let h = headings(&pool, &mat).await;

    let buffer = page_source(&pool, &h.notes).await;

    let [block, embed] = &h.blocks;
    for written in [
        format!("\n{} ^{block}\n", written_refs(&h)),
        format!("\n![[Other#Intro]] ^{embed}\n"),
    ] {
        assert!(buffer.contains(&written), "{written}\n{buffer}");
    }

    let report = save_source(&pool, &mat, &h.notes, &buffer, &buffer)
        .await
        .unwrap();
    assert_eq!(counts(&report), [0; 6]);
    assert_eq!(contents(&pool, &h.notes).await, stored(&h));

    let edited = with(
        &buffer,
        &format!("[[Notes#Own heading]] ^{block}"),
        &format!("[[Notes#Own heading]] too ^{block}"),
    );
    save_source(&pool, &mat, &h.notes, &edited, &buffer)
        .await
        .unwrap();
    let mut expected = stored(&h);
    expected[1] = format!("{} too", expected[1]);
    assert_eq!(contents(&pool, &h.notes).await, expected);
    mat.shutdown();
}

/// A copy writes a unique heading's ref and embed by its text, and a paste
/// under another page reads them back as the refs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_copied_heading_ref_pastes_back_as_the_ref() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let h = headings(&pool, &mat).await;
    let dest = dup_page(&pool, &mat, "Dest").await;
    let anchor = dup_child(&pool, &mat, &dest, "anchor").await;
    settle(&mat).await;

    let copy = get_blocks_source_inner(&pool, h.blocks.to_vec(), false)
        .await
        .unwrap();

    assert_eq!(copy, format!("{}\n\n![[Other#Intro]]\n", written_refs(&h)));
    let pasted: Vec<_> = paste(&pool, &mat, &anchor, paste_text(&copy))
        .await
        .into_iter()
        .filter_map(|row| row.content)
        .collect();
    assert_eq!(pasted, stored(&h)[1..]);
    mat.shutdown();
}

/// The mirror's file writes a unique heading's ref and embed by its text, and
/// the file imported over its page, as a re-import reads it back, changes
/// nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_mirrors_file_writes_a_heading_ref_by_its_heading_and_reads_it_back() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let h = headings(&pool, &mat).await;

    let file = agaric_lib::commands::pages::get_page_file_inner(&pool, h.notes.as_str())
        .await
        .unwrap()
        .text;

    for written in [
        format!("\n{}\n", written_refs(&h)),
        "\n![[Other#Intro]]\n".to_owned(),
    ] {
        assert!(file.contains(&written), "{written}\n{file}");
    }
    let result = import_markdown_inner(
        &pool,
        DEV,
        &mat,
        dir.path(),
        file.clone(),
        Some("Notes.md".into()),
        TEST_SPACE_ID.into(),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;
    assert_eq!(result.page_id, h.notes.as_str());
    assert_eq!(result.merged, Some(Vec::new()), "file:\n{file}");
    assert_eq!(contents(&pool, &h.notes).await, stored(&h));
    mat.shutdown();
}

/// The export writes a unique heading's ref and embed by its text, and
/// imported as a file they are the refs they were.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_export_writes_a_heading_ref_by_its_heading_and_imports_it_back() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let h = headings(&pool, &mat).await;

    let md = export_page_markdown_inner(&pool, h.notes.as_str())
        .await
        .unwrap();

    let written = format!("\n\n{}\n\n![[Other#Intro]]\n", written_refs(&h));
    assert!(md.ends_with(&written), "{md}");

    let result = import_markdown_inner(
        &pool,
        DEV,
        &mat,
        dir.path(),
        md.clone(),
        Some("Notes copy.md".into()),
        TEST_SPACE_ID.into(),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;
    assert_eq!(result.warnings, Vec::<String>::new());
    let copy = BlockId::from_trusted(&result.page_id);
    let mut expected = vec!["# Notes".to_owned()];
    expected.extend(stored(&h));
    assert_eq!(contents(&pool, &copy).await, expected, "md:\n{md}");
    mat.shutdown();
}

/// A heading whose text a second heading of its page repeats, once the ref is
/// written by its text, is written by id from then on.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_heading_repeated_on_its_page_is_written_by_id() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let h = headings(&pool, &mat).await;
    let intro = &h.intro;
    let line = |link: &str| format!("\nsee {link}, ");
    let buffer = page_source(&pool, &h.notes).await;
    assert!(buffer.contains(&line("[[Other#Intro]]")), "{buffer}");

    dup_child(&pool, &mat, &h.other, "#### intro").await;
    settle(&mat).await;

    let buffer = page_source(&pool, &h.notes).await;
    assert!(
        buffer.contains(&line(&format!("[[Other#^{intro}]]"))),
        "{buffer}"
    );
    mat.shutdown();
}

/// Two more unique headings on Other, one a ref-typed value names and one an
/// attachment's owner, and a block of Notes referring to both. Returns the
/// two headings.
async fn held_headings(pool: &SqlitePool, mat: &Materializer, h: &Headings) -> [BlockId; 2] {
    let held = dup_child(pool, mat, &h.other, "## Held").await;
    let owned = dup_child(pool, mat, &h.other, "## Owned").await;
    let pointer = dup_child(pool, mat, &h.other, "pointer").await;
    dup_child(
        pool,
        mat,
        &h.notes,
        &format!("also (({held})) and (({owned}))"),
    )
    .await;
    settle(mat).await;
    sqlx::query("INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'see', ?)")
        .bind(pointer.as_str())
        .bind(held.as_str())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, \
         created_at) VALUES ('01J000000000000000000000A7', ?, 'text/plain', 'a.txt', 1, \
         'attachments/a.txt', 1)",
    )
    .bind(owned.as_str())
    .execute(pool)
    .await
    .unwrap();
    [held, owned]
}

/// Every link `[[Title#anchor]]` in `files`, `(title, text)`, names a line
/// of its title's file as Obsidian reads one (#6277 F4): a `#^id` link a line
/// carrying `^id`, and a `#Heading` link a heading line of that text, which
/// carries no `^ULID`. An anchor-only link names its own file. Returns the
/// heading links checked.
fn assert_links_name_their_lines(files: &[(&str, String)]) -> usize {
    let mut by_heading = 0;
    for (own, text) in files {
        for link in text.split("[[").skip(1) {
            let body = link.split("]]").next().unwrap_or_default();
            let Some((title, anchor)) = body.split_once('#') else {
                continue;
            };
            let title = if title.is_empty() { *own } else { title };
            let (_, target) = files
                .iter()
                .find(|(t, _)| *t == title)
                .unwrap_or_else(|| panic!("no file {title} for [[{body}]]"));
            if let Some(id) = anchor.strip_prefix('^') {
                assert!(
                    target.contains(&format!("^{id}\n")),
                    "[[{body}]]:\n{target}"
                );
            } else {
                by_heading += 1;
                let line = target
                    .lines()
                    .map(|l| l.trim_start_matches("+ "))
                    .find(|l| l.trim_start_matches('#').trim_start().starts_with(anchor))
                    .unwrap_or_else(|| panic!("no heading for [[{body}]]:\n{target}"));
                assert!(line.starts_with('#'), "[[{body}]] names {line:?}");
                assert!(!line.contains(" ^"), "[[{body}]] names {line:?}:\n{target}");
            }
        }
    }
    by_heading
}

/// No line the export, the ZIP (the export without its title line) or the
/// mirror writes is both anchored `^ULID` and named by its heading: a heading
/// every link names by text is written bare, and one a value or an attachment
/// holds keeps its anchor and is linked by id.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_heading_line_is_both_anchored_and_named_by_its_text() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let h = headings(&pool, &mat).await;
    let [held, owned] = held_headings(&pool, &mat, &h).await;
    let mut exports = Vec::new();
    let mut files = Vec::new();
    for (title, page) in [("Other", &h.other), ("Notes", &h.notes)] {
        let md = export_page_markdown_inner(&pool, page.as_str())
            .await
            .unwrap();
        exports.push((title, md));
        let file = agaric_lib::commands::pages::get_page_file_inner(&pool, page.as_str())
            .await
            .unwrap()
            .text;
        files.push((title, file));
    }
    for written in [&exports, &files] {
        let (other, notes) = (&written[0].1, &written[1].1);
        let has = |text: &str, line: &str| text.lines().any(|l| l == line);
        assert!(has(other, "## Intro"), "{other}");
        assert!(has(other, &format!("## Held ^{held}")), "{other}");
        assert!(has(other, &format!("## Owned ^{owned}")), "{other}");
        assert!(
            notes.contains(&format!("also [[Other#^{held}]] and [[Other#^{owned}]]")),
            "{notes}"
        );
        assert!(notes.contains("[[Notes#Own heading]]"), "{notes}");
        assert!(has(notes, "+ # Own heading"), "{notes}");
        assert_eq!(assert_links_name_their_lines(written), 3);
    }
    mat.shutdown();
}

/// The ZIP's files, imported as a folder into another vault, read every link
/// back as the ref it was: one by heading to the bare heading line, one by id
/// to the anchored line.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_zip_of_heading_refs_imports_back_as_the_refs() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let h = headings(&pool, &mat).await;
    let mut notes = Vec::new();
    for (title, page) in [("Other", &h.other), ("Notes", &h.notes)] {
        let md = export_page_markdown_inner(&pool, page.as_str())
            .await
            .unwrap();
        let file = md
            .strip_prefix(&format!("# {title}\n\n"))
            .expect("the export opens with its title line")
            .to_owned();
        notes.push((format!("{title}.md"), file));
    }
    mat.shutdown();

    let (vault, dir) = test_pool().await;
    let mat = Materializer::new(vault.clone());
    let notes: Vec<(&str, &str)> = notes
        .iter()
        .map(|(p, md)| (p.as_str(), md.as_str()))
        .collect();
    let warnings = import_folder(&vault, &mat, dir.path(), &notes, &[]).await;
    assert_eq!(warnings, Vec::<String>::new());
    let page = |title: &'static str| {
        let vault = vault.clone();
        async move {
            let id: String = sqlx::query_scalar(
                "SELECT id FROM blocks WHERE block_type = 'page' AND content = ? \
                 AND deleted_at IS NULL",
            )
            .bind(title)
            .fetch_one(&vault)
            .await
            .unwrap();
            dup_children(&vault, &BlockId::from_trusted(&id)).await
        }
    };
    let other = page("Other").await;
    let id = |content: &str| {
        other
            .iter()
            .find(|(_, c)| c == content)
            .unwrap_or_else(|| panic!("no {content}: {other:?}"))
            .0
            .clone()
    };
    let (intro, dup, colon) = (id("## Intro"), id("## Dup"), id("## Day 1: plan"));
    let notes = page("Notes").await;
    let own = &notes[0].0;
    let contents: Vec<&str> = notes.iter().map(|(_, c)| c.as_str()).collect();
    assert_eq!(
        contents,
        [
            "# Own heading".to_owned(),
            format!("see (({intro})), (({dup})), (({colon})) and (({own}))"),
            format!("{{{{embed (({intro}))}}}}"),
        ]
    );
    mat.shutdown();
}

/// The mirror's file of the page holding the headings writes a heading every
/// link names by text bare, and imported over its page keeps every block's id,
/// so the refs to it stay as they were.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bare_heading_keeps_its_id_through_the_mirrors_reimport() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let h = headings(&pool, &mat).await;
    let before = dup_children(&pool, &h.other).await;

    let file = agaric_lib::commands::pages::get_page_file_inner(&pool, h.other.as_str())
        .await
        .unwrap()
        .text;
    assert!(file.lines().any(|l| l == "## Intro"), "{file}");

    let result = import_markdown_inner(
        &pool,
        DEV,
        &mat,
        dir.path(),
        file.clone(),
        Some("Other.md".into()),
        TEST_SPACE_ID.into(),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;
    assert_eq!(result.merged, Some(Vec::new()), "file:\n{file}");
    assert_eq!(dup_children(&pool, &h.other).await, before);
    assert_eq!(contents(&pool, &h.notes).await, stored(&h));
    mat.shutdown();
}
