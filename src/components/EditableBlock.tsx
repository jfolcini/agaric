/**
 * EditableBlock — wrapper that switches between static div and TipTap editor.
 *
 * When focused: mounts the roving TipTap instance.
 * When not focused: renders StaticBlock (plain div).
 * On blur: serializes, compares, flushes if dirty, auto-splits on \n.
 */

import { EditorContent } from '@tiptap/react'
import type { TFunction } from 'i18next'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useDraftAutosave } from '@/hooks/useDraftAutosave'
import { useEditorBlur } from '@/hooks/useEditorBlur'
import { cn } from '@/lib/utils'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import { shouldSplitOnBlur } from '../editor/use-roving-editor'
import { extractFileInfo } from '../lib/file-utils'
import { addAttachment } from '../lib/tauri'
import { useBlockStore } from '../stores/blocks'
import { usePageBlockStore } from '../stores/page-blocks'
import { FormattingToolbar } from './FormattingToolbar'
import { StaticBlock } from './StaticBlock'

// Re-export for backwards compatibility — consumers may import from EditableBlock
export { EDITOR_PORTAL_SELECTORS } from '@/hooks/useEditorBlur'

/**
 * Unmount the roving editor from the given block and persist its content.
 * Uses `shouldSplitOnBlur` to decide between split and edit.
 * Returns the changed markdown, or null if unchanged.
 */
function persistUnmount(
  re: RovingEditorHandle,
  prevId: string,
  editFn: (id: string, content: string) => void,
  splitBlockFn: (id: string, content: string) => void,
): string | null {
  const changed = re.unmount()
  if (changed !== null) {
    if (shouldSplitOnBlur(changed)) {
      splitBlockFn(prevId, changed)
    } else {
      editFn(prevId, changed)
    }
  }
  return changed
}

/**
 * Shared attachment-processing loop used by both handleDrop and handlePaste.
 * Extracts file info, calls addAttachment, and shows success/error toasts.
 */
async function processFileAttachments(files: File[], blockId: string, t: TFunction): Promise<void> {
  for (const file of files) {
    const info = extractFileInfo(file)
    if (!info.fsPath) {
      toast.error(t('blockTree.filePathReadFailed'))
      continue
    }
    try {
      await addAttachment({
        blockId,
        filename: info.filename,
        mimeType: info.mimeType,
        sizeBytes: info.sizeBytes,
        fsPath: info.fsPath,
      })
      toast.success(t('blockTree.attachedFileMessage', { filename: info.filename }))
    } catch {
      toast.error(t('blockTree.attachFileFailed'))
    }
  }
}

interface EditableBlockProps {
  blockId: string
  content: string
  isFocused: boolean
  rovingEditor: RovingEditorHandle
  /** Called when the user clicks a block-link chip to navigate. */
  onNavigate?: ((id: string) => void) | undefined
  /** Resolve a block/page ULID → display title. */
  resolveBlockTitle?: ((id: string) => string) | undefined
  /** Resolve a tag ULID → display name. */
  resolveTagName?: ((id: string) => string) | undefined
  /** Check whether a linked block is active or deleted. */
  resolveBlockStatus?: ((id: string) => 'active' | 'deleted') | undefined
  /** Check whether a referenced tag is active or deleted. */
  resolveTagStatus?: ((id: string) => 'active' | 'deleted') | undefined
  /** Whether this block is part of a multi-selection. */
  isSelected?: boolean | undefined
  /** Ctrl+Click / Shift+Click selection callback. */
  onSelect?: ((blockId: string, mode: 'toggle' | 'range') => void) | undefined
}

function EditableBlockInner({
  blockId,
  content,
  isFocused,
  rovingEditor,
  onNavigate,
  resolveBlockTitle,
  resolveTagName,
  resolveBlockStatus,
  resolveTagStatus,
  isSelected,
  onSelect,
}: EditableBlockProps): React.ReactElement {
  const setFocused = useBlockStore((s) => s.setFocused)
  const edit = usePageBlockStore((s) => s.edit)
  const splitBlock = usePageBlockStore((s) => s.splitBlock)
  const currentPriority = usePageBlockStore(
    (s) => s.blocks.find((b) => b.id === blockId)?.priority ?? null,
  )
  const wrapperRef = useRef<HTMLElement>(null)

  // Stable refs for values the auto-mount effect needs to READ but should
  // not RE-RUN when they change.  `rovingEditor` is a mutable handle whose
  // object identity changes on every render; `content` is only needed as the
  // initial value passed to `mount()` — a content change while the editor is
  // already mounted should not trigger a re-mount.
  const rovingEditorRef = useRef(rovingEditor)
  rovingEditorRef.current = rovingEditor
  const contentRef = useRef(content)
  contentRef.current = content
  const editRef = useRef(edit)
  editRef.current = edit
  const splitBlockRef = useRef(splitBlock)
  splitBlockRef.current = splitBlock

  // ── Draft autosave: poll editor content while focused ──────────────
  const [liveContent, setLiveContent] = useState('')

  useEffect(() => {
    if (!isFocused || rovingEditorRef.current.activeBlockId !== blockId) {
      setLiveContent('')
      return
    }
    const interval = setInterval(() => {
      const md = rovingEditorRef.current.getMarkdown()
      if (md !== null) setLiveContent(md)
    }, 500)
    return () => clearInterval(interval)
  }, [isFocused, blockId])

  const { discardDraft } = useDraftAutosave(isFocused ? blockId : null, liveContent)

  // Scroll the editor wrapper into view when the block becomes focused.
  // Uses requestAnimationFrame to avoid layout thrashing after mount.
  useEffect(() => {
    if (isFocused) {
      requestAnimationFrame(() => {
        wrapperRef.current?.scrollIntoView({ block: 'nearest' })
      })
    }
  }, [isFocused])

  // Auto-mount the roving editor when focus is set externally (e.g. via
  // PageEditor's "Add block" button or Enter-to-create) without going
  // through handleFocus.  Flushes the previous block's changes first to
  // prevent data loss — same unmount-save logic as handleFocus (H-11).
  useEffect(() => {
    const re = rovingEditorRef.current
    if (isFocused && re.activeBlockId !== blockId) {
      // Unmount from previous block if any (mirrors handleFocus logic)
      if (re.activeBlockId) {
        persistUnmount(re, re.activeBlockId, editRef.current, splitBlockRef.current)
      }
      re.mount(blockId, contentRef.current)
    }
  }, [isFocused, blockId])

  const handleFocus = useCallback(
    (id: string) => {
      // Unmount from previous block if any
      if (rovingEditorRef.current.activeBlockId && rovingEditorRef.current.activeBlockId !== id) {
        persistUnmount(
          rovingEditorRef.current,
          rovingEditorRef.current.activeBlockId,
          edit,
          splitBlock,
        )
      }
      // Mount into the new block
      setFocused(id)
      rovingEditorRef.current.mount(id, content)
    },
    [content, setFocused, edit, splitBlock],
  )

  const { handleBlur } = useEditorBlur({
    rovingEditor,
    blockId,
    edit,
    splitBlock,
    setFocused,
    discardDraft,
  })

  const { t } = useTranslation()
  const [isDragOver, setIsDragOver] = useState(false)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)
      const files = Array.from(e.dataTransfer.files)
      if (files.length === 0) return
      await processFileAttachments(files, blockId, t)
    },
    [blockId, t],
  )

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData.files)
      if (files.length === 0) return // No files — let TipTap handle text paste
      e.preventDefault()
      await processFileAttachments(files, blockId, t)
    },
    [blockId, t],
  )

  if (!isFocused) {
    return (
      <StaticBlock
        blockId={blockId}
        content={content}
        onFocus={handleFocus}
        onNavigate={onNavigate}
        resolveBlockTitle={resolveBlockTitle}
        resolveTagName={resolveTagName}
        resolveBlockStatus={resolveBlockStatus}
        resolveTagStatus={resolveTagStatus}
        isSelected={isSelected}
        onSelect={onSelect}
      />
    )
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: wrapper div catches blur from TipTap contenteditable
    <section
      ref={wrapperRef}
      id={`editor-${blockId}`}
      className={cn(
        'block-editor rounded-md ring-1 ring-ring/30 bg-accent/[0.06] shadow-sm',
        isDragOver && 'ring-2 ring-primary bg-primary/5',
      )}
      data-testid="block-editor"
      data-block-id={blockId}
      onBlur={handleBlur}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      {rovingEditor.editor && (
        <FormattingToolbar
          editor={rovingEditor.editor}
          blockId={blockId}
          currentPriority={currentPriority}
        />
      )}
      <EditorContent editor={rovingEditor.editor} />
    </section>
  )
}

export const EditableBlock = React.memo(EditableBlockInner)
EditableBlock.displayName = 'EditableBlock'
