//! Fuzz target (#5363): the Markdown mirror's read of a file edited outside
//! Agaric, over arbitrary bytes.
//!
//! The mirror reads whatever another tool saved into its folder: any bytes,
//! with `^ID` anchors in any place. Before the save, `ingest::ingest` runs
//! them through pure steps that must never panic, since a panic in the
//! mirror's task ends it: `file_text`, `anchor_free_kept` (strips the anchors
//! by line arithmetic), `pair_unanchored_lines` (pairs each line with a block
//! of the text last written), and, on the way back out, `splice::splice`. The
//! save itself, `apply_page_source_inner`, needs a database and is covered by
//! the mirror's proptests; the grammar under all of these is `import_parse`'s.
//!
//! The input is the text last written, a NUL, then the file's bytes. The text
//! last written gives an id to every line that starts a block, as the
//! mirror's render does, and keeps its own anchors.
//!
//! Run: `cargo +nightly fuzz run mirror_ingest`.

#![no_main]

use std::collections::HashSet;

use libfuzzer_sys::fuzz_target;

use agaric_lib::commands::pages::{anchor_free_kept, pair_unanchored_lines};
use agaric_lib::mirror::ingest::file_text;
use agaric_lib::mirror::splice::splice;

/// A ULID-shaped id for line `n`, uppercase as block ids are.
fn line_id(n: usize) -> String {
    format!("01J{n:023}")
}

fuzz_target!(|data: &[u8]| {
    let Some(split) = data.iter().position(|b| *b == 0) else {
        return;
    };
    let (written, file) = (&data[..split], &data[split + 1..]);
    let Ok(written) = std::str::from_utf8(written) else {
        return;
    };
    let written_ids: Vec<Option<String>> = written
        .split('\n')
        .enumerate()
        .map(|(n, line)| line.starts_with(|c: char| !c.is_whitespace()).then(|| line_id(n)))
        .collect();
    let Ok(text) = file_text(file) else {
        return;
    };

    // As `ingest::ingest` reads the file against the text last written.
    let (free, _, kept) = anchor_free_kept(written);
    let free_ids: Vec<Option<String>> = kept
        .iter()
        .map(|&line| written_ids.get(line).cloned().flatten())
        .collect();
    let (edited, anchors, kept_lines) = anchor_free_kept(&text);
    let known: HashSet<&str> = written_ids.iter().flatten().map(String::as_str).collect();
    let anchors: Vec<Option<String>> = anchors
        .into_iter()
        .map(|id| id.filter(|id| known.contains(id.as_str())))
        .collect();
    let line_ids = pair_unanchored_lines(&free, &free_ids, &edited, &anchors);
    assert_eq!(line_ids.len(), anchors.len(), "one id slot per edited line");

    // The write-back's splice, over the ingest's ids: `write_back` pairs them
    // again against the render first, which needs the save this target skips.
    let mut ids = vec![None; text.split('\n').count()];
    for (line, id) in kept_lines.iter().zip(line_ids) {
        if let Some(slot) = ids.get_mut(*line) {
            *slot = id;
        }
    }
    let (spliced, spliced_ids) = splice(&text, &ids, written, &written_ids);
    assert_eq!(
        spliced.split('\n').count(),
        spliced_ids.len(),
        "one id slot per written line"
    );
});
