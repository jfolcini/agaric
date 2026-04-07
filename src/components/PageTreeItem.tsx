/**
 * PageTreeItem — recursive tree node component for the page browser.
 *
 * Renders a single node in the page tree with expand/collapse behaviour,
 * click-to-navigate, and action buttons (create under namespace, delete).
 *
 * Extracted from PageBrowser for testability.
 */

import { ChevronRight, FileText, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { HighlightMatch } from '@/components/HighlightMatch'
import { Button } from '@/components/ui/button'
import type { PageTreeNode } from '@/lib/page-tree'
import { cn } from '@/lib/utils'

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
  const [expanded, setExpanded] = useState(true) // namespaces start expanded

  if (node.pageId && node.children.length === 0) {
    // Pure leaf page — clickable
    const leafId = node.pageId
    return (
      <div
        className="group flex w-full items-center gap-3 rounded-lg py-1 text-left text-sm transition-colors hover:bg-accent/50 active:bg-accent/70"
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        <button
          type="button"
          className="flex flex-1 items-center gap-3 border-none bg-transparent p-0 text-left text-sm cursor-pointer"
          onClick={() => onNavigate(leafId, node.fullPath)}
        >
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate" title={node.fullPath}>
            <HighlightMatch text={node.name} filterText={filterText} />
          </span>
        </button>
        {onDelete && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
            aria-label={`Delete ${node.fullPath}`}
            onClick={(e) => {
              e.stopPropagation()
              onDelete(leafId, node.fullPath)
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
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
            className="flex-1 text-left px-2 py-1 text-sm text-muted-foreground hover:bg-accent/50 active:bg-accent/70 rounded flex items-center gap-1"
          >
            <ChevronRight
              className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-90')}
            />
            <HighlightMatch text={node.name} filterText={filterText} />
          </button>
          <button
            type="button"
            className="opacity-0 group-hover:opacity-100 h-5 w-5 flex items-center justify-center rounded hover:bg-accent transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 [@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:h-[44px] [@media(pointer:coarse)]:w-[44px] active:bg-accent active:scale-95"
            aria-label={`Create page under ${node.fullPath}`}
            onClick={(e) => {
              e.stopPropagation()
              onCreateUnder(node.fullPath)
            }}
          >
            <Plus size={12} />
          </button>
        </div>
        {isExpanded &&
          node.children.map((child) => (
            <PageTreeItem
              key={child.fullPath}
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
          className="px-2 py-1 text-sm text-muted-foreground hover:bg-accent/50 active:bg-accent/70 rounded flex items-center"
        >
          <ChevronRight className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-90')} />
        </button>
        <button
          type="button"
          className="flex-1 text-left px-1 py-1 text-sm hover:bg-accent/50 active:bg-accent/70 rounded truncate"
          onClick={() => onNavigate(hybridId, node.fullPath)}
          title={node.fullPath}
        >
          <HighlightMatch text={node.name} filterText={filterText} />
        </button>
        <button
          type="button"
          className="opacity-0 group-hover:opacity-100 h-5 w-5 flex items-center justify-center rounded hover:bg-accent transition-opacity focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 [@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:h-[44px] [@media(pointer:coarse)]:w-[44px] active:bg-accent active:scale-95"
          aria-label={`Create page under ${node.fullPath}`}
          onClick={(e) => {
            e.stopPropagation()
            onCreateUnder(node.fullPath)
          }}
        >
          <Plus size={12} />
        </button>
      </div>
      {isExpanded &&
        node.children.map((child) => (
          <PageTreeItem
            key={child.fullPath}
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
