# Session 4061 — A pinned PDF comment becomes a block, and three follow-ups to the highlight slice

The rest of #6629 after its first slice (#6682, session 4039): the pinned-comment checkbox, the two reviewer notes on #6682, and that slice's known gap. One PR, one commit per item.

**What shipped.**

- **A pinned comment becomes a block.** *Save* reads pdf.js's new FreeText editors beside its new highlights (`newAnnotations` in `src/lib/pdf-highlights.ts`): the comment's words are the block's text, `pdf_boxes` holds the one box it is pinned in, and the rest is the highlight path unchanged. Made on Save, as highlights are, for the reason session 4039 gives. The helpers that now serve both kinds are renamed from `…Highlight…` to `…Annotation…`.
- **One Rust const for the three keys.** `PDF_PLACE_KEYS` in `agaric-store/src/op.rs` feeds `is_internal_property_key` and `drop_pdf_places`. `INTERNAL_PROPERTY_KEYS` no longer lists them, so the TS parity test compares against both consts.
- **Undo goes to the owner's page.** The reader also opens from a block's source chip, which can sit on another page than the PDF's owner. Save recorded the new blocks and the link edit on the chip's page, so Ctrl+Z there removed blocks on another page. The entries now go to the owner's page when a store for it is mounted (`getPageStore`), and are not recorded when it is not; the link edit then calls `edit_block` directly.
- **The re-point reads every space.** A block moved to another space kept naming the attachment the Save deleted. `repointAnnotationBlocks` now takes the ids of every space the device lists, plus the active one by its own id, since `availableSpaces` can be empty after a failed refresh while `currentSpaceId` is restored.

**Traps.**

- `SpaceScope` has only the `active` kind, so "every space" is one `query_by_property` per space.
- The owner's page comes from the rows the writes return (`create_blocks_batch`'s blocks, `get_block`), so fixtures that returned no rows or a row with no `page_id` had to become real rows.
- The parity test reads `op.rs` by regex for quoted strings, so the list cannot spell its entries as `PDF_PLACE_KEYS[0]`.

**Falsified.** Disabling the FreeText branch reddened the unit test and three e2e tests on the comment's block. For the undo item: using the reader's store always, dropping the owner store's reload, and dropping the `unwrap` on the direct edit each reddened its own test. For the spaces item: without the fix the e2e read the first copy's id on the moved block; dropping `availableSpaces`, and reading only the first space, each reddened a unit test.

**Ran.** Full vitest, typecheck, lint, knip, the manual-stage prek hooks, `cargo check --workspace --all-targets` offline, `cargo fmt --check`, clippy over the workspace, the whole nextest workspace in two halves, and the Playwright specs `e2e-related` selects. Of those, `page-mode-setting`'s phone test failed once under load and passed alone, and `diagram-legibility`'s two tests failed on the container's older Chromium, the case `docs/BUILD.md` names; neither was compared against `main` here. The real-backend lane was left to CI.
