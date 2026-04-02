/**
 * FormattingToolbar — always-visible toolbar rendered above the active editor.
 *
 * Buttons: Bold, Italic, Code | External Link, Code Block | Priority 1/2/3, Date | Undo, Redo.
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
  Bold,
  CalendarDays,
  Code,
  FileCode2,
  FileSymlink,
  Hash,
  Italic,
  Link2,
  Redo2,
  Signal,
  Undo2,
} from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
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
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)

  const state = useEditorState({
    editor,
    selector: (ctx) => ({
      bold: ctx.editor.isActive('bold'),
      italic: ctx.editor.isActive('italic'),
      code: ctx.editor.isActive('code'),
      link: ctx.editor.isActive('link'),
      codeBlock: ctx.editor.isActive('codeBlock'),
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
        aria-label="Formatting"
        aria-controls={blockId ? `editor-${blockId}` : undefined}
        className="formatting-toolbar flex items-center gap-0.5 border-b border-border/40 bg-muted/30 px-2 py-px"
      >
        <Tip label="Bold (Ctrl+B)">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Bold"
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
        <Tip label="Italic (Ctrl+I)">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Italic"
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
        <Tip label="Inline code (Ctrl+E)">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Code"
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
          <Tip label="External link (Ctrl+K)">
            <PopoverAnchor asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="External link"
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

        <Tip label="Page link ([[)">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Internal link"
            onPointerDown={(e) => {
              e.preventDefault()
              editor.chain().focus().insertContent('[[').run()
            }}
          >
            <FileSymlink size={14} />
          </Button>
        </Tip>

        <Tip label="Tag (@)">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Insert tag"
            onPointerDown={(e) => {
              e.preventDefault()
              editor.chain().focus().insertContent('@').run()
            }}
          >
            <Hash size={14} />
          </Button>
        </Tip>

        <Tip label="Code block (Ctrl+Shift+C)">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Code block"
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

        <Separator orientation="vertical" className="border-l border-border/40 mx-0.5 h-4" />

        <Tip label="Priority 1 (high)">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Priority 1 (high)"
            onPointerDown={(e) => {
              e.preventDefault()
              document.dispatchEvent(new CustomEvent('set-priority-1'))
            }}
          >
            <Signal size={14} className="text-red-500" />
            <span className="ml-0.5 text-[10px] font-bold">1</span>
          </Button>
        </Tip>
        <Tip label="Priority 2 (medium)">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Priority 2 (medium)"
            onPointerDown={(e) => {
              e.preventDefault()
              document.dispatchEvent(new CustomEvent('set-priority-2'))
            }}
          >
            <Signal size={14} className="text-yellow-500" />
            <span className="ml-0.5 text-[10px] font-bold">2</span>
          </Button>
        </Tip>
        <Tip label="Priority 3 (low)">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Priority 3 (low)"
            onPointerDown={(e) => {
              e.preventDefault()
              document.dispatchEvent(new CustomEvent('set-priority-3'))
            }}
          >
            <Signal size={14} className="text-blue-500" />
            <span className="ml-0.5 text-[10px] font-bold">3</span>
          </Button>
        </Tip>
        <Tip label="Insert date">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Insert date"
            onPointerDown={(e) => {
              e.preventDefault()
              document.dispatchEvent(new CustomEvent('open-date-picker'))
            }}
          >
            <CalendarDays size={14} />
          </Button>
        </Tip>

        <Separator orientation="vertical" className="border-l border-border/40 mx-0.5 h-4" />

        <Tip label="Undo (Ctrl+Z)">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Undo"
            disabled={!state.canUndo}
            onPointerDown={(e) => {
              e.preventDefault()
              editor.chain().focus().undo().run()
            }}
          >
            <Undo2 size={14} />
          </Button>
        </Tip>
        <Tip label="Redo (Ctrl+Y)">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Redo"
            disabled={!state.canRedo}
            onPointerDown={(e) => {
              e.preventDefault()
              editor.chain().focus().redo().run()
            }}
          >
            <Redo2 size={14} />
          </Button>
        </Tip>
      </div>
    </TooltipProvider>
  )
}
