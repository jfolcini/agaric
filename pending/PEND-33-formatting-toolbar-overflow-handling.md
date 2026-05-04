# PEND-33 — `FormattingToolbar` overflow handling: BubbleMenu + priority overflow popover

## TL;DR

`FormattingToolbar` renders **23 icon buttons** in a single non-wrapping
flex row inside a Radix `ScrollArea`, per block. <ref_snippet
file="src/components/FormattingToolbar.tsx" lines="248-262" /> Today's
only response to insufficient width is **horizontal scroll** — there
are no breakpoints, no overflow menu, no wrapping, no contextual
hiding.

Two structural problems with that:

1. **Discoverability.** Hidden affordances behind a horizontal scroll
   give no visual cue more buttons exist. Users on a 13" laptop, on a
   nested block at indent depth ≥ 3, or in a split-pane layout silently
   lose access to half the toolbar.
2. **It's per-block.** The constraint is the **block's container
   width**, not the viewport. An indented child at depth 4 starts the
   toolbar ~4 × `--indent-width` to the right of the page margin. A
   `@media` breakpoint can't fix this; the right primitive is a
   container query or a `ResizeObserver`.

This plan proposes a two-layer fix:

- **Layer A — Hoist selection-only marks into a TipTap `BubbleMenu`.**
  Bold, Italic, Code, Strike, Highlight, External Link only act on a
  non-empty selection. Move them into a floating contextual menu that
  appears over the selection (Medium / Notion / Google Docs pattern).
  The always-visible toolbar drops from **23 → 17** buttons.
- **Layer B — Priority + overflow popover on the remaining toolbar.**
  Annotate each `ToolbarButtonConfig` with a `priority: number`. A
  `useToolbarOverflow` hook (driven by `ResizeObserver` on the toolbar
  container) renders as many buttons as fit and collapses the trailing
  ones into a `…` (`MoreHorizontal`) popover. Material's "responsive
  app bar" pattern; Fluent UI's `OverflowSet`; what
  Confluence / Gmail / Slack composer do.

Cost: **M-L** (~10–16 h split: A ≈ 3–5 h, B ≈ 7–11 h). Risk:
**medium** (touches a high-traffic, well-tested surface — 1142-line
test file in `FormattingToolbar.test.tsx`). Impact: **high** (fixes a
real discoverability hole on every editor surface, including the
common nested-block case).

> The two layers are **independently approve-able**. Layer A on its
> own is already a meaningful win — it removes 6 buttons from the
> always-visible row and matches established editor UX. Layer B is the
> rigorous answer to overflow but heavier; can ship later if Layer A
> turns out to be enough in practice.

## Current state

### Toolbar composition (5 groups, 23 buttons)

| Group | Buttons | Selection-dependent? |
| --- | --- | --- |
| 1. Marks | Bold, Italic, Code, Strike, Highlight | yes (mark toggles) |
| 2. Refs / blocks | External Link, Internal Link `[[`, Insert tag `@`, Blockquote | mostly no (link is) |
| 3. Block structure | Code block (popover), Heading (popover), Ordered list, Divider, Callout | no |
| 4. Metadata | Cycle priority, Insert date, Due date, Scheduled date, TODO, Properties | no |
| 5. History | Undo, Redo, Discard | no |

### Rendering site

Rendered inside `EditableBlock.tsx` (lines 282–286) as a sibling to
`<EditorContent>`, scoped to the active editor's block:

```tsx
<section id={`editor-${blockId}`} className="block-editor …">
  {rovingEditor.editor && (
    <FormattingToolbar
      editor={rovingEditor.editor}
      blockId={blockId}
      currentPriority={currentPriority}
    />
  )}
  <EditorContent editor={rovingEditor.editor} />
</section>
```

Width source: the block's container, which is reduced by
`--indent-width` for every nesting level. There is no explicit
max-width on the section.

### Responsive behaviour today

- `<ScrollArea>` wraps the toolbar — defaults to vertical scrolling;
  the inner row uses `flex items-center gap-0.5 px-2 py-px` and **does
  not wrap**. When the row overflows horizontally, the `ScrollArea`
  exposes a horizontal scrollbar.
- No breakpoints in the toolbar component (`sm:` / `md:` / `lg:` etc.
  appear nowhere in `FormattingToolbar.tsx`).
- No buttons are hidden, collapsed, or reflowed at any width.
- Touch-target floor is enforced globally (`@media (pointer: coarse)`
  → `min-height: 44px` etc.) but doesn't help here — the toolbar
  buttons are `size="icon-xs"` (smaller than 44 px) and rely on the
  pointer-coarse override at the primitive level.

### Why scroll-only is insufficient (UX)

- Hidden affordances are not discoverable; no visual chevron / fade
  cue announcing "more on the right".
- WCAG 2.1 SC 1.4.10 (Reflow) discourages content that requires
  two-axis scrolling. The page already scrolls vertically — adding a
  horizontal scroll inside the editor doubles up.
- Touch users panning the page vertically frequently catch the
  toolbar's horizontal scroll by accident, dragging buttons off-screen
  mid-gesture.
- Indented blocks hit the cliff first: at indent depth ≥ 3 on a 13"
  screen, the toolbar overflows by ~6–8 buttons even with the window
  fully expanded.

## Proposed change

### Layer A — Selection-aware `BubbleMenu`

**Add a TipTap `BubbleMenu`** that renders the 5 mark toggles + the
external-link button (6 buttons total) **only when the selection is
non-empty**.

Rationale:

- Every action in this group requires a selection to do anything
  meaningful. Bold / Italic / Code / Strike / Highlight all
  toggle marks on the selected range; toggling them with an empty
  selection is a no-op for the user's mental model (it just sets the
  next-typed-character mark, which is rarely what they want from a
  toolbar click).
- External Link is the same: clicking it with an empty selection
  opens the popover that asks for both URL and label, but with a
  selection it pre-fills the label — which is the common path.
- Removes 6 buttons from the always-visible row.
- The bubble-menu pattern is the dominant convention in modern web
  editors (Medium, Notion, Linear, Confluence, Google Docs).

Composition:

- New file: `src/components/SelectionBubbleMenu.tsx`. Renders a
  `<BubbleMenu>` (from `@tiptap/react`) with the 5 mark toggles + the
  external-link trigger, reusing `createMarkToggles(editor)` and the
  existing `LinkEditPopover` wiring.
- Mount at the same level as `FormattingToolbar` inside
  `EditableBlock.tsx` (sibling to `EditorContent`).
- Visibility predicate: `({ state }) => !state.selection.empty`
  (passed via TipTap's `shouldShow`).
- Accessibility: keep the `role="toolbar"` + `aria-label` and the same
  `aria-pressed` semantics as the always-visible toolbar.
- Touch-coarse handling: same `pointer: coarse` overrides as the
  always-visible toolbar — `<BubbleMenu>` content is a regular React
  subtree, no special handling needed.

Removed from `FormattingToolbar`:

- The `markToggles` group (lines 258–262 in the JSX).
- The first `<Separator>` between marks and refs (lines 264).
- The standalone External Link `<Popover>` block (lines 266–298).
- The `link` / `bold` / `italic` / `code` / `strike` / `highlight`
  fields can be dropped from `useEditorState`'s selector (still
  needed inside the bubble menu's own `useEditorState`).

Resulting always-visible toolbar (Layer A only): **17 buttons** — refs
(internal link `[[`, tag `@`, blockquote) → structure (code block,
heading, ordered list, divider, callout) → metadata (priority, date,
due date, scheduled date, TODO, properties) → history (undo, redo,
discard).

### Layer B — Priority + overflow popover

**Add a `useToolbarOverflow(containerRef, items)` hook** that:

1. Observes the toolbar container's `clientWidth` via `ResizeObserver`.
2. Measures each child button's width on mount + on items-changed
   (off-screen pre-render to a sentinel `<div>` with
   `visibility: hidden; position: absolute`).
3. Returns `{ visible: T[], overflowed: T[] }` such that `visible`
   fits within `containerWidth - overflowTriggerWidth - separatorsBudget`.
4. Trailing items collapse first; ordering is stable per priority.

**Add a `priority?: number` field to `ToolbarButtonConfig`** (optional;
default 0 = drops first). Higher = stays longer.

**Render the overflow trigger** as a single `MoreHorizontal` icon
button (`…`) at the right edge of the toolbar. Click opens a
`<Popover>` containing the overflowed items as a vertical list
(label - icon, full-width clickable rows — same pattern as
`HeadingLevelSelector`).

**Within Layer B, the per-button priorities are:**

| Priority | Buttons (kept longest) |
| --- | --- |
| 100 (always visible) | Undo, Redo |
| 90 | Heading (popover trigger), Code block (popover trigger) |
| 80 | TODO toggle, Cycle priority |
| 70 | Insert date, Set due date, Set scheduled date |
| 60 | Internal link `[[`, Insert tag `@` |
| 50 | Blockquote, Ordered list, Divider |
| 40 | Callout, Properties |
| 30 (drops first) | Discard |

Group separators move with their groups: a separator is rendered only
when **both** the group before and the group after still have at least
one visible button.

**Keyboard / palette parity.** Every overflowed action remains
reachable via:

- The slash command palette (`/`), which already covers all 23 actions.
- Keyboard shortcuts (`getShortcutKeys(...)` for the 3 entries in
  `TOOLBAR_SHORTCUT_IDS` + the StarterKit defaults).

So overflow behaviour is a **discovery / convenience** problem, not a
capability problem.

### Why container query (Layer B), not viewport media query

Two viable measurement paths:

- **`ResizeObserver`** in JS, on the toolbar container's
  `clientWidth`. Works in all our targets (Tauri 2 webview ≈ Chromium
  ≥ 110). Direct measurement of the actual constraint. Plays well
  with the per-block scoping. **Recommended.**
- **CSS `@container`** queries on the `.block-editor` container. The
  codebase already uses container queries (`src/components/ui/card.tsx`
  uses `@container/card-header`). Cleaner for purely visual responses
  but doesn't let us *count* buttons, so the JS path is required for
  the overflow-popover construction anyway.

Plain `@media` is the wrong primitive: it sees only the viewport, not
the indented-block container width.

### State / wiring

- `useToolbarOverflow` lives in `src/hooks/useToolbarOverflow.ts`.
- `FormattingToolbar` keeps its existing `useMemo`-built button arrays;
  before passing to `ToolbarButtonGroup`, it threads them through the
  hook to get the visible / overflowed split.
- The popover `<Popover>` for the overflow trigger reuses
  `data-editor-portal` so click-outside detection in the editor works
  the same way as the existing heading / code-block popovers.

## Test impact

### `src/components/__tests__/FormattingToolbar.test.tsx` (1142 lines)

- **Layer A.** Existing tests that find Bold / Italic / Code / Strike
  / Highlight / Link by `screen.getByRole('button', { name: ... })`
  will need to be re-targeted to the bubble menu. Two options:
  (a) prepare the editor with a non-empty selection in the test setup
  so the bubble menu is rendered, then keep the existing query;
  (b) split the suite into `FormattingToolbar.test.tsx` (the
  always-visible bar — refs, structure, metadata, history) and
  `SelectionBubbleMenu.test.tsx` (marks + link). **Prefer (b)** — it
  matches the new component split and keeps the test files focused.
  Estimated test churn: ~20 tests move from one file to the other,
  ~5 new tests added (bubble-menu visibility predicate, focus
  preservation, mark-toggle on selection, no-render on empty
  selection).
- **Layer B.** New `useToolbarOverflow` hook needs a focused unit test
  (`src/hooks/__tests__/useToolbarOverflow.test.ts`) covering: items
  fit / items overflow / item count changes / container resize /
  priority ordering / stable ordering on re-measure / overflow
  trigger absent when nothing overflows. New `<Popover>` for the
  overflow trigger needs an integration test in
  `FormattingToolbar.test.tsx` covering: trigger renders when
  overflowed; trigger absent when not; clicking an item in the
  popover dispatches the action; popover closes after action; aria
  attributes (`aria-haspopup`, `aria-expanded`, `aria-controls`).

`ResizeObserver` mocking: Vitest doesn't ship it; either install
`resize-observer-polyfill` (already a transitive dep via Radix in
some setups — verify) or write a 20-line `MockResizeObserver` for
the test file. Avoid mocking `getBoundingClientRect` / `offsetWidth`
globally; provide explicit width fixtures per test instead.

### `src/__tests__/AGENTS.md` patterns

The file documents the project's testing conventions; no changes
needed — the new tests follow the same patterns
(`@testing-library/react`, `userEvent`, no real timers, no real
network).

### E2E (`tests-e2e/` or `playwright`)

- Run the full e2e suite to confirm no incidental selection / toolbar
  regressions.
- Add one e2e spec asserting bubble-menu show/hide on selection
  change, and one spec asserting the overflow popover renders the
  expected items at a constrained viewport width.

## Step-by-step plan

### Phase 0 — Spike (1 h)

1. Stand up a minimal `useToolbarOverflow` against the existing
   toolbar in a scratch branch. Confirm `ResizeObserver` semantics
   inside the per-block toolbar (no infinite-loop hazard, stable
   width on initial mount, plays well with React 19 strict mode).
2. Confirm `BubbleMenu` from `@tiptap/react` is exported in
   `^3.22.4` (it is — but verify before promising this in code), and
   that adding it doesn't pull a new TipTap package out of the
   coupled-stack pin defined in AGENTS.md "Coupled Dependency
   Updates".

> If the spike surfaces an unexpected blocker (e.g., `BubbleMenu` is
> in a separate `@tiptap/extension-bubble-menu` package that we'd
> have to add — possible — that's fine and aligns with the
> "all `@tiptap/*` move together" rule, since we'd add it at the
> same `3.22.4` pin), update this plan with the actual scope before
> proceeding to Phase 1.

### Phase 1 — Layer A: BubbleMenu (3–5 h)

1. **`package.json`.** If `BubbleMenu` is not in `@tiptap/react`,
   add `@tiptap/extension-bubble-menu` at `^3.22.4` (matching the
   pinned line). Run `npm install`. Per AGENTS.md, this is a
   coupled-stack-respecting addition (joins the existing pin, no
   bump).
2. **`src/components/SelectionBubbleMenu.tsx`** — new file. Render
   `<BubbleMenu>` with the 5 mark toggles via
   `createMarkToggles(editor)` + the external-link trigger reusing
   `LinkEditPopover`. `shouldShow: ({ state }) => !state.selection.empty`.
3. **`src/components/EditableBlock.tsx`** — mount
   `<SelectionBubbleMenu editor={…} blockId={…} />` next to
   `<FormattingToolbar />` and `<EditorContent />`.
4. **`src/components/FormattingToolbar.tsx`** —
   - Drop `markToggles` group, the first `<Separator>`, and the
     external-link `<Popover>` block.
   - Drop the `bold` / `italic` / `code` / `strike` / `highlight` /
     `link` keys from `useEditorState`'s selector.
   - Drop the now-unused `getMarkRange`-based `getLinkMarkRange` and
     the `Link2` / `getMarkRange` imports (move them to
     `SelectionBubbleMenu.tsx`).
   - Drop the `useEffect` listening for `open-link-popover` (move
     to `SelectionBubbleMenu.tsx`).
5. **Tests.** Split `FormattingToolbar.test.tsx` per the "Test
   impact" section. Keep existing assertions for refs / structure /
   metadata / history. Add the new `SelectionBubbleMenu.test.tsx`
   with selection-prep harness.
6. **Verify.** `npm run lint` (Biome), `npm run typecheck`,
   `npm run test`, `npx playwright test`, manual smoke (open a
   block, type some text, select, confirm bubble menu; click bold,
   confirm focus stays in the editor).

> **Stop here for review.** Layer A on its own is shippable. If
> nesting + indentation overflow stops being painful in practice with
> 17 buttons, Layer B is optional.

### Phase 2 — Layer B: priority + overflow popover (7–11 h)

1. **`src/hooks/useToolbarOverflow.ts`** — new hook. Inputs: a
   container ref + the items array. Output: `{ visible, overflowed }`.
   Internals: `ResizeObserver` on container; off-screen
   pre-rendered measurement for each item width; greedy fill by
   descending priority.
2. **`src/lib/toolbar-config.ts`** — add `priority?: number` to
   `ToolbarButtonConfig`. Set the priorities per the table above.
3. **`src/components/FormattingToolbar.tsx`** — flatten the per-group
   button arrays (with separator markers) into a single ordered
   list, thread through `useToolbarOverflow`, render
   `visible` items inline + a `MoreHorizontal` overflow trigger when
   `overflowed.length > 0`. Overflow popover: full-width rows with
   icon + label, reuses `Tip` for tooltips.
4. **CSS.** No new CSS needed if buttons stay `icon-xs` and the
   popover reuses existing primitives. Confirm `@container` is not
   needed for visual styling (it's not — the JS measurement
   covers the layout response).
5. **Tests.**
   - New: `src/hooks/__tests__/useToolbarOverflow.test.ts`.
   - Update: `FormattingToolbar.test.tsx` — add overflow-popover
     integration tests, ensure all existing button-by-name queries
     still pass (set a wide container width in the test harness so
     nothing overflows by default).
6. **Verify.** Same as Phase 1 verification, plus a manual nesting
   smoke: open a block at indent depth 4 on a 1280 × 800 window,
   confirm the overflow popover appears and contains the expected
   trailing items in priority order; confirm undo/redo never move
   into overflow.

## Out of scope

- **Wrapping the toolbar to two rows.** Cheaper than Layer B and
  honest, but eats permanent vertical chrome on the per-block
  toolbar — bad tradeoff in a tool where vertical density matters.
  If both Layer A and Layer B are rejected, two-row wrap is the
  fall-back.
- **Re-introducing labelled grouped dropdowns** ("Insert ▾",
  "Format ▾", "More ▾"). Notion / Confluence on mobile. Less
  ideal than Layer B (extra click for every action) but easier to
  implement. File as a separate plan if Layer B turns out to be too
  heavy.
- **A unified "show this in BubbleMenu when X" config DSL.** Not
  worth the abstraction for one bubble-menu surface.
- **Dynamic priority based on user history.** Tracking per-user
  toolbar usage to bubble frequent actions to the front: too much
  scope creep, no clear win for a 17-button bar.
- **Compact / dense / comfy density settings.** Out of scope; the
  toolbar already uses the smallest available button size
  (`icon-xs`).
- **Slash-command discoverability hint when an item overflows.**
  Could chain a "Tip: try `/bold`" hint inside the overflow popover.
  Probably noise; leave as a follow-up if user testing surfaces a
  need.
- **Re-organising the per-button order itself.** This plan keeps the
  existing button order; Layer B's priorities only decide *what
  drops first under width pressure*, not display order. A separate
  UX plan can re-order if needed.

## Risks

- **Bubble menu interferes with other floating UI** (suggestion
  pickers, slash menu, link popover, picker portals — `AtTagPicker`,
  `BlockLinkPicker`, `BlockRefPicker`, `PropertyPicker`,
  `SlashCommand`). All those open via TipTap's suggestion plugin or
  the `data-editor-portal` Popover pattern. The bubble menu shouldn't
  conflict because (a) the picker triggers either insert text or
  collapse the selection (so `selection.empty` flips and the bubble
  hides), and (b) the popovers are portalled. **Mitigation:** add a
  `shouldShow` clause that also returns `false` when any active
  suggestion plugin has a query open. Verify in manual smoke + add
  e2e coverage for slash-then-select interaction.
- **`ResizeObserver` infinite-loop hazard.** The classic
  `ResizeObserver loop completed with undelivered notifications`
  warning when the observer's callback mutates layout that triggers
  the observer again. **Mitigation:** the callback only sets state
  (no direct DOM mutation); React batches re-renders; measurement
  is read-only. Add an `unstable_batchedUpdates`-style guard if
  needed (React 19 batches by default).
- **Off-screen measurement of button widths.** Buttons with
  popovers (heading, code block) have additional content (a small
  number / language label) that changes width based on state. The
  measurement pass needs to account for the *worst-case* width to
  avoid layout thrash when state changes. **Mitigation:** measure
  with the active-state class applied; clamp via a small fixed
  budget (e.g., reserve 24 px for each popover-trigger's variable
  inner content).
- **Test churn.** `FormattingToolbar.test.tsx` is 1142 lines with
  ~50 distinct button assertions. Splitting + adding selection prep
  is non-trivial. **Mitigation:** Phase 1 keeps Layer A's split as
  a focused, mechanical refactor; Phase 2 adds the
  `useToolbarOverflow` hook tests in isolation.
- **Touch-coarse overflow popover ergonomics.** The popover items
  must hit the 44 × 44 px floor enforced elsewhere. **Mitigation:**
  reuse existing list-row patterns from `HeadingLevelSelector` /
  `CodeLanguageSelector`, which already meet the floor.
- **Bubble menu hides marks on touch.** A common touch-mobile bug:
  selecting text on touch loses selection when the bubble menu
  appears. **Mitigation:** TipTap's `BubbleMenu` is built on
  `tippy.js` with `pointerEvents: 'auto'`; verify on Android (the
  app's secondary target) before shipping.
- **Theming / dark mode.** Layer A's bubble menu must inherit the
  same `bg-popover` / `border-border` semantic tokens as existing
  popovers. Don't introduce hardcoded colors.

## Cost / Impact / Risk

- **Cost:**
  - Layer A: ~3–5 h (one new component, mount in `EditableBlock`,
    delete chunk from `FormattingToolbar`, split tests).
  - Layer B: ~7–11 h (one new hook + measurement infra, priority
    annotations, overflow popover wiring, hook unit tests, integration
    tests, accessibility verification, manual + e2e nesting smoke).
  - Total if both ship together: **~10–16 h**.
- **Impact:** **high.** Fixes a real UX hole on every editor surface,
  including the indented-block case that no `@media` breakpoint can
  catch. Aligns the toolbar with established editor conventions
  (Medium / Notion / Google Docs hover bars; Material / Fluent
  responsive overflow).
- **Risk:** **medium.** Touches a high-traffic, well-tested surface
  (`FormattingToolbar.test.tsx` is 1142 lines); ResizeObserver +
  off-screen measurement is the most error-prone piece. Phasing
  Layer A first keeps the risky bit (Layer B) optional.
- **Sequencing:** Layer A is a pre-requisite for Layer B (Layer B's
  priorities assume the post-Layer-A 17-button set). Layer A on its
  own is shippable; Layer B on its own is not.
- **Approve-able as:** Layer A only; Layer A + Layer B; or full
  rejection (toolbar stays as-is with horizontal scroll).
