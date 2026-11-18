# Session 4362 — tag specs on the bridge

Slice 1 of #6926: the tag specs move onto the headless bridge (#6529), and five WebdriverIO specs are ported into them or deleted.

**Promoted to `REAL_BACKEND_SPECS`:** `nested-tags`, `tag-management`, `tag-name-whitespace`, `tag-page-tagged-items`, `tags-query-modes`, `tags-and-links-happy-paths`. `tags-lifecycle` was already listed. Before any port, all 37 tests passed in each of three bridge runs; none needed `@mock-only`.

**Deleted as duplicates:**
- `tag-roundtrip`: twin is *switching back lists that space, and a delete purges only its tag* (`tags-lifecycle`).
- `tag-search-under`: twin is *expands a tagged block, and searches everything under the tag* (`tag-page-tagged-items`).

**Ported, then deleted from `e2e-tauri/`, into `tags-lifecycle.spec.ts`:**
- `tag-usage-rename`: a tag referenced inline in a block counts 1 in the Tags list. Renamed, the list shows the new name with the same count after leaving the view and coming back, and the block's chip reads the new name.
- `space-scoped-tag`: a tag created from the `@` picker in Work is listed in Work, not in Personal, and in Work again after switching back. `list_all_tags_in_space` agrees.
- `batch-add-tag`: the Pages batch toolbar tags three selected pages. Each one, reopened, shows the chip, and `list_tags_for_block` returns the tag.

**Ported, kept in `e2e-tauri/`:** `tag-color-synced`'s navigation half is now a test in `tag-management.spec.ts`. A colour picked in the Tags view survives `localStorage` being cleared and the view being left, and the tag's `color` property holds it. The WDIO file stays: its restart half moves into smoke spec 7 (`editor-durability`) in the smoke-lane slice.

**A test bug the bridge showed, fixed:** `tags-and-links-happy-paths`' tag composer test failed once in three runs, and 2 times in 40 under 8 workers. `activePopover` is the last popover in the DOM, and the beta popover's exit animation kept it there while the gamma popover opened. The test typed into the closing popover; that took focus from the gamma popover, which closed, and the beta one then unmounted with the button. `addTag` now waits for its popover to be gone. After: 80 of 80 under 8 workers.

**Shown red on the bridge**, each by one break and a rebuild:
- `add_tags_by_ids` tagging only the first page: the toast read 1 page, not 3.
- `create_tag_in_space` filing every tag under Personal: the Work Tags list never showed it.
- No `RebuildTagsCache` on a tag-block edit: the list never showed the renamed tag.
- The tag colour written under `colour`: the property read was empty.

Two of those breaks did not reach the check I expected:
- The colour break did not redden the badge check after navigation, because the resolve store keeps the synced colour in memory. Only the property read and a restart show a lost write.
- The rename test's chip check was not shown red on its own.

**Ran:**
- the seven files on the bridge, three times after the fix: 41 passed each time;
- `tags-lifecycle` and `tag-management` on the mock, two repeats: 52 passed;
- `tags-and-links-happy-paths` and `tag-suggested-properties` on the mock, two repeats: 10 passed;
- `e2e-tauri/visibility-probe.test.ts`;
- `npm run typecheck`.
