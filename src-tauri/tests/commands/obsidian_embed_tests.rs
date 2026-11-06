//! #6277 F1 — a block that is one embed is written as Obsidian's embed,
//! `![[Title]]` and `![[Title#^id]]`, and each surface it is written to reads
//! it back as the embed it stored: export → import, buffer → save, copy →
//! paste and the mirror's file → re-import.

use crate::prelude::*;

use super::page_cmd_tests::{
    counts, dup_child, dup_children, dup_page, page_source, paste, paste_text, save_source, with,
};

/// The page "Notes" embedding the page "Other", a block of Other's and a
/// block of its own, with an embed among text after them.
struct Embeds {
    notes: BlockId,
    other: BlockId,
    theirs: BlockId,
    own: BlockId,
    /// The block that embeds Other, then the one that embeds `theirs`.
    embeds: [BlockId; 2],
}

async fn embeds(pool: &SqlitePool, mat: &Materializer) -> Embeds {
    let other = dup_page(pool, mat, "Other").await;
    let theirs = dup_child(pool, mat, &other, "their block").await;
    let notes = dup_page(pool, mat, "Notes").await;
    let own = dup_child(pool, mat, &notes, "own block").await;
    let page = dup_child(pool, mat, &notes, &format!("{{{{embed [[{other}]]}}}}")).await;
    let block = dup_child(pool, mat, &notes, &format!("{{{{embed (({theirs}))}}}}")).await;
    dup_child(pool, mat, &notes, &format!("{{{{embed (({own}))}}}}")).await;
    dup_child(pool, mat, &notes, &format!("see {{{{embed [[{other}]]}}}}")).await;
    settle(mat).await;
    Embeds {
        notes,
        other,
        theirs,
        own,
        embeds: [page, block],
    }
}

/// The contents under `page`, in document order.
async fn contents(pool: &SqlitePool, page: &BlockId) -> Vec<String> {
    dup_children(pool, page)
        .await
        .into_iter()
        .map(|(_, content)| content)
        .collect()
}

/// What `embeds` stores under Notes, its own block's embed naming `own`.
fn stored(e: &Embeds, own: &str) -> Vec<String> {
    vec![
        "own block".to_owned(),
        format!("{{{{embed [[{}]]}}}}", e.other),
        format!("{{{{embed (({}))}}}}", e.theirs),
        format!("{{{{embed (({own}))}}}}"),
        format!("see {{{{embed [[{}]]}}}}", e.other),
    ]
}

/// The export writes a page embed and a block embed, on another page or its
/// own, as Obsidian's, an embed among text as it was; imported as a file, they
/// are the embeds they were, the own block's naming its imported copy.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_export_writes_embeds_as_obsidians_and_imports_them_back() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let e = embeds(&pool, &mat).await;

    let md = export_page_markdown_inner(&pool, e.notes.as_str())
        .await
        .unwrap();

    let (own, theirs) = (&e.own, &e.theirs);
    let written = format!(
        "\n\n![[Other]]\n\n![[Other#^{theirs}]]\n\n![[#^{own}]]\n\nsee {{{{embed [[Other]]}}}}\n"
    );
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
    let read = dup_children(&pool, &copy).await;
    // The export's `# Notes` names another page, so it stays a heading.
    assert_eq!(read[0].1, "# Notes", "md:\n{md}");
    let own_copy = &read[1].0;
    let mut expected = vec!["# Notes".to_owned()];
    expected.extend(stored(&e, own_copy));
    assert_eq!(contents(&pool, &copy).await, expected, "md:\n{md}");
    mat.shutdown();
}

/// Edit as Markdown writes a page embed whose name reads back as Obsidian's,
/// and a block embed as Obsidian's, as it writes a block ref; the buffer saved as
/// it was changes nothing, and an embed edited in it saves as an embed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_buffer_writes_a_page_embed_as_obsidians_and_saves_it_back() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let e = embeds(&pool, &mat).await;
    let third = dup_page(&pool, &mat, "Third").await;
    settle(&mat).await;

    let buffer = page_source(&pool, &e.notes).await;

    let [page, block] = &e.embeds;
    assert!(
        buffer.contains(&format!("\n![[Other]] ^{page}\n")),
        "{buffer}"
    );
    let theirs = &e.theirs;
    assert!(
        buffer.contains(&format!("\n![[Other#^{theirs}]] ^{block}\n")),
        "{buffer}"
    );
    assert!(buffer.contains("\nsee {{embed [[Other]]}} ^"), "{buffer}");

    let report = save_source(&pool, &mat, &e.notes, &buffer, &buffer)
        .await
        .unwrap();
    assert_eq!(counts(&report), [0; 6]);
    assert_eq!(contents(&pool, &e.notes).await, stored(&e, e.own.as_str()));

    let edited = with(&buffer, "![[Other]]", "![[Third]]");
    save_source(&pool, &mat, &e.notes, &edited, &buffer)
        .await
        .unwrap();
    settle(&mat).await;
    let mut expected = stored(&e, e.own.as_str());
    expected[1] = format!("{{{{embed [[{third}]]}}}}");
    assert_eq!(contents(&pool, &e.notes).await, expected);
    mat.shutdown();
}

/// A copy writes a page embed as Obsidian's, and a paste reads it back as the
/// embed, beside a block embed it writes as Obsidian's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_copied_embed_pastes_back_as_the_embed() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let e = embeds(&pool, &mat).await;
    let dest = dup_page(&pool, &mat, "Dest").await;
    let anchor = dup_child(&pool, &mat, &dest, "anchor").await;
    settle(&mat).await;

    let copy = get_blocks_source_inner(&pool, e.embeds.to_vec(), false)
        .await
        .unwrap();

    let theirs = &e.theirs;
    assert_eq!(copy, format!("![[Other]]\n\n![[Other#^{theirs}]]\n"));
    let pasted: Vec<_> = paste(&pool, &mat, &anchor, paste_text(&copy))
        .await
        .into_iter()
        .filter_map(|row| row.content)
        .collect();
    assert_eq!(pasted, stored(&e, e.own.as_str())[1..3]);
    mat.shutdown();
}

/// The mirror's file writes a page embed as Obsidian's, and the file imported
/// over its page, as a re-import reads it back, changes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_mirrors_file_writes_a_page_embed_as_obsidians_and_reads_it_back() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let e = embeds(&pool, &mat).await;

    let file = agaric_lib::commands::pages::get_page_file_inner(&pool, e.notes.as_str())
        .await
        .unwrap()
        .text;

    assert!(file.contains("\n![[Other]]\n"), "{file}");
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
    assert_eq!(result.page_id, e.notes.as_str());
    assert_eq!(result.merged, Some(Vec::new()), "file:\n{file}");
    assert_eq!(contents(&pool, &e.notes).await, stored(&e, e.own.as_str()));
    mat.shutdown();
}
