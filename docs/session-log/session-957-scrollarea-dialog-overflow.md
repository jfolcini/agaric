# Session 957 — ScrollArea height-resolution / dialog overflow fix

**Date:** 2026-06-03
**Scope:** Fix the Report-a-bug dialog overflow (content clipped, no scroll) — and
the same latent bug everywhere the shared `ScrollArea` is used.

## Symptom

In the Report-a-bug dialog (Settings → Help → Report a bug), the lower part of the
form (logs list, confirmation checkbox) was cut off and the body could not be
scrolled to reveal it.

## Root cause (measured, not guessed)

Probed the live DOM via Playwright at a short window height:

- `DialogContent` is a `flex flex-col` capped by `max-height: calc(100dvh - 2rem)`
  only — its height is **content-driven, not "definite"**.
- The body Root (`DialogBody` = a `ScrollArea`) correctly shrank to its
  flex-resolved height (264px), but the Radix scroll **viewport** inside it
  computed `height: 672px` (its content height), not `100%` of the 264px Root.
- Per CSS §10.5, a percentage height (`h-full`, from the viewport's `size-full`)
  resolves to `auto` when the containing block's height is not explicitly
  specified. So the viewport grew to content height, overflowed the Root, was
  clipped by `overflow-hidden`, and `scrollHeight === clientHeight` → nothing to
  scroll.

This is **not** dialog-specific: every `ScrollArea` whose Root height comes from a
constraint (`max-h-*`, `flex-1`) rather than a definite height had the same latent
clip bug — confirmed on the nested preview pane (`max-h-56`, viewport 304px clipped
in a 224px Root). ~20 call sites use that pattern (TemplatePicker, the property
pickers, TagValuePicker, AddPropertyPopover, SuggestionList, KeyboardSettingsTab,
PageOutline, BlockPropertyDrawer, `SheetBody`, …).

## Fix (single primitive — `src/components/ui/scroll-area.tsx`)

Make the viewport size to the Root's *resolved* height via flexbox instead of a
percentage:

- Vertically-scrolling areas (`orientation` `vertical`/`both`): Root gets
  `flex flex-col`; viewport gets `flex-auto min-h-0` (basis `auto` keeps the
  intrinsic content height that sizes the constrained Root, while `min-h-0` lets it
  shrink below content and scroll).
- Horizontal-only areas keep `h-full` — width already resolves via normal block
  layout, so no change there (verified TabBar/Settings tabs still scroll
  horizontally and don't grow vertically).

No call-site changes needed — the fix is entirely in the shared primitive, so all
dialogs (`DialogBody`/`SheetBody`) and every `max-h-*`/`flex-1` ScrollArea benefit.

## Verification

- New `e2e/bug-report-dialog.spec.ts`: forces overflow with a short window, asserts
  `scrollHeight > clientHeight` and that `scrollTop` actually moves.
- Broad e2e sweep (62 tests) across ScrollArea-heavy suites: bug-report, settings,
  search-help, templates, property-picker, tag-management, suggestion-keyboard,
  palette — all green.
- Horizontal probe: settings tab bar scrolls (`scrollWidth 1130 > clientWidth 340`,
  `scrollLeft` reaches 790) with no vertical growth.
- `BugReportDialog` unit tests (68) green; `tsc` clean; `oxlint` clean.
