# Dialog responsiveness — make the primitive "just work"

> Status: ready for review.
> Triggered by: BugReportDialog has three concrete failure modes on short / narrow windows. Investigation showed they're not BugReport-specific — every consumer of the dialog primitive can hit them. Fix the primitive once.

## The bugs in BugReportDialog (concrete repro)

`src/components/BugReportDialog.tsx:336`. With the bug report dialog open:

1. **Textarea drag-resize escapes the dialog frame.** `<textarea>` defaults to `resize: both`. The textarea primitive (`src/components/ui/textarea.tsx:6`) does not override it. Drag the bottom-right corner of the description textarea to the right and it grows past the dialog's `max-w-2xl`, pushing the form wider than the inner ScrollArea viewport. Because the viewport is `overflow-hidden` and the only scrollbar is vertical, the right side of the form (and the right side of the title input above it, since they share a `w-full` parent) is silently clipped. This is exactly the "controls grow too much horizontally / parts disappear" report.
2. **Cannot scroll on a short window.** Resize the OS window to ~400 px tall. The dialog's `max-h-[calc(100dvh-2rem)]` clamps it correctly, and BugReportDialog wraps its body in a `flex-1 min-h-0` ScrollArea (`src/components/BugReportDialog.tsx:342`), so vertical scroll *should* work — and it does for the outer body. But the body itself contains TWO fixed-height inner ScrollAreas (`h-56` for the preview, `h-32` for the logs list, lines 421 and 438). Those fixed pixels do not yield. On a very short window, `header + h-56 + h-32 + footer + gaps` already exceeds the available height, so the form fields above them are pushed out of the visible viewport and there is no way to reach them — the inner ScrollArea consumes the scroll, but the outer one needs to scroll *past* the inner blocks first, and Radix' wheel-event forwarding into nested viewports is unreliable when the inner viewport is taller than its parent's remaining space. End result: form fields stuck off-screen, scroll wheel doesn't move them.
3. **Header / footer on dialogs that don't opt into the flex pattern.** Most dialogs (QueryBuilderModal, SpaceManageDialog, QuickCaptureDialog, RenameDialog, WelcomeModal, BlockDatePicker, every AlertDialog) rely on the primitive's default `grid w-full ... gap-4 overflow-y-auto`. That works for short content. For tall content the entire dialog scrolls, header and footer included, and on a short window the footer can be scrolled out of view — the user has to scroll *inside* the modal to find the Cancel / Submit buttons. BugReportDialog hit this before PEND-28b M1 added the `flex flex-col` workaround; the workaround works but every new dialog has to rediscover it.

These are three symptoms of the same root cause: **the primitive doesn't enforce a sane responsive contract, so each consumer reinvents one (or doesn't, and breaks).**

## What "primitives just right" means here

A dialog primitive should guarantee, with zero per-call boilerplate:

- The dialog frame fits the viewport (capped by `max-h-[100dvh-2rem]` and `max-w-[100%-2rem]`). ✅ today.
- The header and footer are always visible — they never scroll out.
- The body between them scrolls when content exceeds available space.
- Children (inputs, textareas, pre blocks) cannot push the dialog wider than the frame, even via user interaction.
- The textarea primitive cannot be drag-resized horizontally beyond its container.

Today's primitive guarantees only the first one. The rest are the consumer's problem.

## The fix

### 1. Textarea: clamp horizontal resize at the primitive

`src/components/ui/textarea.tsx`. Add `resize-y` to the base classes (vertical drag stays useful for long descriptions, horizontal drag is always wrong inside a constrained layout). One-line change:

```diff
-        'flex min-h-[80px] w-full rounded-md border border-input bg-transparent ...'
+        'flex min-h-[80px] w-full resize-y rounded-md border border-input bg-transparent ...'
```

Cost: ~5 minutes. Risk: zero — `resize-y` is the strict subset of the current `resize: both`. No consumer relies on horizontal drag (it's always a layout bug when it happens).

### 2. Dialog: make the scrollable-body pattern the default

Refactor `src/components/ui/dialog.tsx` so that `DialogContent` is **always** `flex flex-col overflow-hidden` and provides a `DialogBody` slot that wraps its children in a ScrollArea. Concretely:

```tsx
// dialog.tsx
const DIALOG_CONTENT_BASE =
  'bg-background ... fixed top-[50%] left-[50%] z-50 ' +
  'flex flex-col w-full max-w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] ' +
  'translate-x-[-50%] translate-y-[-50%] gap-4 overflow-hidden ' +
  'rounded-lg border p-6 shadow-lg duration-moderate sm:max-w-lg ...'

// New:
const DialogBody = ({ ref, className, children, ...props }: React.ComponentProps<'div'>) => (
  <ScrollArea
    ref={ref}
    className={cn('flex-1 min-h-0 -mx-6', className)}
    viewportClassName="px-6"
    {...props}
  >
    <div className="space-y-4 min-w-0">{children}</div>
  </ScrollArea>
)
```

Key changes vs today:

- `grid` → `flex flex-col`. Header at top, body in the middle, footer at the bottom. No more "footer scrolls out of view" surprise.
- `overflow-y-auto` → `overflow-hidden`. The frame never scrolls; only the body does.
- New `DialogBody` slot bakes in the `flex-1 min-h-0 -mx-6 / viewportClassName="px-6"` pattern that BugReportDialog and PdfViewerDialog had to rediscover. Negative-x-margin lets the scrollbar sit in the gutter without eating the dialog padding — same trick BugReportDialog already uses.
- The inner wrapper has `min-w-0` so flex children (inputs, textareas, label rows) can shrink. Combined with the `w-full min-w-0` already on `Input`, this means no child can push the dialog wider than the frame.
- AlertDialog gets the same treatment in `src/components/ui/alert-dialog.tsx` (its `DIALOG_CONTENT_BASE` is duplicated verbatim — fix both, or factor the string into one shared const).

For dialogs that intentionally want the *old* "whole dialog scrolls" behaviour (e.g. tiny confirm dialogs where there's no real header/body/footer split), nothing changes — they just don't render `<DialogBody>`. The flex-col layout still works for any direct children laid out in a column.

For dialogs that need a fully custom frame (ImageLightbox uses `bg-black/80 border-0 shadow-none rounded-none p-0` for full-screen image viewing), the className override still wins over the base — `flex flex-col` doesn't conflict with the lightbox's existing layout, and tailwind-merge collapses display utilities cleanly so a consumer can opt out by passing `grid` or `block`.

### 3. Migrate consumers to `DialogBody`

This is the audit step the user asked for. Once `DialogBody` exists, walk every `DialogContent` consumer and decide:

| File | Action |
| --- | --- |
| `src/components/BugReportDialog.tsx` | Replace the manual `<ScrollArea className="flex-1 min-h-0 -mx-6" viewportClassName="px-6">` (line 342) with `<DialogBody>`. Drop `flex flex-col overflow-hidden` from the className (now default). The two inner fixed-height ScrollAreas (`h-56`, `h-32`) become `max-h-56` / `max-h-32` so they shrink on short windows instead of stealing scroll. |
| `src/components/PdfViewerDialog.tsx` | Already does `flex flex-col + flex-1 min-h-0` by hand. Replace with `<DialogBody>`. Keep `max-w-5xl max-h-[90vh]` overrides. |
| `src/components/SpaceManageDialog.tsx` | Currently uses `<ScrollArea className="max-h-[85vh]">` *outside* a flex layout — this works by accident on tall windows and breaks on short ones. Replace with `<DialogBody>`; drop the explicit max-h. |
| `src/components/QueryBuilderModal.tsx`, `QuickCaptureDialog.tsx`, `RenameDialog.tsx`, `WelcomeModal.tsx`, `GoogleCalendarSettingsTab.tsx` (the AlertDialog inside it), `ConfirmDialog.tsx`, `ConfirmDestructiveAction.tsx`, `SpaceManageDialog/SpaceDeleteButton.tsx`, `block-tree/BlockBatchActionMenu.tsx` | These render header + a few rows + footer, no inner scroll today. Wrap the body region in `<DialogBody>` so on a short window the body scrolls instead of the footer disappearing. For the AlertDialogs that have no body at all (just header + footer), no change. |
| `src/components/PairingDialog.tsx` | Already wraps in ScrollArea. Replace its custom wrapper with `<DialogBody>`. Keep the `pairing-dialog gap-0` className. |
| `src/components/block-tree/BlockDatePicker.tsx` | Uses a custom ScrollArea inside a calendar-shaped DialogContent. Likely keeps its own layout — calendar grids are fixed-size by nature. Verify on a 320×400 window before deciding. |
| `src/components/ImageLightbox.tsx` | Full-screen lightbox; no body/footer. No change. |

For each migration, the diff is small (delete custom wrapper → `<DialogBody>`), the test for each dialog should pass unchanged because DOM structure is the same set of nodes.

### 4. Lint rule (optional, low priority)

A short biome / eslint custom rule could flag bare `<DialogContent>` with more than one direct child and no `<DialogBody>` — but the biome custom-rule machinery in this repo is light, and a code-review convention plus the migrated baseline is probably enough. Skip unless this regresses again later.

## Verification

- `npm run typecheck` — primitive change is purely additive (new `DialogBody` export, modified base class string).
- `npm run test -- BugReportDialog ConfirmDialog ConfirmDestructiveAction QuickCaptureDialog WelcomeModal SpaceManage Pairing PdfViewer` — DOM trees stay equivalent for tests that check structure; tests that check dialog scrolling will benefit.
- Manual: open BugReportDialog, resize the OS window to 400 × 400. Verify (a) header + footer remain visible, (b) body scrolls smoothly, (c) the description textarea cannot be drag-resized past the frame's right edge.
- E2E: there's a `bug-report` Playwright spec — run it (`npm run e2e -- bug-report`) to confirm the structural changes don't break the existing test IDs (`bug-report-body`, `bug-report-preview`, `bug-report-logs-list`).

## Cost / impact / risk

| Dimension | Notes |
| --- | --- |
| **Cost** | S. Primitive change: ~30 min. Consumer audit + migration: ~2 h across ~12 files (mostly 2-line diffs). Tests: ~30 min. Total ≤ half a day. |
| **Impact** | Closes the "can't scroll", "controls escape the dialog", "footer disappears" classes of bugs in one place. New dialogs get the right behaviour for free. Removes the "every dialog reinvents the scroll-body pattern" footgun that produced the BugReportDialog comment block at lines 328-335. |
| **Risk** | Low. The primitive change is `display: grid → flex` + `overflow-y-auto → overflow-hidden`. Display swap is benign for grid-of-one-column layouts (which all current consumers are). Overflow swap means dialogs without a `<DialogBody>` and with content taller than the frame will *clip* instead of scroll — but this affects only dialogs that today scroll the entire frame including header/footer, and the migration adds `<DialogBody>` to all such consumers in step 3. The escape hatch is `className="overflow-y-auto"` on a specific call site if needed. |
| **Reversibility** | High. All changes are local to `src/components/ui/dialog.tsx`, `alert-dialog.tsx`, `textarea.tsx` and their consumers. Revert by reverting the commits. |

## Out of scope

- Mobile sheet variants (`ConfirmDialog` already routes to a Sheet on mobile). The Sheet primitive has its own scrolling story; not touched here.
- Any visual / token / variant changes. Pure layout-correctness fix.
- A new `DialogScrollableBody` vs `DialogBody` distinction. Keep it to one slot — consumers that don't want scroll just don't use it.

## Why this isn't done as part of an existing pending plan

Closest neighbours: `pending/design-system-ux-review-2026-05-09.md` and `pending/design-system-maintainability-2026-05-09.md` cover the broader design-system audit. Both already have their scope locked. This is a single concrete defect with a single concrete fix; folding it into either review file would dilute their cost estimates. Land it as its own commit with the migration in the same PR.
