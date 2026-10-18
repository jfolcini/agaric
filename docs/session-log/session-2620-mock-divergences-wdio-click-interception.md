# Session 2620 — Two mock divergences closed, the WDIO click interceptions, and review notes from #5870, #5881 and #5884

The last follow-up of session `01DfwuhFseNHQzDHna7LsBiH`. Its reserved range (2593–2599) now
sits below the numbering window, so this log takes 2620.

**Mock divergences** (AGENTS.md testing invariant 2), each pinned by a conformance fixture
whose `expected` the backend authored:
- `set_property` with no value field, or two, is refused as the backend refuses it; a reserved
  key with none still clears its column. The mock stored an all-null row, which is why the
  ref-property bug #5862 fixed was green on the mock lane. New fixture
  `set_property_value_count.json`.
- `list_blocks` by type keeps only the space's own blocks. The mock listed every space's, so a
  fresh space always looked non-empty and Settings never offered to delete it.
  `spaces-management.spec.ts` drops its "documented mock limitation" and now deletes an empty
  space; `SpacesTab.test.tsx` no longer stubs the emptiness probe. The tag, agenda and
  children branches of the same handler are still unscoped in the mock; nothing found depends
  on them.
- Two more divergences turned out to be backend defects, so the mock keeps the safer
  behaviour and each is filed: #5898 (an agent's `delete_property` of an absent key wedges
  Ctrl+Z on the page) and #5899 (a page deep link to a content block adds an empty child on
  every visit).

**WDIO click interception** (the flake #5882 left with this session):
- "Markdown saved" toasts slid in under a pointer left on Save; WebKit reports that as the
  pointer entering the toast, sonner expands the stack and holds it open, and two saves later
  it covers Save and Cancel. `clickPageSourceButton` waits for the button, clicks it and moves
  the pointer off; it replaces `pageSourceButton` at all eleven call sites.
- `page-alias-undo`: the closing page menu still covered the alias input. `focusForTyping`
  waits for its target to be clickable.

**Review notes:** #5870's duplicated date helpers are one `isoDay` in `e2e-tauri/helpers.ts`
(with the third copy in `reminder-due-task.e2e.ts`); #5881's `openPropertyDrawer`, copied in two
specs, is one helper; #5884's stall test builds its job with `counter_job`, as session 2596
said the next PR would.

**Shown red:** each mock fix by reverting it (the fixture's mock leg fails on the backend's
answer; the scope mutation also reddens 14 `SpacesTab` tests and the space-delete spec).
`focusForTyping` with a cover laid over the alias input: the old helper fails on `element click
intercepted`, the new one passes. The stall test with `MissedTickBehavior::Skip` removed: 10 runs
instead of 1. Not shown red on demand: the pointer move in `clickPageSourceButton`; the old code
failed in 1 of 4 plain runs and 3 of 5 instrumented ones, and the recorded `mouseover` on the
toast is the evidence for it.

**Ran:** conformance with and without `CONFORMANCE_UPDATE`; vitest over all of `src/`;
`npm run typecheck`, `npm run typecheck:e2e-tauri`; Playwright on the spaces, templates,
onboarding and property specs; the stall test; on a binary rebuilt from this tree, the changed
real-lane specs listed in the PR.
