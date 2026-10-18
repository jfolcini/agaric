# Session 2597 — Adding a ref property from the drawer, on the real backend (#5862)

#5862 fixed a bug users hit: Add on a ref key in the block property drawer sent
`set_property` with every value field null, which `validate_set_property` rejects,
so the property was never added. It now opens a local draft row that writes when a
page is picked. AGENTS.md testing invariant 4 asks for that path on the real lane;
the chip itself is pinned on the mock lane by `property-ref-boolean-chips.spec.ts`.

**Spec:** `reserved-property-roundtrip.e2e.ts` (the block-mode "a property set through
the UI survives a round trip" file) gains a second `it`: a run-scoped ref key made in
Settings › Properties, added to a block from its drawer, a page picked in the draft
row; after leaving to Pages and coming back, the block's chip opens that page and the
reopened drawer still shows it. The drawer is closed with its Close button: one Escape
right after a pick lands on the page popover's exit animation (standard Radix layering;
a second Escape, or one after the popover is gone, closes the drawer).

**Shown red:** `buildInitParams` back to its pre-#5862 `valueRef: null` with 'ref'
out of `DRAFT_ROW_VALUE_TYPES`: the add opens no row with a page picker, and the app
log shows "SetProperty must have exactly 1 non-null value field, found 0".

**Ran:** the file on a binary rebuilt from this tree, 2 passing; `npm run
typecheck:e2e-tauri`, oxlint, oxfmt and `npx vitest run e2e-tauri`.
