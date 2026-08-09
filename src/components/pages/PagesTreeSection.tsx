/**
 * PagesTreeSection — child-page hierarchy panel at the bottom of PageEditor.
 *
 * Renders the current page's descendant pages (anything whose title starts
 * with `pageTitle + '/'`) as a collapsible tree. Sits ABOVE LinkedReferences
 * so the navigational "pages under this page" affordance lives near the
 * Editor body, not buried under the references stack (Bug 2).
 *
 * Data source: `listPagesWithMetadata` narrowed by a `PathGlob` on the
 * page's own namespace prefix (#3342). It used to call the explicitly
 * unpaginated `listAllPagesInSpace`, which pulled EVERY live page row in
 * the space on every page open and on every title edit, only to keep the
 * handful prefixed `pageTitle + '/'` — and to `return null` when there
 * were none. The backend reserves that no-pagination command for callers
 * that genuinely need every page (markdown export, graph rendering).
 *
 * Empty-descendants behaviour: when the filtered list contains only the
 * current page itself (or nothing), the section returns `null` and the
 * panel disappears entirely — the surrounding `FeatureErrorBoundary`
 * collapses too. The plan explicitly mandates the hide-on-empty rule;
 * the `pagesTree.empty` string is kept around for callers that want to
 * surface the empty state explicitly (debug surfaces, future tests).
 *
 * Collapse default: collapsed (per plan §"Per-page collapse state"),
 * local `useState` only — the project has no `useUiPrefsStore` to
 * persist preference across navigations.
 */

import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CollapsiblePanelHeader } from '@/components/common/CollapsiblePanelHeader'
import { PageTreeItem } from '@/components/pages/PageTreeItem'
import { unwrap } from '@/lib/app-error'
import type { PageResponse, PageWithMetadataRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { buildPageTree, type PageTreeNode } from '@/lib/page-tree'
import { paginationLimit } from '@/lib/safe-limit'
import { useSpaceStore } from '@/stores/space'

/** The `{ id, content }` pair `buildPageTree` consumes. */
interface PageRef {
  id: string
  content: string | null
}

/**
 * Characters that would change how the backend parses a glob entry:
 * `prepare_globs` splits an entry on top-level commas, brace-expands
 * `{a,b}`, treats `[...]` as a character class, REJECTS unbalanced
 * brackets / nested braces / escapes with a `Validation` error, and
 * TRIMS each entry. A page title is arbitrary user text, so
 * interpolating it verbatim would make `Notes, drafts` silently match
 * two unrelated globs, `Notes [2026]` fail the IPC outright, and a
 * leading-space title lose the space the real row still carries.
 * Whitespace is in the set for that last reason: `?` is not trimmed.
 */
const GLOB_SIGNIFICANT = /[\s,{}[\]\\*?]/g

/**
 * A glob matching AT LEAST every page under `pageTitle`'s namespace.
 *
 * Each glob-significant character is replaced by `?` (exactly one
 * character), which can only ever widen the match — never drop a real
 * descendant. Matching is also case-insensitive on the backend
 * (`LOWER(title) GLOB ?`). Both are fine because the result is still run
 * through `filterDescendantPages`, the exact prefix test this component
 * already applied to the whole-space list; the glob is a server-side
 * pre-filter, not the predicate.
 *
 * One case the widening does not cover: a title longer than
 * `MAX_GLOB_LEN` (1024 bytes) is rejected by `prepare_globs`, so the
 * fetch rejects and the panel stays hidden — the same outcome any other
 * IPC failure has always produced here.
 */
function descendantGlob(pageTitle: string): string {
  return `${pageTitle.replace(GLOB_SIGNIFICANT, '?')}/*`
}

/**
 * Runaway guard for the cursor drain: 10 pages x the 200-row page limit,
 * so the tree is TRUNCATED past 2000 descendants. A namespace that deep
 * is well past the point where a flat tree panel is usable, and the cap
 * keeps a non-advancing cursor from spinning forever.
 */
const MAX_DESCENDANT_PAGES = 10

/** Every page under `pageTitle`'s namespace, drained across the cursor chain. */
async function fetchDescendantPages(spaceId: string, pageTitle: string): Promise<PageRef[]> {
  const out: PageRef[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_DESCENDANT_PAGES; page += 1) {
    const res: PageResponse<PageWithMetadataRow> = await commands
      .listPagesWithMetadata(
        {
          spaceId,
          filters: [{ type: 'PathGlob', pattern: descendantGlob(pageTitle), exclude: false }],
        },
        cursor,
        paginationLimit(200),
      )
      .then(unwrap)
    // Defensive narrowing: some smoke-test mocks resolve `invoke` with a
    // non-array shape, matching the `Array.isArray` guard used elsewhere.
    const items = Array.isArray(res.items) ? res.items : []
    for (const row of items) out.push({ id: row.id, content: row.content })
    if (!res.has_more || res.next_cursor == null) break
    cursor = res.next_cursor
  }
  return out
}

export interface PagesTreeSectionProps {
  pageId: string
  pageTitle: string
  onNavigateToPage: (pageId: string, title: string) => void
}

/**
 * Pull descendant pages out of the full page list.
 *
 * Includes the parent page itself when its title matches exactly so
 * `buildPageTree` has a consistent root (otherwise a child like
 * `Notes/2026` produces a synthetic `Notes` namespace node instead of a
 * hybrid `Notes` page node). Callers then drop the anchor row by only
 * rendering descendants — see `descendantNodes` below.
 */
function filterDescendantPages(pages: ReadonlyArray<PageRef>, pageTitle: string): PageRef[] {
  const prefix = `${pageTitle}/`
  return pages.filter((p) => {
    const content = p.content ?? ''
    return content === pageTitle || content.startsWith(prefix)
  })
}

/**
 * From the full tree built off `[parent, ...descendants]`, return the
 * `children` array of the node that represents `pageTitle`.
 *
 * Walks segments left-to-right so a nested parent title (`work/projects`)
 * still resolves to the right hybrid node. Returns `[]` if the parent
 * isn't in the tree (e.g. an untitled page with no descendants).
 */
function descendantNodes(tree: PageTreeNode[], pageTitle: string): PageTreeNode[] {
  const segments = pageTitle.split('/')
  let current: PageTreeNode[] = tree
  for (const seg of segments) {
    const next = current.find((n) => n.name === seg)
    if (!next) return []
    current = next.children
  }
  return current
}

export function PagesTreeSection({
  pageId,
  pageTitle,
  onNavigateToPage,
}: PagesTreeSectionProps): React.ReactElement | null {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [pages, setPages] = useState<PageRef[]>([])
  // Collapsed by default per plan §"Per-page collapse state" — the
  // panel is informational, not the primary navigation surface, so
  // hidden-by-default avoids stacking it on top of LinkedReferences
  // visually. Local state, not a store, because `useUiPrefsStore`
  // doesn't exist in this codebase.
  const [collapsed, setCollapsed] = useState(true)

  useEffect(() => {
    // FE-H-22 mirror — the resolve cache `preload` bails when
    // `currentSpaceId == null`; do the same here so we don't issue a
    // bare IPC during pre-bootstrap that would either error or return
    // foreign-space data.
    if (currentSpaceId == null) {
      setPages([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const rows = await fetchDescendantPages(currentSpaceId, pageTitle)
        if (!cancelled) setPages(rows)
      } catch (err) {
        if (cancelled) return
        logger.error(
          'PagesTreeSection',
          'Failed to load pages for descendants tree',
          { spaceId: currentSpaceId, pageTitle },
          err,
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [currentSpaceId, pageTitle])

  const children = useMemo(() => {
    // The glob matches `pageTitle/...` only, so re-add the page itself as the
    // tree anchor — `buildPageTree` needs it to emit a hybrid page node rather
    // than a synthetic namespace node (see `filterDescendantPages`).
    const descendants = filterDescendantPages(
      [{ id: pageId, content: pageTitle }, ...pages],
      pageTitle,
    )
    if (descendants.length === 0) return []
    const tree = buildPageTree(descendants.map((p) => ({ id: p.id, content: p.content })))
    return descendantNodes(tree, pageTitle)
  }, [pages, pageId, pageTitle])

  // Hide the entire section when there are zero descendants. The plan
  // Mandates `return null` here — "explain why empty" rule
  // doesn't apply to discovery affordances (the editor body is the
  // primary surface; the tree is purely additive).
  if (children.length === 0) {
    return null
  }

  return (
    <section
      className="pages-tree-section"
      data-testid="pages-tree-section"
      aria-label={t('pagesTree.ariaLabel', { title: pageTitle })}
    >
      <CollapsiblePanelHeader
        isCollapsed={collapsed}
        onToggle={() => setCollapsed((prev) => !prev)}
        className="pages-tree-section-header"
      >
        {t('pagesTree.title')}
      </CollapsiblePanelHeader>

      {!collapsed && (
        <div className="pages-tree-section-content mt-1">
          {children.map((child) => (
            <PageTreeItem
              key={child.fullPath}
              node={child}
              depth={0}
              onNavigate={onNavigateToPage}
              // PagesTreeSection intentionally does not surface
              // create-under / delete affordances — those belong on
              // PageBrowser where the full tree is the focus. The
              // recursive renderer requires the callbacks, so we pass
              // no-ops; the create button is still visible on
              // namespace/hybrid rows but produces no side effect.
              // (UX could be tightened by adding an `actions?: boolean`
              // prop to PageTreeItem, but that's S1 territory.)
              onCreateUnder={() => {}}
              filterText=""
              forceExpand={false}
            />
          ))}
        </div>
      )}
    </section>
  )
}
