/**
 * FormattingToolbar — always-visible toolbar rendered above the active editor.
 *
 * Buttons (post PEND-33 Layer A): Internal Link, Tag, Blockquote | Code Block,
 * Heading | Ordered List, Divider, Callout | Cycle Priority, Date, Due Date,
 * Scheduled Date, TODO, Properties | Undo, Redo, Discard.
 *
 * The 5 mark toggles (Bold, Italic, Code, Strike, Highlight) and the External
 * Link button were hoisted to `SelectionBubbleMenu` — they only do useful work
 * on a non-empty selection, and a contextual hover bar matches every other
 * modern web editor.
 *
 * PEND-33 Layer B: each button carries a `priority` (see
 * `src/lib/toolbar-config.ts`). When the per-block toolbar's container is
 * narrow enough that not every button fits, the lowest-priority buttons
 * collapse into a `MoreHorizontal` overflow popover. Group separators
 * disappear when both sides have lost all visible buttons. The hook
 * `useToolbarOverflow` does the measurement via `ResizeObserver` on the
 * container + an off-screen sentinel for per-item widths.
 *
 * Uses onPointerDown + preventDefault so clicks never steal focus from TipTap.
 * Active states (codeBlock, blockquote, heading, priority) are highlighted via
 * aria-pressed + bg-accent.
 *
 * Priority and Date buttons dispatch custom events that BlockTree listens for.
 */

import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { FileCode2, Heading, MoreHorizontal } from 'lucide-react'
import type React from 'react'
import { useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type ToolbarItem, useToolbarOverflow } from '@/hooks/useToolbarOverflow'
import { dispatchBlockEvent } from '@/lib/block-events'
import { getShortcutKeys } from '@/lib/keyboard-config'
import type { ToolbarButtonConfig } from '@/lib/toolbar-config'
import {
  createHistoryButtons,
  createMetadataButtons,
  createRefsAndBlocks,
  createStructureButtons,
  LANG_SHORT,
  toolbarActiveClass,
} from '@/lib/toolbar-config'
import { cn } from '@/lib/utils'
import { CodeLanguageSelector } from './CodeLanguageSelector'
import { HeadingLevelSelector } from './HeadingLevelSelector'
import { Button } from './ui/button'
import { MenuPopoverContent } from './ui/menu-popover-content'
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover'
import { ScrollArea } from './ui/scroll-area'
import { Separator } from './ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

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

/**
 * Map of toolbar button label keys to keyboard-config shortcut ids (UX-301).
 * Buttons listed here get their tooltip rebuilt as `${label} (${binding})`
 * via `tooltipWithShortcut`, picking up any user customisation. Buttons
 * absent from this map keep their existing `tip` i18n string.
 */
const TOOLBAR_SHORTCUT_IDS: Record<string, string> = {}

/**
 * Append the current keyboard binding for `shortcutId` to `label` so the
 * tooltip stays in sync with user customisations (UX-301). Returns the
 * plain label when the id is unknown so we never render an empty `()`
 * for buttons that lack a configurable shortcut.
 */
function tooltipWithShortcut(label: string, shortcutId: string): string {
  const keys = getShortcutKeys(shortcutId)
  return keys ? `${label} (${keys})` : label
}

const Tip = ({
  ref,
  label,
  children,
}: {
  label: string
  children: React.ReactElement
  ref?: React.Ref<HTMLButtonElement>
}) => (
  <Tooltip>
    <TooltipTrigger asChild ref={ref}>
      {children}
    </TooltipTrigger>
    <TooltipContent side="bottom" sideOffset={6}>
      {label}
    </TooltipContent>
  </Tooltip>
)
Tip.displayName = 'Tip'

/** Render mode for each toolbar item. */
type RenderMode = 'inline' | 'overflow' | 'sentinel'

/**
 * Render a config-driven button. In `inline` and `sentinel` modes the
 * button is icon-only (matches the existing toolbar). In `overflow`
 * mode the button widens into a list row with icon + label, matching
 * `HeadingLevelSelector` / `CodeLanguageSelector` so the 44 px touch
 * floor is honoured.
 */
function renderConfigButton(
  btn: ToolbarButtonConfig,
  state: Record<string, unknown>,
  mode: RenderMode,
  t: (key: string) => string,
  onAfterAction?: () => void,
): React.ReactElement {
  const shortcutId = TOOLBAR_SHORTCUT_IDS[btn.label]
  const tooltip = shortcutId ? tooltipWithShortcut(t(btn.label), shortcutId) : t(btn.tip)
  const isActive = btn.activeKey ? (state[btn.activeKey] as boolean) : false
  const disabled = btn.disabledWhenFalse ? !state[btn.disabledWhenFalse] : undefined

  if (mode === 'overflow') {
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label={t(btn.label)}
        aria-pressed={btn.activeKey ? isActive : undefined}
        disabled={disabled}
        className={cn(
          'justify-start text-sm w-full [@media(pointer:coarse)]:min-h-11',
          isActive && toolbarActiveClass,
        )}
        onPointerDown={(e) => {
          e.preventDefault()
          btn.action()
          onAfterAction?.()
        }}
      >
        <btn.icon className="h-3.5 w-3.5 mr-2" />
        <span>{t(btn.label)}</span>
      </Button>
    )
  }

  return (
    <Tip label={tooltip}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t(btn.label)}
        aria-pressed={btn.activeKey ? isActive : undefined}
        disabled={disabled}
        className={cn(isActive && toolbarActiveClass)}
        onPointerDown={(e) => {
          e.preventDefault()
          btn.action()
        }}
      >
        <btn.icon className="h-3.5 w-3.5" />
      </Button>
    </Tip>
  )
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

  // ── Button config groups ─────────────────────────────────────────────

  const refsAndBlocks = useMemo(() => createRefsAndBlocks(editor), [editor])
  const structureButtons = useMemo(() => createStructureButtons(), [])
  const metadataButtons = useMemo(() => createMetadataButtons(), [])
  const historyButtons = useMemo(() => createHistoryButtons(editor), [editor])

  // ── Flatten into a single ordered ToolbarItem list ───────────────────
  // Group ids: 0 = refs+blocks+heading/codeBlock, 1 = structure,
  // 2 = priority+metadata, 3 = history. Separators sit between groups.

  const configByKey = useMemo(() => {
    const map = new Map<string, ToolbarButtonConfig>()
    for (const c of [
      ...refsAndBlocks,
      ...structureButtons,
      ...metadataButtons,
      ...historyButtons,
    ]) {
      map.set(c.label, c)
    }
    return map
  }, [refsAndBlocks, structureButtons, metadataButtons, historyButtons])

  const items: ToolbarItem[] = useMemo(() => {
    const out: ToolbarItem[] = []
    const pushButton = (
      key: string,
      group: number,
      priority: number,
      isPopoverTrigger?: boolean,
    ) => {
      out.push(
        isPopoverTrigger
          ? { kind: 'button', key, group, priority, isPopoverTrigger: true }
          : { kind: 'button', key, group, priority },
      )
    }

    // Group 0 — refs + blocks + popover triggers
    for (const c of refsAndBlocks) pushButton(c.label, 0, c.priority ?? 0)
    pushButton('toolbar.codeBlockLanguage', 0, 90, true)
    pushButton('toolbar.headingLevel', 0, 90, true)
    out.push({ kind: 'separator', key: 'sep-0', group: 0, priority: 0 })

    // Group 1 — structure
    for (const c of structureButtons) pushButton(c.label, 1, c.priority ?? 0)
    out.push({ kind: 'separator', key: 'sep-1', group: 1, priority: 0 })

    // Group 2 — priority + metadata
    pushButton('toolbar.cyclePriority', 2, 80)
    for (const c of metadataButtons) pushButton(c.label, 2, c.priority ?? 0)
    out.push({ kind: 'separator', key: 'sep-2', group: 2, priority: 0 })

    // Group 3 — history
    for (const c of historyButtons) pushButton(c.label, 3, c.priority ?? 0)

    return out
  }, [refsAndBlocks, structureButtons, metadataButtons, historyButtons])

  const { visible, overflowed } = useToolbarOverflow(containerRef, sentinelRef, items)

  // ── Item renderers ────────────────────────────────────────────────────

  /** Render the cycle-priority button (a custom inline button). */
  const renderCyclePriority = (mode: RenderMode): React.ReactElement => {
    const tipText = t('toolbar.cyclePriorityTip')
    if (mode === 'overflow') {
      return (
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('toolbar.cyclePriority')}
          aria-pressed={currentPriority != null}
          className={cn(
            'justify-start text-sm w-full [@media(pointer:coarse)]:min-h-11',
            currentPriority != null && toolbarActiveClass,
          )}
          onPointerDown={(e) => {
            e.preventDefault()
            dispatchBlockEvent('CYCLE_PRIORITY')
            setOverflowPopoverOpen(false)
          }}
        >
          <span className="inline-flex items-center gap-1 text-xs font-semibold leading-none mr-2">
            {currentPriority === '1' && (
              <span className="h-2 w-2 rounded-full bg-priority-urgent" />
            )}
            {currentPriority === '2' && <span className="h-2 w-2 rounded-full bg-priority-high" />}
            {currentPriority === '3' && (
              <span className="h-2 w-2 rounded-full bg-priority-normal" />
            )}
            {currentPriority ? `P${currentPriority}` : 'P'}
          </span>
          <span>{t('toolbar.cyclePriority')}</span>
        </Button>
      )
    }
    return (
      <Tip label={tipText}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('toolbar.cyclePriority')}
          aria-pressed={currentPriority != null}
          className={cn(currentPriority != null && toolbarActiveClass)}
          onPointerDown={(e) => {
            e.preventDefault()
            dispatchBlockEvent('CYCLE_PRIORITY')
          }}
        >
          <span className="inline-flex items-center gap-1 text-xs font-semibold leading-none text-muted-foreground">
            {currentPriority === '1' && (
              <span className="h-2 w-2 rounded-full bg-priority-urgent" />
            )}
            {currentPriority === '2' && <span className="h-2 w-2 rounded-full bg-priority-high" />}
            {currentPriority === '3' && (
              <span className="h-2 w-2 rounded-full bg-priority-normal" />
            )}
            {currentPriority ? `P${currentPriority}` : 'P'}
          </span>
        </Button>
      </Tip>
    )
  }

  /**
   * Render the code-block popover trigger. When visible inline this
   * mounts the full Popover wrapper so the heading-level / language
   * selector opens anchored to the button. In `overflow` mode we mount
   * a NESTED Popover wrapper anchored to the overflow row — Radix
   * supports nested popovers.
   */
  const renderCodeBlockButton = (mode: RenderMode): React.ReactElement => {
    if (mode === 'sentinel') {
      // Just the button shape — skip Popover wrapper to avoid duplicating
      // popover content in the DOM.
      return (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-hidden
          tabIndex={-1}
          className={cn(state.codeBlock && toolbarActiveClass)}
        >
          <FileCode2 className="h-3.5 w-3.5" />
          {state.codeBlock && state.codeBlockLanguage && (
            <span className="text-[10px] font-bold">
              {LANG_SHORT[state.codeBlockLanguage] ?? state.codeBlockLanguage}
            </span>
          )}
        </Button>
      )
    }

    const tipLabel = tooltipWithShortcut(t('toolbar.codeBlockLanguage'), 'codeBlock')

    const trigger =
      mode === 'overflow' ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('toolbar.codeBlockLanguage')}
          aria-pressed={state.codeBlock}
          className={cn(
            'justify-start text-sm w-full [@media(pointer:coarse)]:min-h-11',
            state.codeBlock && toolbarActiveClass,
          )}
          onPointerDown={(e) => {
            e.preventDefault()
            setCodeBlockPopoverOpen((prev) => !prev)
          }}
        >
          <FileCode2 className="h-3.5 w-3.5 mr-2" />
          <span>{t('toolbar.codeBlockLanguage')}</span>
          {state.codeBlock && state.codeBlockLanguage && (
            <span className="ml-auto text-[10px] font-bold">
              {LANG_SHORT[state.codeBlockLanguage] ?? state.codeBlockLanguage}
            </span>
          )}
        </Button>
      ) : (
        <Tip label={tipLabel}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('toolbar.codeBlockLanguage')}
            aria-pressed={state.codeBlock}
            className={cn(state.codeBlock && toolbarActiveClass)}
            onPointerDown={(e) => {
              e.preventDefault()
              setCodeBlockPopoverOpen((prev) => !prev)
            }}
          >
            <FileCode2 className="h-3.5 w-3.5" />
            {state.codeBlock && state.codeBlockLanguage && (
              <span className="text-[10px] font-bold">
                {LANG_SHORT[state.codeBlockLanguage] ?? state.codeBlockLanguage}
              </span>
            )}
          </Button>
        </Tip>
      )

    return (
      <Popover open={codeBlockPopoverOpen} onOpenChange={setCodeBlockPopoverOpen}>
        <PopoverAnchor asChild>{trigger}</PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-auto max-w-[calc(100vw-2rem)] p-1"
          data-editor-portal
        >
          <CodeLanguageSelector
            editor={editor}
            isCodeBlock={state.codeBlock}
            currentLanguage={state.codeBlockLanguage}
            onClose={() => {
              setCodeBlockPopoverOpen(false)
              if (mode === 'overflow') setOverflowPopoverOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
    )
  }

  /** Render the heading popover trigger — same shape as code-block. */
  const renderHeadingButton = (mode: RenderMode): React.ReactElement => {
    if (mode === 'sentinel') {
      return (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-hidden
          tabIndex={-1}
          className={cn(state.headingLevel > 0 && toolbarActiveClass)}
        >
          <Heading className="h-3.5 w-3.5" />
          {state.headingLevel > 0 && (
            <span className="text-[10px] font-bold">{state.headingLevel}</span>
          )}
        </Button>
      )
    }

    const trigger =
      mode === 'overflow' ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('toolbar.headingLevel')}
          aria-pressed={state.headingLevel > 0}
          className={cn(
            'justify-start text-sm w-full [@media(pointer:coarse)]:min-h-11',
            state.headingLevel > 0 && toolbarActiveClass,
          )}
          onPointerDown={(e) => {
            e.preventDefault()
            setHeadingPopoverOpen((prev) => !prev)
          }}
        >
          <Heading className="h-3.5 w-3.5 mr-2" />
          <span>{t('toolbar.headingLevel')}</span>
          {state.headingLevel > 0 && (
            <span className="ml-auto text-[10px] font-bold">{state.headingLevel}</span>
          )}
        </Button>
      ) : (
        <Tip label={t('toolbar.headingTip')}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('toolbar.headingLevel')}
            aria-pressed={state.headingLevel > 0}
            className={cn(state.headingLevel > 0 && toolbarActiveClass)}
            onPointerDown={(e) => {
              e.preventDefault()
              setHeadingPopoverOpen((prev) => !prev)
            }}
          >
            <Heading className="h-3.5 w-3.5" />
            {state.headingLevel > 0 && (
              <span className="text-[10px] font-bold">{state.headingLevel}</span>
            )}
          </Button>
        </Tip>
      )

    return (
      <Popover open={headingPopoverOpen} onOpenChange={setHeadingPopoverOpen}>
        <PopoverAnchor asChild>{trigger}</PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-auto max-w-[calc(100vw-2rem)] p-1"
          data-editor-portal
        >
          <HeadingLevelSelector
            editor={editor}
            headingLevel={state.headingLevel}
            onClose={() => {
              setHeadingPopoverOpen(false)
              if (mode === 'overflow') setOverflowPopoverOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
    )
  }

  /** Render any single toolbar item in the requested mode. */
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
        return renderCodeBlockButton(mode)
      case 'toolbar.headingLevel':
        return renderHeadingButton(mode)
      case 'toolbar.cyclePriority':
        return renderCyclePriority(mode)
      default: {
        const cfg = configByKey.get(item.key)
        if (!cfg) return null
        return renderConfigButton(
          cfg,
          state as Record<string, unknown>,
          mode,
          t,
          mode === 'overflow' ? () => setOverflowPopoverOpen(false) : undefined,
        )
      }
    }
  }

  return (
    <TooltipProvider delayDuration={200}>
      <ScrollArea className="formatting-toolbar border-b border-border/40 bg-muted/30">
        <div
          ref={containerRef}
          role="toolbar"
          aria-label={t('toolbar.formatting')}
          aria-controls={blockId ? `editor-${blockId}` : undefined}
          className="relative flex items-center gap-0.5 px-2 py-px"
          data-testid="formatting-toolbar"
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
                    aria-haspopup="menu"
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
      </ScrollArea>
    </TooltipProvider>
  )
}
