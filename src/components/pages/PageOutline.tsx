/**
 * PageOutline — table of contents / outline panel for page headings.
 *
 * Reads blocks from the per-page block store, extracts markdown headings
 * (# , ## , ### , etc.) and renders them as a hierarchical list inside a
 * slide-out Sheet. Clicking a heading scrolls its block to the top of the
 * view.
 */

import { List } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { scrollElementIntoView } from '@/lib/scroll-into-view'
import { cn } from '@/lib/utils'
import type { FlatBlock } from '@/stores/page-blocks'
import { usePageBlockStore } from '@/stores/page-blocks'

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
    // Blocks render `data-block-id={blockId}`; the editable element's own `id`
    // is `editor-${blockId}`, so `getElementById(blockId)` never matched and the
    // click was a silent no-op (#2211).
    const el = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`)
    // Jump to the top, not a smooth scroll to the center: rows never scrolled
    // into view are placeholders of estimated height (#5329) that grow as they
    // hydrate, so a smooth scroll lands short by every row it passes, and a
    // centered target is pushed down by the rows above it.
    if (el) scrollElementIntoView(el, { block: 'start' })
  }

  return (
    <Sheet>
      {/* pair the icon-only outline trigger with a Tooltip so the
          aria-label is also discoverable by sighted mouse users on hover.
          Tooltip wraps SheetTrigger; both use Radix `Slot` (asChild) so the
          hover and click handlers compose onto the same Button. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t('pageHeader.openOutline')}>
              <List className="h-4 w-4" />
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('pageHeader.openOutline')}</TooltipContent>
      </Tooltip>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>{t('outline.title')}</SheetTitle>
          <SheetDescription className="sr-only">{t('outline.navLabel')}</SheetDescription>
        </SheetHeader>
        <SheetBody>
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
                        'focus-ring-visible focus-visible:ring-inset',
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
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
