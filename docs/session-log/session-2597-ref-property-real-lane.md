# Session 2597 — Adding a ref property from the drawer, on the real backend (#5862), and #5879's notes

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

**Why the first push went red in CI:** WebKitWebDriver's right-click releases the
button as the left one, so the block also took a click and mounted the roving editor,
whose focus closed the drawer's "Add property" picker when it landed late.
`openContextMenu` (`e2e-tauri/helpers.ts`) sends the `contextmenu` event a right-click
sends; `agenda-projected-repeat.e2e.ts`, the other right-click, uses it too.
`pages-most-linked.e2e.ts` failed in the same run on a layout shift: the page count
mounts left of the sort trigger and moves it, so a click aimed before that landed on the
count. The spec now waits for the count.

**#5879's notes:** `android_jni.rs` no longer lists the dropped `staticlib`, and BUILD.md
says Phase D runs only when the push changes Rust (`HAS_RS`). The rest of #5882's notes
went to session 2600 (816f944, #5888); a duplicate built here was dropped.

**Shown red:** `buildInitParams` back to its pre-#5862 `valueRef: null` with 'ref'
out of `DRAFT_ROW_VALUE_TYPES`: the add opens no row with a page picker, and the app
log shows "SetProperty must have exactly 1 non-null value field, found 0". The
right-click race, with `StaticBlock` focusing a second late: the old spec fails on the
missing "Search definitions" input and the new one passes on that binary. Not shown red:
the `pages-most-linked` wait, which needs a product-side delay to reproduce.

**Ran:** `reserved-property-roundtrip` and `pages-most-linked` on a rebuilt binary, 2
passing runs each; `npm run typecheck:e2e-tauri`, oxlint, oxfmt and
`npx vitest run e2e-tauri`.
