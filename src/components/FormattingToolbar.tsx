/**
 * FormattingToolbar — always-visible toolbar rendered above the active editor.
 *
 * Buttons (post Layer A): Format, Internal Link, Tag, Blockquote | Code Block,
 * Heading | Ordered List, Divider, Callout | Cycle Priority, Date, Due Date,
 * Scheduled Date, TODO, Properties | Undo, Redo, Discard. The mark toggles
 * + External Link live in `SelectionBubbleMenu` (Layer A); the leading
 * "Format" popover (#1958) re-exposes those same mark toggles so they can be
 * applied at the caret with no selection (and on touch, where the bubble is
 * suppressed).
 *
 * Layer B: each button carries a `priority` (see
 * `src/lib/toolbar-config.ts`). When the container is narrow enough that not
 * every button fits, the lowest-priority buttons collapse into a
 * `MoreHorizontal` overflow popover. Group separators disappear when both
 * sides have lost all visible buttons. The hook `useToolbarOverflow` does
 * the measurement via `ResizeObserver` on the container + an off-screen
 * sentinel for per-item widths.
 *
 * Uses onPointerDown + preventDefault so clicks never steal focus from TipTap.
 * Priority and Date buttons dispatch custom events that BlockTree listens for.
 *
 * Per-group renderers, the item-flatten helper, and shared
 * primitives live in `./FormattingToolbar/`. This file only owns wiring —
 * editor state, popover open state, the overflow hook, and the
 * render-dispatch switch.
 */

import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { MoreHorizontal } from 'lucide-react'
import type React from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useIsTouch } from '@/hooks/useIsTouch'
import { useRovingTabindex } from '@/hooks/useRovingTabindex'
import { type ToolbarItem, useToolbarOverflow } from '@/hooks/useToolbarOverflow'
import { computeKeyboardInset } from '@/lib/keyboard-inset'
import {
  createHistoryButtons,
  createMetadataButtons,
  createRefsAndBlocks,
  createStructureButtons,
} from '@/lib/toolbar-config'
import { cn } from '@/lib/utils'

import { buildConfigByKey, buildToolbarItems } from './FormattingToolbar/items'
import { renderCyclePriority } from './FormattingToolbar/MetadataGroup'
import {
  renderFormatButton,
  renderTableOpsButton,
  renderTablePickerButton,
  renderTurnIntoButton,
} from './FormattingToolbar/RefsAndBlocksGroup'
import { type RenderMode, renderConfigButton, Tip } from './FormattingToolbar/shared'
import { Button } from './ui/button'
import { MenuPopoverContent } from './ui/menu-popover-content'
import { Popover, PopoverAnchor } from './ui/popover'
import { Separator } from './ui/separator'

interface FormattingToolbarProps {
  editor: Editor
  /** Block ID used to associate toolbar with its editor via aria-controls. */
  blockId?: string
  /** Current priority of the focused block (null, '1', '2', '3'). */
  currentPriority?: string | null
}

function getHeadingLevel(editor: Editor): number {
  for (let lvl = 1; lvl <= 6; lvl++) {
    if (editor.isActive('heading', { level: lvl })) return lvl
  }
  return 0
}

export function FormattingToolbar({
  editor,
  blockId,
  currentPriority,
}: FormattingToolbarProps): React.ReactElement {
  const { t } = useTranslation()
  // #925 f3 — on coarse-pointer (touch) devices the inline, per-block toolbar
  // scrolls away with the block and ends up hidden behind the soft keyboard.
  // Pin the touch instance to the bottom of the layout viewport and lift it
  // above the keyboard via `visualViewport`. Desktop keeps the inline layout.
  const isTouch = useIsTouch()
  const [formatPopoverOpen, setFormatPopoverOpen] = useState(false)
  const [turnIntoPopoverOpen, setTurnIntoPopoverOpen] = useState(false)
  const [tableOpsPopoverOpen, setTableOpsPopoverOpen] = useState(false)
  const [tablePickerPopoverOpen, setTablePickerPopoverOpen] = useState(false)
  const [overflowPopoverOpen, setOverflowPopoverOpen] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const overflowMenuId = useId()

  // WAI-ARIA toolbar roving-tabindex model (#1724): one tab stop, Arrow/Home/End
  // move focus between the visible buttons. The hook needs the container node;
  // compose its callback ref with our existing `containerRef` (used for overflow
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

  const state = useEditorState({
    editor,
    selector: (ctx) => ({
      codeBlock: ctx.editor.isActive('codeBlock'),
      codeBlockLanguage: ctx.editor.isActive('codeBlock')
        ? ((ctx.editor.getAttributes('codeBlock')['language'] as string) ?? '')
        : '',
      blockquote: ctx.editor.isActive('blockquote'),
      headingLevel: getHeadingLevel(ctx.editor),
      // #215 — drives the contextual table-ops trigger's presence.
      isInsideTable: ctx.editor.isActive('table'),
      canUndo: ctx.editor.can().undo(),
      canRedo: ctx.editor.can().redo(),
    }),
  })

  const groups = useMemo(
    () => ({
      refsAndBlocks: createRefsAndBlocks(editor),
      structureButtons: createStructureButtons(),
      metadataButtons: createMetadataButtons(),
      historyButtons: createHistoryButtons(editor),
    }),
    [editor],
  )
  const configByKey = useMemo(() => buildConfigByKey(groups), [groups])
  const items: ToolbarItem[] = useMemo(
    () => buildToolbarItems(groups, { includeTableOps: state.isInsideTable }),
    [groups, state.isInsideTable],
  )

  const { visible, overflowed } = useToolbarOverflow(containerRef, sentinelRef, items)

  // ── Item renderer dispatch ────────────────────────────────────────────

  const closeOverflow = () => setOverflowPopoverOpen(false)

  const renderItem = (item: ToolbarItem, mode: RenderMode): React.ReactElement | null => {
    if (item.kind === 'separator') {
      if (mode === 'overflow') return null
      return (
        <Separator
          key={item.key}
          orientation="vertical"
          className="border-l border-border/40 mx-0.5 h-4"
        />
      )
    }
    switch (item.key) {
      case 'toolbar.format': {
        return renderFormatButton({
          editor,
          mode,
          t,
          open: formatPopoverOpen,
          setOpen: setFormatPopoverOpen,
        })
      }
      case 'toolbar.turnInto': {
        return renderTurnIntoButton({
          editor,
          mode,
          t,
          open: turnIntoPopoverOpen,
          setOpen: setTurnIntoPopoverOpen,
        })
      }
      case 'toolbar.tableOps': {
        return renderTableOpsButton({
          editor,
          mode,
          t,
          open: tableOpsPopoverOpen,
          setOpen: setTableOpsPopoverOpen,
          onOverflowClose: closeOverflow,
        })
      }
      case 'toolbar.insertTable': {
        return renderTablePickerButton({
          editor,
          mode,
          t,
          open: tablePickerPopoverOpen,
          setOpen: setTablePickerPopoverOpen,
          onOverflowClose: closeOverflow,
        })
      }
      case 'toolbar.cyclePriority': {
        return renderCyclePriority({
          mode,
          t,
          currentPriority,
          onAfterOverflowAction: closeOverflow,
        })
      }
      default: {
        const cfg = configByKey.get(item.key)
        if (!cfg) return null
        return renderConfigButton(
          cfg,
          state as Record<string, unknown>,
          mode,
          t,
          mode === 'overflow' ? closeOverflow : undefined,
        )
      }
    }
  }

  return (
    <div
      tabIndex={-1}
      ref={setContainer}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
      role="toolbar"
      aria-label={t('toolbar.formatting')}
      aria-controls={blockId ? `editor-${blockId}` : undefined}
      className={cn(
        'formatting-toolbar flex items-center gap-0.5 border-border/40 bg-muted/30 px-2 py-px',
        // #925 f3 — touch: pin above the keyboard (fixed, lifted via the
        // visualViewport effect); desktop: inline, just under the block.
        isTouch
          ? 'fixed inset-x-0 bottom-0 z-30 overflow-x-auto border-t bg-muted/95 backdrop-blur supports-backdrop-blur:bg-muted/80'
          : 'relative border-b',
      )}
      data-testid="formatting-toolbar"
      data-pinned={isTouch ? 'true' : undefined}
      data-editor-portal=""
    >
      {visible.map((item) => (
        <span key={`v-${item.key}`} className="inline-flex">
          {renderItem(item, 'inline')}
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
               * `renderItem` drops separator items in overflow mode, so the
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
                      {renderItem(item, 'overflow')}
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
              renderItem(item, 'sentinel')
            )}
          </span>
        ))}
      </div>
    </div>
  )
}
