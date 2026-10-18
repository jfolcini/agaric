# Session 2571 — Page mode gets the slash menu and the `::` and `{{` pickers

Slice 8 of #5743, after the queries and embeds slice (#5844). It closes the
last editing difference on the issue's list ("The slash menu, and the `::` and
`{{` pickers"), and the Dates note. That note said clearing a date and adding
one to an undated block were still to come. `/due` and `/schedule` now add one,
and the property drawer, in page mode since #5822, clears one.

**Premise check.** Every block-mode command, the handler that runs it, and
what page mode does with it:

| Command | Block mode | Page mode |
| --- | --- | --- |
| `todo` `doing` `done` `cancelled` | `set_todo_state`, the page store; `done` reloads a repeating task | (b) after the save, on the caret's block; the checkbox reads the store |
| `priority-*` | `set_priority`, the page store | (b) likewise; the badge |
| `date` | the picker, then a date page's link at the caret | (a) at once, as `Ctrl+Shift+D` |
| `due` `schedule` `repeat-until` | the picker on the focused block | (b) the picker opens on the command's block (`openDatePickerFor`); an until date is read again after the pick |
| `effort-*` `assignee-*` `location-*` `repeat-*` `repeat-limit-*` | `set_property` / `delete_property` | (b) after the save; the page is read again, so the chips show it |
| `assignee` `location`, the *Custom…* presets | the property drawer | (b) page mode's drawer, on the block |
| `attach` `voice` | the file dialog, the recorder | (b) after the save; the attachment's invalidation reads the page again |
| `link` `block-ref` `tag` `embed` | insert `[[`, `((`, `@`, `{{embed ` at the caret | (a) at once, in the document |
| `bold` `italic` `code-mark` `strike` `highlight` | a stored mark at the caret | (a) at once |
| `code` `quote` | toggle the node at the caret | (a) at once |
| `emoji` `table` | a dialog or grid that inserts at the caret | (a) at once, block mode's dialog and grid |
| `h1`–`h6` `callout` `callout-*` `divider` | rewrite the block's text with `edit_block` and remount | (b) the same handler, the text rewritten in the document (`blockText`) |
| `turn-*` | that rewrite, then `listStyle` | (b) the rewrite in the document, after the save for the style |
| `numbered-list` `bullet-list` | `listStyle` | (b) after the save; the marker shows from the read after |
| `query`, `{{` *Insert query…* | the builder; Save writes `{{query …}}` | (b) the builder on the block; Save through page mode's `saveQuery`, as the results' edit |
| `duplicate` | copies the block's subtree through the store | (c) not offered |
| `template` | inserts a template's blocks through IPC, then focuses one | (c) not offered |
| `::` | inserts `key:: `; the line is committed as the block is left | (a) page mode commits the line on leave (#5822) |
| `{{embed …` | a picker of pages and blocks | (a) the same list |

(c) is absent from page mode's menu: those commands add blocks through the
store, outside the document, which owns the page's structure there. The menu's
"Recent" band is filtered the same way.

**Design.**
- One handler per command. `useSlashHandlers` is the merged table of the four
  sub-hooks, the template's aside, and `runSlashCommand` records the MRU and
  dispatches. Block mode calls both, and so does page mode
  (`page-slash-commands.tsx`), with the caret's block as `blockId`.
- The one seam in block mode's handlers is `SlashCommandContext.blockText`. A
  content command reads the block's text and writes it back there, in place of
  the editor's whole document and `edit_block`. Block mode leaves it out.
- A command that writes to the block, or opens what writes to it, runs through
  page mode's `afterSave`. That makes a save that creates the block (`keep`, so
  a block holding only `/todo` is created empty), then runs the handler, then
  reads the page again. This is the same chain the checkbox and the chips use.
  Only the document-only commands (`runsInDocument`) run as picked: a mark
  needs the caret as it is, and a link should open its picker without waiting.
  An unknown future command gets the safe default.
- Block mode's property handlers call `flushActiveDraft` first, which is page
  mode's flush: queued behind the very step running the handler, it waited
  forever. While a change after its save runs, that flush resolves at once,
  since the save it asks for has just run.
- `useBlockDatePicker`'s `openDatePickerFor` takes any mode, so `/due`,
  `/schedule` and `/repeat-until` open the picker on the command's block, as a
  chip opens it on the chip's.
- `embedTargets`, the `{{embed ` list, moved out of the roving editor so both
  editors build the same one.
- The pickers sit where block mode's do: after the chips, ahead of
  `PageRenderedKeys` (priority 99), so an open menu keeps its arrows.
  `pickerOpen` (`page-keys.ts`) now names the three, so page mode's Enter, Tab,
  Backspace and Escape, and the list keys, leave them to an open menu.
- The dialogs are block mode's `BlockTreeDialogs` (builder, emoji, voice) and
  `BlockTablePicker`, mounted by page mode.

**Found on the way.** axe flags the slash menu itself, in block mode too:
`aria-required-children`. A listbox owns options and groups of options, and the
category `<h3>` and the `<hr>` between groups sat inside it. Each category now
names its `fieldset` group (`aria-labelledby`), with the label and the rule
drawn only (`role="none"`). The test that pinned the `<h3>`, and the block-mode
Recent-band spec that read it as a heading, now read the group's name.

**Tests, each shown red first by a one-command mutation (backup, `trap`,
`! cmp -s`):**
- vitest `PageModeEditor.test.tsx`, a `slash menu and pickers` describe:
  - `/` opens the menu without `duplicate` and `template`, and the editor
    becomes the combobox, with axe on the page and on the popup. Red three
    times: no pickers (no listbox), the set not filtered (`DUPLICATE`
    offered), and the list's `<h3>` back (`aria-required-children`).
  - Escape closes the menu, writes nothing and keeps the focus; Enter picks
    and splits no block. Red: `pickerOpen` without the slash key (the listbox
    stayed open).
  - `/doing` on a block and `/todo` on a new, empty one: the backend holds the
    state and the checkbox shows. Red: every command run at once (the empty
    block is never created; `block … not found`).
  - Refused `set_todo_state` and `set_property`: block mode's toasts, and
    nothing shown. Red: the task-state toast silenced.
  - `/effort` then `EFFORT 1h`, and `/numbered`: the chip and the marker show.
    Red twice: no read after the command.
  - `/due` dates an undated block through block mode's picker, and the drawer
    clears it. Red: the picker opened without the command's block (no date
    written).
  - `/h2` and `/bold` edit the document, the save writes them, and neither
    reads the page. Red twice: no `blockText` seam (`['first', 'second ']`),
    and `/bold` run after a save (a read: 2, not 1).
  - `::` lists the keys, and the pick is a `key:: ` line that becomes the
    property once left; `{{` opens the builder, whose Save is the block's
    query, whose results show once left. Red: the two pickers left out.
  - A command typed after text, with page mode's flush registered: the text
    and the priority are written. Red: no re-entrancy guard (the priority
    never written).
- `SuggestionList.test.tsx`: each category names its group, with axe. Red: the
  `<h3>` back.
- Playwright `page-mode.spec.ts` replaces "`/` and `::` are plain text":
  - Escape closes the menu with no write; `/todo` by Enter, with axe on the
    open popup; `/due` on an undated block through the picker; the drawer
    clears another block's date. After away, back and Page again, the
    checkbox and chips, the backend's rows and its text are as left. Red
    twice: `pickerOpen` without the slash key (the menu stayed after Escape),
    and the `<h3>` back (`aria-required-children`).
  - `::assi` gives an `assignee:: Ana` line that becomes the chip once left;
    `{{` then *Insert query…* opens the builder, and the query
    (`{{query type:tag expr:work}}`) shows four results once the caret
    leaves. Both still there after away and back. Red: the pickers left out.
  - Parity: `/todo` and `/h2` on two blocks in block mode and on the same
    two in page mode leave the same rows (`buy milk ` TODO, `## call mom `).
    Red: no `blockText` seam (`call mom `).
- e2e-tauri: none. Each write is one command the mock's conformance fixtures
  pin (`set_todo_state`, `set_priority`, `set_due_date`, `set_property`,
  `edit_block`), on the chain the checkbox and chips already run against the
  real backend (`page-mode-attachments.e2e.ts`). The `::` line is #5822's
  commit, and the query's results are #5844's.
- fast-check: not extended. #5721's property drives a bare editor with no
  pickers (`commands` left out), and the commands run block mode's handlers.

**Measurement.** `AGARIC_PERF=1 AGARIC_PERF_REPEATS=5 e2e/perf.spec.ts -g
'page mode'`, sizes held to 500, unthrottled, median [min–max], page mode's
column. The baseline is origin/main's `src` swapped in, and runs alternated in
one session on a machine other sessions loaded:

| Run | Build | Load average | Worst frame while opening | Key to paint, p50 |
| --- | --- | --- | --- | --- |
| 1 | without | 7.9 → 14.8 | 118 [94–767] ms | 8.2 [7.0–39] ms |
| 2 | with | 16.4 → 7.6 | 88 [78–114] ms | 7.7 [6.9–8.6] ms |
| 3 | without | 7.3 → 3.4 | 91 [73–108] ms | 7.9 [6.2–8.7] ms |
| 4 | with | 3.0 → 27.1 | 101 [97–877] ms | 8.8 [6.5–43] ms |
| 5 | without | 28.1 → 39.1 | 451 [254–968] ms | 29 [24–32] ms |
| 6 | with | 16.0 → 19.7 | 133 [113–546] ms | 10 [8.9–41] ms |
| 7 | without | 20.9 → 7.8 | 117 [89–143] ms | 7.9 [7.6–9.6] ms |

No difference shows outside the bands. Run 5 is the machine, not the build:
load rose to 39 while it ran, and block mode's column moved as much. The
quietest pair, runs 2 and 3, is 88 against 91 ms and 7.7 against 7.9 ms.

Closed, each of the three pickers costs what each of the `[[`, `#` and `((`
pickers already there costs, as in block mode: TipTap's `Suggestion` state
runs one regular expression over the text node before the caret on each
transaction with an empty selection (`findSuggestionMatch`, read in
`@tiptap/suggestion`).

**Gates:** vitest over `src/editor src/components/block-tree
src/components/editor src/stores` (217 files, 7,196 passed) and `src/lib
src/components src/hooks` (770 files, 17,513 passed). Also `npm run typecheck`,
`npm run typecheck:e2e` and `npm run lint`, with no warning in a touched file.
Playwright on a private port (143 tests): `page-mode`, `page-mode-setting`,
`block-ref-picker`, `callout-picker`, `emoji-picker`, `picker-happy-paths`,
`property-picker`, `query-blocks`, `query-hint`, `slash-command-properties`,
`slash-commands`, `slash-commands-coverage`, `slash-commands-happy-paths`,
`slash-marks`, `slash-table-grid` and `templates`. 142 passed. The Recent-band
test failed on the list's heading, as above, and its spec passed (6) once it
read the group's name.
