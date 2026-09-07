# Session 1569 — Embed edit-in-place, behind a per-embed unlock

Phase 2 of `{{embed …}}` (#4550). Phase 1 (#4572) shipped a read-only container; this is the remaining deliverable — content-only editing inside it, behind an explicit per-embed unlock, with structural chords disabled.

The shape of the solution is set by invariant 4: one roving TipTap instance per mounted `BlockTree`, and focus is global. An unlocked embed therefore mounts **no** editor of its own. `BlockTree` publishes its own editable-row renderer on the new `EmbedRowEditorContext`, bound to its roving handle by `useEmbedRowEditorValue`; `EmbeddedBlockTree` swaps the **focused** row — and only that row — from its read-only div to that renderer. The one instance roves into the embed. Outside a `BlockTree` the context is `null`, which is also the signal `EmbedContainer` uses to hide the unlock control rather than offer a dead one.

The editable row lands inside the **source** page's `PageBlockStoreProvider`, which is what makes the write go to the page that owns the block: `EditableBlock` reads its store from context, so the debounced commit, the blur flush and the draft autosave all address the source store. Route it anywhere else and the optimistic write silently no-ops (`idx < 0` in the `edit` reducer) while the IPC still lands, leaving the embed stale until a reload. That is the discriminating assertion in the test file, not the `edit_block` call shape — `edit_block` is addressed by id and would land from any store.

Structural chords are off for the region, not per keystroke. Two changes:

- `BlockTree` hands `useBlockKeyboard` a **null** editor whenever the focused block is not one this tree's store owns (`storeOwnsBlock`). Every callback there acts through the host page store — `edit`, `splitBlock`, `createBelow`, `indent` — so with the editor roved into an embed, Enter would split against a store that does not hold the block and `createBelow` would place the new sibling on the wrong page. Plain typing and TipTap's own formatting keymap never route through this hook and are untouched.
- `useBlockFlush` returns before unmounting when the roving editor's active block is foreign, for the same reason on the imperative path. The embedded row's own blur is bound to the source store and persists it correctly.

Two behaviours that look like polish and are not. Unlocking **moves** the focus to the first editable row, skipping a row that is itself an embed (it renders a nested container, not an editable row, so focusing it would unlock into nothing) — without that the feature is pointer-only, because embedded rows carry no tab stop and phase 1 deliberately kept arrow-key outline navigation from descending into an embed. And relocking clears the focus if it is still inside the embed, or the global focus would sit on a block no mounted tree owns: host chords stay detached and no row renders an editor, so the keyboard would be dead until the user clicked a host row.

The relock-on-blur trigger is the **global focused block id**, not a DOM `focusout`. Swapping a row between its read-only div and the editable one detaches the old node mid-click, and a `focusout` with a null `relatedTarget` there would relock the embed the user just entered. A `wasInside` latch makes it a blur rather than a "focus is elsewhere" test: `setUnlocked` and the focus move are two different stores, so an effect run landing between them would otherwise relock on the tick the embed was opened.

The unlock toggle is the region's second tab stop and the only one added. Phase 1 shipped the read-only region as a single stop; an editable region's way *in* has to be reachable without first landing on the container and guessing a key. The collapse and open-source controls stay opted out, and the test asserts the total count so the region cannot quietly grow to four.

## Verification

`npm run typecheck` clean (also re-run with `tsc -b --force --noEmit`, since a solution-style `-b` build can otherwise report an up-to-date cache). `EmbedEditInPlace.test.tsx` 12/12, `BlockTree.test.tsx` and `use-block-flush.test.ts` green, and the wider editor/embed estate re-run.

Six of the twelve cases in `EmbedEditInPlace.test.tsx` arrived red from an earlier interrupted session and were fixed here, both times because the test predated the "unlocking moves focus" behaviour: five clicked the first row *after* unlocking, by which point that row hosts the editor and its text is no longer plain text to find; one seeded a fixture whose intended "first row is a nested embed" case still had an ordinary row above it. No production change — the code was right and the tests were describing an older design.

Four falsifications, each run against a copy and restored with `cmp`:

- Dropping `unlocked` from `EmbeddedBlockTree`'s `editable` predicate → 2 red (`stays read-only until this one embed is unlocked`, `relocks on the toggle`).
- `useBlockKeyboard(rovingEditor.editor, …)` without the `ownsRovingBlock` gate → 1 red in `BlockTree.test.tsx`.
- Deleting the `storeOwnsBlock` early return in `useBlockFlush` → 1 red in `use-block-flush.test.ts`.
- Making the page store's `edit` optimistic write an unconditional no-op — the exact failure mode of an editable row rendered under the wrong provider, where the reducer no-ops while the IPC still lands → 1 red (`writes through the embedded block's own page store, not the host page's`), which is what shows that assertion tracks the store and not the `edit_block` call.

## Review round 1 — two defects in the interaction the feature is named after

`agaric-reviewer` blocked on both, correctly.

**Clicking a second row relocked the embed.** A click starts by blurring the
editor, and `useEditorBlur` step 5 ends in `setFocused(null)` — before the row's
own `onClick` fires. The relock effect read that null as "the user left",
`setUnlocked(false)` re-rendered every row with `editable === false` (so
`onClick: undefined`), and the click then dispatched against handlers that no
longer existed. Since embedded rows carry no tab stop and arrow navigation does
not descend into an embed, re-unlocking only ever put the caret back on
`firstEditableRowId`: **only the first row was ever reachable**, the opposite of
what `docs/features/tags-and-links.md` states.

The fix is a `pointerInside` latch set on `onPointerDownCapture` anywhere in the
container and consumed by the relock effect. Pointerdown precedes blur, which is
what makes it a latch rather than a race. A null focus with no pointer down
inside is still a real blur and still relocks — the second test pins that half,
because a latch that never releases would pass the first test alone.

**An embed of a block a mounted tree already renders mounted two editors for one
id.** `isFocused` is `focusedBlockId === block.id` in every tree at once, so
focusing such a block rendered an `EditableBlock` in that tree *and* the host
tree's editable row inside the embed: two `EditorSurface`s and two
`id="editor-<id>"` nodes for one roving instance — the invariant-4 violation this
whole design exists to avoid. Two ways in, both allowed by the `/embed` picker:
a page holding both a block and an embed of it, and the journal week/stream,
where one mounted day embeds a block from another mounted day's page.

No new registry was needed. `block-command-bus` already holds exactly one entry
per mounted `BlockTree`, keyed by its page store, so "a mounted tree owns this
block" is the same question — it gained `blockIsRenderedByAMountedTree` and a
membership subscription (`subscribeBlockCommandTargets`, notified on mount and
unmount only, never on a re-registration, which happens every BlockTree render).
`canEdit` consumes it through `useSyncExternalStore`, so the unlock control is
withheld — the same "not offered at all rather than offered dead" rule the
no-host-tree and no-editable-row cases already follow. An embed already open
relocks the same way: `unlocked` became `unlockRequested && !renderedByAMountedTree`,
DERIVED rather than relocked from an effect. The hazard is two `EditableBlock`s
in a SINGLE commit, and an effect relocks one render too late; `oxlint`'s
`react(set-state-in-effect)` said the same thing about the first draft. Deriving
also answers the focus question, which the effect version had to handle by hand:
the tree that now owns the block is the one rendering the editor for it, so
there is nothing stranded, and a tree unmounting hands the embed back.

The predicate deliberately over-approximates: it answers "owned by a mounted
tree", not "currently on screen", so a collapsed or scrolled-away row counts.
The cost of the safe direction is an unlock withheld from an embed the user
could have edited in place, with the source page one click away in the header.

Neither defect was catchable by the old suite, and the new tests say why in
place: the faked handle never DOM-blurs, so `userEvent.click` alone cannot
produce the null focus (the first test drives the pointer press, the blur and
the release separately); and the harness never renders a host tree's own rows,
so the second registers a bus target for the source page instead — which also
exercises the subscription rather than just the predicate. `__resetBlockCommandBus()`
moved into the file-level `beforeEach`, because the registry is module-global and
one registration would otherwise withhold the control from every test after it.

Falsified against a copy: dropping the `pointerInside` branch reddens exactly
"survives the blur the click itself causes"; dropping `!renderedByAMountedTree`
from `canEdit` reddens exactly "is not offered the unlock, and relocks if a tree
mounts while it is open". Restored and `cmp`-verified.

## Review round 2 — the guard missed the case it mattered most for

Round 1's invariant-4 guard asked `blockIsRenderedByAMountedTree(targetId)`, and
for a PAGE target that is always false: `buildFlatTree` starts at the page's
CHILDREN, so a page's own id is in no store's `blocksById` — `selectEmbeddedRows`
says as much itself ("The page block itself is not a row in its own flat tree").

So the guard was a no-op for exactly the case where an embed's rows ARE another
mounted tree's own rows: `/embed` page P from page P (the picker merges
`searchPages` with no current-page exclusion), or Monday's page embedding
Tuesday's in the journal week. Unlocking either mounted two `EditableBlock`s for
one id — the violation round 1 was supposed to stop.

The fix is to key on a rendered ROW rather than the target. Every row in an embed
comes from the one source-page store, so a row answers for both kinds of target,
and `firstEditableRowId` — which `canEdit` already needs — is one. It moved above
the predicate; nothing else changed.

The new test renders `{{embed ((PAGE_S))}}`, asserts the control IS offered while
nothing else renders those rows, then registers a mounted tree for the source page
and asserts it goes away — so it pins the guard firing rather than page embeds
being unlockable at all. Falsified: putting `targetId` back reddens exactly that
test.

Non-blocking note taken: `!renderNested` in `EmbeddedBlockTree`'s `editable` was
dead — the nested branch returns above every read of it.

## Review round 3 — two embeds of one block

Blocking, and derived by reading rather than executed — so the first thing I did
was write the repro, and it fails as described: **two `<section id="editor-B1">`
for one roving instance.**

A host page holding `{{embed ((B))}}` twice (or a journal week where two mounted
days each embed B) can have both unlocked at once. Unlocking the second calls
`setFocused('B1')`, and the first embed's relock effect sees `rowIds.has('B1')`
and stays unlocked, so both satisfy `editable && isFocused` and both call
`renderRow` for the same block. Neither `canEdit` nor
`blockIsRenderedByAMountedTree` can separate them: both ask the BlockTree
registry, and two sibling embeds are in neither.

`active-embed.ts` is the arbiter — one module slot naming the embed that
currently hosts the roving row, in the same shape and for the same reason as
`src/editor/active-editor.ts`: one process-wide fact about the editor, not page
state. Unlocking claims the slot, which relocks whoever held it; `unlocked`
takes `isActiveEmbed` as a third term. It reads better too — two editable rows
for one piece of text would be two carets.

`releaseActiveEmbed(id)` releases only if `id` still holds the slot, which is
what makes the ordering safe: unlocking B claims the slot and relocks A, and A's
own cleanup then runs with B already active. An unmount effect releases it as
well, or an embed that unmounted while unlocked would strand the slot and leave
every other embed permanently unable to unlock.

Falsified: dropping `isActiveEmbed` from `unlocked` reddens exactly the new test.
Restored and `cmp`-verified.

Both non-blocking notes folded in: the `--embed-rail-unlocked` line inside
`@media (prefers-contrast: more)` restated the `:root` value verbatim and did
nothing, and `EmbedRowEditorProps.isFocused` was only ever passed the literal
`true` from inside the branch that had already established it — so
`useEmbedRowEditorValue` sets it and the field is gone.

## Review round 4 — "structural chords stay off" was not true

Two blocking findings, both the same gap: the PR gated `useBlockKeyboard` and
`useBlockFlush` on `storeOwnsBlock`, but the roving editor carries several other
host-page-bound callbacks that were not gated. The description's claim that
structural chords stay off inside an embed was, for the one chord it names,
false.

**Enter still split the source block.** Handing `useBlockKeyboard` a null editor
removes the INTERCEPTION, not the behaviour — `use-block-keyboard.ts`'s own
attach comment says so. With no keymap, ProseMirror handles Enter itself and
inserts a paragraph, and `useEditorBlur` → `runUnmountFlush` →
`shouldSplitOnBlur` turns that into a real `splitBlock` on the source store: the
embedded block becomes two blocks on the source page.

The bindings `preventDefault()` *before* they call back, so the fix is to keep
the keymap attached and make every action inert —
`INERT_BLOCK_KEYBOARD_CALLBACKS`. Attached-and-inert swallows the chord; detached
merely stops watching it. Plain typing and TipTap's own formatting keymap never
route through here, so "text edits only" is exactly what remains.

The old test asserted the wrong contract — that the editor goes null — which is
why the defect shipped past it. It now asserts the keymap stays attached AND
that the callbacks are the inert set, with the owned half kept so it cannot pass
by being inert everywhere.

**Slash commands and the checkbox / list syntaxes wrote through the host store.**
`handleSlashCommand`, `handleCheckboxSyntax` and `handleListStyleSyntax` build
their context as `{ blockId: focusedBlockId, pageStore: <host> }` with no
ownership gate, so `/todo` on an embedded row committed
`setTodoState(embeddedBlockId, 'TODO')` and then no-opped its optimistic update
against a store that does not hold the block — a committed write with no UI
trace until a reload — while `notifyUndo(rootParentId)` filed the undo entry
under the host page. `/priority`, `/due`, `/date` and the `[] ` and `- ` / `1. `
syntaxes are the same shape. All three are now registered through `whenOwned`,
which required moving the `ownsRovingBlock` derivation above the late-bound
registration block. `propertySelect` needed nothing: it has been a no-op thunk
since #2656.

**The predicate needed both terms, and the suite proved it.** The first version
gated on `!storeOwnsBlock(pageStore, focusedBlockId)` alone — the shape the two
shipped gates use — and reddened **34 tests across 6 files**. That predicate is
also true for any focused id this store has not loaded yet, which is an ordinary
state during an async page load, so it disarmed the page's own chords and slash
commands while it lasted. The other single term is no better: an active embed
alone is true for a same-page embed, whose rows this tree DOES own and where the
callbacks are correct. `rovingBlockIsForeign` is the conjunction — an embed is
hosting the roving row AND the block under it belongs to another store — which
names exactly the case and leaves all 257 neighbouring cases untouched. The two
new tests model both halves.

Both falsified: restoring the conditional `null` editor reddens exactly the
keymap test, and dropping `whenOwned` reddens exactly the slash-command test.
Restored and `cmp`-verified.

## Review round 5 — the inert keymap made the embed a keyboard trap

Round 4's fix was right for Enter and wrong for everything else. Keeping the
keymap attached means every binding still `preventDefault()`s before calling
back, and `useBlockKeyboard` then `stopPropagation()`s on `defaultPrevented` —
so with the caret in an embedded row, Escape, Tab, Shift+Tab and the arrows were
all swallowed by callbacks that do nothing. A pointer was the only way out, in a
region this PR also gave a keyboard-only way *in*.

`src/lib/editor-preferences.ts` states the contract that broke: "even with
Tab-indent ON the editor is never a keyboard trap: Escape exits the block ... so
Tab can move focus away again". This PR removed Escape for the one region where
it also removed Tab.

Escape is now the way out, handled on `EmbedShell` in the **capture** phase so it
runs before `useBlockKeyboard`'s listener rather than being swallowed by it. It
relocks through the same `onToggleUnlock` path the toggle uses — which clears the
focus off the embedded row — and then focuses the container, this region's one
tab stop, so Tab continues from there. Escape restructures nothing, so unlike the
structural chords it needs no ownership gate.

Two documents asserted the opposite of what shipped and are corrected: this
file's own docblock claimed "Tab (or a click elsewhere) is the way out ... Escape
is inert inside an unlocked embed", and `docs/features/tags-and-links.md` told
the user Tab does nothing without naming a replacement.

Falsified: dropping `onKeyDownCapture` reddens exactly the new test, which
asserts all three halves — relocked, editor gone, and focus actually landed on
the container rather than being cleared to `document.body`, which would leave the
trap only half-opened.

## Review round 6 — the exit swallowed the pickers' own Escape

Round 5's capture-phase Escape had no popup guard. The `/`, `[[`, `#` and `::`
pickers are portaled to `document.body` and never hold focus, so their Escape
arrives on the contenteditable *inside* the shell, and React's root capture
listener runs before ProseMirror's handler. Dismissing a menu therefore ejected
the user from the region entirely and committed the half-typed trigger text to
the source page.

`use-block-keyboard.ts` guards its own Escape with `isSuggestionPopupVisible()`,
so that predicate is now exported and reused rather than copied — its
detached-node reasoning is the kind of thing that rots in a second copy.

Also recorded, from the same review: Escape here **saves**. Relocking clears the
focus, and `useEditorBlur` persists on the way out — the opposite of Escape in a
host row, which discards and toasts. That is deliberate rather than incidental:
the edit lands on another page, and silently dropping it on the keypress a user
reaches for as "get me out" is worse than keeping it. Both the docblock and
`docs/features/tags-and-links.md` now say so, instead of describing only where
the focus goes.
