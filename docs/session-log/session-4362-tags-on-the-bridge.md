# Session 4362 — tag and property specs on the bridge

Slices 1, 4 and 5 of #6926, one commit each, with the #6967 fix before slice 4.

## Slice 1: tags

The tag specs move onto the headless bridge (#6529), and five WebdriverIO specs are ported into them or deleted.

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

## #6967: the refusal toast's "Validation error: " prefix

Promoting `properties-system` showed it. *Counts live uses, and a trashed one still blocks the delete* failed on the bridge every run: the refusal toast began "Validation error: Can't delete 'stage'…". An uncoded validation error keeps that display prefix in `message` on the wire; `AppError`'s `Serialize` does it on purpose and pins it. `formatErrorForDisplay` strips it, but `reportIpcErrorWithReason` and `PropertyDefinitionsList`'s in-use refusal showed the raw message. The mock throws the bare reason, so only the bridge showed it.

Both call sites now go through `formatErrorForDisplay`, as `useSpaceMove` does. The mock's uncoded rejections still omit the prefix, but the UI now renders both lanes the same. The `report-ipc-error` test's fixture carries the wire's prefix. Showing the raw message again reddens it at the stripped toast. The bridge test passes 3 of 3.

## Slice 4: properties, part 1

**Promoted:** `property-def-undo`, `property-key-rename`, `property-type-change`, `properties-table-and-refusals`, `property-unfit-marks`, `property-unfit-values`, `properties-system`. All 37 of their tests passed on the bridge three times, except the #6967 test.

**Deleted as duplicates:**
- `property-key-rename`: twin is *a rename moves the definition and its values to the new key*.
- `property-option-rename`: twin is *renaming an option renames the values blocks hold, and Undo takes it back*.
- `property-unfit-values`: twin is *Remove takes them off, and the toast's Undo puts them back*.

**Ported, then deleted:**
- `property-type-change` → `property-type-change.spec.ts`: a text key holding `3` and `plum`, changed to number, previews one value converted and one that doesn't fit. Afterwards `get_properties` reads `3` as a number and `plum` as text, and the chips show both.
- `property-list-type-change` → the same file: `Ann, Bob` split at commas is stored as the list of `Ann` and `Bob`. The toast's Undo stores the text again, and the key is listed as text after leaving Settings.
- `property-defs-per-space` → `properties-system.spec.ts`: `size` is a number in Personal and text in Work. The same `size:: plum` line becomes a property in Work and stays as text in Personal, with its toast. Both hold after reopening.

**Shown red on the bridge**, each by one break and a rebuild:
- `coerce` refusing every text-to-number conversion: the preview read 0 converted.
- The type change recording the converted value as its `prior`: the Undo left the list.
- `block_property_declaration` reading Personal's definition for every block: Work refused `plum`.

Two breaks did not redden the number test. With `type_change_writes` writing nothing, the conversion still landed through `reproject_key_values`; skipping the reprojection alone, the value writes made it. Each path covers the other, which is why the coercion they share is the break that shows. Writing nothing did redden the list test.

**Ran:** the seven files on the bridge, three times after the fix: 41 passed each time; on the mock, two repeats: 82 passed.

## Slice 5: properties, part 2

**Promoted:** `property-change-refresh`, `property-datetime`, `property-list-drawer`, `property-picker`, `property-ref-boolean-chips`, `property-types-happy-paths`, `slash-command-properties`, `backend-error-language`. All 25 tests passed on the bridge three times before any port.

**Ported, then deleted:**
- `property-list-copies` → `property-list-drawer.spec.ts`: a block holding a text list, one item with a comma, and a ref list keeps both through Duplicate and through `/template`, the ref item by block id. The ref target is a seeded page: the mock's minted ids are not ULIDs, and it refuses them as ref items.
- `slash-repeat-remove` → `slash-command-properties.spec.ts`: `/repeat remove` takes the rule off, so a completion makes no next occurrence. On a task limited to one occurrence, removing the rule takes the limit and the count with it, so a rule set again makes the next occurrence. Completions go through `set_todo_state`, which makes the next occurrence itself.
- `reserved-property-roundtrip` → `property-ref-boolean-chips.spec.ts`: a TODO set from the block menu is stored and still a task after navigating away and back. Its ref-property case was already *a ref chip shows its page renamed after navigating away and back*.
- `escape-property-line` → `properties-table-and-refusals.spec.ts`: its control (Escape on a blank block an Enter made drops it) now sits beside its two twins there and in `property-picker`.

**Ported, kept in `e2e-tauri/`:** `ref-property-title-follows-rename`'s bug class (#6427): an open ref property's label follows a title that reaches the resolve cache after mount. On the bridge the title resolves after the property table mounts, so *an open ref property shows its target's title once it resolves* covers it. An IPC rename from the test sends the frontend no change event, so the agent's rename needs MCP. The WDIO file stays until the smoke lane's MCP spec takes it.

**Shown red on the bridge**, each by one break:
- `repeat` refused as a system-managed key: no "Repeat removed", in both tests.
- The rule's bounds kept: the second test's next occurrence still held `repeat-count` and `repeat-seq`.
- A quoted list item read without its quotes: the copy held `"review` and `final"`.
- `/template` dropping `value_list`: the insert itself failed (no "Template inserted"), not the lists check.
- `set_todo_state` storing null: `get_block` read no state.
- The empty-block cleanup skipping content blocks: the blank block was not deleted.
- `RefEditor` reading the title without subscribing (#6427 reverted): the label showed the raw `[[id]]`.

The first Duplicate break, no `note_list` write-back, did not redden: that path carries lists of keys nobody declared, and this test's keys are declared.

**Ran:** the eight files plus `properties-table-and-refusals` on the bridge, three times: 40 passed each time; on the mock, two repeats: 80 passed after the ref-target fix; `npm run typecheck`.
