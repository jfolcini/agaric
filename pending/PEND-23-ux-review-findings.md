# PEND-23 — UX review: confirmed non-nit findings

## TL;DR

Two-round UX review of the frontend (8 parallel Round-1 discovery subagents
across tokens / primitives / shared components / forms / overlays / page
views / a11y+i18n / mobile+L-E-E states, then 4 Round-2 validation subagents
that re-opened every cited file:line and re-ran every grep). The frontend is
in **excellent shape**: CVA + Radix + `cn()` is followed everywhere, 100%
axe-presence in 147/147 component test files, 0 `forwardRef` /
`ComponentRef` / bare `<img>` / inline `<Loader2 animate-spin>` in production,
and a single canonical icon-button + Tooltip + `aria-label={t(...)}` pattern
across 315+ sites.

After validation, **~20 raw findings were dropped as false positives or
intentional/documented patterns** (full list in the "Hallucinations dropped"
section at the bottom of this file). Round-1 grep counts were also frequently
off — focus-ring duplication is **61** sites (not 21), `<TooltipProvider>` is
**67** (not ~26, but per-component nesting is the *correct* Radix pattern so
that finding was dropped entirely), `axe(` calls are **334** (not 408), `<Skeleton>`
bare is **16** (not 0). Only validated counts appear below.

What remains: **4 HIGH, 10 MEDIUM, 17 LOW** confirmed findings. None are
critical bugs. Most are small per-site fixes; two (M6 focus-ring extraction,
H3 Dialog→Sheet on mobile) are slightly more invasive but still narrow.

Cost: **S–M** if cherry-picked individually, **L** if all done in one bundle
(estimated ~30–50 LOC per item × 31 items + ~2 new shared utilities).
Risk: **low** across the board (no API shape changes, no schema migrations,
no architectural shifts). Impact: **medium** for a11y polish + design-system
consolidation; **low–medium** UX impact otherwise.

## HIGH — fix soon

### H1 — `BlockPropertyEditor` select-options dropdown lacks ARIA roles

<ref_snippet file="/home/javier/dev/agaric/src/components/BlockPropertyEditor.tsx" lines="221-231" />

The popover renders a column of bare `<button>` elements with no
`role="listbox"` on the wrapper, no `role="option"` / `aria-selected` /
`aria-activedescendant` on the buttons. Keyboard / screen-reader users get a
list of generic buttons instead of a navigable listbox. The in-repo correct
reference is `TagValuePicker.tsx:174–183`.

**Fix:** add the four ARIA attributes (cheaper) or migrate to Radix Select /
cmdk (more invasive but uniform with the rest of the picker layer). Cost:
~30 LOC + 1 test. Risk: low.

### H2 — `BootGate` diagnostic uses bare `overflow-x-auto`

<ref_snippet file="/home/javier/dev/agaric/src/components/BootGate.tsx" lines="113-113" />

The single production-side hit of the bare-overflow anti-pattern in the
entire repo. All other `overflow-(y|x|)auto` matches (24 of 25) are in tests
or comments. The diagnostic `<pre>` should use `ScrollArea` for momentum
scroll on mobile and consistent scrollbar styling.

**Fix:** wrap the `<pre>` in `<ScrollArea>` or apply the established
`ScrollArea` shell pattern used in `App.tsx`. Cost: ~5 LOC. Risk: trivial.

### H3 — Dialogs do not adapt to a Sheet on mobile

`ConfirmDialog`, `BugReportDialog`, `HistoryRestoreDialog` (wraps
`ConfirmDialog`), `ConflictKeepDialog` (wraps `ConfirmDialog`),
`PdfViewerDialog`, `RenameDialog`, `WelcomeModal`, `QuickCaptureDialog`, etc.
all render `Dialog` / `AlertDialog` unconditionally regardless of viewport.
On <600 px phones this leaves cramped modals with poor reach for action
buttons.

<ref_file file="/home/javier/dev/agaric/src/components/ConfirmDialog.tsx" />

**Fix:** introduce `useDialogOrSheet()` (or a `<ResponsiveDialog>`
component) that returns a Dialog on `useIsMobile() === false` and a Sheet
(`side="bottom"`) on mobile. Apply to `ConfirmDialog` first, then propagate
to consumers that wrap it. Cost: M (~3–5 h, +1 hook + ~3 callsite touches +
tests on both render paths). Risk: low — both Dialog and Sheet are Radix-based
with compatible `open`/`onOpenChange` APIs.

### H4 — Three primitive test files are empty

<ref_file file="/home/javier/dev/agaric/src/components/ui/**tests**/checkbox.test.tsx" />

<ref_file file="/home/javier/dev/agaric/src/components/ui/**tests**/input.test.tsx" />

<ref_file file="/home/javier/dev/agaric/src/components/ui/**tests**/label.test.tsx" />

All three are 0 bytes. These are core form-control primitives used across
the entire app. The `axe-presence` pre-commit hook only enforces presence of
`axe(` per *non-empty* test file, so an empty file slips through.

**Fix:** mirror `button.test.tsx` / `textarea.test.tsx` — render + variants +
controlled/uncontrolled interaction + disabled + axe. Consider tightening the
`axe-presence` hook to also reject 0-byte test files. Cost: ~250 LOC across
3 files. Risk: trivial.

## MEDIUM — incremental cleanup

### M1 — `DateChipEditor` ignores its own `currentDate` prop

<ref_snippet file="/home/javier/dev/agaric/src/components/DateChipEditor.tsx" lines="42-49" />

The component destructures `currentDate: _currentDate` (prefixed with `_` to
silence the unused-variable warning) and never passes it to `useDateInput()`,
which defaults `initialValue = ''`. Result: opening the editor on a block
that already has a due date shows an empty input instead of the existing
value.

**Fix:** `useDateInput({ initialValue: currentDate ?? '' })`. Add a regression
test asserting the input pre-fills. Cost: 1 LOC + 1 test. Risk: trivial.

### M2 — `TagValuePicker` swallows search errors silently

<ref_snippet file="/home/javier/dev/agaric/src/components/TagValuePicker.tsx" lines="40-56" />

`.catch { setResults([]); setActiveIndex(-1) }` with no `logger.warn` /
`logger.error`. Violates the documented "no silent catch" rule (AGENTS.md
"Anti-patterns" §). All other IPC error sites in the codebase log via
`logger.warn` (see `LinkEditPopover.tsx:147` for the pattern).

**Fix:** add
`logger.warn('TagValuePicker', 'failed to search tags', { prefix }, err)`
before clearing results. Cost: ~3 LOC + 1 test (mock `listTagsByPrefix`
to reject, assert `logger.warn` called, assert results cleared). Risk:
trivial.

### M3 — `PopoverContent` lacks `aria-label` on most menu/filter popovers

Verified gaps (PopoverContent has no `aria-label` and no inner element
labelling the popover as a whole):

- <ref_snippet file="/home/javier/dev/agaric/src/components/PropertyDefinitionsList.tsx" lines="316-316" />
- <ref_snippet file="/home/javier/dev/agaric/src/components/BlockPropertyDrawer.tsx" lines="439-439" />
- <ref_snippet file="/home/javier/dev/agaric/src/components/GraphFilterBar.tsx" lines="473-473" />
- <ref_snippet file="/home/javier/dev/agaric/src/components/HistoryFilterBar.tsx" lines="129-129" />
- <ref_snippet file="/home/javier/dev/agaric/src/components/PeerListItem.tsx" lines="135-135" />

`SearchablePopover.tsx:146` and `TagList.tsx:261` partially label inner
elements (input or fieldset) — those are softer cases, the popover container
itself still benefits from a label. Radix Popover does not auto-derive a
label from the trigger.

**Fix:** add `aria-label={t(...)}` to each `PopoverContent`. Reuse / add
i18n keys per popover purpose (filter, picker, menu, settings panel). Cost:
~10 LOC across 5–7 files + i18n key additions. Risk: trivial.

### M4 — `QuickCaptureDialog` has redundant + misapplied `aria-label`s

<ref_snippet file="/home/javier/dev/agaric/src/components/QuickCaptureDialog.tsx" lines="108-128" />

`DialogContent` has `aria-label={t('quickCapture.dialogTitle')}` *and* a
`<DialogTitle>` with the same string — Radix already derives the dialog
label from `DialogTitle`, so the explicit `aria-label` is duplicate noise.
The inner `Textarea` then *also* receives `aria-label={t('quickCapture.dialogTitle')}`,
which mislabels the textarea as the dialog title rather than as a capture
input.

**Fix:** drop `DialogContent`'s `aria-label`; give the textarea its own
i18n key (`'quickCapture.captureInputLabel'` or similar). Cost: ~5 LOC + 1
test. Risk: trivial.

### M5 — `.theme-solarized-dark` is missing accent-palette overrides

<ref_snippet file="/home/javier/dev/agaric/src/index.css" lines="486-796" />

The Solarized-dark theme defines all the standard semantic tokens
(background, foreground, status, priority, …) but **does not override the
accent palette** (`--accent-emerald`, `--accent-blue`, `--accent-violet`,
`--accent-amber`, `--accent-rose`, `--accent-slate`, `--accent-orange`).
Because the same tokens are defined in the default `.dark` block (lines
~366–373), the actual fallback is to the default-dark accent palette — not
catastrophic, but it makes the Solarized-dark `SpaceAccentBadge` visually
inconsistent with the rest of the theme.

**Fix:** add accent overrides inside `.theme-solarized-dark { ... }` with
OKLch values appropriate for a Solarized-dark background. Cost: ~7 lines.
Risk: trivial. Coordinate with PEND-11 (space indicator redesign) if it
touches the same tokens.

### M6 — Focus-ring pattern duplicated 61 times

The pattern
`focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden`
appears verbatim 61 times across `src/components/`. (Round 1 said 21; the
validator's grep returned 61.) The pattern itself is correct — the issue is
the repetition: changing the ring width, color, or offset requires touching
61 files instead of one.

A `.focus-ring` `@utility` already exists at `src/index.css:842` for an
*unrelated* `px-3 py-1 outline-none` shape, so the file already has the
right tooling for the extraction.

**Fix:** add (or rename to free the slot) a `@utility focus-ring-visible`
with the exact CSS, then run a grep-and-replace pass. Verified callsites
include
`CollapsiblePanelHeader.tsx:32`,
`BlockInlineControls.tsx:193,216,237,321`,
`SearchablePopover.tsx:179`,
`PropertyChip.tsx:48,71`.
(Round 1 also cited `BlockGutterControls.tsx:73` and `RenameDialog.tsx:132`
— those were validated as miscites: the former already uses a
`focus-ring`-style utility via `GUTTER_BUTTON_BASE`, the latter has no
custom focus-visible styling at all.)

This finding also subsumes L12 (a few `outline-none` callsites that lack a
focus-visible replacement) — the same utility solves both. Cost: M (~50 LOC
deletion across 50+ files, no behavior change). Risk: low if done with care.

### M7 — `SectionTitle` accepts a raw `color: string` prop

<ref_snippet file="/home/javier/dev/agaric/src/components/ui/section-title.tsx" lines="1-22" />

The component takes `color: string` and forwards it directly to `cn()`. Its
own test file passes `text-red-500`. This is exactly the "Never hardcode
Tailwind color classes" anti-pattern called out in AGENTS.md "Mandatory
patterns".

**Fix:** constrain to a semantic union (e.g.,
`color?: 'done' | 'active' | 'pending' | 'overdue' | 'default'`) and map
internally to `text-status-*` tokens. Update the existing test. Cost:
~15 LOC + test update + grep callers (small surface). Risk: low — the
component has few callers; any caller passing a non-semantic class will
surface as a TS error.

### M8 — `Input` font-size is unconditionally `text-sm`

<ref_snippet file="/home/javier/dev/agaric/src/components/ui/input.tsx" lines="11-13" />

Touch-target *height* correctly bumps to `h-11` on `[@media(pointer:coarse)]`
but the font remains 14 px. Two consequences: (a) reduced legibility on
phones, and (b) if the app is ever shipped on iOS WebView (Tauri 2 mobile),
Safari triggers zoom-on-focus for `<input>` with font-size <16 px.

**Fix:** add `[@media(pointer:coarse)]:text-base` to the base className
string. Cost: ~1 LOC. Risk: trivial. Apply the same to `Textarea` /
`SearchInput` for consistency if a quick check shows the same issue.

### M9 — `GraphView` error state is set but not consistently rendered

<ref_snippet file="/home/javier/dev/agaric/src/components/GraphView.tsx" lines="78-78" />

Line 78 declares `const [error, setError] = useState<string | null>(null)`,
line 142 calls `setError(t('graph.loadFailed'))`, but the conditional
rendering of the error string in the JSX is not consistent with how Loading
/ Empty are handled. Result: a fetch failure can leave the user staring at
an empty graph with no surfaced explanation.

**Fix:** add an explicit branch after the loading guard:
`if (error) return <EmptyState icon={AlertCircle} message={error} />` (or
the equivalent inline error card pattern used in `HistoryView`). Cost:
~5–10 LOC + test. Risk: low.

### M10 — `DonePanel` and `DuePanel` duplicate keyboard-nav setup

<ref_snippet file="/home/javier/dev/agaric/src/components/DonePanel.tsx" lines="162-192" />

<ref_snippet file="/home/javier/dev/agaric/src/components/DuePanel.tsx" lines="123-193" />

Both panels stand up `useListKeyboardNavigation` with the same options
(`homeEnd: true`, `pageUpDown: true`), the same focus-into-view effect, and
the same reset-on-filter-change logic. ~30 LOC duplicated across the two
files.

**Fix:** extract `useKeyboardNavigableList(itemCount, onSelect, options?)`
that returns `{ focusedIndex, setFocusedIndex, handleKeyDown, listRef }` and
internally wraps `useListKeyboardNavigation` + the scroll-into-view effect.
Cost: ~80 LOC (new hook + 2 panel call-site shrinks + tests). Risk: low.

## LOW — polish / consistency

### L1 — `EmptyState` is a plain `<div>` with no landmark

<ref_snippet file="/home/javier/dev/agaric/src/components/EmptyState.tsx" lines="19-31" />

Promote the wrapper to `<section role="region" aria-label={message}>` so
screen readers can navigate to / past the empty state as a distinct region.
Cost: ~3 LOC + tweak existing tests.

### L2 — `LinkEditPopover` URL validation is spread across the file

<ref_snippet file="/home/javier/dev/agaric/src/components/LinkEditPopover.tsx" lines="45-100" />

`normalizeUrl()` (line ~63) and inline checks in `handleApply()` (line ~97)
share a hardcoded blocked-scheme list. Extract `src/lib/url-validation.ts`
with a unit-tested `normalizeUrl(raw)` and `isAllowedUrl(url)` API. Cost:
~60 LOC (new file + tests + 1 callsite). Risk: trivial. Light security
benefit (centralizes the scheme list).

### L3 — `SpaceManageDialog` accent swatches use hardcoded Tailwind colors

<ref_snippet file="/home/javier/dev/agaric/src/components/SpaceManageDialog.tsx" lines="86-93" />

The `ACCENT_SWATCHES` array stores both a `token` (CSS var name like
`'accent-blue'`) *and* a `className` like `'bg-blue-500'`. The CSS var is
the source of truth, but the swatch preview uses the hardcoded class — so
theme switching does not update the swatch colors.

**Fix:** drop the `className` field; render with
`<span style={{ backgroundColor: \`var(--${swatch.token})\` }} />`. Cost:
~5 LOC. Risk: trivial. Resolves the same finding A1 surfaced for the
design-token review.

### L4 — `LoadingSkeleton` always defaults to `h-4`

<ref_snippet file="/home/javier/dev/agaric/src/components/LoadingSkeleton.tsx" lines="12-29" />

Many call sites override `height` to match list-row heights or table-row
heights. Add a `variant?: 'text' | 'heading' | 'button' | 'list-row'` enum
that maps to sensible defaults (`h-4`, `h-6`, `h-9`, `h-11`). Keep `height`
as an escape hatch. Cost: ~15 LOC + tests.

### L5 — `DiffDisplay` hunk counter has no `aria-live`

<ref_snippet file="/home/javier/dev/agaric/src/components/DiffDisplay.tsx" lines="170-180" />

The "Hunk X of Y" counter is a plain `<span>`. SR users navigating with the
prev/next buttons don't hear the position change. Wrap in
`<span aria-live="polite" aria-atomic="true">`. (Note: the prev/next buttons
themselves correctly use native `disabled` — Round 1's claim that they need
`aria-disabled` was misclassified; that part of the original finding is
dropped.) Cost: ~3 LOC.

### L6 — `PeerListItem` IP-address input is placeholder-only

<ref_snippet file="/home/javier/dev/agaric/src/components/PeerListItem.tsx" lines="135-144" />

The popover has a small `<p>` title above the input but no `<Label>` or
`aria-label` on the `<Input>` itself. Add `aria-label={t('device.peerAddress')}`
(or equivalent). Cost: ~2 LOC + i18n key.

### L7 — `BugReportDialog` nested log-preview Dialog has no `autoFocus`

<ref_snippet file="/home/javier/dev/agaric/src/components/BugReportDialog.tsx" lines="525-600" />

When the preview dialog opens, focus is not explicitly placed on a focusable
element. Add `autoFocus` to the close button (or pass `initialFocus` ref).
Cost: ~3 LOC.

### L8 — `Toaster` position hardcoded `bottom-right`

<ref_snippet file="/home/javier/dev/agaric/src/App.tsx" lines="510-515" />

On mobile this overlaps the thumb-reach / nav-bar area. Make the position
responsive: `position={isMobile ? 'top-center' : 'bottom-right'}`. Cost:
~3 LOC.

### L9 — Popover widths inconsistent + a few omit viewport-clamp

Audited widths across consumers: `w-56`, `w-64`, `w-72`, `w-80` all appear,
and several callsites (e.g., `GraphFilterBar.tsx:473`) omit
`max-w-[calc(100vw-2rem)]`, allowing overflow on small viewports. Pick a
canonical class string (`w-64 max-w-[calc(100vw-1.5rem)]` or similar) and
either codify it in a thin `MenuPopoverContent` wrapper or document it in
`AGENTS.md` "Frontend Development Guidelines". Cost: ~30 LOC across 8–10
files (or ~20 LOC for a wrapper).

### L10 — `--ring` contrast is identical light/dark and consumed at `/50` opacity

<ref_snippet file="/home/javier/dev/agaric/src/index.css" lines="135-140" />

`--ring: oklch(0.55 0.188 28.71)` is the same value in `:root` and `.dark`,
and the focus-ring pattern applies it at 50% opacity. Round 1 claimed a
WCAG 2.4.7 violation but did **not actually measure** the contrast, so this
is filed as "measure first, then act". Run a contrast check (e.g., against
`--background` light ≈ `oklch(1 0 0)` and dark) and either drop the `/50`
or give `--ring` per-theme values matching the chroma adjustment used in
`prefers-contrast: more` (lines 1100–1107). Cost: ~30 min audit + ≤5 LOC.

### L11 — Two task-state tokens are duplicated between light and dark

<ref_snippet file="/home/javier/dev/agaric/src/index.css" lines="200-203" />

Validated: `--task-done` and `--task-doing` are identical between the
`:root` (lines 200–203) and `.dark` (lines 344–347) blocks; `--task-cancelled`
and `--task-custom` *do* differ. (Round 1 claimed all four were identical.)
Adjust the two truly-duplicated tokens for dark backgrounds. Cost: ~2 lines.

### L12 — A few `outline-none` usages lack a focus-visible replacement

Verified offenders:

- <ref_snippet file="/home/javier/dev/agaric/src/components/JournalPage.tsx" lines="145-145" /> — `focus:outline-none` (not `focus-visible`) and no replacement ring.
- <ref_snippet file="/home/javier/dev/agaric/src/components/UnlinkedReferences.tsx" lines="367-367" /> — bare `outline-none` with no focus-visible ring.
- <ref_snippet file="/home/javier/dev/agaric/src/App.tsx" lines="452-452" /> — bare `outline-none` with no focus-visible ring.

Most of the other 20+ `outline-none` callsites *are* paired correctly. Fold
into M6 (focus-ring extraction) — applying the new utility to these three
sites is the cheapest fix. Cost: ~6 LOC if rolled into M6, separate
otherwise.

### L13 — Scroll-to-focus pattern duplicated

<ref_snippet file="/home/javier/dev/agaric/src/components/JournalPage.tsx" lines="84-90" />

<ref_snippet file="/home/javier/dev/agaric/src/components/journal/DailyView.tsx" lines="35-43" />

Both use `requestAnimationFrame` + `scrollIntoView` with different selectors
and options. Extract `useScrollToFocus(targetId, options?)` in `src/hooks/`.
Cost: ~50 LOC (new hook + 2 callsite shrinks + tests). Risk: low.

### L14 — `AttachmentList` delete-via-toast hardcodes a 3000 ms confirm window

<ref_snippet file="/home/javier/dev/agaric/src/components/AttachmentList.tsx" lines="50-80" />

Two acceptable fixes: (a) extract the timeout to a named constant alongside
the rest of the toast/UX constants; or (b) replace the toast-based
two-click delete with a `ConfirmDestructiveAction` dialog (more aggressive
UX change, brings the component in line with the rest of the destructive
pattern). Cost: (a) ~5 LOC; (b) ~30 LOC + design call.

### L15 — `ConfirmDestructiveAction` lacks a pending Spinner

<ref_snippet file="/home/javier/dev/agaric/src/components/ConfirmDestructiveAction.tsx" lines="125-140" />

`ConfirmDialog.tsx:101` renders `{loading && <Spinner />}` inside the
action button; `ConfirmDestructiveAction` only disables the button. UX
inconsistency between the two confirm components. Add the same Spinner
render to match. Cost: ~5 LOC + test.

### L16 — `FilterSortControls` direction-toggle is narrow on touch

<ref_snippet file="/home/javier/dev/agaric/src/components/FilterSortControls.tsx" lines="60-80" />

`min-h-[44px]` is set on `[@media(pointer:coarse)]` but `px-1` keeps the
*horizontal* footprint well under 44 px. Either bump to
`[@media(pointer:coarse)]:px-2` or migrate to Button `size="icon-sm"` (which
has square 44 × 44 sizing on coarse pointers). Cost: ~3 LOC.

### L17 — `StatusIcon` and `PriorityBadge` hardcode their size

<ref_snippet file="/home/javier/dev/agaric/src/components/ui/status-icon.tsx" lines="30-58" />

<ref_snippet file="/home/javier/dev/agaric/src/components/ui/priority-badge.tsx" lines="15-25" />

Both render at a fixed `h-4` / `h-4 min-w-4`. Add `sm` / `md` / `lg` CVA
size variants modeled after `Spinner` so callers can scale them in dense
list rows or large header chips without inline overrides. Cost: ~30 LOC
across both files + tests.

## Hallucinations dropped (do not reopen)

Round 1 surfaced these as findings; Round 2 disproved each by re-opening
the cited file:line. Listed here so they don't get re-raised.

- **`SectionTitle` missing `data-slot`** — it has `data-slot="section-title"` at line 17.
- **`RichContentRenderer` Suspense missing fallback** — fallback exists at lines 453–466 (Spinner + loading message).
- **`PropertyRowEditor` / `PropertyValuePicker` / `TagValuePicker` `h-7` overrides suppress touch targets** — Tailwind media-query variants in the `Input` primitive's base class (`[@media(pointer:coarse)]:h-11`) win over a className override of `h-7`. Actual touch height is 44 px.
- **`BlockPropertyEditor` uses `onPointerDown` instead of `onClick`** — the button handlers are `onClick`; the reviewer confused them with an outside-click `pointerdown` document listener at lines 114–137.
- **`BugReportDialog` has no required-field signal** — title is intentionally optional; the actually-required confirmation checkbox at lines 465–487 is `aria-required="true"` with a visual asterisk.
- **`BlockGutterControls` touch sizing inconsistent** — both `GUTTER_BUTTON_BASE` and `SHEET_ROW_CLASS` include the `touch-target` utility (44 × 44 on coarse).
- **`LinkEditPopover` IPC error is silent** — the catch at line 147 calls `logger.warn`. (Test-coverage of the rejection path is a separate, valid item, but not "silent error swallowing".)
- **`<Skeleton>` bare = 0** — actual count is **16**. Bare `<Skeleton>` is acceptable when used inside the `LoadingSkeleton` wrapper or for one-off skeleton shapes; the "0" claim was simply wrong.
- **`forwardRef` ⇒ "20+ deprecated wrappers"** — actual count: **0**. React 19 migration is complete.
- **`PopoverMenuItem` "underused"** — actual count: **31** call sites. Well integrated.
- **`<TooltipProvider>` per-component nesting (67 occurrences) is HIGH inefficiency** — per-component nesting is the *correct* Radix pattern for isolated tooltips. Drop the finding (or downgrade to NIT cleanup if the team wants a single root provider).
- **`axe()` "408 calls"** — actual: **334** calls in **147** test files. The pre-commit hook enforces presence-per-file, not a total count.
- **Breadcrumb deviates from the focus-ring standard** — the deviation is documented in-file (FEAT-13 reference) and intentional for text-link semantics. Accepted exception.
- **`AddPropertyPopover`'s `<span tabIndex={0}>` workaround for disabled-trigger Tooltip** — standard Radix workaround, has a `biome-ignore` plus an explanatory comment. Accepted exception.
- **`logger.ts:155–157` `.catch(() => {})`** — has an explicit comment marking it as the sole, intentional exception (recursion-prevention through the logging IPC). Accepted exception.
- **`ConfirmDialog` vs `ConfirmDestructiveAction` "duplicate logic"** — different APIs by design (generic vs destructive-only with i18n keys + async error handling). Not a duplication bug. (Note: L15 still applies — the *pending Spinner* parity gap is the only real subset of this finding.)
- **`SpaceAccentBadge` and `SpaceStatusChip` duplicating `accentVar()`** — `SpaceStatusChip.tsx:38–40` has an explicit comment documenting this as intentional (kept private to each module). Accepted exception. (Note: L3 *does* still apply — the swatch's hardcoded Tailwind colors are unrelated.)
- **`DependencyIndicator` silent best-effort fallback** — actually does call `logger.warn`. Not silent.
- **`BlockInlineControls` re-exports `dueDateColor` / `formatCompactDate` / `MONTH_SHORT`** — intentional MAINT-94 / MAINT-129 deprecation shims with comments. Accepted exception.
- **`DiffDisplay` thresholds (`LARGE_DIFF_THRESHOLD = 500`, `COLLAPSED_SPAN_COUNT = 100`) are hardcoded** — documented module-level constants, parametrizing them would over-parameterize the component.

Round-1 grep undercounts that should not be reused as evidence in any
follow-up:

- focus-ring pattern: claimed 21, actual **61**
- `<TooltipProvider>`: claimed ~26, actual **67** (but the finding itself was dropped, so this only matters if revisiting the original framing)
- `axe()` calls: claimed 408, actual **334**
- `<Skeleton>` bare: claimed 0, actual **16**
- `toLocaleDateString`: claimed 19, actual **18**
- `outline-none` "all paired with focus-visible:ring": 3 of 5 spot-checked sites are unpaired (now folded into L12 / M6).
- `<div onClick>` "all on backdrops": 1 of 3 is a test fixture (`PageLink.test.tsx:87`).

## Suggested ordering

If picking individual items off this list:

1. **H1, H2, H4** — small, mechanical, remove real a11y / consistency gaps quickly. Total ~1–2 h.
2. **M1, M2, M4** — single-file fixes with clear acceptance criteria. Total ~1 h.
3. **M3, L6** — `aria-label`/labelling pass, batch them in one commit. Total ~1 h.
4. **M6 + L12** — extract the focus-ring utility once, apply to all 61+ sites. ~2–3 h.
5. **M7** — tighten `SectionTitle`'s color prop. ~30 min.
6. **L3 + M5** — accent palette consistency (two related design-token fixes in `index.css`). ~1 h together.
7. **H3** — design + implementation of `useDialogOrSheet()`. M (3–5 h).
8. **M8, M9, M10, L13** — incremental ergonomics work. ~2–3 h together.
9. The remaining LOWs are good first issues.

Total: roughly **12–18 h** if everything ships. Most items can land
independently — there are no inter-dependencies beyond M6 ⊃ L12 and the
explicit suggestion to bundle L3 with M5.

## Notes for follow-up sessions

- AGENTS.md "Anti-patterns" / "Common frontend review catches" list is
  current and accurate; nothing in this review suggests adding a new
  anti-pattern entry. The one addition worth considering is codifying the
  canonical icon-button pattern (Radix `Tooltip` + `Button size="icon"` +
  `aria-label={t(...)}`), which is followed everywhere but not formally
  documented.
- The `axe-presence` pre-commit hook should reject 0-byte test files (see
  H4) — small adjustment to `scripts/check-axe-presence.sh`.
- A future code-review session should treat all Round-1 grep counts with
  suspicion: this review surfaced four counts that were off by ≥2× and one
  that was a clean false positive. Round-2 validation is non-negotiable for
  numerical claims.
