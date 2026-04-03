/**
 * FormattingToolbar — always-visible toolbar rendered above the active editor.
 *
 * Buttons: Bold, Italic, Code | External Link, Code Block, Heading | Priority 1/2/3, Date, Due Date, Scheduled Date, TODO | Undo, Redo.
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
  Italic,
  Link2,
  Redo2,
  Signal,
  Undo2,
  X,
} from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LinkEditPopover } from './LinkEditPopover'
import { Button } from './ui/button'
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover'
import { Separator } from './ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

interface FormattingToolbarProps {
  editor: Editor
  /** Block ID used to associate toolbar with its editor via aria-controls. */
  blockId?: string
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

export function FormattingToolbar({ editor, blockId }: FormattingToolbarProps): React.ReactElement {
  const { t } = useTranslation()
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)
  const [headingPopoverOpen, setHeadingPopoverOpen] = useState(false)

  const state = useEditorState({
    editor,
    selector: (ctx) => ({
      bold: ctx.editor.isActive('bold'),
      italic: ctx.editor.isActive('italic'),
      code: ctx.editor.isActive('code'),
      link: ctx.editor.isActive('link'),
      codeBlock: ctx.editor.isActive('codeBlock'),
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

  return (
    <TooltipProvider delayDuration={200}>
      <div
        role="toolbar"
        aria-label={t('toolbar.formatting')}
        aria-controls={blockId ? `editor-${blockId}` : undefined}
        className="formatting-toolbar flex items-center gap-0.5 border-b border-border/40 bg-muted/30 px-2 py-px overflow-x-auto"
      >
        <Tip label={t('toolbar.boldTip')}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('toolbar.bold')}
            aria-pressed={state.bold}
            className={state.bold ? 'bg-accent text-accent-foreground' : ''}
            onPointerDown={(e) => {
              e.preventDefault()
              editor.chain().focus().toggleBold().run()
            }}
          >
            <Bold size={14} />
          </Button>
        </Tip>
        <Tip label={t('toolbar.italicTip')}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('toolbar.italic')}
            aria-pressed={state.italic}
            className={state.italic ? 'bg-accent text-accent-foreground' : ''}
            onPointerDown={(e) => {
              e.preventDefault()
              editor.chain().focus().toggleItalic().run()
            }}
          >
            <Italic size={14} />
          </Button>
        </Tip>
        <Tip label={t('toolbar.codeTip')}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('toolbar.code')}
            aria-pressed={state.code}
            className={state.code ? 'bg-accent text-accent-foreground' : ''}
            onPointerDown={(e) => {
              e.preventDefault()
              editor.chain().focus().toggleCode().run()
            }}
          >
            <Code size={14} />
          </Button>
        </Tip>

        <Separator orientation="vertical" className="border-l border-border/40 mx-0.5 h-4" />

        <Popover open={linkPopoverOpen} onOpenChange={setLinkPopoverOpen}>
          <Tip label={t('toolbar.linkTip')}>
            <PopoverAnchor asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('toolbar.link')}
                aria-pressed={state.link}
                className={state.link ? 'bg-accent text-accent-foreground' : ''}
                onPointerDown={(e) => {
                  e.preventDefault()
                  setLinkPopoverOpen((prev) => !prev)
                }}
              >
                <Link2 size={14} />
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

        <Tip label={t('toolbar.pageLinkTip')}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('toolbar.internalLink')}
            onPointerDown={(e) => {
              e.preventDefault()
              editor.chain().focus().insertContent('[[').run()
            }}
          >
            <FileSymlink size={14} />
          </Button>
        </Tip>

        <Tip label={t('toolbar.tagTip')}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('toolbar.insertTag')}
            onPointerDown={(e) => {
              e.preventDefault()
              editor.chain().focus().insertContent('@').run()
            }}
          >
            <AtSign size={14} />
          </Button>
        </Tip>

        <Tip label={t('toolbar.codeBlockTip')}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('toolbar.codeBlock')}
            aria-pressed={state.codeBlock}
            className={state.codeBlock ? 'bg-accent text-accent-foreground' : ''}
            onPointerDown={(e) => {
              e.preventDefault()
              editor.chain().focus().toggleCodeBlock().run()
            }}
          >
            <FileCode2 size={14} />
          </Button>
        </Tip>

        <Popover open={headingPopoverOpen} onOpenChange={setHeadingPopoverOpen}>
          <Tip label={t('toolbar.headingTip')}>
            <PopoverAnchor asChild>
              <Button
                variant="ghost"
                size="xs"
                aria-label={t('toolbar.headingLevel')}
                aria-pressed={state.headingLevel > 0}
                className={state.headingLevel > 0 ? 'bg-accent text-accent-foreground' : ''}
                onPointerDown={(e) => {
                  e.preventDefault()
                  setHeadingPopoverOpen((prev) => !prev)
                }}
              >
                <Heading size={14} />
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
                  className={`justify-start text-sm ${state.headingLevel === level ? 'bg-accent' : ''}`}
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
                className={`justify-start text-sm ${state.headingLevel === 0 ? 'bg-accent' : ''}`}
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

        <Tip label={t('toolbar.priority1Tip')}>
          <Button
            variant="ghost"
            size="xs"
            aria-label={t('toolbar.priority1')}
            onPointerDown={(e) => {
              e.preventDefault()
              document.dispatchEvent(new CustomEvent('set-priority-1'))
            }}
          >
            <Signal size={14} className="text-red-500" />
            <span className="text-[10px] font-bold">1</span>
          </Button>
        </Tip>
        <Tip label={t('toolbar.priority2Tip')}>
          <Button
            variant="ghost"
            size="xs"
            aria-label={t('toolbar.priority2')}
            onPointerDown={(e) => {
              e.preventDefault()
              document.dispatchEvent(new CustomEvent('set-priority-2'))
            }}
          >
            <Signal size={14} className="text-yellow-500" />
            <span className="text-[10px] font-bold">2</span>
          </Button>
        </Tip>
        <Tip label={t('toolbar.priority3Tip')}>
          <Button
            variant="ghost"
            size="xs"
            aria-label={t('toolbar.priority3')}
            onPointerDown={(e) => {
              e.preventDefault()
              document.dispatchEvent(new CustomEvent('set-priority-3'))
            }}
          >
            <Signal size={14} className="text-blue-500" />
            <span className="text-[10px] font-bold">3</span>
          </Button>
        </Tip>
        <Tip label={t('toolbar.insertDateTip')}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('toolbar.insertDate')}
            onPointerDown={(e) => {
              e.preventDefault()
              document.dispatchEvent(new CustomEvent('open-date-picker'))
            }}
          >
            <CalendarDays size={14} />
          </Button>
        </Tip>
        <Tip label={t('toolbar.dueDateTip')}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('toolbar.setDueDate')}
            onPointerDown={(e) => {
              e.preventDefault()
              document.dispatchEvent(new CustomEvent('open-due-date-picker'))
            }}
          >
            <CalendarClock size={14} />
          </Button>
        </Tip>
        <Tip label={t('toolbar.scheduledDateTip')}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('toolbar.setScheduledDate')}
            onPointerDown={(e) => {
              e.preventDefault()
              document.dispatchEvent(new CustomEvent('open-scheduled-date-picker'))
            }}
          >
            <CalendarCheck2 size={14} />
          </Button>
        </Tip>
        <Tip label={t('toolbar.todoToggleTip')}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('toolbar.todoToggle')}
            onPointerDown={(e) => {
              e.preventDefault()
              document.dispatchEvent(new CustomEvent('toggle-todo-state'))
            }}
          >
            <CheckSquare size={14} />
          </Button>
        </Tip>

        <Separator orientation="vertical" className="border-l border-border/40 mx-0.5 h-4" />

        <Tip label={t('toolbar.undoTip')}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('toolbar.undo')}
            disabled={!state.canUndo}
            onPointerDown={(e) => {
              e.preventDefault()
              editor.chain().focus().undo().run()
            }}
          >
            <Undo2 size={14} />
          </Button>
        </Tip>
        <Tip label={t('toolbar.redoTip')}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('toolbar.redo')}
            disabled={!state.canRedo}
            onPointerDown={(e) => {
              e.preventDefault()
              editor.chain().focus().redo().run()
            }}
          >
            <Redo2 size={14} />
          </Button>
        </Tip>
        <Tip label={t('toolbar.discardTip')}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('toolbar.discard')}
            onPointerDown={(e) => {
              e.preventDefault()
              document.dispatchEvent(new CustomEvent('discard-block-edit'))
            }}
          >
            <X size={14} />
          </Button>
        </Tip>
      </div>
    </TooltipProvider>
  )
}
