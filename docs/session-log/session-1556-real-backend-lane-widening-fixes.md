# Session 1556 — the widened real-backend lane, made green

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

## Verification

Pending: re-dispatched to the weekly lane. This section names the green run
once it concludes; no spec is claimed to pass before then.
