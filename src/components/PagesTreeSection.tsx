/**
 * PagesTreeSection — child-page hierarchy panel at the bottom of PageEditor.
 *
 * Renders the current page's descendant pages (anything whose title starts
 * with `pageTitle + '/'`) as a collapsible tree. Sits ABOVE LinkedReferences
 * so the navigational "pages under this page" affordance lives near the
 * editor body, not buried under the references stack (PEND-83 Bug 2).
 *
 * Data source: `listAllPagesInSpace(currentSpaceId)` — same IPC the
 * `[[ picker preload uses, so the data is usually already warm in the
 * resolve cache. The component does its own fetch on mount because it
 * needs the full `{ id, content }[]` shape (not just resolved titles),
 * and it needs to react to `pageTitle` / space changes deterministically.
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

import type { PageHeading } from '@/lib/bindings'
import { listAllPagesInSpace } from '@/lib/tauri'

import { logger } from '../lib/logger'
import { buildPageTree, type PageTreeNode } from '../lib/page-tree'
import { useSpaceStore } from '../stores/space'
import { CollapsiblePanelHeader } from './CollapsiblePanelHeader'
import { PageTreeItem } from './PageTreeItem'

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
function filterDescendantPages(
  pages: ReadonlyArray<PageHeading>,
  pageTitle: string,
): PageHeading[] {
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
  pageId: _pageId,
  pageTitle,
  onNavigateToPage,
}: PagesTreeSectionProps): React.ReactElement | null {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [pages, setPages] = useState<PageHeading[]>([])
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
    listAllPagesInSpace(currentSpaceId)
      .then((rows) => {
        if (cancelled) return
        // Defensive narrowing: some smoke-test mocks resolve `invoke`
        // with a non-array shape; the upstream contract is `PageHeading[]`
        // but matches the `Array.isArray` guard pattern used elsewhere.
        setPages(Array.isArray(rows) ? rows : [])
      })
      .catch((err) => {
        if (cancelled) return
        logger.error(
          'PagesTreeSection',
          'Failed to load pages for descendants tree',
          { spaceId: currentSpaceId, pageTitle },
          err,
        )
      })
    return () => {
      cancelled = true
    }
  }, [currentSpaceId, pageTitle])

  const children = useMemo(() => {
    const descendants = filterDescendantPages(pages, pageTitle)
    if (descendants.length === 0) return []
    const tree = buildPageTree(descendants.map((p) => ({ id: p.id, content: p.content })))
    return descendantNodes(tree, pageTitle)
  }, [pages, pageTitle])

  // Hide the entire section when there are zero descendants. The plan
  // mandates `return null` here — UX-152's "explain why empty" rule
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
