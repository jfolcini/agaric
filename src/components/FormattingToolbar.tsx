/**
 * FormattingToolbar — always-visible toolbar rendered above the active editor.
 *
 * Buttons: Bold, Italic, Code | Undo, Redo.
 * Uses onMouseDown + preventDefault so clicks never steal focus from TipTap.
 * Active marks are highlighted via aria-pressed + bg-accent.
 */

import type { Editor } from '@tiptap/react'
import { useEditorState } from '@tiptap/react'
import { Bold, Code, Italic, Redo2, Undo2 } from 'lucide-react'
import type React from 'react'
import { Button } from './ui/button'
import { Separator } from './ui/separator'

interface FormattingToolbarProps {
  editor: Editor
}

export function FormattingToolbar({ editor }: FormattingToolbarProps): React.ReactElement {
  const state = useEditorState({
    editor,
    selector: (ctx) => ({
      bold: ctx.editor.isActive('bold'),
      italic: ctx.editor.isActive('italic'),
      code: ctx.editor.isActive('code'),
      canUndo: ctx.editor.can().undo(),
      canRedo: ctx.editor.can().redo(),
    }),
  })

  return (
    <div className="formatting-toolbar flex items-center gap-0.5 rounded-md border bg-muted/50 p-0.5 mb-1">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Bold"
        aria-pressed={state.bold}
        className={state.bold ? 'bg-accent' : ''}
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
        className={state.italic ? 'bg-accent' : ''}
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
        className={state.code ? 'bg-accent' : ''}
        onMouseDown={(e) => {
          e.preventDefault()
          editor.chain().focus().toggleCode().run()
        }}
      >
        <Code size={14} />
      </Button>

      <Separator orientation="vertical" className="border-l border-border mx-1 h-5" />

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
