# Session 2520

Page mode shows and sets block properties. Slice 4 of #5743, after the
lazy controls (#5818). A page whose blocks hold user properties, a repeating
task's rule among them, now opens in page mode.

**Design.**
- Properties are not in the page store, so page mode keeps them itself
  (`src/editor/page-mode/page-properties.ts`, `PageProperties`). They come
  from the read the blocker check already made: `readPageFit` returns the
  `getBatchProperties` rows with the blocker, at open and on every reload
  page mode brings in. No new IPC on open. Each block's list is block mode's
  projection (`extraPropertiesOf`, exported from `useExtraBlockProperties`),
  and keeps its identity while unchanged, so a reload draws nothing.
- The same `pageBlock` node view draws them. Its row is now
  `PageBlockMetadata`: block mode's `BlockMetadataRow` with the chips and the
  repeat rule, and `BlockPropertyEditor`, paired as `SortableBlock` pairs
  them. The node view filters `INTERNAL_PROPERTY_KEYS` as `SortableBlock`
  does. The row mounts through the same lazy gate. Its empty box keeps a
  property chip's height (`data-properties`): the chip's text, padding and
  border do not scale with the font, so at 14 px it is taller than a date
  chip.
- A chip's value opens block mode's property editor, its key the rename, and
  the `+N` pill block mode's drawer (`BlockPropertyDrawer`). `Ctrl+Shift+P`
  (`openPropertiesDrawer`) opens the drawer on the caret's block, after the
  save, so a new block exists first (`afterSave`, `keep`). The pill's tooltip
  names that key, so page mode binds it. The editor and the drawer write
  through the property commands themselves. When either closes, page mode
  re-reads the page on its save chain (`propertiesEdited`). The mock emits no
  `block:properties-changed`, so that event alone would not refresh the chips.
- The editor's popup carries `data-editor-portal`. Page mode's blur saves only
  blocks the caret has left, as with the date picker. An editor closed by
  Enter or Escape leaves focus on `body`, so page mode puts the caret back.
  It does that a task later. Done at once, inside the mock's
  microtask-resolved IPC, the closing Enter landed in the document and split
  the block. Playwright showed it.
- A typed `key:: value` line is committed in `commitTyped` after the task
  marker and before the tags, through block mode's `commitInlineProperties`
  (`commitPageProperties`). Only lines whose key the block did not hold as
  text before its first change count. That uses block mode's
  `addedInlineProperties`, now exported, against the block as it was
  (`typedIn`, the same record slice 2's markers use). A refused write keeps
  the line, and block mode's notice says so.
- Repeating tasks are let in. Completing one goes through `handleToggleTodo`,
  whose `reloadIfRepeating` reloads the page store. Page mode's subscriber
  brings the next occurrence in, rule and dates with it. Its properties are
  taken before the patch, so its row draws at once.
- What stays blocked, under a new kind: `listStyle`. Page mode draws no list
  marker, and block mode's Enter and Backspace continue and leave a list
  (#4552), which page mode's keys do not. Drawing the marker without that
  behaviour would make a numbered list edit differently in the two modes. The
  message is "Page mode can’t show bullet or numbered blocks yet."
  `pageMode.blocked.properties` is gone.
- Image size, alignment and caption need no blocker. Block mode applies them
  only to an image attachment, and the `attachments` blocker keeps those pages
  out. On a block without one, block mode draws nothing for them either.
- `PropertyChip`'s key label was `opacity-60` on the muted chip, 2.4:1. axe
  flagged it once page mode's Playwright spec ran axe over chips, and block
  mode has the same chip. The fade is gone in both.

**Tests, each shown red first by a one-command mutation (backup, trap, `! cmp -s`):**
- vitest `PageModeEditor.test.tsx`, a new `properties` describe:
  - Chips and the repeat rule render under the text, with axe. Red twice:
    `filteredProperties: []`, and no repeat rule (no `properties`, `repeats`
    dropped).
  - A chip opens the editor, its value is read back, and the caret returns.
    Red three times: a no-op `onEditProp`, no re-read on close, and no
    refocus.
  - The key renames: red with no re-read on the rename's close.
  - An emptied chip deletes the property and its row: red with no re-read, and
    with a dropped block not counted as a change in `take`.
  - A refused chip write toasts, and the chip keeps the backend's value: red
    with the editor's `reportIpcError` swallowed.
  - The `+N` pill and `Ctrl+Shift+P` open the drawer, and its delete shows
    once closed. Red three times: no `onShowProperties`, the key not taken,
    and the close not re-reading.
  - A typed line converts on leave, not before. Red: no
    `commitPageProperties`, and the caret's block not skipped.
  - A line the block already held stays text: red with `loaded` read as empty.
  - A refused typed write keeps the line: red with page mode stripping every
    typed line itself.
  - A peer's set and deleted properties show on reload, outside undo: red with
    no `take` in `bringIn`.
  - Completing a repeating task brings in the next occurrence, with its
    checkbox, due chip and rule. The mock has no recurrence, so the test's
    `set_todo_state` makes the sibling as `build_recurrence_sibling_in_tx`
    does. Red with the reload during the toggle ignored.
  - The lazy gate keeps a properties-only row's empty box with
    `data-properties`. Red: the attribute not set.
  - The existing no-redraw test seeds a property and reloads twice: red with
    `take` minting new arrays. With one reload it passed: the read lands after
    that reload's redraw.
- `page-mode-fit.test.ts`: user properties and a rule are let in and handed
  over. Bullet and numbered blocks are kept out with their message. Red:
  properties kept out again, and the `listStyle` check dropped.
- `PageEditor.test.tsx` and `page-mode-setting.spec.ts` now block on a bullet
  block.
- `PropertyChip.test.tsx` pinned `opacity-60`. It now pins its absence: red
  with it back.
- fast-check: two new steps, set or delete a property, and type a
  `key:: value` line then leave. The backend holds each block's last property,
  the line leaves the text exactly when it is written, and no save writes over
  a property. Red three times: no commit (after 2 runs), a lowercased value,
  and a mock `edit_block` that deletes a property.
- Playwright `page-mode.spec.ts`:
  - A page with a repeating task and a property opens in page mode. The chip
    edits; a typed `status:: done` becomes a chip after ArrowDown. Away, back,
    Page again: still there. Then axe.
  - Red three times: the key label faded (`color-contrast`), the refocus done
    at once (cursor in a new block 3), and no commit (one chip).
  - The lazy spec seeds properties alone and with a badge and dates, and gains
    a 14 px run. Red: no `data-properties` height at 14 px (heights
    47.25 → 49). It passed at 16 px, where the two chips are equally tall.
  - 40 of 40 at 8 workers.
- e2e-tauri `page-mode-properties.e2e.ts`: a property and a weekly task due
  today set through the real IPC, a typed `status:: done` line, and the task
  completed by its checkbox. The next occurrence comes in TODO, with its rule
  and a due date a week out, and stays after a round trip. Type-checked only;
  it runs in CI.

**Measurement.** `AGARIC_PERF=1 AGARIC_PERF_REPEATS=5 e2e/perf.spec.ts -g 'page
mode'`, sizes held to 500, unthrottled, median and band. The harness now
gives every block an `assignee` property. The baseline is the same build with
that seeding skipped, run in the same session:

| Measure | Block mode | Page mode, no properties | Page mode, properties |
| --- | --- | --- | --- |
| Open | 63 [56–82] ms | 367 [363–391] ms | 368 [364–369] ms |
| Worst frame while opening | 60 [0–68] ms | 69 [59–92] ms | 69 [68–75] ms |
| Key to paint, p50 | 3 [2.8–3.2] ms | 5.3 [5.2–5.4] ms | 5.3 [5.2–5.4] ms |
| Key to paint, p95 | 9.1 [3.7–9.3] ms | 8.5 [6.1–8.5] ms | 7.9 [6.6–8.4] ms |
| INP while typing | 16 [16–16] ms | 16 [16–16] ms | under 16 ms |

The lazy-controls slice measured 69 [68–79] ms and 5.1 [5.1–5.3] ms. The
opening frame is unchanged. Key to paint is 0.2 ms above that slice but
equal to this session's own baseline, so it is between sessions, not
properties. With properties, no interaction reached the Event Timing
threshold of 16 ms in any repeat; the harness reports that as no INP.

**Gates:** vitest over `src/editor src/stores src/components/pages
src/components/block-tree src/components/properties src/components/editor
src/hooks`, `npm run typecheck`, `npm run typecheck:e2e-tauri`, `npx vitest
run e2e-tauri`, `npm run lint`, and the page-mode, page-mode-setting,
properties-system and property-picker Playwright specs on a private port.
