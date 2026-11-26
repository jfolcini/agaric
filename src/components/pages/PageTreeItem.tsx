/**
 * PageTreeItem — recursive tree node component for the page browser.
 *
 * Renders a single node in the page tree with expand/collapse behaviour,
 * click-to-navigate, and action buttons (create under namespace, delete).
 *
 * Extracted from PageBrowser for testability.
 */

import { FileText, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DuplicateTitleCue } from '@/components/common/DuplicateTitleCue'
import { HighlightMatch } from '@/components/common/HighlightMatch'
import { NewTabTarget } from '@/components/common/NewTabTarget'
import { Button } from '@/components/ui/button'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import { TruncatedText } from '@/components/ui/truncated-text'
import { useIsTouch } from '@/hooks/useIsTouch'
import { usePhoneLayout } from '@/hooks/usePhoneLayout'
import type { PageTreeNode } from '@/lib/page-tree'

export interface PageTreeItemProps {
  node: PageTreeNode
  depth: number
  onNavigate: (pageId: string, title: string) => void
  onCreateUnder: (namespacePath: string) => void
  filterText: string
  forceExpand: boolean
  onDelete?: (pageId: string, name: string) => void
}

export function PageTreeItem({
  node,
  depth,
  onNavigate,
  onCreateUnder,
  filterText,
  forceExpand,
  onDelete,
}: PageTreeItemProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(true) // namespaces start expanded
  // On a touch phone a page row carries no bin, as a top-level `PageRow` carries none there:
  // a page is deleted from its own ⋮ menu (#7040 P5).
  const isTouch = useIsTouch()
  const phoneLayout = usePhoneLayout()
  const touchPhone = isTouch && phoneLayout

  if (node.pageId && node.children.length === 0) {
    // Pure leaf page — clickable
    const leafId = node.pageId
    return (
      <div
        className="group flex w-full items-center gap-3 rounded-sm py-1 text-left text-sm transition-colors hover:bg-accent/50 active:bg-accent/70"
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        <NewTabTarget pageId={leafId} title={node.fullPath}>
          <button
            type="button"
            className="flex flex-1 items-center gap-3 border-none bg-transparent p-0 text-left text-sm cursor-pointer rounded focus-ring-visible"
            onClick={() => onNavigate(leafId, node.fullPath)}
          >
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <TruncatedText text={node.name} data-page-title={node.fullPath}>
              <HighlightMatch text={node.name} filterText={filterText} />
            </TruncatedText>
          </button>
        </NewTabTarget>
        {node.duplicateTitle && <DuplicateTitleCue pageId={leafId} />}
        {onDelete && !touchPhone && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 touch-target hover-reveal text-muted-foreground hover:text-destructive active:text-destructive active:scale-95"
            aria-label={t('pageTree.delete', { path: node.fullPath })}
            onClick={(e) => {
              e.stopPropagation()
              onDelete(leafId, node.fullPath)
            }}
          >
            <Trash2 />
          </Button>
        )}
      </div>
    )
  }

  const isExpanded = forceExpand || expanded

  if (!node.pageId && node.children.length > 0) {
    // Pure namespace folder — collapsible
    return (
      <div>
        <div className="group flex items-center" style={{ paddingLeft: `${depth * 16}px` }}>
          <button
            type="button"
            onClick={() => !forceExpand && setExpanded(!expanded)}
            aria-label={t('pageTree.toggleNamespace', { path: node.fullPath })}
            className="flex-1 text-left px-2 py-1 text-sm text-muted-foreground hover:bg-accent/50 active:bg-accent/70 rounded flex items-center gap-1 focus-ring-visible"
          >
            <ChevronToggle isExpanded={isExpanded} />
            <HighlightMatch text={node.name} filterText={filterText} />
          </button>
          <button
            type="button"
            className="h-5 w-5 flex items-center justify-center rounded hover:bg-accent focus-ring-visible [@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:h-[44px] [@media(pointer:coarse)]:w-[44px] active:bg-accent active:scale-95"
            aria-label={t('pageTree.createUnder', { path: node.fullPath })}
            onClick={(e) => {
              e.stopPropagation()
              onCreateUnder(node.fullPath)
            }}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        {isExpanded &&
          node.children.map((child) => (
            <PageTreeItem
              // #4709 — `fullPath` is shared by duplicate-title siblings,
              // so it is not a usable React key; `nodeKey` is set on
              // exactly those nodes.
              key={child.nodeKey ?? child.fullPath}
              node={child}
              depth={depth + 1}
              onNavigate={onNavigate}
              onCreateUnder={onCreateUnder}
              filterText={filterText}
              forceExpand={forceExpand}
              {...(onDelete ? { onDelete } : {})}
            />
          ))}
      </div>
    )
  }

  // Hybrid: both a page AND a namespace folder
  const hybridId = node.pageId ?? ''
  return (
    <div>
      <div className="group flex items-center" style={{ paddingLeft: `${depth * 16}px` }}>
        <button
          type="button"
          onClick={() => !forceExpand && setExpanded(!expanded)}
          aria-label={t('pageTree.toggleHybrid', { path: node.fullPath })}
          className="px-2 py-1 text-sm text-muted-foreground hover:bg-accent/50 active:bg-accent/70 rounded flex items-center focus-ring-visible"
        >
          <ChevronToggle isExpanded={isExpanded} />
        </button>
        <NewTabTarget pageId={hybridId} title={node.fullPath}>
          <button
            type="button"
            className="min-w-0 flex-1 text-left px-1 py-1 text-sm hover:bg-accent/50 active:bg-accent/70 rounded focus-ring-visible"
            onClick={() => onNavigate(hybridId, node.fullPath)}
          >
            <TruncatedText text={node.name} className="block" data-page-title={node.fullPath}>
              <HighlightMatch text={node.name} filterText={filterText} />
            </TruncatedText>
          </button>
        </NewTabTarget>
        {node.duplicateTitle && <DuplicateTitleCue pageId={hybridId} />}
        <button
          type="button"
          className="h-5 w-5 flex items-center justify-center rounded hover:bg-accent focus-ring-visible [@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:h-[44px] [@media(pointer:coarse)]:w-[44px] active:bg-accent active:scale-95"
          aria-label={t('pageTree.createUnder', { path: node.fullPath })}
          onClick={(e) => {
            e.stopPropagation()
            onCreateUnder(node.fullPath)
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {isExpanded &&
        node.children.map((child) => (
          <PageTreeItem
            // #4709 — same as the namespace branch above: `fullPath` is
            // shared by duplicate-title siblings, `nodeKey` is not.
            key={child.nodeKey ?? child.fullPath}
            node={child}
            depth={depth + 1}
            onNavigate={onNavigate}
            onCreateUnder={onCreateUnder}
            filterText={filterText}
            forceExpand={forceExpand}
            {...(onDelete ? { onDelete } : {})}
          />
        ))}
    </div>
  )
}
