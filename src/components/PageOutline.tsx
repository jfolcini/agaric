/**
 * PageOutline — table of contents / outline panel for page headings.
 *
 * Reads blocks from the per-page block store, extracts markdown headings
 * (# , ## , ### , etc.) and renders them as a hierarchical list inside a
 * slide-out Sheet. Clicking a heading smooth-scrolls to the corresponding
 * block element in the DOM.
 */

import { List } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import type { FlatBlock } from '../stores/page-blocks'
import { usePageBlockStore } from '../stores/page-blocks'
import { EmptyState } from './EmptyState'

// ── Heading extraction ───────────────────────────────────────────────────

export interface HeadingEntry {
  blockId: string
  level: number
  text: string
}

const HEADING_RE = /^(#{1,6})\s/

/**
 * Extract headings from a flat block list.
 *
 * Scans each block's `content` for a markdown heading prefix (`# `, `## `, …)
 * and returns an ordered list of `{ blockId, level, text }` entries.
 */
export function extractHeadings(blocks: FlatBlock[]): HeadingEntry[] {
  const headings: HeadingEntry[] = []
  for (const block of blocks) {
    if (!block.content) continue
    const match = HEADING_RE.exec(block.content)
    if (match?.[1]) {
      headings.push({
        blockId: block.id,
        level: match[1].length,
        text: block.content.slice(match[0].length),
      })
    }
  }
  return headings
}

// ── PageOutline component ────────────────────────────────────────────────

export function PageOutline() {
  const { t } = useTranslation()
  const blocks = usePageBlockStore((s) => s.blocks)
  const headings = extractHeadings(blocks)

  const handleClick = (blockId: string) => {
    document.getElementById(blockId)?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('pageHeader.openOutline')}>
          <List className="h-4 w-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>{t('outline.title')}</SheetTitle>
          <SheetDescription className="sr-only">{t('outline.navLabel')}</SheetDescription>
        </SheetHeader>
        <ScrollArea className="flex-1 px-4 pb-4">
          {headings.length === 0 ? (
            <EmptyState compact message={t('pages.outline.empty')} />
          ) : (
            <nav aria-label={t('outline.navLabel')}>
              <ul className="space-y-1">
                {headings.map((h) => (
                  <li key={h.blockId} style={{ paddingLeft: `${(h.level - 1) * 12}px` }}>
                    <button
                      type="button"
                      className={cn(
                        'w-full text-left text-sm truncate rounded px-2 py-1',
                        'hover:bg-accent hover:text-accent-foreground',
                        'focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 outline-hidden',
                        'transition-colors',
                      )}
                      onClick={() => handleClick(h.blockId)}
                    >
                      {h.text}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
