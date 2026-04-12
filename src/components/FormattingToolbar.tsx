/**
 * FormattingToolbar — always-visible toolbar rendered above the active editor.
 *
 * Buttons: Bold, Italic, Code, Strikethrough, Highlight | External Link, Code Block, Heading | Cycle Priority, Date, Due Date, Scheduled Date, TODO | Undo, Redo.
 * Uses onPointerDown + preventDefault so clicks never steal focus from TipTap.
 * Active marks are highlighted via aria-pressed + bg-accent.
 *
 * The External Link button opens a LinkEditPopover (shadcn Popover) instead
 * of the old `window.prompt()`. The popover is also opened by the Ctrl+K
 * keyboard shortcut (dispatched from the ExternalLink TipTap extension).
 *
 * Priority and Date buttons dispatch custom events that BlockTree listens for.
 */

import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { FileCode2, Heading, Link2 } from 'lucide-react'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { dispatchBlockEvent } from '@/lib/block-events'
import type { ToolbarButtonConfig } from '@/lib/toolbar-config'
import {
  createHistoryButtons,
  createMarkToggles,
  createMetadataButtons,
  createRefsAndBlocks,
  createStructureButtons,
  LANG_SHORT,
  toolbarActiveClass,
} from '@/lib/toolbar-config'
import { cn } from '@/lib/utils'
import { CodeLanguageSelector } from './CodeLanguageSelector'
import { HeadingLevelSelector } from './HeadingLevelSelector'
import { LinkEditPopover } from './LinkEditPopover'
import { Button } from './ui/button'
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

const Tip = React.forwardRef<HTMLButtonElement, { label: string; children: React.ReactElement }>(
  ({ label, children }, ref) => (
    <Tooltip>
      <TooltipTrigger asChild ref={ref}>
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  ),
)
Tip.displayName = 'Tip'

function ToolbarButtonGroup({
  buttons,
  state,
  t,
}: {
  buttons: ToolbarButtonConfig[]
  state: Record<string, unknown>
  t: (key: string) => string
}): React.ReactElement {
  return (
    <>
      {buttons.map((btn) => (
        <Tip key={btn.label} label={t(btn.tip)}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t(btn.label)}
            aria-pressed={btn.activeKey ? (state[btn.activeKey] as boolean) : undefined}
            disabled={btn.disabledWhenFalse ? !state[btn.disabledWhenFalse] : undefined}
            className={cn(btn.activeKey && (state[btn.activeKey] as boolean) && toolbarActiveClass)}
            onPointerDown={(e) => {
              e.preventDefault()
              btn.action()
            }}
          >
            <btn.icon className="h-3.5 w-3.5" />
          </Button>
        </Tip>
      ))}
    </>
  )
}

export function FormattingToolbar({
  editor,
  blockId,
  currentPriority,
}: FormattingToolbarProps): React.ReactElement {
  const { t } = useTranslation()
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)
  const [headingPopoverOpen, setHeadingPopoverOpen] = useState(false)
  const [codeBlockPopoverOpen, setCodeBlockPopoverOpen] = useState(false)

  const state = useEditorState({
    editor,
    selector: (ctx) => ({
      bold: ctx.editor.isActive('bold'),
      italic: ctx.editor.isActive('italic'),
      code: ctx.editor.isActive('code'),
      strike: ctx.editor.isActive('strike'),
      highlight: ctx.editor.isActive('highlight'),
      link: ctx.editor.isActive('link'),
      codeBlock: ctx.editor.isActive('codeBlock'),
      codeBlockLanguage: ctx.editor.isActive('codeBlock')
        ? ((ctx.editor.getAttributes('codeBlock')['language'] as string) ?? '')
        : '',
      blockquote: ctx.editor.isActive('blockquote'),
      headingLevel: ctx.editor.isActive('heading', { level: 1 })
        ? 1
        : ctx.editor.isActive('heading', { level: 2 })
          ? 2
          : ctx.editor.isActive('heading', { level: 3 })
            ? 3
            : ctx.editor.isActive('heading', { level: 4 })
              ? 4
              : ctx.editor.isActive('heading', { level: 5 })
                ? 5
                : ctx.editor.isActive('heading', { level: 6 })
                  ? 6
                  : 0,
      canUndo: ctx.editor.can().undo(),
      canRedo: ctx.editor.can().redo(),
    }),
  })

  // Listen for Ctrl+K custom event dispatched by the ExternalLink extension
  useEffect(() => {
    const dom = editor.view?.dom
    if (!dom) return

    const handler = () => setLinkPopoverOpen(true)
    dom.addEventListener('open-link-popover', handler)
    return () => dom.removeEventListener('open-link-popover', handler)
  }, [editor])

  const currentUrl = state.link ? ((editor.getAttributes('link')['href'] as string) ?? '') : ''

  const handleLinkPopoverClose = useCallback(() => {
    setLinkPopoverOpen(false)
  }, [])

  // ── Button config groups ─────────────────────────────────────────────

  const markToggles = useMemo(() => createMarkToggles(editor), [editor])
  const refsAndBlocks = useMemo(() => createRefsAndBlocks(editor), [editor])
  const structureButtons = useMemo(() => createStructureButtons(), [])
  const metadataButtons = useMemo(() => createMetadataButtons(), [])
  const historyButtons = useMemo(() => createHistoryButtons(editor), [editor])

  return (
    <TooltipProvider delayDuration={200}>
      <ScrollArea className="formatting-toolbar border-b border-border/40 bg-muted/30">
        <div
          role="toolbar"
          aria-label={t('toolbar.formatting')}
          aria-controls={blockId ? `editor-${blockId}` : undefined}
          className="flex items-center gap-0.5 px-2 py-px"
          data-testid="formatting-toolbar"
        >
          <ToolbarButtonGroup
            buttons={markToggles}
            state={state as Record<string, unknown>}
            t={t}
          />

          <Separator orientation="vertical" className="border-l border-border/40 mx-0.5 h-4" />

          <Popover open={linkPopoverOpen} onOpenChange={setLinkPopoverOpen}>
            <PopoverAnchor asChild>
              <Tip label={t('toolbar.linkTip')}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('toolbar.link')}
                  aria-pressed={state.link}
                  className={cn(state.link && toolbarActiveClass)}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    setLinkPopoverOpen((prev) => !prev)
                  }}
                >
                  <Link2 className="h-3.5 w-3.5" />
                </Button>
              </Tip>
            </PopoverAnchor>
            <PopoverContent align="start" className="w-72 p-3" data-editor-portal>
              <LinkEditPopover
                editor={editor}
                isEditing={state.link}
                initialUrl={currentUrl}
                onClose={handleLinkPopoverClose}
              />
            </PopoverContent>
          </Popover>

          <ToolbarButtonGroup
            buttons={refsAndBlocks}
            state={state as Record<string, unknown>}
            t={t}
          />

          <Popover open={codeBlockPopoverOpen} onOpenChange={setCodeBlockPopoverOpen}>
            <PopoverAnchor asChild>
              <Tip label={t('toolbar.codeBlockLanguageTip')}>
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
            </PopoverAnchor>
            <PopoverContent align="start" className="w-auto p-1" data-editor-portal>
              <CodeLanguageSelector
                editor={editor}
                isCodeBlock={state.codeBlock}
                currentLanguage={state.codeBlockLanguage}
                onClose={() => setCodeBlockPopoverOpen(false)}
              />
            </PopoverContent>
          </Popover>

          <Popover open={headingPopoverOpen} onOpenChange={setHeadingPopoverOpen}>
            <PopoverAnchor asChild>
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
            </PopoverAnchor>
            <PopoverContent align="start" className="w-auto p-1" data-editor-portal>
              <HeadingLevelSelector
                editor={editor}
                headingLevel={state.headingLevel}
                onClose={() => setHeadingPopoverOpen(false)}
              />
            </PopoverContent>
          </Popover>

          <Separator orientation="vertical" className="border-l border-border/40 mx-0.5 h-4" />

          <ToolbarButtonGroup
            buttons={structureButtons}
            state={state as Record<string, unknown>}
            t={t}
          />

          <Separator orientation="vertical" className="border-l border-border/40 mx-0.5 h-4" />

          <Tip label={t('toolbar.cyclePriorityTip')}>
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
                {currentPriority === '2' && (
                  <span className="h-2 w-2 rounded-full bg-priority-high" />
                )}
                {currentPriority === '3' && (
                  <span className="h-2 w-2 rounded-full bg-priority-normal" />
                )}
                {currentPriority ? `P${currentPriority}` : 'P'}
              </span>
            </Button>
          </Tip>

          <ToolbarButtonGroup
            buttons={metadataButtons}
            state={state as Record<string, unknown>}
            t={t}
          />

          <Separator orientation="vertical" className="border-l border-border/40 mx-0.5 h-4" />

          <ToolbarButtonGroup
            buttons={historyButtons}
            state={state as Record<string, unknown>}
            t={t}
          />
        </div>
      </ScrollArea>
    </TooltipProvider>
  )
}
