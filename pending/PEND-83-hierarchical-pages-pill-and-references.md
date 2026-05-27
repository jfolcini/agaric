# PEND-83 — Hierarchical pages: pill display consistency + dedicated child-pages tree on the page view

> Two related UX bugs on the **hierarchical (namespaced) pages** surface
> — page names like `Notes/2026/Quarterly` that are split on `/` into a
> parent → child hierarchy:
>
> 1. **The page "pill" (chip) renders inconsistently.** The same page
>    titled `Notes/2026/Quarterly` is shown as `Notes/2026/Quarterly`
>    in some places and as just `Quarterly` in others. The user can't
>    predict which they'll see and there's no design rule documenting
>    the intent.
> 2. **Opening a parent page leaks its children into the wrong section.**
>    Open page `Notes` and the **Unlinked references** panel surfaces
>    the child pages (`Notes/2026`, `Notes/2026/Quarterly`, …) as
>    collapsible groups (often with only the leaf segment as the group
>    label — see bug 1) and as FTS-matched "mention" rows. Some of
>    those rows are unresolved `[[ULID]]` placeholders because the
>    matched block is a *title block* whose content is the child
>    page's name. Children should not appear in unlinked references at
>    all; the parent page should instead have a **dedicated "Pages
>    tree" section** showing its descendant page hierarchy, alongside
>    the existing Linked / Unlinked references panels.

## TL;DR

- **Bug 1 — pill display consistency:** introduce a single
  `getPageDisplayName(fullPath, mode)` utility (modes: `'full'`,
  `'leaf'`, `'leaf-with-breadcrumb'`) and an explicit per-context
  policy table (tabs, recents strip, references group headers, inline
  `[[link]]` chip, search picker, page tree). Replace ad-hoc renders
  with the utility. The picker already does the right thing
  (`formatNamespacedLabel` → `{ label: leaf, breadcrumb: parent }` in
  `src/hooks/useBlockResolve.ts:65-76`); generalise it.
- **Bug 2 — dedicated child-pages tree, exclude children from
  unlinked refs:** add a `PagesTreeSection` rendered between
  `LinkedReferences` and `UnlinkedReferences` in `PageEditor`
  (`src/components/PageEditor.tsx:202-211`). The section lists
  pages whose title satisfies `title === parentTitle + '/' + …`
  (any depth), rendered via the existing `PageTreeItem`
  (`src/components/PageTreeItem.tsx`) and the existing `buildPageTree`
  helper (`src/lib/page-tree.ts:13-52`). At the same time, filter
  child pages out of the unlinked-references result set so the
  "title-of-A/B contains A" FTS hit no longer surfaces in the wrong
  panel. Two options for where to filter (backend `eval_unlinked_references`
  vs FE `UnlinkedReferences` post-filter) — see Open Qs.
- **Cost:** S–M (~6–10 h total: bug 1 ≈ 2–3 h utility + audit + tests;
  bug 2 ≈ 4–6 h new component + filter wiring + i18n + tests). No
  schema migration. No new always-on Tauri commands (the FE-side
  filter reuses `listAllPagesInSpace`, already loaded for the picker
  preload).
- **Risk:** Low. Pill renames are visual-only; the existing tests at
  `src/components/__tests__/CollapsibleGroupList.test.tsx` and
  `src/components/__tests__/PageBrowser.test.tsx` already constrain
  the display logic in their respective surfaces. The unlinked-refs
  filter changes the result set — needs a test that confirms
  child-page-title FTS hits are excluded but unrelated mentions still
  surface.

## Current state (verified 2026-05-27)

### Hierarchy primitives

- **Hierarchy is title-based, not stored.** A page is a "child" of
  another solely by the `/` convention in its `content` (title)
  field — there is no `parent_id` for pages. `src/lib/page-tree.ts:25-49`
  is the canonical splitter: `path.split('/')` → segment nodes;
  each node has `{ name, fullPath, pageId?, children }`.
- **All slash splitters in the FE (non-test):**
  - `src/lib/page-tree.ts:27` — tree builder.
  - `src/components/PageHeader.tsx:72` — breadcrumb segments above
    the editor.
  - `src/hooks/useBlockResolve.ts:73` (`formatNamespacedLabel`) —
    picker label = leaf, breadcrumb = parent path. Already does the
    right thing in one place.
  - `src/hooks/useJournalAutoCreate.ts:71`, `src/hooks/useDeepLinkRouter.ts:267`,
    `src/components/TabBar.tsx:134` — unrelated (shortcut key
    parser / URL path / journal date format).

### Bug 1 — Where pills render which mode

| Surface | File:line | Source field | Current display | Notes |
| --- | --- | --- | --- | --- |
| Inline `[[link]]` chip in block content | `src/components/RichContentRenderer/marks/blockLink.tsx:37,48` | `ctx.resolveBlockTitle(linkId)` → cache value | **Full** (`Notes/2026/Quarterly`) | Resolves via `useBlockResolve.resolveBlockTitle` (`src/hooks/useBlockResolve.ts:257-262`), which stores and returns the raw cached title verbatim. |
| Linked / unlinked references group header | `src/components/CollapsibleGroupList.tsx:118,139,155` | `group.page_title` | **Full** | Header is the source page that *contains* the back-reference; full path is sensible here, but inconsistent with the tree view. |
| Page browser tree (`PageBrowser`) | `src/components/PageTreeItem.tsx:55,90,140` | `node.name` (leaf segment) | **Leaf** | `title={node.fullPath}` on the wrapper provides the tooltip; correct for a tree view (the parent segments are already visible as the row's ancestor folder rows). |
| Picker autocomplete (typing `[[` or `@`) | `src/hooks/useBlockResolve.ts:65-76,78-81` (`formatNamespacedLabel` + `makePagePickerItem`) | `formatNamespacedLabel(title)` | **Leaf + breadcrumb** (`Quarterly` with `Notes / 2026` muted underneath) | The pre-existing good pattern. |
| Tab bar (open tabs) | `src/components/TabBar.tsx:204,276` | `tab.label` (the page title at navigate-time) | **Full** | Tabs are space-constrained and already truncate via `truncate justify-start`; full path overflows fast. |
| Recents strip chip | `src/components/RecentPagesStrip.tsx:222,236,248` | `ref.title` | **Full** | Same truncation pressure as tabs (`max-w-[160px]`); leaf-with-tooltip would fit far more chips. |
| Page editor header breadcrumb | `src/components/PageHeader.tsx:70-81` | `title.split('/')` → per-segment `BreadcrumbCrumb` | **Segmented** | Each segment is its own crumb; correct for a header. |
| Block link resolver placeholder | `src/components/RichContentRenderer/marks/blockLink.tsx:37` (fallback) | `[[<id-prefix>...]]` when cache miss | **Raw ULID prefix** | Unrelated to namespacing but worth flagging — see Bug 2 below where unresolved ULIDs leak into the wrong panel. |

**The inconsistency the user is reporting** is the gap between the
tree/picker (leaf) and everything else (full). There is no
documented policy that says which is intended, and no shared
utility, so each new surface picks one arbitrarily.

### Bug 2 — Why children leak into Unlinked references

- **PageEditor footer composition** (`src/components/PageEditor.tsx:199-214`):
  `LinkedReferences` → `UnlinkedReferences` → `PageMetadataBar`.
  There is **no Pages-tree section**.
- **Unlinked-refs query** (`src-tauri/src/backlink/grouped.rs:334-402`):
  fetches the page's `content` (its title), OR-joins it with every
  alias from `page_aliases`, and runs an FTS5 query against
  `fts_blocks`. The FTS5 table uses the **trigram tokenizer**
  (`src-tauri/src/fts/search.rs:161-187`, migration
  `0006_fts5_trigram.sql`). Trigram tokenization is substring-based
  with `case_sensitive 0`.
- **Why child-page title blocks match:** a child page `Notes/2026` is
  stored as a `block_type = 'page'` row whose `content = 'Notes/2026'`.
  The trigram FTS index indexes every 3-char window of that content,
  including the trigrams for `Notes`. The unlinked-refs query for
  page `Notes` matches the trigrams `Not`, `ote`, `tes` → the title
  block of `Notes/2026` is an FTS hit. After the "exclude already-
  linked blocks" filter (which only removes blocks that already
  contain a literal `[[<parent-page-id>]]` link), this title block
  *survives* and is returned as an unlinked reference whose source
  page is `Notes/2026` itself.
- **Why the user sees `B (collapsible) → B`:** the outer collapsible
  is the per-source-page group rendered by `CollapsibleGroupList`,
  using `group.page_title = 'Notes/2026'` (or just the leaf, per
  Bug 1) as the header. The inner item is the matched block, which
  for the title-block case is a `block_type = 'page'` block whose
  rendered preview is the same `Notes/2026` text — looking like the
  group repeated itself.
- **Why the user sees unresolved `[[ULID]]`:** `resolveBlockTitle`
  (`src/hooks/useBlockResolve.ts:257-262`) falls back to
  `[[${id.slice(0, 8)}...]]` when the title isn't cached.
  `UnlinkedReferences` does not pre-warm the resolve cache for the
  source-page IDs it surfaces — if the source page (e.g. a deeply
  nested child created in a different session) isn't in the resolve
  cache yet, any inline `[[block-link]]` *inside* the matched block,
  or the matched-block-itself if it's a page-link node, renders as a
  raw ULID prefix until the cache populates.
- **There is no existing "list descendant pages" backend query.** The
  closest analog is `listAllPagesInSpace` (loaded for the picker
  preload, `src/hooks/useBlockResolve.ts:105`), which returns the
  full page list for the active space. A FE-side `pages.filter(p =>
  p.content === parentTitle || p.content.startsWith(parentTitle + '/'))`
  is the cheapest path.

### What we already have to build on

- `PageTreeNode` + `buildPageTree` (`src/lib/page-tree.ts`) — pure,
  already used by `PageBrowser` via `usePageBrowserGrouping`.
- `PageTreeItem` (`src/components/PageTreeItem.tsx`) — recursive
  renderer with expand/collapse, navigate-on-click, create-under,
  delete. Reusable verbatim for the new tree section.
- `CollapsiblePanelHeader` (`src/components/CollapsiblePanelHeader.tsx`)
  — used by both `LinkedReferences` and `UnlinkedReferences`; the
  new tree section should use the same primitive for visual parity.
- `listAllPagesInSpace` (`src/lib/tauri.ts`) — already loaded by the
  picker preload effect in `BlockTree`. Free of charge if the data
  is already in `pagesListRef`.
- `formatNamespacedLabel` (`src/hooks/useBlockResolve.ts:65-76`) —
  the leaf+breadcrumb formatter to generalise.

## Proposal

### Bug 1 — Single source of truth for page-name display

1. **Add `src/lib/page-display.ts`** with the shared utility:

   ```ts
   export type PageDisplayMode = 'full' | 'leaf' | 'leaf-with-breadcrumb'
   export interface PageDisplay { label: string; breadcrumb?: string; title: string }
   export function getPageDisplayName(fullPath: string, mode: PageDisplayMode): PageDisplay
   ```

   `title` is always the full path (for tooltips / `title=""`). For
   non-namespaced titles the three modes collapse to the same
   `{ label: fullPath, title: fullPath }`.
2. **Migrate `formatNamespacedLabel`** in `useBlockResolve.ts` to
   delegate to `getPageDisplayName(fullPath, 'leaf-with-breadcrumb')`,
   keeping the picker behaviour byte-identical.
3. **Adopt per-surface policy** (proposed; see Open Q1 for the
   decision required):
   - **Inline `[[link]]` chip**: `leaf` + tooltip with full path.
     The chip is dense inline content — full path overflows the
     line. Add a hover/long-press tooltip so the full path stays
     discoverable.
   - **References group headers (linked + unlinked)**: `leaf` +
     parent breadcrumb above, mirroring the picker. The header is
     describing "which page contains this back-reference" — leaf
     reads cleaner and the breadcrumb scopes it.
   - **Tabs**: `leaf` + tooltip. Same density argument as the chip.
   - **Recents strip**: `leaf` + tooltip. Same.
   - **Page tree (`PageTreeItem`)**: unchanged (already `leaf`).
   - **PageHeader breadcrumb**: unchanged (already segmented).
4. **Add unit tests** for `getPageDisplayName` covering: empty
   string, no slash, single slash, deeply nested, leading slash,
   trailing slash, double slash.
5. **Snapshot or render-test the surfaces that change** so a future
   regression flips a CI signal. Affected tests likely:
   `src/components/__tests__/CollapsibleGroupList.test.tsx`,
   `src/components/__tests__/TabBar.test.tsx` (if exists; otherwise
   add a minimal one),
   `src/components/__tests__/RecentPagesStrip.test.tsx`.

### Bug 2 — Pages-tree section + child-page filter

1. **New `src/components/PagesTreeSection.tsx`** modelled on
   `LinkedReferences` / `UnlinkedReferences` (header via
   `CollapsiblePanelHeader`, body via `PageTreeItem`):
   - Inputs: `{ pageId, pageTitle, onNavigateToPage }`.
   - Data source: pages whose content === `pageTitle` (the page
     itself, included so the tree root is anchored) OR starts with
     `pageTitle + '/'`. Reuses `listAllPagesInSpace(spaceId)` via
     the same per-space subscription pattern as
     `UnlinkedReferences:60` (`useSpaceStore`).
   - Rendering: pass the filtered list to `buildPageTree`, then
     drop the synthetic root if `pageTitle` is the only entry (no
     children → render an empty-state message via `EmptyState` and
     hide the section entirely if there are zero descendants).
   - Collapsed by default to mirror `UnlinkedReferences`; remember
     the collapse state per-page in `useUiPrefsStore` (look for the
     existing pattern — `LinkedReferences` already does this).
2. **Wire into `PageEditor.tsx`** between
   `LinkedReferences` and `UnlinkedReferences` (line 204 ↔ 209),
   wrapped in `FeatureErrorBoundary name="PagesTreeSection"`.
3. **Filter children out of `UnlinkedReferences`.** Two options:
   - **Option A (FE-only, fast):** in `UnlinkedReferences`, after
     `setGroups(respGroups)`, post-filter `respGroups` to drop any
     group whose `page_id` corresponds to a page whose title
     starts with `pageTitle + '/'`. Requires the page list in
     memory (already loaded via the picker preload, or fetch
     `listAllPagesInSpace` on mount). **Risk:** pagination — the
     filter shrinks the result page below `paginationLimit(20)`,
     so the "Load more" affordance becomes lossy. Mitigation: keep
     fetching with a wider limit until the post-filter page hits
     the target, or accept smaller pages and document it.
   - **Option B (backend, correct):** add a `WHERE` clause to
     `eval_unlinked_references` in `src-tauri/src/backlink/grouped.rs`
     that excludes blocks whose owning page's title starts with
     `<page_title>/`. Requires a SQL `LIKE '<title>/%' ESCAPE`
     against the resolved owning page (joined via `b.page_id`).
     Pagination stays correct because the filter is applied
     pre-`total_count`. **Risk:** alias-aware semantics — a page
     can have aliases, so "owning page title starts with parent's
     title" isn't strictly identical to "owning page is a
     descendant"; needs a clear rule (e.g. only filter when the
     match is on the *title* term, not on an *alias* term —
     requires tracking which term matched, which the current FTS
     query doesn't surface).
   - **Recommend Option A** for the first ship; revisit B once the
     "completeness" complaint surfaces (Open Q3).
4. **Pre-warm the resolve cache** for any page IDs surfaced in
   `UnlinkedReferences.groups` so the `[[ULID]]` fallback never
   reaches the user. Either call
   `useResolveStore.batchSet(...)` after `setGroups`, or fetch
   missing titles in a follow-up effect that resolves on the next
   render. Likely already handled for the matched-block content
   path; verify and patch the source-page-header path specifically.
5. **i18n strings** — add to `src/lib/i18n/pages.ts`:
   `pagesTree.title` (panel title, e.g. "Pages tree"),
   `pagesTree.empty` (empty state when there are zero descendants —
   only shown when the parent page itself has children somewhere
   in the system but the current page has none, otherwise the
   whole section is hidden), `pagesTree.ariaLabel`.
6. **Add tests:**
   - `src/components/__tests__/PagesTreeSection.test.tsx` —
     descendants render, empty-state hides section, navigate on
     click reaches `onNavigateToPage`.
   - Extend `src/components/__tests__/UnlinkedReferences.test.tsx`
     — given a parent page `A` with a child page `A/B` whose title
     block is an FTS hit, the `A/B` group is *not* in the rendered
     output. Negative case: an unrelated page `Aardvark` whose
     content mentions `A` *is* in the output (no false-positive
     prefix collisions).
   - Snapshot the page editor footer so the new section sits in
     the right slot.

## Open questions

1. **Per-surface display policy.** The "Adopt per-surface policy"
   list above is opinionated. Confirm or override:
   - Should the inline `[[link]]` chip really hide the parent path
     by default? An alternative is "show full path inline, but
     truncate the *parent* part with an ellipsis on overflow." Per
     the picker (`useBlockResolve.ts:65-76`) the maintainer has
     already chosen `leaf` for that surface; the inline chip
     consistency argument is the same.
   - Should tabs / recents use leaf-only or "leaf + dimmed parent
     breadcrumb" when the chip is wide enough? Notion uses the
     latter; Logseq uses leaf only. Decision should match whatever
     the picker is locked at.
2. **Where the Pages-tree section lives in the footer.** Above
   `LinkedReferences` (because the tree describes the page's own
   structure, which is conceptually closer to the page than its
   references)? Below (current proposal — least disruption to the
   existing scroll position)? Or in the sidebar instead of the
   footer (existing `PageBrowser` is a sidebar tree; a per-page
   *sub-tree* in the sidebar may be a better home — see Q5).
3. **Backend vs FE filter for child exclusion (Bug 2 step 3).** The
   recommendation is Option A (FE post-filter) for the first ship;
   confirm or pick B. If B, decide the alias-vs-title semantics.
4. **Pre-existing "title block in unlinked refs" bug surface.** The
   FTS hit on title blocks isn't unique to the child case — *any*
   page whose title contains the parent title as a trigram will
   surface its title block in unlinked refs (e.g. `Aardvark`
   matching `A`, or `My Notes` matching `Notes`). Is the
   maintainer's intent that title blocks should *never* appear in
   unlinked refs (filter `WHERE b.block_type != 'page'`)? Or only
   that children specifically should be filtered? This affects
   whether Bug 2 step 3 is a narrow fix or a broader
   "title-blocks-out" rule.
5. **Pages tree in the sidebar vs the footer.** The maintainer has
   `PageBrowser` rendering a tree view of all pages; a per-page
   subtree in the page footer is a duplicate surface. Alternative:
   when viewing page `Notes`, scroll/expand the sidebar to
   highlight the `Notes` subtree and skip the footer section
   entirely. Footer-section is more discoverable (the sidebar is
   often collapsed on mobile); sidebar-only is less code. Confirm
   intent.

## Cost / Impact / Risk

- **Cost:** ~6–10 h.
  - Bug 1: ~2–3 h. Utility + tests = ~1 h; per-surface migration +
    test updates = ~1–2 h.
  - Bug 2: ~4–6 h. New `PagesTreeSection` + tests = ~2–3 h; FE
    child-filter in `UnlinkedReferences` + tests = ~1–2 h; resolve-
    cache pre-warm + i18n + wiring = ~1 h.
- **Impact:** High UX. Hierarchical pages are a core navigation
  affordance and both bugs degrade the user's trust in the
  references panel (they think the system is showing duplicate /
  broken data). The pill consistency fix also unblocks any future
  surface (e.g. command palette breadcrumbs) by giving it a
  ready-made utility.
- **Risk:** Low.
  - Bug 1 is visual-only and isolated to the call sites listed in
    the table; no data model changes.
  - Bug 2's filter changes the result set. If Option B (backend)
    is chosen, the alias semantics need a careful test pass. If
    Option A (FE), pagination needs the documented mitigation.
  - The new section adds to page-render cost. Estimated overhead:
    one `listAllPagesInSpace` call per page navigation (already
    paid for by the picker preload), one `buildPageTree` call on
    the filtered list (O(n·depth), trivially fast for any realistic
    page count). No new IPC required.

## Out of scope (explicit)

- Storing real `parent_id` for pages (would replace the title-split
  convention). Touches the engine model and is deferred to PEND-80
  / PEND-81.
- Mobile-specific layout for the Pages-tree section. Reuse whatever
  the existing references panels do; redesign only if a real
  mobile regression appears.
- Drag-to-reparent in the new tree section. Out of scope; the
  existing `PageBrowser` tree doesn't support it either.
- Renaming pages to update the hierarchy (rename `Notes` →
  `Journal` should rename children `Notes/2026` → `Journal/2026`).
  Pre-existing missing feature, not introduced by this work.
