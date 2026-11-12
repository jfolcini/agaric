# Session 3934 — Review notes from #6603

#5363: the notes #6603's review left for a follow-up. #6611 and #6612 left none open. Each note's premise was checked against `origin/main` (2854e1a) first, and each still held.

## The notes

- **A save's copy links are placed before it is read in.**
  - Checked: `try_write_page` built the links from the render's attachments alone, and `read_edit` passed them to the ingest, which writes the file back through `Links::localize`.
  - The failure: with copying on, a page's file saved with a link to a copy of an attachment the page did not link read in as that attachment, but was written back as `attachment:<id>`. The next tick turned it back into the copy link, so an editor holding the file saw it rewritten twice.
  - The fix: the edit branch places the attachments the render or the save links (`assets::copy_linked`) and hands those links to `read_edit`. `localized`, then a one-line wrapper with one caller, is inlined.
- **`kept_copies`'s doc** said "no longer wanted". Since #6603 every changed copy is listed, wanted or not; the comment says so.
- **`sweep_copies`'s doc** said only that copies are removed "each only while unchanged". It now also says that every changed copy, wanted or not, is listed as kept.
- **Docs:** `docs/architecture/data-and-events.md` (*Copies*) says which copies the write-back links.

## Tests

- **Rust (`src/mirror/assets_tests.rs`):** `a_save_linking_a_copy_its_page_did_not_link_keeps_that_link`. Page Beta's file is saved with a link to Alpha's image copy. Two ticks later the block holds the attachment's link and the file still holds the copy link.
- **Red first:** on `origin/main`, it failed on the file assertion, with `attachment:<id>` where the copy link was saved. The block assertion passed.
- **Falsified:** with the save's ids dropped from the union, in one command that restored the file, it failed on the same assertion.
- **Results:**
  - `cargo nextest run -p agaric --lib -E 'test(/mirror/)'`: 122 passed;
  - `cargo clippy --workspace --all-targets -- -D warnings`: clean.
