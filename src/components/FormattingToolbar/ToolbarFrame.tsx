/**
 * The frame both editing toolbars share: the block editor's
 * (`FormattingToolbar`) and *Edit as Markdown*'s (`PageSourceToolbar`,
 * #5160). It lays out the items it is given, collapses the lowest-priority
 * ones into a `MoreHorizontal` overflow popover when the bar is too narrow
 * (`useToolbarOverflow`, measured on an off-screen sentinel), keeps one tab
 * stop with arrow-key roving (#1724), and on touch pins the bar above the
 * soft keyboard (#925 f3). What each item is, and what it does, is the
 * caller's `renderItem`.
 */

import { MoreHorizontal } from 'lucide-react'
import type React from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { type RenderMode, Tip } from '@/components/FormattingToolbar/shared'
import { Button } from '@/components/ui/button'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverAnchor } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { useIsTouch } from '@/hooks/useIsTouch'
import { useRovingTabindex } from '@/hooks/useRovingTabindex'
import { type ToolbarItem, useToolbarOverflow } from '@/hooks/useToolbarOverflow'
import { computeKeyboardInset } from '@/lib/keyboard-inset'
import { cn } from '@/lib/utils'

export interface ToolbarFrameProps {
  items: ToolbarItem[]
  /** A button item, as `mode` shows it; `closeOverflow` closes the overflow popover it may be in. */
  renderItem: (
    item: ToolbarItem,
    mode: RenderMode,
    closeOverflow: () => void,
  ) => React.ReactElement | null
  label: string
  testId: string
  /** The editor the bar acts on, for `aria-controls`. */
  controls?: string | undefined
  /** Added to the inline (non-touch) bar's classes. */
  className?: string | undefined
}

export function ToolbarFrame({
  items,
  renderItem,
  label,
  testId,
  controls,
  className,
}: ToolbarFrameProps): React.ReactElement {
  const { t } = useTranslation()
  // #925 f3 — on coarse-pointer (touch) devices an inline toolbar scrolls away
  // with its editor and ends up hidden behind the soft keyboard. Pin the touch
  // instance to the bottom of the layout viewport and lift it above the
  // keyboard via `visualViewport`. Desktop keeps the inline layout.
  const isTouch = useIsTouch()
  const [overflowPopoverOpen, setOverflowPopoverOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const overflowMenuId = useId()

  // WAI-ARIA toolbar roving-tabindex model (#1724): one tab stop, Arrow/Home/End
  // move focus between the visible buttons. The hook needs the container node;
  // compose its callback ref with `containerRef` (used for overflow
  // measurement) so both observe the same element. The off-screen measurement
  // sentinel renders duplicate buttons, but it carries `aria-hidden="true"` and
  // the hook ignores any button inside an `aria-hidden` / `inert` subtree, so
  // the sentinel's buttons never join the roving set or steal the tab stop.
  const roving = useRovingTabindex()
  const setContainer = (node: HTMLDivElement | null) => {
    containerRef.current = node
    roving.containerRef(node)
  }

  // #925 f3 — keep the pinned (touch) toolbar resting on top of the soft
  // keyboard. The bar is `position: fixed` at the layout-viewport bottom; we
  // set its `bottom` to the keyboard inset so it tracks the keyboard as it
  // shows/hides (visualViewport `resize`) and as the page scrolls under it
  // (`scroll`). No-op on desktop (fine pointer) — the inline layout stays put.
  useEffect(() => {
    if (!isTouch) return
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    const apply = () => {
      const el = containerRef.current
      if (!el) return
      el.style.bottom = `${vv ? computeKeyboardInset(vv) : 0}px`
    }
    apply()
    if (!vv) return
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
    }
  }, [isTouch])

  const { visible, overflowed } = useToolbarOverflow(containerRef, sentinelRef, items)

  const closeOverflow = () => setOverflowPopoverOpen(false)

  const render = (item: ToolbarItem, mode: RenderMode): React.ReactElement | null => {
    if (item.kind !== 'separator') return renderItem(item, mode, closeOverflow)
    if (mode === 'overflow') return null
    return (
      <Separator
        key={item.key}
        orientation="vertical"
        className="border-l border-border/40 mx-0.5 h-4"
      />
    )
  }

  return (
    <div
      tabIndex={-1}
      ref={setContainer}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
      role="toolbar"
      aria-label={label}
      aria-controls={controls}
      className={cn(
        'formatting-toolbar flex items-center gap-0.5 border-border/40 bg-muted/30 px-2 py-px',
        // #925 f3 — touch: pin above the keyboard (fixed, lifted via the
        // visualViewport effect); desktop: inline, beside its editor.
        isTouch
          ? 'fixed inset-x-0 bottom-0 z-30 overflow-x-auto border-t bg-muted/95 backdrop-blur supports-[backdrop-filter]:bg-muted/80'
          : // `rounded-t-md` matches the `.block-editor` box it heads, which
            // cannot clip it (`overflow-hidden` would cut ImageResizeToolbar).
            cn('relative rounded-t-md border-b', className),
      )}
      data-testid={testId}
      data-pinned={isTouch ? 'true' : undefined}
      data-editor-portal=""
    >
      {visible.map((item) => (
        <span key={`v-${item.key}`} className="inline-flex">
          {render(item, 'inline')}
        </span>
      ))}

      {overflowed.length > 0 && (
        <Popover open={overflowPopoverOpen} onOpenChange={setOverflowPopoverOpen}>
          <PopoverAnchor asChild>
            <Tip label={t('toolbar.moreTip')}>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('toolbar.more')}
                aria-haspopup="dialog"
                aria-expanded={overflowPopoverOpen}
                aria-controls={overflowMenuId}
                onPointerDown={(e) => {
                  e.preventDefault()
                  setOverflowPopoverOpen((prev) => !prev)
                }}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </Tip>
          </PopoverAnchor>
          <MenuPopoverContent
            id={overflowMenuId}
            align="end"
            data-editor-portal
            data-testid="toolbar-overflow-menu"
          >
            <div className="flex flex-col gap-0.5">
              {/*
               * #217 A2 — preserve group structure in the overflow popover.
               * `render` drops separator items in overflow mode, so the
               * list was previously flat. Filter the separators out and
               * re-insert a divider whenever the group index changes,
               * mirroring the inline toolbar's inter-group dividers (and the
               * block context menu) on both desktop and pointer:coarse.
               */}
              {overflowed
                .filter((item) => item.kind !== 'separator')
                .map((item, i, buttons) => {
                  const prev = buttons[i - 1]
                  const showDivider = prev != null && item.group !== prev.group
                  return (
                    <span key={`o-${item.key}`}>
                      {showDivider && (
                        <hr
                          className="my-1 h-px border-0 bg-border"
                          data-testid="overflow-group-divider"
                        />
                      )}
                      {render(item, 'overflow')}
                    </span>
                  )
                })}
            </div>
          </MenuPopoverContent>
        </Popover>
      )}

      {/*
       * Off-screen sentinel used by `useToolbarOverflow` to measure
       * each item's natural width. Mirrors every item (visible or
       * overflowed) so widths are always available, with
       * `aria-hidden="true"` so testing-library / a11y traversal
       * skip the duplicates.
       */}
      <div
        ref={sentinelRef}
        aria-hidden="true"
        data-testid="toolbar-sentinel"
        className="pointer-events-none absolute -left-[9999px] top-0 flex items-center gap-0.5"
        style={{ visibility: 'hidden' }}
      >
        {items.map((item) => (
          <span key={`s-${item.key}`} data-toolbar-item-key={item.key} className="inline-flex">
            {item.kind === 'separator' ? (
              <span className="border-l border-border/40 mx-0.5 h-4" />
            ) : (
              renderItem(item, 'sentinel', closeOverflow)
            )}
          </span>
        ))}
      </div>
    </div>
  )
}
