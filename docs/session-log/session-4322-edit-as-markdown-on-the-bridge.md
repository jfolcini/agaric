# Session 4322 — Edit as Markdown on the bridge

Slice 6 of #6926: the Edit as Markdown specs move onto the headless bridge (#6529), and their eight WebdriverIO specs are ported into `e2e/page-source-edit.spec.ts` and deleted.

**Promoted to `REAL_BACKEND_SPECS`:** `page-source-edit`, `keyboard-chords-page`, `typed-anchor-links-6033`. All 37 of their tests passed on the bridge three times before any port; none needed `@mock-only`.

**Ported:**
- `page-source-edit`: deleted as a duplicate. Its reorder, edit and delete in one save are the twins *an edited line, a paragraph added with Enter and a moved paragraph persist* and *Ctrl+S saves, and the report lists what the save deleted*, now on the bridge.
- `page-source-merge`: the Merge test re-opens the page and checks both edits are stored once each.
- `page-source-paste`: a paragraph cut and pasted elsewhere moves its block with its child; a paragraph copied and pasted is a new block beside the original. The paste from another page's buffer was already a test.
- `page-source-property-lines`: a `key::` line sets, edits and, left empty, deletes the property; a refused `repeat::` rule blocks the save, names its line and writes nothing.
- `page-source-document`: a page of every kind of block, pasted into the buffer, is stored as those blocks; saving it again with only a blank line added appends no op (`list_page_history` unchanged); `-` restyled `1.` saves numbered and joins the run.
- `heading-link-obsidian`, `block-ref-obsidian-link`, `link-label-source-roundtrip`: the buffer writes `[[Title#Heading]]`, `[[Title#^id]]` and `[[Page|label]]`, and saves them back as the same ref or label. Only the backend writes names in the buffer (the mock keeps raw ids, as the three fail there), so they are tagged `@real-only` (#6926 G2).

**Also ported:** the Created date test that slice 2 (#6928) left in `e2e-tauri/references-filters.e2e.ts`, now `@real-only` in `e2e/references-filters.spec.ts` (the mock's ids carry no time), and that WDIO file is deleted. From #6928's review: the #5365 test's comment no longer says the Pages filter reads a materializer copy (it globs the block's own title), and the `filter.fill('')` it questioned says why it is there (`openPage` clicks the title in the Pages list, which the filter would still narrow).

`pasteText`, which nine specs each define, is now in `e2e/helpers.ts` for this file; the other copies are untouched.

**Shown red on the bridge**, each at the predicted assertion: property deletions dropped (the emptied line's property still in the buffer), every property re-set on save (history grew by 72 rows), `repeat` not validated (no refusal), the buffer read as `PageRead::Duplicate` (raw ids in all three name tests), a moved block placed last (cut order), a created block appended (copy order). Swapped Created date bounds (0 of 3, not 3 of 3). A move placed at slot 0 did not redden the cut test, because the pairing moves the other block there; that break was replaced. The Merge test's added re-open was not shown red on its own.

**Ran**, rebased on main with G2's `@real-only` (#6929):
- the three files plus `references-filters` and `rename-invalidation` on the bridge, three times: 55 passed each time;
- the same five plus `link-labels` and `page-mode-markdown-switch` (headers edited) on the mock, which skips `@real-only`, two repeats: 110 passed;
- `npm run typecheck`.
