/**
 * FormattingToolbar — always-visible toolbar rendered above the active editor.
 *
 * Buttons: Bold, Italic, Code | External Link, Code Block | Undo, Redo.
 * Uses onMouseDown + preventDefault so clicks never steal focus from TipTap.
 * Active marks are highlighted via aria-pressed + bg-accent.
 *
 * The External Link button opens a LinkEditPopover (shadcn Popover) instead
 * of the old `window.prompt()`. The popover is also opened by the Ctrl+K
 * keyboard shortcut (dispatched from the ExternalLink TipTap extension).
 */

import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { Bold, Code, FileCode2, Italic, Link2, Redo2, Undo2 } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { LinkEditPopover } from './LinkEditPopover'
import { Button } from './ui/button'
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover'
import { Separator } from './ui/separator'

interface FormattingToolbarProps {
  editor: Editor
}

export function FormattingToolbar({ editor }: FormattingToolbarProps): React.ReactElement {
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
    <div className="formatting-toolbar flex items-center gap-0.5 border-b border-border/40 bg-muted/30 px-2 py-px">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Bold"
        aria-pressed={state.bold}
        className={state.bold ? 'bg-accent text-accent-foreground' : ''}
        onMouseDown={(e) => {
          e.preventDefault()
          editor.chain().focus().toggleBold().run()
        }}
      >
        <Bold size={14} />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Italic"
        aria-pressed={state.italic}
        className={state.italic ? 'bg-accent text-accent-foreground' : ''}
        onMouseDown={(e) => {
          e.preventDefault()
          editor.chain().focus().toggleItalic().run()
        }}
      >
        <Italic size={14} />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Code"
        aria-pressed={state.code}
        className={state.code ? 'bg-accent text-accent-foreground' : ''}
        onMouseDown={(e) => {
          e.preventDefault()
          editor.chain().focus().toggleCode().run()
        }}
      >
        <Code size={14} />
      </Button>

      <Separator orientation="vertical" className="border-l border-border/40 mx-0.5 h-4" />

      <Popover open={linkPopoverOpen} onOpenChange={setLinkPopoverOpen}>
        <PopoverAnchor asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="External link"
            aria-pressed={state.link}
            className={state.link ? 'bg-accent text-accent-foreground' : ''}
            onMouseDown={(e) => {
              e.preventDefault()
              setLinkPopoverOpen((prev) => !prev)
            }}
          >
            <Link2 size={14} />
          </Button>
        </PopoverAnchor>
        <PopoverContent align="start" className="w-72 p-3">
          <LinkEditPopover
            editor={editor}
            isEditing={state.link}
            initialUrl={currentUrl}
            onClose={handleLinkPopoverClose}
          />
        </PopoverContent>
      </Popover>

      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Code block"
        aria-pressed={state.codeBlock}
        className={state.codeBlock ? 'bg-accent text-accent-foreground' : ''}
        onMouseDown={(e) => {
          e.preventDefault()
          editor.chain().focus().toggleCodeBlock().run()
        }}
      >
        <FileCode2 size={14} />
      </Button>

      <Separator orientation="vertical" className="border-l border-border/40 mx-0.5 h-4" />

      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Undo"
        disabled={!state.canUndo}
        onMouseDown={(e) => {
          e.preventDefault()
          editor.chain().focus().undo().run()
        }}
      >
        <Undo2 size={14} />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Redo"
        disabled={!state.canRedo}
        onMouseDown={(e) => {
          e.preventDefault()
          editor.chain().focus().redo().run()
        }}
      >
        <Redo2 size={14} />
      </Button>
    </div>
  )
}
