//! #6277 F2 — a block ref is written as an Obsidian block link, `[[#^id]]` to
//! a block of its own page and `[[Title#^id]]` to another page's, and a block
//! that is one block embed as `![[#^id]]` or `![[Title#^id]]`, on the surfaces
//! that come back to Agaric; each reads them back as the refs it stored: the
//! buffer → save, copy → paste and the mirror's file → re-import.

use crate::prelude::*;

use super::page_cmd_tests::{
    counts, dup_child, dup_children, dup_page, page_source, paste, paste_text, save_source, with,
};

/// The page "Notes" holding a block, a block referring to it and to a block
/// of the page "Other", and an embed of each.
struct Refs {
    notes: BlockId,
    other: BlockId,
    theirs: BlockId,
    own: BlockId,
    /// The block holding the refs, then the embeds of `own` and `theirs`.
    blocks: [BlockId; 3],
}

async fn refs(pool: &SqlitePool, mat: &Materializer) -> Refs {
    let other = dup_page(pool, mat, "Other").await;
    let theirs = dup_child(pool, mat, &other, "their block").await;
    let notes = dup_page(pool, mat, "Notes").await;
    let own = dup_child(pool, mat, &notes, "own block").await;
    let refs = dup_child(
        pool,
        mat,
        &notes,
        &format!("see (({own})) and (({theirs}))"),
    )
    .await;
    let own_embed = dup_child(pool, mat, &notes, &format!("{{{{embed (({own}))}}}}")).await;
    let their_embed = dup_child(pool, mat, &notes, &format!("{{{{embed (({theirs}))}}}}")).await;
    settle(mat).await;
    Refs {
        notes,
        other,
        theirs,
        own,
        blocks: [refs, own_embed, their_embed],
    }
}

/// What `refs` stores under Notes.
fn stored(r: &Refs) -> Vec<String> {
    let (own, theirs) = (&r.own, &r.theirs);
    vec![
        "own block".to_owned(),
        format!("see (({own})) and (({theirs}))"),
        format!("{{{{embed (({own}))}}}}"),
        format!("{{{{embed (({theirs}))}}}}"),
    ]
}

/// The contents under `page`, in document order.
async fn contents(pool: &SqlitePool, page: &BlockId) -> Vec<String> {
    dup_children(pool, page)
        .await
        .into_iter()
        .map(|(_, content)| content)
        .collect()
}

/// Edit as Markdown writes the refs and embeds as Obsidian's; the buffer saved
/// as it was changes nothing, and edited, a link saves as the ref it names.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_buffer_writes_block_refs_as_obsidian_links_and_saves_them_back() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = refs(&pool, &mat).await;

    let buffer = page_source(&pool, &r.notes).await;

    let (own, theirs) = (&r.own, &r.theirs);
    let [block, own_embed, their_embed] = &r.blocks;
    for written in [
        format!("\nsee [[#^{own}]] and [[Other#^{theirs}]] ^{block}\n"),
        format!("\n![[#^{own}]] ^{own_embed}\n"),
        format!("\n![[Other#^{theirs}]] ^{their_embed}\n"),
    ] {
        assert!(buffer.contains(&written), "{written}\n{buffer}");
    }

    let report = save_source(&pool, &mat, &r.notes, &buffer, &buffer)
        .await
        .unwrap();
    assert_eq!(counts(&report), [0; 6]);
    assert_eq!(contents(&pool, &r.notes).await, stored(&r));

    let edited = with(
        &buffer,
        &format!("[[Other#^{theirs}]] ^{block}"),
        &format!("[[Other#^{theirs}]] too ^{block}"),
    );
    save_source(&pool, &mat, &r.notes, &edited, &buffer)
        .await
        .unwrap();
    let mut expected = stored(&r);
    expected[1] = format!("{} too", expected[1]);
    assert_eq!(contents(&pool, &r.notes).await, expected);
    mat.shutdown();
}

/// A copy writes the refs and embeds as Obsidian's, naming the page a ref to
/// the copy's own page points into, and a paste reads them back as the refs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_copied_block_ref_pastes_back_as_the_ref() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = refs(&pool, &mat).await;
    let dest = dup_page(&pool, &mat, "Dest").await;
    let anchor = dup_child(&pool, &mat, &dest, "anchor").await;
    settle(&mat).await;

    let copy = get_blocks_source_inner(&pool, r.blocks.to_vec(), false)
        .await
        .unwrap();

    let (own, theirs) = (&r.own, &r.theirs);
    assert_eq!(
        copy,
        format!(
            "see [[Notes#^{own}]] and [[Other#^{theirs}]]\n\n![[Notes#^{own}]]\n\n\
             ![[Other#^{theirs}]]\n"
        )
    );
    let pasted: Vec<_> = paste(&pool, &mat, &anchor, paste_text(&copy))
        .await
        .into_iter()
        .filter_map(|row| row.content)
        .collect();
    assert_eq!(pasted, stored(&r)[1..]);
    mat.shutdown();
}

/// The mirror's file writes the refs and embeds as Obsidian's, each target
/// carrying its `^id` in its page's file, and the file imported over its
/// page, as a re-import reads it back, changes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_mirrors_file_writes_block_refs_as_obsidian_links_and_reads_them_back() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = refs(&pool, &mat).await;
    let file_of = |page: BlockId| {
        let pool = pool.clone();
        async move {
            agaric_lib::commands::pages::get_page_file_inner(&pool, page.as_str())
                .await
                .unwrap()
                .text
        }
    };

    let file = file_of(r.notes.clone()).await;

    let (own, theirs) = (&r.own, &r.theirs);
    for written in [
        format!("own block ^{own}\n"),
        format!("\nsee [[#^{own}]] and [[Other#^{theirs}]]\n"),
        format!("\n![[#^{own}]]\n"),
        format!("\n![[Other#^{theirs}]]\n"),
    ] {
        assert!(file.contains(&written), "{written}\n{file}");
    }
    let their_file = file_of(r.other.clone()).await;
    assert!(
        their_file.contains(&format!("their block ^{theirs}\n")),
        "{their_file}"
    );
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
    assert_eq!(result.page_id, r.notes.as_str());
    assert_eq!(result.merged, Some(Vec::new()), "file:\n{file}");
    assert_eq!(contents(&pool, &r.notes).await, stored(&r));
    mat.shutdown();
}

/// A ref to a deleted block stays as stored in the buffer, beside one that
/// is written as a link.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_ref_to_a_deleted_block_stays_raw() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let notes = dup_page(&pool, &mat, "Notes").await;
    let gone = dup_child(&pool, &mat, &notes, "gone").await;
    let kept = dup_child(&pool, &mat, &notes, "kept").await;
    let block = dup_child(&pool, &mat, &notes, &format!("(({gone})) (({kept}))")).await;
    delete_block_inner(&pool, DEV, &mat, gone.clone())
        .await
        .unwrap();
    settle(&mat).await;

    let buffer = page_source(&pool, &notes).await;

    assert!(
        buffer.contains(&format!("\n(({gone})) [[#^{kept}]] ^{block}\n")),
        "{buffer}"
    );
    mat.shutdown();
}

/// Block ids are global, so an anchor-only `[[#^id]]`, as the buffer and an
/// agent's read write a ref to a block of their own page, pasted or appended
/// under another page still names that block, and `![[#^id]]` its embed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_anchor_only_link_pasted_under_another_page_is_the_ref() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = refs(&pool, &mat).await;
    let dest = dup_page(&pool, &mat, "Dest").await;
    let anchor = dup_child(&pool, &mat, &dest, "anchor").await;
    settle(&mat).await;
    let own = &r.own;

    let text = format!("see [[#^{own}]]\n\n![[#^{own}]]\n");
    let pasted: Vec<_> = paste(&pool, &mat, &anchor, paste_text(&text))
        .await
        .into_iter()
        .filter_map(|row| row.content)
        .collect();

    assert_eq!(
        pasted,
        [format!("see (({own}))"), format!("{{{{embed (({own}))}}}}")]
    );
    mat.shutdown();
}
