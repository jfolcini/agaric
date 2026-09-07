# Session 1575 — the widened real-backend lane, made green

Branch `fix/4671-real-backend-e2e-widen`, part 1 of #4671. The eight new
specs from the two earlier commits were dispatched to the weekly lane and
three of them failed. This session diagnoses those three and fixes them.

## Red run

[34065136247](https://github.com/jfolcini/agaric/actions/runs/34065136247) —
`11 passed, 3 failed, 14 total`. Three distinct causes, none of them flake:

1. **`attachment-paste-roundtrip`** — `invalid selector: The string did not
   match the expected pattern`. WDIO compiles `[data-sonner-toast]*=<text>`
   into `contains(., "<text>")`, and the expected toast
   (`blockTree.attachedFileMessage` → `Attached "wdio-paste.png"`) carries
   double quotes, so the XPath was malformed. Two further defects sat behind
   it, unreached: the row wrapper is a `<div>`, so `li[data-block-id=…]`
   matched nothing, and `[data-testid="attachment-section"]` renders only
   behind the badge's `showAttachments` toggle (`useState(false)`).
2. **`space-scoped-tag`** — `expect("").not.toBe("")` on the space
   switcher's label, 1.6 s after boot. The trigger mirrors the selected
   `SelectItem`, and the items arrive from SpaceSwitcher's fire-and-forget
   `refreshAvailableSpaces()`; before it lands the trigger is empty. The
   app-ready signal does not cover that store.
3. **`undo-create-block`** — `Add block did not add a second row`. The spec
   assumed an empty "Add block" row survives losing focus. It cannot:
   BlockTree's #4729 leaked-empty-block cleanup deletes it on focus-leave,
   with `undoable: false`, so the row never reaches the tree and the undo
   stack never sees the delete either.

## Changes

- `helpers.ts` `waitForToast` matches toast text in JS over the resolved
  elements instead of through WDIO's `*=` selector, so a quoted message is
  no longer a malformed XPath.
- `attachment-paste-roundtrip` addresses the row as `[data-block-id=…]`
  (the form the passing reserved-property spec already uses) and asserts the
  badge's `aria-label`, which exists only when `attachmentCount > 0` and is
  therefore the re-queried durable read. The section assertion is dropped:
  it is behind a UI toggle, so its absence said nothing about the backend.
- `space-scoped-tag` waits for the switcher to name an active space before
  reading it.
- `undo-create-block` is replaced by `undo-todo-state`: the reversed action
  is the task checkbox, whose single `set_property` op is unambiguously the
  page's last op, and whose effect is readable straight off the checkbox's
  `aria-label` — in place after Ctrl+Z, and again after the page is re-opened
  from the Pages list.

## Found by the lane, not fixed here

`PagesTreeSection` calls `listPagesWithMetadata` with `paginationLimit(200)`,
but that IPC caps at 100 (invariant 10), so every page open logs
`Validation error: list_pages_with_metadata limit must be in [1, 100]; got
200` and the descendants tree never loads. Visible in the red run's app log.
Filed as #4805 — a production defect the mock-backed estate does not
exhibit, i.e. exactly the class #4671 exists to catch.

## Second red run

[34088762135](https://github.com/jfolcini/agaric/actions/runs/34088762135) —
`12 passed, 2 failed`. The attachment spec passes. The other two failed on
causes the first run had hidden behind their earlier failures:

4. **`space-scoped-tag`** — `getText()` on the switcher trigger returns ""
   for the full 60 s, while the failure screenshot shows it plainly reading
   "Personal". The label is not the button's own text: Radix's `SelectValue`
   is a portal target and the selected `SelectItemText` renders into it from
   the subtree the closed Select keeps hidden, which WebDriver's
   rendered-text algorithm does not follow. Both the initial read and
   `switchToSpace`'s confirmation now go through `textContent`.
5. **`undo-todo-state`** — the single Ctrl+Z reversed a `delete_block` as
   well as the checkbox's `set_property`. `handleToggleTodo` pushes a
   ref-less undo entry, so Ctrl+Z resolves positionally through
   `undoPageGroup`, which reverts everything within `UNDO_GROUP_WINDOW_MS`
   (500 ms) of the newest op — and the Escape that dropped the empty
   Enter-sibling landed inside that window. Restoring it left the page
   unresolvable (`block '01M1X8…' not in current space`), the page editor
   healed the stale reference and bounced to Journal, and the marked block
   was gone. The block is now committed by navigating away instead of with
   Enter+Escape, which removes the `delete_block` entirely and puts a
   round-trip's worth of time between the block's ops and the checkbox's.

## Third red run — and the production bug behind it

[34090532222](https://github.com/jfolcini/agaric/actions/runs/34090532222) —
`13 passed, 1 failed`. The two fixes above hold. The last failure is not a spec
problem at all:

6. **`space-scoped-tag`** — `element (".//button[.//span[normalize-space(.)=
   "Journal"]]") still not clickable after 60000ms`. Radix portals every popper
   into a positioned `[data-radix-popper-content-wrapper]`, and that wrapper
   hit-tests. Closing a Select restores focus to its trigger; the SpaceSwitcher's
   trigger carries a tooltip, so the tooltip re-opens on that focus, and its
   shortcut hint is tall enough to cover the first sidebar nav item. The click
   after a mouse space switch landed on the tooltip and did nothing.

   Nothing inside a tooltip is interactive and `pointer-events` inherits, so
   opting the wrapper out fixes the content too. Scoped by `:has()` to tooltip
   poppers — Select/Popover/Dropdown poppers must stay clickable and do not
   match.

   This is a real user-facing defect, not a test artefact: any click under an
   open tooltip was being eaten. It is the third production bug this lane has
   surfaced (after #4805), which is the argument #4671 is making.

## Verification

`e2e/tooltip-pointer-events.spec.ts` guards the fix per-PR, since the
real-backend lane is `schedule` + `workflow_dispatch` only until #4671 lands
(`e2e/AGENTS.md` invariant 4: a spec there needs a per-PR partner or it does not
guard the PR that reintroduces the bug).

It asserts the MECHANISM — `elementFromPoint` over the tooltip's own centre must
not return the tooltip — rather than that one particular click lands. The first
draft did the latter, clicking the nav item after the Select closed, and it
**passed against a reverted fix**: whether the tooltip actually covers that
button depends on viewport height and on how many spaces exist. That version was
worth nothing and is recorded here so nobody rewrites it that way. The mechanism
assertion reddens on the revert (`hitsTooltip` `Expected: false / Received:
true`) and is green with it; restored and `cmp`-verified.

The weekly lane itself is re-dispatched with this commit; this section names the
green run once it concludes, and no spec is claimed to pass there before then.
