/**
 * FormattingToolbar — always-visible toolbar rendered above the active editor.
 *
 * Buttons (post PEND-33 Layer A): Internal Link, Tag, Blockquote | Code Block,
 * Heading | Ordered List, Divider, Callout | Cycle Priority, Date, Due Date,
 * Scheduled Date, TODO, Properties | Undo, Redo, Discard. The 5 mark toggles
 * + External Link live in `SelectionBubbleMenu` (PEND-33 Layer A).
 *
 * PEND-33 Layer B: each button carries a `priority` (see
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
 * MAINT-219: per-group renderers, the item-flatten helper, and shared
 * primitives live in `./FormattingToolbar/`. This file only owns wiring —
 * editor state, popover open state, the overflow hook, and the
 * render-dispatch switch.
 */

import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { MoreHorizontal } from 'lucide-react'
import type React from 'react'
import { useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type ToolbarItem, useToolbarOverflow } from '@/hooks/useToolbarOverflow'
import {
  createHistoryButtons,
  createMetadataButtons,
  createRefsAndBlocks,
  createStructureButtons,
} from '@/lib/toolbar-config'
import { buildConfigByKey, buildToolbarItems } from './FormattingToolbar/items'
import { renderCyclePriority } from './FormattingToolbar/MetadataGroup'
import { renderCodeBlockButton, renderHeadingButton } from './FormattingToolbar/RefsAndBlocksGroup'
import { type RenderMode, renderConfigButton, Tip } from './FormattingToolbar/shared'
import { Button } from './ui/button'
import { MenuPopoverContent } from './ui/menu-popover-content'
import { Popover, PopoverAnchor } from './ui/popover'
import { Separator } from './ui/separator'
import { TooltipProvider } from './ui/tooltip'

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
  const [headingPopoverOpen, setHeadingPopoverOpen] = useState(false)
  const [codeBlockPopoverOpen, setCodeBlockPopoverOpen] = useState(false)
  const [overflowPopoverOpen, setOverflowPopoverOpen] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const overflowMenuId = useId()

  const state = useEditorState({
    editor,
    selector: (ctx) => ({
      codeBlock: ctx.editor.isActive('codeBlock'),
      codeBlockLanguage: ctx.editor.isActive('codeBlock')
        ? ((ctx.editor.getAttributes('codeBlock')['language'] as string) ?? '')
        : '',
      blockquote: ctx.editor.isActive('blockquote'),
      headingLevel: getHeadingLevel(ctx.editor),
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
  const items: ToolbarItem[] = useMemo(() => buildToolbarItems(groups), [groups])

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
      case 'toolbar.codeBlockLanguage':
        return renderCodeBlockButton({
          editor,
          mode,
          t,
          isCodeBlock: state.codeBlock,
          codeBlockLanguage: state.codeBlockLanguage,
          open: codeBlockPopoverOpen,
          setOpen: setCodeBlockPopoverOpen,
          onOverflowClose: closeOverflow,
        })
      case 'toolbar.headingLevel':
        return renderHeadingButton({
          editor,
          mode,
          t,
          headingLevel: state.headingLevel,
          open: headingPopoverOpen,
          setOpen: setHeadingPopoverOpen,
          onOverflowClose: closeOverflow,
        })
      case 'toolbar.cyclePriority':
        return renderCyclePriority({
          mode,
          t,
          currentPriority,
          onAfterOverflowAction: closeOverflow,
        })
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
    <TooltipProvider delayDuration={200}>
      <div
        ref={containerRef}
        role="toolbar"
        aria-label={t('toolbar.formatting')}
        aria-controls={blockId ? `editor-${blockId}` : undefined}
        className="formatting-toolbar relative flex items-center gap-0.5 border-b border-border/40 bg-muted/30 px-2 py-px"
        data-testid="formatting-toolbar"
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
                {overflowed.map((item) => (
                  <span key={`o-${item.key}`}>{renderItem(item, 'overflow')}</span>
                ))}
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
    </TooltipProvider>
  )
}
