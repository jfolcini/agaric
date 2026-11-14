# Session 4198 — a property can hold a list: defining and editing (#6741, PR 2 of 4)

The second of the four pull requests in the design the maintainer approved on #6741 ("Design for option 3 (a list value in the one row)"), on top of PR 1 (#6796, session 4189). This one makes a list reachable: a user can declare a key that holds several values, turn a key into a list or back, and edit, type, copy and review its items. No new migration, table, op type, store, queue, sync message or engine format change.

## What shipped

- **Defining.** "Holds several values" in Settings › Properties' create form and the page Properties table's *Create definition*, for every type but boolean; a list definition reads "select · several values". The space file (`export-graph.ts`, `vault-import.ts`) carries `multiple` when it is set.
- **Change type…** to and from a list. `preview_property_type_change`, `list_property_type_change_values` and `change_property_type` take `multiple` and a `ListSeparator` (`comma`, `semicolon` or none). One rule (`ConversionRule::convert`) serves preview, list and write: a text splits into items at the separator, or is one item; a list joins into a text or a URL with the separator; a one-item list becomes its item; a list converts to another item type when every item does. The dialog previews nothing until a separator is chosen, because splitting `Doe, Jane` at commas makes two people.
- **Don't fit.** Under a list key a value fits as a list whose items the write check takes; a list under a key of one value, or one value under a list key, doesn't. Remove, Convert (the replacement is read as a list), Move (a list only to a list key it fits) and Add to options (a multi-select's missing items) take lists. The frontend's `property-fit.ts`, the inline chip's mark and the page table's row read the items.
- **Editing.** `ListEditor` in `PropertyRowEditor`: one chip per item with a remove button, and an add control of the item type (text, number, date, the options not yet held, the page picker). The drawer and the page table send a list key there, not through `EditorSlot`, which the query table cell shares (PR 3). Removing the last item deletes the property; adding a list key from a definition opens a draft that its first item writes.
- **One line of text.** A list is `key:: a, "b, c", [[Page]]`: `splitListItems` / `joinListItems` in TypeScript, `property_list_items` / `write_property_list` in Rust. Typed in a block, Edit as Markdown and Duplicate read and write it; under a key of one value the line is one value as before.
- **Copies.** Duplicate (through its buffer), templates (`create_blocks_batch` carries `value_list`) and a key renamed from its chip carry a list. `set_property` resolves each item of a ref list as it resolves a single typed ref.
- **MCP and History.** The `set_property` and `batch` tools take `value_list`; the summary and the history read show the items. History's view shows a list op's items.

## Decisions and traps

- **The lanes.** Three builders in parallel, each in its own tree: the backend with the mock and fixtures, the definitions and type-change UI, and the editing UI. They built to one written contract. The backend builder stopped on a usage limit before the mock twins; a second builder finished them and reviewed the inherited diff, fixing five clippy errors it had left.
- **The preview shows a list as its line of text**, quoted, so "Don't split" (`["Ann, Bob"]`, shown `"Ann, Bob"`) reads differently from a split (`Ann, Bob`).
- **A list item that leaves a `[` open is quoted**, or it takes the next comma with it. Rust's writer had the rule; the TypeScript twin gained it at integration.
- **The typed ref list's titles are resolved once, by the backend.** The editing lane had resolved them in the frontend before `set_property` learned to; that copy was deleted.
- **A list's fit mark needs its items.** The page table's row and the inline chip called the one-value check without them, so every list under a list key read as not fitting. Fixed at integration and pinned by two tests.
- **Shared scratch files collide.** Two builders used the same falsification backup name in the shared scratchpad, and one restore overwrote two of the other's files with the wrong contents. They were recovered from the main checkout and re-run, and each builder then kept its own scratch folder.
- **File import splits too.** It shares `PropertyLines` with Edit as Markdown, so a `key::` line under a declared list key imports as a list. YAML lists, bibliography authors and export stay PR 4's.

## Existing assertions edited

- `property_list_cmd_tests.rs`, `each_item_is_held_to_the_definitions_type_6741`: a ref item that is not an id is now resolved as a title, so `"not a block id"` and a lowercase id are refused with `no page is titled …` instead of `expects a list of 'ref'`.
- `AddPropertyPopover.test.tsx`: `onCreateDef` takes `multiple`, so `('newfield', 'text', null)` and `('homepage', 'url', null)` became `(…, null, false)`.
- `export-graph.test.ts`: the space file's expectation gained a list definition.
- `BlockInlineControls.test.tsx`: its `PropertyChip` mock exposes `unfit` as `data-unfit`.

## Left for the later PRs

PR 3: the any-item rule in filters, the value typeahead, grouping, the query table cell and sort, the board and References sort. PR 4: YAML lists in and out, bibliography authors, ZIP and the mirror, `docs/features/import-export.md`'s list rows and the comparison documents' *Properties* and *Multi-value* rows. An undo that restores a multi-select list after one of its options was renamed still keeps the old option name (session 4189).

## Checks run

- Whole-workspace nextest in two partitions: 4148 and 4143 passed, none failed. `cargo test --doc --workspace` passed.
- `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --check`: clean. `scripts/clippy-sqlx-check.sh`: the cache matches.
- Conformance on both sides, with three new backend-authored fixtures: `property_type_change_list`, `property_unfit_list`, `property_list_lines`.
- `npm run typecheck` and `npm run typecheck:e2e-tauri`: clean. Full vitest: see the PR.
- Playwright on the mock: the new `property-list-drawer.spec.ts` and the property, template, history and space-move specs.
- `e2e-tauri/property-list-type-change.e2e.ts` and `property-list-copies.e2e.ts` typecheck but were not run here: the box has no tauri-driver. CI's WebdriverIO lane is their first run.

## Falsification

One mutation per shell command: back up, trap a restore, mutate once, confirm with `! cmp -s`, run. Every new test reddened at the assertion its case predicted.

- **Line of text.** Each rule of `splitListItems`, `joinListItems` and the Rust twins (comma depth, quotes, blanks, the quoting set, the open bracket) is killed by its own test, both sides.
- **Type change.** The separator, the empty-list rule, the text/URL join guard, the flag-only change, whole-or-nothing item conversion and the quoted display are each killed by `property_list_edit_cmd_tests` and the `property_type_change_list` fixture; the dialog's separator gate, join-only-for-text, boolean, the reset on open and the arguments sent by `ChangePropertyType.test.tsx` and `TypeChangeValues.test.tsx`.
- **Don't fit.** Each list rule in `unfit_values`, add-to-options, convert and move is killed by its command test and `property_unfit_list`; `property-fit.ts`'s by `property-fit.test.ts`; the row and chip marks by `ListEditor.test.tsx` and `BlockInlineControls.test.tsx`.
- **Lines, copies, MCP.** Number items as text, ref items as ids, the unchecked save, unresolved ref names, the first item only, a dropped batch list, rename and merge dropping the list, and each MCP path are each killed by their Rust test and `property_list_lines`.
- **Editing UI.** Each branch of `ListEditor`, the draft row, the routing in the drawer and `PropertyRowEditor`, the chip's list branch, `extraPropertiesOf`, `propertyRowEqual`, the typed split, the number and date items, the template spread, the rename flag and the history join are each killed by their vitest test. `property-list-drawer.spec.ts` went red once with appends broken and once with the checkbox ignored.
- **Mock.** Twelve mutations of the mock's list paths each reddened their fixture. Two first survived (the join guard, the list-line pre-check), and the fixtures were strengthened until they did not.
