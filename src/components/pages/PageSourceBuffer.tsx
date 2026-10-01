/**
 * PageSourceBuffer — the text of *Edit as Markdown* (#5160 phase 5): a
 * plain-text TipTap editor whose lines carry their block ids
 * (`@/editor/source-buffer`). `PageSourceEditor` reaches it only through a
 * dynamic import, so TipTap stays off the startup path.
 */

import { EditorContent, useEditor } from '@tiptap/react'
import type React from 'react'
import { useEffect, useImperativeHandle, useState } from 'react'

import {
  linesContent,
  readLines,
  sourceBufferExtensions,
  type SourceLines,
} from '@/editor/source-buffer'

export interface PageSourceBufferHandle {
  /** Focus the buffer with line `index`, counted from 0, selected, when it has that line. */
  selectLine: (index: number) => void
  focus: () => void
}

export interface PageSourceBufferProps {
  /** The lines the buffer opens with; a new buffer, by `key`, opens with others. */
  initial: SourceLines
  /** The page's line ids as loaded: the only ids a paste or a drop brings in. */
  pageIds: ReadonlyArray<string | null>
  readOnly: boolean
  label: string
  describedBy: string
  className: string
  onChange: (lines: SourceLines) => void
  /** Sees each keydown after the editor's own keys; true when it handled it. */
  onKeyDown: (event: KeyboardEvent) => boolean
  ref?: React.Ref<PageSourceBufferHandle>
}

export function PageSourceBuffer({
  initial,
  pageIds,
  readOnly,
  label,
  describedBy,
  className,
  onChange,
  onKeyDown,
  ref,
}: PageSourceBufferProps): React.ReactElement {
  // One options object for the editor's life: `useEditor` re-applies options
  // that change identity.
  const [options] = useState(() => ({
    extensions: sourceBufferExtensions(pageIds),
    content: linesContent(initial),
    autofocus: 'start' as const,
    // Built in an effect: a lazily loaded editor built during render can be
    // reclaimed by TipTap's unmount timer before it mounts (use-roving-editor).
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': label,
        'aria-describedby': describedBy,
        spellcheck: 'false',
        'data-testid': 'page-source-editor',
        class: className,
      },
    },
  }))
  const editor = useEditor(options)

  useEffect(() => {
    if (editor === null) return
    const update = (): void => onChange(readLines(editor.state.doc))
    editor.on('update', update)
    return () => {
      editor.off('update', update)
    }
  }, [editor, onChange])

  useEffect(() => {
    if (editor === null) return
    const dom = editor.view.dom
    const keydown = (event: KeyboardEvent): void => {
      if (onKeyDown(event)) event.preventDefault()
    }
    dom.addEventListener('keydown', keydown)
    return () => dom.removeEventListener('keydown', keydown)
  }, [editor, onKeyDown])

  useEffect(() => {
    if (editor === null) return
    editor.setEditable(!readOnly, false)
    editor.view.dom.setAttribute('aria-readonly', String(readOnly))
  }, [editor, readOnly])

  useImperativeHandle(
    ref,
    () => ({
      selectLine: (index) => {
        if (editor === null) return
        const { doc } = editor.state
        if (index < 0 || index >= doc.childCount) return
        let from = 1
        for (let i = 0; i < index; i += 1) from += doc.child(i).nodeSize
        const to = from + doc.child(index).content.size
        editor.chain().setTextSelection({ from, to }).scrollIntoView().run()
        // Not TipTap's `focus`: ProseMirror focuses only an editable view, and a
        // refused save names its line while the buffer is still read-only.
        editor.view.dom.focus()
      },
      focus: () => {
        editor?.commands.focus()
      },
    }),
    [editor],
  )

  return <EditorContent editor={editor} />
}
