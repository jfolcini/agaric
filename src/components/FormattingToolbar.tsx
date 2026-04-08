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
import type { LucideIcon } from 'lucide-react'
import {
  AtSign,
  Bold,
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  CheckSquare,
  Code,
  FileCode2,
  FileSymlink,
  Heading,
  Highlighter,
  Italic,
  Link2,
  Quote,
  Redo2,
  Settings2,
  Strikethrough,
  Undo2,
  X,
} from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { dispatchBlockEvent } from '@/lib/block-events'
import { cn } from '@/lib/utils'
import { LinkEditPopover } from './LinkEditPopover'
import { Button } from './ui/button'
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover'
import { ScrollArea } from './ui/scroll-area'
import { Separator } from './ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

/** Shared active-state class applied to toolbar buttons when their feature is on. */
const toolbarActiveClass = 'bg-accent text-accent-foreground'

/** Languages available in the code block language selector popover. */
const CODE_LANGUAGES = [
  'javascript',
  'typescript',
  'python',
  'rust',
  'bash',
  'sql',
  'html',
  'css',
  'json',
  'go',
  'java',
  'c',
  'cpp',
  'ruby',
  'markdown',
  'yaml',
  'toml',
] as const

/** Short display labels shown on the toolbar button when a code block language is active. */
const LANG_SHORT: Record<string, string> = {
  javascript: 'JS',
  typescript: 'TS',
  python: 'PY',
  rust: 'RS',
  bash: 'SH',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  json: 'JSON',
  go: 'GO',
  java: 'JA',
  c: 'C',
  cpp: 'C++',
  ruby: 'RB',
  markdown: 'MD',
  yaml: 'YML',
  toml: 'TOML',
}

interface FormattingToolbarProps {
  editor: Editor
  /** Block ID used to associate toolbar with its editor via aria-controls. */
  blockId?: string
  /** Current priority of the focused block (null, '1', '2', '3'). */
  currentPriority?: string | null
}

interface ToolbarButtonConfig {
  icon: LucideIcon
  label: string
  tip: string
  activeKey?: string
  disabledWhenFalse?: string
  action: () => void
}

function Tip({
  label,
  children,
}: {
  label: string
  children: React.ReactElement
}): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

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
        ? ((ctx.editor.getAttributes('codeBlock').language as string) ?? '')
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

  const currentUrl = state.link ? ((editor.getAttributes('link').href as string) ?? '') : ''

  const handleLinkPopoverClose = useCallback(() => {
    setLinkPopoverOpen(false)
  }, [])

  // ── Button config groups ─────────────────────────────────────────────

  const markToggles: ToolbarButtonConfig[] = useMemo(
    () => [
      {
        icon: Bold,
        label: 'toolbar.bold',
        tip: 'toolbar.boldTip',
        activeKey: 'bold',
        action: () => editor.chain().focus().toggleBold().run(),
      },
      {
        icon: Italic,
        label: 'toolbar.italic',
        tip: 'toolbar.italicTip',
        activeKey: 'italic',
        action: () => editor.chain().focus().toggleItalic().run(),
      },
      {
        icon: Code,
        label: 'toolbar.code',
        tip: 'toolbar.codeTip',
        activeKey: 'code',
        action: () => editor.chain().focus().toggleCode().run(),
      },
      {
        icon: Strikethrough,
        label: 'toolbar.strikethrough',
        tip: 'toolbar.strikethroughTip',
        activeKey: 'strike',
        action: () => editor.chain().focus().toggleStrike().run(),
      },
      {
        icon: Highlighter,
        label: 'toolbar.highlight',
        tip: 'toolbar.highlightTip',
        activeKey: 'highlight',
        action: () => editor.chain().focus().toggleHighlight().run(),
      },
    ],
    [editor],
  )

  const refsAndBlocks: ToolbarButtonConfig[] = useMemo(
    () => [
      {
        icon: FileSymlink,
        label: 'toolbar.internalLink',
        tip: 'toolbar.pageLinkTip',
        action: () => editor.chain().focus().insertContent('[[').run(),
      },
      {
        icon: AtSign,
        label: 'toolbar.insertTag',
        tip: 'toolbar.tagTip',
        action: () => editor.chain().focus().insertContent('@').run(),
      },
      {
        icon: Quote,
        label: 'toolbar.blockquote',
        tip: 'toolbar.blockquoteTip',
        activeKey: 'blockquote',
        action: () => editor.chain().focus().toggleBlockquote().run(),
      },
    ],
    [editor],
  )

  const metadataButtons: ToolbarButtonConfig[] = useMemo(
    () => [
      {
        icon: CalendarDays,
        label: 'toolbar.insertDate',
        tip: 'toolbar.insertDateTip',
        action: () => dispatchBlockEvent('OPEN_DATE_PICKER'),
      },
      {
        icon: CalendarClock,
        label: 'toolbar.setDueDate',
        tip: 'toolbar.dueDateTip',
        action: () => dispatchBlockEvent('OPEN_DUE_DATE_PICKER'),
      },
      {
        icon: CalendarCheck2,
        label: 'toolbar.setScheduledDate',
        tip: 'toolbar.scheduledDateTip',
        action: () => dispatchBlockEvent('OPEN_SCHEDULED_DATE_PICKER'),
      },
      {
        icon: CheckSquare,
        label: 'toolbar.todoToggle',
        tip: 'toolbar.todoToggleTip',
        action: () => dispatchBlockEvent('TOGGLE_TODO_STATE'),
      },
      {
        icon: Settings2,
        label: 'toolbar.properties',
        tip: 'toolbar.propertiesTip',
        action: () => dispatchBlockEvent('OPEN_BLOCK_PROPERTIES'),
      },
    ],
    [],
  )

  const historyButtons: ToolbarButtonConfig[] = useMemo(
    () => [
      {
        icon: Undo2,
        label: 'toolbar.undo',
        tip: 'toolbar.undoTip',
        disabledWhenFalse: 'canUndo',
        action: () => editor.chain().focus().undo().run(),
      },
      {
        icon: Redo2,
        label: 'toolbar.redo',
        tip: 'toolbar.redoTip',
        disabledWhenFalse: 'canRedo',
        action: () => editor.chain().focus().redo().run(),
      },
      {
        icon: X,
        label: 'toolbar.discard',
        tip: 'toolbar.discardTip',
        action: () => dispatchBlockEvent('DISCARD_BLOCK_EDIT'),
      },
    ],
    [editor],
  )

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
            <Tip label={t('toolbar.linkTip')}>
              <PopoverAnchor asChild>
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
              </PopoverAnchor>
            </Tip>
            <PopoverContent align="start" className="w-72 p-3">
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
            <Tip label={t('toolbar.codeBlockLanguageTip')}>
              <PopoverAnchor asChild>
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
              </PopoverAnchor>
            </Tip>
            <PopoverContent align="start" className="w-auto p-1">
              <div className="flex flex-col gap-0.5">
                {CODE_LANGUAGES.map((lang) => (
                  <Button
                    key={lang}
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'justify-start text-sm',
                      state.codeBlockLanguage === lang && 'bg-accent',
                    )}
                    onPointerDown={(e) => {
                      e.preventDefault()
                      const attrs = { language: lang }
                      if (!state.codeBlock) {
                        editor
                          .chain()
                          .focus()
                          .toggleCodeBlock()
                          .updateAttributes('codeBlock', attrs)
                          .run()
                      } else {
                        editor.chain().focus().updateAttributes('codeBlock', attrs).run()
                      }
                      setCodeBlockPopoverOpen(false)
                    }}
                  >
                    {lang}
                  </Button>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'justify-start text-sm',
                    state.codeBlock && !state.codeBlockLanguage && 'bg-accent',
                  )}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    if (state.codeBlock) {
                      editor.chain().focus().updateAttributes('codeBlock', { language: '' }).run()
                    } else {
                      editor.chain().focus().toggleCodeBlock().run()
                    }
                    setCodeBlockPopoverOpen(false)
                  }}
                >
                  {t('toolbar.plainText')}
                </Button>
              </div>
            </PopoverContent>
          </Popover>

          <Popover open={headingPopoverOpen} onOpenChange={setHeadingPopoverOpen}>
            <Tip label={t('toolbar.headingTip')}>
              <PopoverAnchor asChild>
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
              </PopoverAnchor>
            </Tip>
            <PopoverContent align="start" className="w-auto p-1">
              <div className="flex flex-col gap-0.5">
                {([1, 2, 3, 4, 5, 6] as const).map((level) => (
                  <Button
                    key={level}
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'justify-start text-sm',
                      state.headingLevel === level && 'bg-accent',
                    )}
                    onPointerDown={(e) => {
                      e.preventDefault()
                      editor.chain().focus().toggleHeading({ level }).run()
                      setHeadingPopoverOpen(false)
                    }}
                  >
                    H{level}
                  </Button>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn('justify-start text-sm', state.headingLevel === 0 && 'bg-accent')}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    if (state.headingLevel > 0) {
                      editor
                        .chain()
                        .focus()
                        .toggleHeading({ level: state.headingLevel as 1 | 2 | 3 | 4 | 5 | 6 })
                        .run()
                    }
                    setHeadingPopoverOpen(false)
                  }}
                >
                  {t('toolbar.paragraph')}
                </Button>
              </div>
            </PopoverContent>
          </Popover>

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
