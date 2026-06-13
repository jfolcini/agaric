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

import { SelectionBubbleMenu } from '@/components/editor-toolbar/SelectionBubbleMenu'
import { StaticBlock } from '@/components/editor/StaticBlock'
import { FormattingToolbar } from '@/components/FormattingToolbar'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { shouldSplitOnBlur } from '@/editor/use-roving-editor'
import { useDraftAutosave } from '@/hooks/useDraftAutosave'
import { useEditorBlur } from '@/hooks/useEditorBlur'
import { useScrollCaretAboveKeyboard } from '@/hooks/useScrollCaretAboveKeyboard'
import { extractFileInfo, isAttachmentAllowed, readFileBytes } from '@/lib/file-utils'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { reportIpcError } from '@/lib/report-ipc-error'
import { addAttachmentWithBytes } from '@/lib/tauri'
import { cn } from '@/lib/utils'
import { useBlockStore } from '@/stores/blocks'
import { type PageBlockState, usePageBlockStore, usePageBlockStoreApi } from '@/stores/page-blocks'

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
 * Validates MIME + size, reads the file to bytes, calls
 * `addAttachmentWithBytes` (PEND-76 F2 — backend is the sole writer), and
 * shows success/error toasts.
 */
/** Files smaller than this show no progress toast — the IPC round-trip is fast enough. */
const ATTACH_PROGRESS_THRESHOLD_BYTES = 1_048_576 // 1 MB

async function processFileAttachments(files: File[], blockId: string, t: TFunction): Promise<void> {
  for (const file of files) {
    const info = extractFileInfo(file)
    const allowed = isAttachmentAllowed(info.mimeType, info.sizeBytes)
    if (!allowed.ok) {
      notify.error(t(allowed.reason, allowed.i18nContext))
      continue
    }
    const showProgress = info.sizeBytes >= ATTACH_PROGRESS_THRESHOLD_BYTES
    const progressToastId = showProgress
      ? notify.loading(t('blockTree.attachingFileMessage', { filename: info.filename }))
      : undefined
    try {
      const bytes = await readFileBytes(file)
      await addAttachmentWithBytes({
        blockId,
        filename: info.filename,
        mimeType: info.mimeType,
        bytes,
      })
      if (progressToastId !== undefined) notify.dismiss(progressToastId)
      notify.success(t('blockTree.attachedFileMessage', { filename: info.filename }))
    } catch (err) {
      if (progressToastId !== undefined) notify.dismiss(progressToastId)
      reportIpcError('EditableBlock', 'blockTree.attachFileFailed', err, t, {
        blockId,
        filename: info.filename,
      })
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
  const { edit, splitBlock } = usePageBlockStoreApi().getState()
  const prioritySelector = useCallback(
    (s: PageBlockState) => s.blocksById.get(blockId)?.priority ?? null,
    [blockId],
  )
  const currentPriority = usePageBlockStore(prioritySelector)
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

  // ── Draft autosave: subscribe to TipTap update events while focused ──
  const [liveContent, setLiveContent] = useState('')

  useEffect(() => {
    if (!isFocused) {
      setLiveContent('')
      return
    }
    // Register whenever focused — do NOT gate on `activeBlockId === blockId`
    // here. On a block→block focus switch React runs this effect before the
    // auto-mount effect (:179), so `activeBlockId` still points at the OLD
    // block and the newly-focused block would never register its callback
    // (silent draft-autosave loss, #1015). Block identity is enforced inside
    // the callback instead, so late/cross-block fires are ignored.
    rovingEditorRef.current.setOnMarkdownChange((md) => {
      if (rovingEditorRef.current.activeBlockId === blockId) setLiveContent(md)
    })
    return () => {
      rovingEditorRef.current.setOnMarkdownChange(null)
    }
  }, [isFocused, blockId])

  const { discardDraft } = useDraftAutosave(isFocused ? blockId : null, liveContent)

  // Scroll the editor wrapper into view when the block becomes focused, and
  // keep its caret above the on-screen soft keyboard while focused (#917).
  // On desktop / where no soft keyboard is present this degrades to the
  // original `scrollIntoView({ block: 'nearest' })` behavior.
  useScrollCaretAboveKeyboard(wrapperRef, isFocused)

  // Auto-mount the roving editor when focus is set externally (e.g. via
  // PageEditor's t('action.addBlock') button or Enter-to-create) without going
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
          editRef.current,
          splitBlockRef.current,
        )
      }
      // Mount into the new block
      logger.debug('editor', 'focus', { blockId: id })
      setFocused(id)
      rovingEditorRef.current.mount(id, content)
    },
    [content, setFocused],
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
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- wrapper div catches blur from TipTap contenteditable
    <section
      ref={wrapperRef}
      id={`editor-${blockId}`}
      className={cn(
        'block-editor rounded-md ring-1 ring-ring/30 bg-accent/[0.06] shadow-sm',
        isSelected && 'block-selected',
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
      {rovingEditor.editor && (
        <SelectionBubbleMenu editor={rovingEditor.editor} blockId={blockId} />
      )}
      <EditorContent editor={rovingEditor.editor} />
      {isDragOver && (
        <p className="px-3 pb-1 text-xs text-primary/70 select-none" aria-live="polite">
          {t('block.attachDropZoneCaption')}
        </p>
      )}
    </section>
  )
}

export const EditableBlock = React.memo(EditableBlockInner)
EditableBlock.displayName = 'EditableBlock'
