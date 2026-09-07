# Session 1567 — Enter/Backspace continuation for listStyle blocks

Slice 3 of #4552, the only slice the 2026-09-02 rationalization pass left open. Slices 1, 2
and 4 had already shipped, so `listStyle` had a writer (`/numbered-list`, `/bullet-list`,
Turn-into) but no keyboard grain: Enter on a numbered block produced a plain sibling, and
the only way out of a list was the property drawer. This session added the three gestures
the design doc records — Enter on a styled block carries the style onto the sibling it
creates, Enter on an *empty* styled block clears the style instead of adding another empty
item, and Backspace at the start of a styled block strips the style before the second
Backspace merges or deletes.

The gestures live in `use-block-action-orchestration.ts` (`handleEnterSave`,
`handleMergeWithPrev`, `handleDeleteBlock`) rather than in `use-block-keyboard.ts`, where
the design doc had penciled them in: the keyboard hook only routes, and the handlers are
what already own `createBelow` / `remove` and the re-entrancy guards those gestures race
against. Reading the focused block's style needed a synchronous source, and the hook mounts
above `BatchPropertiesProvider`, so it goes through the roving-editor handle instead — a new
`listMarkerStyle()` reading back what `EditableBlock` last pushed into the marker plugin
(`listMarkerStyleOf`). That keeps `BlockTree`'s eager import graph free of TipTap (#2939,
pinned by `BlockTree.lazy-editor-import-graph.test.ts`) and it is what makes the *second*
keystroke work: the clear pushes `'none'` locally before awaiting the property write, so
the next Backspace reads a plain block and merges rather than clearing again while the
property refetch is still debouncing. #4577 needed no work here — it was settled in slice 2
by flushing the pending draft before the property write.

Verified in this session, not carried over: `npm run typecheck` exit 0. `npx vitest run`
over the nine touched test files — 9 files, 423 tests passed — plus twelve neighbour suites
(`use-roving-editor`, `list-style`, `list-ordinals`, `editor-list-marker-css`,
`useListStyles`, `useListStyleSyntax`, `ListMarker`, the three `BlockListRenderer` suites,
the lazy-import-graph pin and the i18n catalog-parity guard) — 12 files, 227 tests passed.
`npx playwright test e2e/list-style-keyboard.spec.ts --workers=1` — 2 passed. That spec
drives the two deterministic gestures against the mock backend and asserts the durable
effect after a `reopenPage`, not the call shape. The fourth gesture — Backspace at the
start of a *non-empty* styled block — is unit-tested only: on a styled block `Home` and
`Control+Home` do not move the caret at all, because the marker widget is
`contenteditable=false`, so no caret-at-start precondition is reachable from outside the
editor.

Seven mutants, each applied to the real file after a `cp` backup and restored from it with
`cmp` confirming byte-identity: dropping the continuation on the plain `createBelow` path
(2 failed), on the caret-split path (1), dropping the Enter-on-empty clear (2), the
Backspace strip-then-merge guard in `handleMergeWithPrev` (4), the empty-styled guard in
`handleDeleteBlock` (2), making `listMarkerStyleOf` always report the empty state (12,
across two files), and making the lazy stub answer `'bullet'` (1). All seven reddened. The
sixth is the interesting one — it reddens the orchestration suite too, which is what proves
the marker double in those tests really drives the plugin instead of restating its own
setup.

Not done here: the multi-block paste split inside `handleEnterSave` (`consumePendingSplit`)
does not propagate the style to the blocks it produces; those are pasted content rather
than a continuation, and slice 4 owns the markdown side.

## Review round 1 — the continuation had no local-first push

`agaric-reviewer` requested changes on PR #4807 and was right. `clearFocusedListStyle`
pushes `updateListMarker('none', undefined)` before awaiting its write, precisely so the
next keystroke reads a plain block. `continueListStyle` had no counterpart: it only called
`setListStyle`. So the style of the block Enter had just created had to travel
`set_property` → `block:properties-changed` → the 150 ms trailing debounce in
`block-property-events.ts` → the batch refetch → `useListStyles` → `ListMarkerContext` →
`EditableBlock`'s marker effect → `updateListMarker`, while `mount()` had already reset the
new block's marker to `'none'` (#3000) and that effect had re-pushed the context's still-empty
value.

Concrete failure, in the reviewer's words and reproduced as a test: on a numbered block type
"step one", press Enter, then Enter again within ~200 ms — the ordinary "double Enter to leave
the list" gesture. The second Enter read `'none'`, took the plain `createBelow` path, and left
a stray empty ordered item with an unstyled block under it. `empty-block-cleanup.ts` guard 5
then keeps that stray forever, because it carries a `listStyle` property.

The fix is an `optimisticListStyle` ref: `continueListStyle` records `{blockId, style}` BEFORE
its write (the gesture lands while the write is in flight) and drops it if the write rejects.
`focusedListStyle` consults it only when the marker reads `'none'` for that same block.

Reading also EXPIRES a spent entry — once focus has left the block it was recorded for, or the
marker shows any style at all, the marker is authoritative again. That expiry is what bounds
it: a later Turn-into clears `listStyle` through paths this hook never sees
(`use-block-tree-event-listeners.ts`, `useSlashCommandStructural`), and without the expiry the
entry would keep answering for a block that is no longer a list item. The one window it cannot
cover is a style cleared before the marker ever showed it — under ~250 ms after the Enter that
created the block, which no menu or slash command is reachable in.

What it deliberately does NOT do is paint the marker early. The orchestration has no ordinal
for a block it just created (ordinals come from `computeListOrdinals` over the whole sibling
list, in `BlockListRenderer`), and pushing a style with a wrong ordinal is worse than a late
one. So the ~150-250 ms marker lag stays — the same lag the toolbar, slash-command and syntax
paths have had since slice 2. This fixes the behaviour, not the paint.

Non-blocking note (a) folded in, since a push was going out anyway: a rejected `clearListStyle`
left the marker cleared, so the block rendered AND behaved as plain while still being a list
item in SQLite — nothing would refetch it, because the context map is unchanged and
`EditableBlock`'s marker effect never re-fires. The restore needs the ordinal, so the handle's
`listMarkerStyle(): ListStyle` widened to `listMarker(): ListMarkerState` (style + ordinal),
and `listMarkerStyleOf` became `listMarkerOf`. Guarded on the editor still being on that block,
so a user who clicked away mid-write does not get the old marker painted onto their new one.

Note (b) — `focusedListStyle` is a `useCallback([])` its call sites could inline — no longer
applies: it now owns the optimistic read and its expiry.

Falsified against a copy: reverting the optimistic read reddens "a second Enter inside the
property-event window still LEAVES the list", and dropping the restore push reddens "a rejected
clear puts back the exact marker it cleared, ordinal included". Restored and `cmp`-verified.
