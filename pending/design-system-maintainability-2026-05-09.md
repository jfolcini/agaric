# Design-system maintainability — close the verified findings

> **Status:** Phase 1 partially shipped. Items 1a (ARCHITECTURE.md inventory
> refresh), 1b (focus-ring-visible utility migration across 13 production
> files + 6 test files), 1c (tests for `recent-page-chip` and `toggle-group`),
> and 1e (TagList `pickReadableForeground` helper + `--shadow-accent-stroke`
> token replacing the two `drop-shadow-[…]` arbitrary classes) all shipped.
> Phase 2 partial: **2a** (cn() merge order unified across Button / Label /
> Spinner to the Badge form `cn(variants(...), className)`), **2b**
> (`asChild` polymorphism added to `card-button`, `list-item`,
> `alert-list-item`, `recent-page-chip`, `popover-menu-item`), and **2d**
> (MetricCard + SectionGroupHeader + FormField extracted; StatusPanel,
> DuePanel, DonePanel, AppearanceTab migrated; primitive inventory bumped
> 38 → 41) shipped.
> **Still open:** 1d (text-[10px] decision needs a design pass), Phase 2
> item 2c (badge-family consolidation), Phase 3 structural moves.
> Tiers remain independent — Tier 1 is mechanical cleanup, Tier 2 is API
> consolidation that pays back over time, Tier 3 is the bigger structural
> moves that need more thought before scheduling.

## Why this exists

A two-round design-system audit (five parallel Explore agents in Round 1,
verification grep pass in Round 2) found the system is in better shape
than the surface suggests: tokens are coherent, `prek` hooks already
guard raw-color drift (`no-hsl-rgb-var-wrap` at `prek.toml:72`), React 19
ref-as-prop is fully adopted (zero `forwardRef` in `src/components`),
and the `axe-presence` hook keeps a11y honest in tests.

What it found is **drift around the edges**: a half-finished focus-ring
utility migration, a stale primitive inventory in `ARCHITECTURE.md`, a
fragmented badge-family API, and a few duplication clusters that have
crystallised into reusable shapes nobody has extracted yet.

This plan groups every confirmed issue into phases that are
independently approve-able. Round-1 claims that did not survive Round-2
verification (notably "219 hex/rgb/hsl leaks" and "6 untested
primitives") are excluded — the real numbers are smaller and addressed
where they matter.

---

## Phase 1 — Mechanical cleanup (Tier 1)

**Goal:** kill the small, well-localised drift items. Each step is
~15-60 minutes and lands as its own commit.

### 1a. Refresh `ARCHITECTURE.md` primitive inventory

`ARCHITECTURE.md:1024` claims "120+ domain + 29 shadcn/ui + 1 editor =
150+ total". The list at `ARCHITECTURE.md:1048` enumerates 29
primitives. Reality: 37 `.tsx` files in `src/components/ui/`.

Missing from the doc: `breadcrumb`, `checkbox`, `menu-popover-content`,
`recent-page-chip`, `search-input`, `switch`, `textarea`, `toggle-group`.

**Change:** add the 8 missing primitives to the inventory list and bump
the count (`29` → `37`, `150+` → `158+`).

### 1b. Finish the `focus-ring-visible` utility migration

`src/index.css:1228` defines `@utility focus-ring-visible { @apply
focus-visible:ring-[3px] focus-visible:ring-ring/50; }`. 48 component
files use it. 20 still inline the raw classes.

**Change:** replace the inline form with the utility class in:

| File | Notes |
| --- | --- |
| `src/components/ui/button.tsx` | also drops a `focus-visible:border-ring` that the utility already covers |
| `src/components/ui/sidebar.tsx` | one occurrence inside a long className (line ~821) |
| `src/components/ui/scroll-area.tsx` | scrollbar thumb |
| `src/components/PageLink.tsx` | |
| `src/components/TabBar.tsx` | |
| `src/components/PageOutline.tsx` | |
| `src/components/PageHeaderMenu.tsx` | |
| `src/components/SpaceAccentBadge.tsx` | |
| (+ remaining 12 files surfaced by `grep -rl 'focus-visible:ring-\[3px\]' src/components`) | |

Test files also reference the literal class string (e.g.
`AddPropertyPopover.test.tsx`); leave those alone — they're asserting on
the rendered output and will keep passing once the utility resolves to
the same classes.

**Optional follow-up:** add a `prek` guard
(`no-inline-focus-ring`) so the migration doesn't drift back. Mirror
the pattern of `no-hsl-rgb-var-wrap` (`prek.toml:72`).

### 1c. Add tests for the two truly untested primitives

`src/components/ui/__tests__/primitives.test.tsx` already covers
`Spinner`, `CardButton`, `CloseButtonIcon`, `Label`, `ListItem`. The
genuinely uncovered primitives are:

- `recent-page-chip.tsx`
- `toggle-group.tsx`

**Change:** extend `primitives.test.tsx` with render + interaction +
`axe(container)` assertions for both, matching the existing block
structure. Same convention is enforced by the `axe-presence` `prek`
hook (`prek.toml:160`).

### 1d. Decide on the `text-[10px]` gap

27 occurrences of `text-[10px]` exist across the codebase. The token
scale jumps from `--text-xs: 12px` to nothing smaller. There's a
recorded comment in `src/components/PeerListItem.tsx:168` ("UX-12:
bumped from text-[10px] to text-xs") showing the team has noticed this.

Two viable options — pick one:

- **Option A: add `--text-xxs: 10px`** to `src/index.css` alongside
  `--text-xs`, expose via Tailwind `@theme`, replace the 27 arbitraries.
  Cost: small. Hazard: encourages 10px usage that may be too small for
  touch.
- **Option B: collapse all `text-[10px]` to `text-xs`** and accept that
  10px is not a token. Cost: small. Hazard: visual change in 27 places
  — needs a design pass before merging.

Recommendation: Option B. The cases I sampled
(`PageHeaderMenu.tsx:117`, `BacklinkGroupRenderer.tsx:70`,
`BlockPropertyDrawer.tsx:480-486`) are mostly meta-info chrome that
12px would not visually break.

### 1e. Two stray inline-color hot spots

These are the only real drift items the verified count surfaced:

- `src/components/TagList.tsx:234` — `style={{ backgroundColor: color,
  color: '#fff' }}`. The background is user-supplied; the `'#fff'`
  foreground is hard-coded and may fail contrast on light pastel tags.
  Replace `'#fff'` with a contrast-aware computation (or accept it and
  document the WCAG note).
- `src/components/SpaceManageDialog.tsx:187` and
  `src/components/SpaceManageDialog/SpaceAccentPicker.tsx:107` —
  `drop-shadow-[0_0_1.5px_rgb(0_0_0/0.9)]`. Either lift to a
  `--shadow-accent-stroke` token in `index.css` or accept it and add an
  inline comment explaining why a token isn't a fit (the stroke is a
  legibility outline, not a brand shadow).

### Phase 1 cost / impact / risk

- **Cost:** ~half a day total across all five steps.
- **Impact:** removes the easy-to-quote "design-system drift" pointers,
  brings doc parity with code, finishes a visible half-migration.
- **Risk:** very low. Each step is mechanical and reversible. Step 1d
  is the only one with a visible UI change — gate it on a quick design
  pass.

---

## Phase 2 — API consolidation (Tier 2)

**Goal:** remove cognitive tax in the primitive layer so feature
authors don't have to learn three near-identical APIs.

### 2a. Unify `cn()` merge order between Button and Badge — **closed**

`button.tsx:59` (now `:61`) used to call `cn(buttonVariants({ variant,
size, className }))` — passing `className` *into* the CVA invocation.
`badge.tsx:42` calls `cn(badgeVariants({ variant }), className)` —
passing it *alongside*.

Both end up funnelled through `twMerge` so the user-facing override
behavior is the same. The cost was contributor cognitive load: every
new primitive copied one of the two patterns, and reviewers had to
spot which.

**Done:** standardised on `cn(variants(...), className)` (the Badge
form — clearer that caller `className` overrides). Migrated sites
(grep of `cn(\w+Variants({...className}))` across `src/components/ui/`):

- `src/components/ui/button.tsx:61` — `cn(buttonVariants({ variant, size }), className)`
- `src/components/ui/label.tsx:38` — `cn(labelVariants({ size, muted }), className)`
- `src/components/ui/spinner.tsx:37` — `cn(spinnerVariants({ size }), className)`

No other in-tree primitive used the Button form. `badge.tsx`, `priority-badge.tsx`,
`popover-menu-item.tsx`, `alert-list-item.tsx`, `sidebar.tsx` already
used the `cn(variants(...), className)` form.

### 2b. Add `asChild` polymorphism to composite primitives — **closed**

The following primitives were hard-coded to a single DOM element and
could not be composed via Radix `Slot`:

| Primitive | Default tag | `asChild` shipped |
| --- | --- | --- |
| `card-button.tsx` | `<button>` | yes — `Slot.Root` swap; `type="button"` only emitted on the native path so it does not leak onto `<a>` children |
| `list-item.tsx` | `<li>` | yes |
| `alert-list-item.tsx` | `<li>` | yes (preserves `variant` CVA) |
| `recent-page-chip.tsx` | `<button>` | yes — `type` only emitted on the native path |
| `popover-menu-item.tsx` | `<button>` | yes — `type` and the native `disabled` attribute only emitted on the native path; the CVA `disabled` styling class still applies in both modes |

**Done:** each got the same Slot treatment Button/Badge use:

```tsx
const Comp = asChild ? Slot.Root : 'button' /* or 'li' */
```

Added unit tests on each primitive's existing test file that pass
`asChild` + `<a href="…">` and assert the rendered element is `<a>`
with the merged className, the primitive's `data-slot`, and (for the
button-rooted three) that `type="button"` does not leak onto the
anchor:

- `src/components/ui/__tests__/primitives.test.tsx` — CardButton,
  ListItem, RecentPageChip asChild tests
- `src/components/ui/__tests__/alert-list-item.test.tsx` — AlertListItem
- `src/components/ui/__tests__/popover-menu-item.test.tsx` — PopoverMenuItem

Existing tests of these primitives that assert the root element is
`<button>` / `<li>` keep passing because `asChild` defaults to `false`
(opt-in). No consumer call sites were touched.

### 2c. Consolidate the badge-family API — **closed**

Today the badge family is fragmented:

| Primitive | Discriminator prop | Notes |
| --- | --- | --- |
| `badge.tsx` | `variant` (6 values) | the canonical one |
| `status-badge.tsx` | **`state`** (5 values) | non-standard prop name |
| `priority-badge.tsx` | `size` only; color via `priorityColor()` runtime fn | color is a runtime computation, not a CVA variant |
| `filter-pill.tsx` | wraps Badge with hard-coded `variant="secondary"` + a remove button | composition, fine |
| `recent-page-chip.tsx` | own button shape | not a badge but in the same visual neighbourhood |

**Change:** introduce a unified `Badge` with axes `intent` (`default |
secondary | destructive | status | priority | …`) and `size`, with
state/priority handled as `intent` values rather than parallel
primitives. Keep `FilterPill` and `RecentPageChip` as thin compositions
on top.

This is a ~1-PR migration, not a gradual deprecation — the overlap is
small enough (5 files in `ui/`, ~20-30 callers) that long-lived
compatibility shims would cost more than they save.

**Sequencing:** do this **after** 2b. `asChild` lets the unified Badge
render as the right element type for each call site without the
per-primitive composition workarounds we have today.

**Done.** `Badge` now exposes three orthogonal axes — `tone`
(`default | secondary | destructive | outline | ghost | link |
priority | status`), `size` (`xs | sm | compact | default | lg`),
`shape` (`pill | rounded`) — plus `statusState` / `priorityLevel`
props that drive the colour for the `status` and `priority` tones.
The `priority` tone delegates to the existing `priorityColor()`
utility (UX-201b, index-based) instead of duplicating the
level→token map. The legacy `variant` prop is preserved as a 1:1
alias for `tone` so unrelated callers do not need to be touched.
`compact` size matches the legacy `StatusBadge` chrome (`px-1
py-0.5`, no fixed height); `sm` matches the legacy `PriorityBadge`
md cell (`h-4 min-w-4 px-1`); `lg` matches the legacy
`PriorityBadge` lg cell (header chip).

- `src/components/ui/status-badge.tsx` — **deleted**.
- `src/components/ui/priority-badge.tsx` — **deleted**.
- `src/components/ui/alert-list-item.tsx` → **renamed**
  `alert-list-row.tsx`, export `AlertListRow`, `data-slot`
  updated to `alert-list-row` (UX item 4 — break the
  badge-naming collision).
- 4 production consumers migrated (`AlertSection`,
  `BlockListItem`, `DuePanel`, `QueryResultList`); the
  `FilterPill` / `RecentPageChip` button-shaped primitives are
  deliberately out of scope (different a11y contract).

Tests: full `npx vitest run` clean (9 746 passing). The 33 cases
in the deleted `status-badge.test.tsx` / `priority-badge.test.tsx`
were collapsed into 21 cases in the extended `badge.test.tsx` (5
new `tone="status"`, 5 `tone="priority"`, 4 size/shape; the
legacy `variant`-prop alias has its own test). `npx tsc -b
--noEmit` clean; `npx --no biome check` clean on every touched
file. ARCHITECTURE.md inventory dropped from 41 → 39; AGENTS.md
mandatory-patterns row notes the new axes.

### 2d. Extract three duplication clusters — **closed**

Each is documented with file:line evidence:

- **`MetricCard`** — `StatusPanel.tsx:194-247` repeats `<div
  className="rounded-lg border bg-muted/30 p-4 text-center">` five
  times for sync/conflict/queue/journal/peer counters. Extract to
  `src/components/ui/metric-card.tsx` with `label`, `value`, optional
  `icon`, optional `tone` variant.
- **`SectionGroupHeader`** — `DuePanel.tsx:284` styles a section
  header inline as `px-3 py-1 text-xs font-semibold uppercase
  tracking-wide bg-muted/50 rounded`. Same shape recurs in
  `HistoryPanel` (header rows). Extract to
  `src/components/ui/section-group-header.tsx`. Note: a `SectionTitle`
  primitive already exists — confirm the visual deltas before deciding
  whether to add a sibling or extend `SectionTitle` with a `density`
  prop.
- **`FormField` / `SettingsRow`** — settings tabs each reimplement
  label + control + help-text alignment:
  - `src/components/settings/AppearanceTab.tsx:72-100`
  - `src/components/settings/KeyboardSettingsTab.tsx`
  - `src/components/PropertyRowEditor.tsx` (573 lines, 5 input types)
  - `src/components/GoogleCalendarSettingsTab.tsx` (637 lines)

  Extract `<FormField label description error>{children}</FormField>`
  in `src/components/ui/form-field.tsx`. Migrate the AppearanceTab
  first as the smallest case study; defer the larger files to Phase 3.

**Done:**

- `MetricCard` (`src/components/ui/metric-card.tsx`) ships with
  `label` / `value` / `icon` / `tone` (`default` | `warning` |
  `success`) plus a `labelSlot` escape hatch for the existing
  tooltip-bound `MetricLabel` in `StatusPanel`, an `as` toggle
  (`dl-item` default emits `<dd>` / `<dt>` so callers keep description-
  list semantics; `div` emits plain `<div>`s for non-`<dl>` parents),
  and an optional `footer` slot for the "Peak: N" sub-line. All 8
  inline cells in `StatusPanel.tsx` (4 materializer metrics with
  warning/success tone via `queueHealthClasses`, 4 sync metrics)
  migrated.
- `SectionGroupHeader` (`src/components/ui/section-group-header.tsx`)
  shipped **as a sibling to `SectionTitle`**, not as an extension. The
  shapes are different in role and styling: `SectionTitle` is an
  `<h4>` document-heading primitive (`text-xs font-semibold mb-1.5
  flex items-center gap-1` + colour-token text fill, no background),
  whereas the call sites consolidated here use a chip-shaped
  sub-section divider (`px-3 py-1 ... uppercase tracking-wide
  bg-muted/50 rounded` + larger touch-target on coarse pointers).
  Folding both into one CVA matrix would create variants that are
  illegal together (e.g. chip background only makes sense at the
  larger density). Cleaner as two named primitives. Migrated
  `DuePanel.tsx:284` (group-state sub-headers — `DOING`/`TODO`/`DONE`/`Other`)
  and `DonePanel.tsx:245` (per-page group headers — note: `HistoryPanel`
  was the plan's named second site, but it does not actually contain
  the inline shape; the real sibling-of-`DuePanel` duplication lives
  in `DonePanel`, which uses `bg-muted` rather than `bg-muted/50` —
  the migration passes that as a className override so twMerge picks
  it up).
- `FormField` (`src/components/ui/form-field.tsx`) extracted with
  `label` / `description` / `error` / `htmlFor` / `children`. Uses
  the shared `Label` primitive so typography stays consistent.
  `AppearanceTab` migrated (3 inline `<div className="space-y-2">`
  `<label>` + control blocks → 3 `<FormField>`s). Larger sites
  (`KeyboardSettingsTab`, `PropertyRowEditor`,
  `GoogleCalendarSettingsTab`) deliberately deferred to a follow-up
  as the plan called out.
- Tests: 33 new specs in `src/components/ui/__tests__/primitives.test.tsx`
  cover render, slot contracts, variant classes, refs, and axe a11y
  for all three primitives.
- Inventory: `ARCHITECTURE.md` bumped 38 → 41 with `metric-card`,
  `section-group-header`, and `form-field` added (the previous "37"
  header was already inaccurate vs. its own list of 38; both header
  and list updated). `AGENTS.md` primitive-example list extended
  with `FormField`, `MetricCard`, `SectionGroupHeader`.

### Phase 2 cost / impact / risk

- **Cost:** ~3-5 days. Step 2c is the largest (badge consolidation).
- **Impact:** removes the most-cited friction points from the audit —
  inconsistent variant prop names, missing polymorphism, recurring
  inline shapes.
- **Risk:** medium. Step 2c touches ~20-30 callers; needs a careful
  visual diff. Step 2b is mechanical but each primitive's tests need
  the new `asChild` case.

---

## Phase 3 — Larger structural moves (Tier 3)

**Goal:** address the two systemic concerns that need design before
implementation. Don't schedule until Phase 2 lands.

### 3a. Centralise toast usage

`grep -rl "toast\." src/components | wc -l` returns **100**.

Every direct `toast.success(...)` / `toast.error(...)` call hard-codes
the choice of library (sonner today), the message string (often
hard-coded English bypassing `t()`), and the durations.

**Change:** introduce `useNotifier()` (or a `notify` module) in
`src/lib/`:

```ts
notify.success(t('key.success'))
notify.error(error, { fallbackKey: 'key.error.unknown' })
notify.info(t('key.info'))
```

Internally it calls sonner. The win is one chokepoint for: i18n
fallback, dedup of identical errors, future provider swap, and
consistent durations.

**Sequencing:** **don't gradually migrate** 100 files; that's six
months of half-done state. Either:

- (a) ship the wrapper, codemod all 100 callers in a single mechanical
  PR, then add a `prek` rule banning direct `from 'sonner'` imports
  outside the wrapper; or
- (b) accept the status quo and just add a `prek` rule pinning the
  message strings to `t()` keys (cheaper, smaller win).

Recommendation: (a). The codemod is straightforward and the prek guard
keeps the gain durable.

### 3b. Triage the seven ≥590-line feature files

| File | Lines | Likely seams |
| --- | --- | --- |
| ~~`src/components/ui/sidebar.tsx`~~ | ~~1078~~ → 865 | **closed Session 717** — extracted `useSidebarState` (open / openMobile / sidebarWidth / isResizing + cookie + localStorage persistence), `useSidebarKeyboard` (Cmd+B / Ctrl+B with input/textarea/contenteditable bail-out), `useSidebarEdgeSwipe` (left-edge touch-drawer open), and `useSidebarRailDrag` (pointer-drag resize + FE-H-15 unmount cleanup) into `src/components/ui/sidebar/*.ts`. Public API (22 sub-components + `useSidebar` context) unchanged. Hooks each ship with a sibling test file. |
| `src/components/BlockTree.tsx` | 790 | recursion + DnD overlay logic could split |
| ~~`src/components/RichContentRenderer.tsx`~~ | ~~659~~ → 53 | **closed Session 716** — per-mark renderers extracted to `src/components/RichContentRenderer/marks/*.tsx` (block, blockLink, blockquote, blockRef, code, hardBreak, heading, horizontalRule, inline, mermaid, orderedList, tagRef, text). `CALLOUT_CONFIG` + `RenderContext` moved to `context.ts`. Main file is now a 53-line parse-and-dispatch entry; public exports (`renderRichContent`, `CALLOUT_CONFIG`) unchanged. |
| `src/components/HistoryListItem.tsx` | 645 | per-op renderers (create/edit/move/tag) extractable |
| `src/components/GoogleCalendarSettingsTab.tsx` | 637 | extract OAuth state + sync-status + form into siblings |
| `src/components/BugReportDialog.tsx` | 627 | form sections + diagnostics collection |
| `src/components/FormattingToolbar.tsx` | 624 | mark/state/action groups |
| `src/components/PageHeader.tsx` | 592 | already orchestrates 4 named subcomponents; check if more pull out |
| `src/components/SearchPanel.tsx` | 590 | filters + result list + ranking |

**Change:** each is a separate ticket. Don't bundle them.
`PropertyRowEditor.tsx` (573 lines) gets the FormField extraction from
2d as a natural seam — schedule it after 2d lands.

**Note:** size alone is a weak signal. ~~`sidebar.tsx` is shadcn's
canonical file and refactoring it forks the upstream.~~ Filter the list
by "are we actively editing it?" before scheduling. (Session 717 reversed
the sidebar carve-out call — the four hooks decompose cleanly without
touching the 22 sub-component render bodies, so the "upstream fork"
concern was overstated; the hooks live in a sibling `sidebar/` folder
and the host file imports them by path. Re-pulling shadcn upstream would
only touch the sub-components and `Sidebar` itself, leaving the hooks
intact.)

### Phase 3 cost / impact / risk

- **Cost:** 3a is ~1-2 days for the codemod + guard; 3b is per-file
  and should be opportunistic, not a blocking initiative.
- **Impact:** 3a is the bigger maintainability win (one chokepoint vs.
  100). 3b is gradual code-health.
- **Risk:** 3a is medium — codemod must preserve every existing call
  site's behaviour exactly. 3b is per-file low risk.

---

## Out of scope (for completeness)

Findings the audit raised that this plan deliberately skips:

- **Round-1 claim of "219 hex/rgb/hsl leaks"** — verified to be ~26
  after filtering issue-number references and comments, and `prek`
  already guards raw-colour drift via `no-hsl-rgb-var-wrap`. No work
  needed.
- **Round-1 claim of "65% primitive reuse"** — unverifiable estimate.
  The qualitative reading ("reuse is broadly good with three concrete
  duplication clusters") is captured in 2d; the percentage isn't
  actionable.
- **`forwardRef` migration** — already complete. Zero usages in
  `src/components`.
- **Token system overhaul** — the OKLch + 6-theme system is mature and
  consistent. Nothing to do at the token-definition layer.

---

## Cost / Impact / Risk summary

| Phase | Cost | Impact | Risk |
| --- | --- | --- | --- |
| Phase 1 (mechanical) | ~half a day | low-but-visible cleanup | very low |
| Phase 2 (API consolidation) | 3-5 days | high — fixes most-cited friction | medium |
| Phase 3 (structural) | 3a: 1-2 days; 3b: opportunistic | 3a high, 3b gradual | 3a medium, 3b low |

**Recommended sequencing:** Phase 1 → Phase 2 → Phase 3a. Phase 3b
piggybacks on whatever feature work touches the listed files.

**Don't:** start Phase 2 before Phase 1 (the focus-ring utility
migration affects Button, which 2a touches). Don't bundle Phase 3a
into Phase 2 — the toast codemod is mechanically large and deserves
its own review surface.
