# UX Component Review

> Comprehensive visual polish review of all 19 components + App shell.
> Reviewed via code analysis (4 parallel subagents) + visual browser inspection (chrome-browser MCP).
> Standard: Notion / Linear / Obsidian level polish.

---

## Executive Summary

The app has **solid functional foundations** — all views work, navigation is correct, CRUD flows are complete, and accessibility basics (ARIA roles, keyboard support) are in place. The design system (shadcn/ui + Tailwind) provides a clean starting point.

However, the app falls short of "polished modern app" status due to **five systemic issues**:

1. **Inconsistent spacing** — no shared rhythm; `space-y-0.5`, `space-y-1`, `space-y-2`, `space-y-4` used interchangeably
2. **Weak interactive affordance** — clickable items lack clear hover/focus states; drag handles hidden until hover
3. **Minimal empty states** — plain text in dashed boxes with no icons, no CTAs, no personality
4. **Inconsistent component patterns** — different loading states, badge variants, button sizes, timestamp formats across views
5. **Missing inline token styling** — `[[links]]` and `#tags` render as plain text instead of styled chips

**Total findings: 4 critical, 18 major, 28 minor, 8 nits = 58 issues**

---

## Table of Contents

1. [Critical Issues (Fix Immediately)](#1-critical-issues)
2. [App-Wide Systemic Issues](#2-app-wide-systemic-issues)
3. [Component-by-Component Findings](#3-component-findings)
4. [Prioritized Fix Plan](#4-prioritized-fix-plan)

---

## 1. Critical Issues

These break the core experience and should be fixed first.

### C1. Missing inline token chip styling
- **Components**: BlockTree, StaticBlock, EditableBlock
- **Issue**: `block-link-chip` and `tag-ref-chip` CSS classes are applied in code but have **no styling at all**. `[[page links]]` and `#tag` references render as unstyled plain text — no background, no pill shape, no visual distinction from surrounding content.
- **Visually confirmed**: `[[test]]` in "Getting Started" page renders as raw `[[test]]` text.
- **Fix**: Add to `src/index.css`:
  ```css
  .block-link-chip {
    @apply inline-flex items-center rounded-md bg-accent px-1.5 py-0.5 text-sm font-medium text-accent-foreground cursor-pointer hover:bg-accent/80;
  }
  .tag-ref-chip {
    @apply inline-flex items-center rounded-full bg-primary/10 text-primary px-2 py-0.5 text-sm font-medium cursor-pointer hover:bg-primary/20;
  }
  ```

### C2. Editing block has insufficient visual distinction
- **Component**: EditableBlock
- **Issue**: The active/editing block has only a very thin border. In the screenshot, it's barely distinguishable from static blocks. Users can't tell at a glance which block they're editing.
- **Visually confirmed**: Editing the first block in "Getting Started" shows an extremely subtle blue border.
- **Fix**: Add stronger focus indicator — `ring-2 ring-ring/30 bg-accent/10 rounded-lg` to the editing wrapper.

### C3. Drag handle completely hidden until hover
- **Component**: SortableBlock
- **Issue**: Drag handles use `opacity-0 group-hover:opacity-100`, making them invisible by default. New users won't discover that blocks are draggable. Touch devices have no hover.
- **Fix**: Change to `opacity-30 group-hover:opacity-100 transition-opacity` — subtly visible at rest, clear on hover.

### C4. Destructive actions too subtle
- **Components**: TrashView ("Purge"), ConflictList ("Discard")
- **Issue**: Both use `variant="ghost"` with `text-destructive`. For **permanent irreversible deletion**, these buttons need stronger visual weight. Easy to click accidentally.
- **Fix**: Change to `variant="destructive" size="sm"` to match the red confirmation buttons already used in the confirmation flow.

---

## 2. App-Wide Systemic Issues

These patterns appear across multiple components and should be fixed as shared abstractions.

### S1. Spacing rhythm — no shared scale

| Component | Top-level | Section gaps | Item gaps |
|-----------|-----------|-------------|-----------|
| BlockTree | `space-y-0.5` | — | 2px |
| TagList | `space-y-4` | — | `space-y-1` (4px) |
| SearchPanel | `space-y-4` | — | `space-y-2` (8px) |
| PageBrowser | `space-y-2` | — | `py-2` (8px) |
| HistoryPanel | — | — | `p-3` |
| TagFilterPanel | `space-y-4` | `space-y-2` | `space-y-1` |

**Proposed standard**:
- Top-level container: `space-y-6` (24px)
- Section gaps: `space-y-4` (16px)
- Item list gaps: `space-y-2` (8px)
- Tight groups (badges, inline): `space-y-1` (4px) or `gap-1.5`
- Block tree: `space-y-1.5` (6px) — currently 2px, too tight

### S2. Empty states — inconsistent and minimal

| Component | Has empty state | Icon | CTA button | Padding |
|-----------|----------------|------|------------|---------|
| JournalPage | Yes | No | No (separate) | `p-8` |
| PageBrowser | Yes | No | No (separate) | `p-8` |
| SearchPanel | Yes | No | No | `p-8` |
| TagList | Yes | No | No | `p-8` |
| TagPanel | Yes | No | No | `p-6` (!) |
| TrashView | Yes | No | No | `p-8` |
| ConflictList | Yes | No | No | `p-8` |
| HistoryPanel | Yes | Yes (Clock) | No | `p-8` |
| BacklinksPanel | Yes | Yes (Link) | No | `p-8` |
| BlockTree | Yes | No | No | `p-8` |

**Issues**:
- TagPanel uses `p-6` while all others use `p-8`
- Only 2/10 have icons
- Zero have inline CTA buttons (the action is always elsewhere on the page)
- Messages are generic: "Trash is empty.", "No conflicts", "No results found."

**Fix**: Create a shared `<EmptyState icon={...} title="..." description="..." action={...} />` component. Every empty state gets an icon, descriptive text, and optional inline action button.

### S3. Loading states — mixed patterns

| Component | Loading indicator |
|-----------|-----------------|
| JournalPage | Skeleton loaders (`space-y-2`) |
| PageBrowser | Skeleton loaders (`space-y-2`) |
| SearchPanel | Skeleton loaders (`space-y-2`) |
| TagList | Skeleton loaders (`space-y-1`) |
| BacklinksPanel | Text: "Loading backlinks..." |
| HistoryPanel | Text: "Loading history..." |
| ConflictList | Text: "Loading conflicts..." |
| TrashView | Text: "Loading trash..." |
| TagFilterPanel | Text: "Loading results..." |
| StatusPanel | Text: "Loading status..." |

**Fix**: Standardize on skeleton loaders for all list views. Text-only loading is hard to notice.

### S4. Hover states — inconsistent affordance

| Pattern | Used in |
|---------|---------|
| `hover:bg-accent/50` | StaticBlock, PageBrowser items |
| `hover:bg-accent` | (none — not used) |
| `opacity-0 → opacity-100` | Drag handles, delete buttons |
| No hover state | BacklinksPanel items |

**Fix**: Standardize: `hover:bg-accent transition-colors` for list items, `opacity-40 group-hover:opacity-100` for reveal-on-hover actions.

### S5. Badge variant inconsistency

| Component | Badge usage | Variant |
|-----------|------------|---------|
| TagList | Tag names | `secondary` |
| TagPanel | Applied tags | `secondary` |
| TagFilterPanel | Selected tags | `secondary` |
| SearchPanel | Result type | Custom span (not Badge!) |
| HistoryPanel | Op type | `outline` |
| ConflictList | Block type | `outline` |
| TrashView | Block type | `outline` |

**Fix**: Use `variant="secondary"` everywhere. Replace SearchPanel's custom span with Badge component.

### S6. Timestamp format inconsistency

| Component | Format | Output |
|-----------|--------|--------|
| HistoryPanel | `toLocaleString()` | "1/15/2025, 2:30:45 PM" |
| TrashView | `toLocaleDateString()` | "1/15/2025" |
| ConflictList | None | — |

**Fix**: Create shared `formatTimestamp(date, 'full' | 'date' | 'relative')` utility. Use consistently.

### S7. Button size inconsistency

| Usage | Current sizes |
|-------|--------------|
| Primary CTAs | `size="sm"` (New Page, Add Tag) |
| Icon actions | Mixed `size="icon-xs"` / no explicit size |
| Delete buttons | Inconsistent |

**Fix**: Establish hierarchy: primary CTAs = `size="default"`, secondary = `size="sm"`, inline icon buttons = `size="icon-xs"`.

---

## 3. Component Findings

### App.tsx (Shell)

| Sev. | Issue | Fix |
|------|-------|-----|
| Major | Header bar (`h-12`) feels thin and underutilized — just a label + sidebar trigger | Increase to `h-14`, add subtle `border-b` weight |
| Minor | Content area `p-6` may be too much on mobile | Use `p-4 md:p-6` |
| Minor | Tags view uses `<hr className="border-border" />` as separator between TagList and TagFilterPanel — looks basic | Replace with a section heading or styled separator |

### BootGate.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Major | Loading state shows spinner only — no text context | Add "Starting Agaric..." text below spinner |
| Major | Error state text is `text-destructive` on white background — poor hierarchy | Wrap in card with `bg-destructive/10`, add AlertCircle icon |
| Minor | No transition between states | Add `transition-opacity duration-300` |

### BlockTree.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Critical | Chip styling missing (see C1) | Add CSS for `.block-link-chip`, `.tag-ref-chip` |
| Major | Block spacing `space-y-0.5` (2px) is too tight | Change to `space-y-1.5` (6px) |
| Major | Drop indicator barely visible (2px line) | Increase to 3-4px with stronger color |
| Major | Empty state generic, CTA disconnected | Include action button in empty state |

### EditableBlock.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Critical | No clear visual focus state (see C2) | Add `ring-2 ring-ring/30 bg-accent/10 rounded-lg` |
| Minor | `min-h-[2rem]` (32px) feels cramped | Increase to `min-h-[2.5rem]` |

### StaticBlock.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Critical | Chip styling missing (see C1) | Same fix as BlockTree |
| Major | `hover:bg-accent/50` too subtle | Change to `hover:bg-accent` |
| Minor | No focus ring for keyboard navigation | Add `focus-visible:ring-2 focus-visible:ring-ring` |
| Minor | Empty blocks show nothing | Add "Click to edit..." placeholder in muted text |

### SortableBlock.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Critical | Drag handle `opacity-0` (see C3) | Change to `opacity-30 group-hover:opacity-100` |
| Major | Delete button too close to drag handle | Add `gap-1.5` between them |
| Minor | Drag opacity `0.5` too low | Change to `0.75` |
| Minor | Delete button lacks hover background | Add `hover:bg-destructive/10 rounded-sm` |

### FormattingToolbar.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Minor | Buttons packed too tightly | Add `gap-1` between buttons |
| Minor | Active button state too subtle | Use `bg-accent text-accent-foreground` |
| Minor | Group separator barely visible | Use `border-l border-border mx-1` |

### PageEditor.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Major | Title editing has no visual editability hint | Add `hover:border-b hover:border-border` or `focus:bg-accent/10` |
| Minor | "Add block" button visually weak | Use `variant="outline"` or dashed border pattern |

### JournalPage.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Major | Empty state disconnected from "Add block" button | Put CTA inside empty state container |
| Minor | Date center group `gap-2` too tight | Increase to `gap-3` |
| Minor | "Today" button `variant="ghost"` too subtle | Change to `variant="outline"` |
| Minor | Loading skeleton (2 items) doesn't match expected content | Show 3-4 varied-height skeletons |

### PageBrowser.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Major | Delete button `opacity-0` until hover — too hidden | Change to `opacity-40 group-hover:opacity-100` |
| Major | Empty state CTA disconnected from "New Page" button | Add primary button inside empty state |
| Minor | Page items hover state subtle | Add `group-hover:text-foreground` to title |

### BacklinksPanel.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Major | Backlink items look like cards but aren't clickable — no hover, no cursor | Add `cursor-pointer hover:bg-accent/50 transition-colors` |
| Major | "Select a block" vs "No backlinks" states look identical | Give "select" state a different visual (lighter bg, arrow icon) |
| Minor | Loading state is text-only | Use skeleton loaders |

### SearchPanel.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Major | No visual feedback during 300ms debounce | Add subtle spinner or "Searching..." text after 100ms |
| Major | "No results found." too vague | Show query in message, suggest alternatives |
| Major | Search input not prominent enough for a search-focused view | Increase height to `h-10`/`h-11` |
| Minor | Result items `p-3` cramped | Increase to `p-4` |
| Minor | Result type uses custom span instead of Badge | Use Badge component |

### TagList.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Major | Delete button `opacity-0` too hidden | Change to `opacity-30 group-hover:opacity-100` |
| Major | Item spacing `space-y-1` (4px) too tight | Change to `space-y-2` (8px) |
| Minor | Create tag form blends with tag list | Add `border-b pb-4 mb-4` separator |
| Minor | Tag icon next to each badge is redundant | Remove or make `h-3 w-3 opacity-50` |

### TagPanel.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Major | Tag picker `max-h-40` (160px) too small | Increase to `max-h-56` or `max-h-64` |
| Major | No label distinguishing "applied" vs "available" tags | Add "Applied tags" label above |
| Minor | Tag chip remove button `h-3 w-3` too small for touch | Increase to `h-4 w-4` |
| Minor | Empty state uses `p-6` (inconsistent with `p-8` elsewhere) | Standardize to `p-8` |

### TagFilterPanel.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Major | AND/OR toggle unclear to users | Add tooltip explaining difference |
| Major | Section headers `text-xs` too small | Change to `text-sm font-semibold` |
| Major | Loading state text-only | Replace with skeleton loaders |
| Major | Results summary "5 blocks match..." too small | Increase to `text-base` or add background |
| Minor | Search icon positioned outside input awkwardly | Move inside as prefix |

### StatusPanel.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Major | Metric cards `p-3` inconsistent with Card's `px-6` | Change to `p-4`, add `bg-muted/30` |
| Minor | Label `text-xs` too small vs value `text-2xl` — extreme jump | Change label to `text-sm` |
| Minor | No error state if `getStatus()` fails | Add error tracking + retry button |

### HistoryPanel.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Major | List items `p-3` inconsistent with Card padding | Change to `p-4` |
| Major | Restore button only shows for some ops — no explanation | Always show, disable with tooltip |
| Minor | Badge `variant="outline"` too subtle | Change to `variant="secondary"` |
| Minor | Loading text doesn't distinguish initial vs pagination | "Loading..." vs "Loading more..." |

### ConflictList.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Critical | Destructive "Discard" too subtle (see C4) | Change to `variant="destructive"` |
| Major | Confirmation flow cramped in one line | Multi-line layout with `bg-destructive/10` |
| Major | No timestamp shown | Add conflict creation timestamp |
| Minor | Content not truncated | Add `truncate` or `line-clamp-2` |
| Minor | Empty state "No conflicts" too terse | Add explanation of what conflicts are |

### TrashView.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Critical | Destructive "Purge" too subtle (see C4) | Change to `variant="destructive"` |
| Major | Confirmation flow cramped in one line | Multi-line layout with `bg-destructive/10` |
| Minor | "Trash is empty." no icon, no explanation | Add Trash icon + "Deleted items appear here" |
| Minor | Content not truncated | Add `truncate` or `line-clamp-2` |
| Minor | Restore button has no tooltip | Add `title="Restore to original location"` |

### KeyboardShortcuts.tsx

| Sev. | Issue | Fix |
|------|-------|-----|
| Major | `<kbd>` styling basic — no border or shadow | Add `border border-border shadow-sm px-2 py-1 font-semibold` |
| Minor | Table rows `py-2` too tight | Change to `py-3` |
| Minor | Table header `text-muted-foreground` too subtle | Change to `font-semibold text-foreground` |
| Minor | No category grouping (Navigation / Editing / UI) | Group with section headers |
| Minor | Shortcut key descriptions inconsistent ("/" vs "+" vs "in") | Standardize format |
| Nit | Missing Escape key shortcut | Add "Escape — Close dialog" |

---

## 4. Prioritized Fix Plan

### Phase 1 — Critical Polish (highest impact)

| # | Fix | Components | Effort |
|---|-----|-----------|--------|
| 1 | Add `.block-link-chip` / `.tag-ref-chip` CSS | index.css | 5 min |
| 2 | Stronger editing block focus ring | EditableBlock | 5 min |
| 3 | Make drag handle visible at rest (`opacity-30`) | SortableBlock | 2 min |
| 4 | Destructive buttons `variant="destructive"` | TrashView, ConflictList | 5 min |
| 5 | Increase block spacing `space-y-0.5` -> `space-y-1.5` | BlockTree | 2 min |
| 6 | Stronger StaticBlock hover `hover:bg-accent` | StaticBlock | 2 min |

### Phase 2 — Empty States & Loading (consistency)

| # | Fix | Components | Effort |
|---|-----|-----------|--------|
| 7 | Create shared `<EmptyState>` component | New component | 30 min |
| 8 | Replace all 10 empty states with `<EmptyState>` | All views | 30 min |
| 9 | Standardize loading to skeleton loaders | BacklinksPanel, HistoryPanel, ConflictList, TrashView, TagFilterPanel, StatusPanel | 30 min |
| 10 | Add debounce loading indicator | SearchPanel | 15 min |

### Phase 3 — Spacing & Typography (rhythm)

| # | Fix | Components | Effort |
|---|-----|-----------|--------|
| 11 | Standardize list item padding to `p-4` | HistoryPanel, ConflictList, TrashView, SearchPanel | 10 min |
| 12 | Standardize Badge to `variant="secondary"` everywhere | SearchPanel, HistoryPanel, ConflictList, TrashView | 10 min |
| 13 | Create shared `formatTimestamp()` utility | New util + 3 components | 20 min |
| 14 | Increase section headers from `text-xs` to `text-sm` | TagFilterPanel | 5 min |
| 15 | Standardize tag item spacing `space-y-2` | TagList | 2 min |

### Phase 4 — Interactive Polish

| # | Fix | Components | Effort |
|---|-----|-----------|--------|
| 16 | Add hover state to BacklinksPanel items | BacklinksPanel | 5 min |
| 17 | Delete button visibility `opacity-40` at rest | PageBrowser, TagList | 5 min |
| 18 | Improve confirmation flow layout (multi-line) | TrashView, ConflictList | 20 min |
| 19 | Title editing hint (hover border/bg) | PageEditor | 5 min |
| 20 | `<kbd>` styling upgrade (border + shadow) | KeyboardShortcuts | 5 min |

### Phase 5 — Refinement

| # | Fix | Components | Effort |
|---|-----|-----------|--------|
| 21 | BootGate loading text + error card | BootGate | 15 min |
| 22 | AND/OR toggle tooltip | TagFilterPanel | 10 min |
| 23 | Inline CTAs in empty states | JournalPage, PageBrowser | 10 min |
| 24 | Category grouping in shortcuts dialog | KeyboardShortcuts | 15 min |
| 25 | Tags view separator upgrade | App.tsx | 5 min |
| 26 | Metric card padding + label sizing | StatusPanel | 5 min |
| 27 | FormattingToolbar button spacing + active state | FormattingToolbar | 10 min |
| 28 | Content truncation in list views | ConflictList, TrashView | 5 min |

---

**Estimated total effort**: ~5-6 hours for all phases.
**Phase 1 alone** (~20 min) addresses the most impactful visual issues.
**Phases 1-3** (~2.5 hours) bring the app to "polished" status.
