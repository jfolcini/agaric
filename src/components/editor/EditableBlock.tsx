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
import { useDebouncedContentCommit } from '@/hooks/useDebouncedContentCommit'
import { useDraftAutosave } from '@/hooks/useDraftAutosave'
import { useEditorBlur } from '@/hooks/useEditorBlur'
import { useScrollCaretAboveKeyboard } from '@/hooks/useScrollCaretAboveKeyboard'
import { retryOnPoolBusy } from '@/lib/app-error'
import { attachmentRef } from '@/lib/attachment-ref'
import { extractFileInfo, isAttachmentAllowed, readFileBytes } from '@/lib/file-utils'
import { bumpFlushSeq, commitInlineProperties } from '@/lib/inline-property-commit'
import { parseInlineProperties } from '@/lib/inline-property-parse'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { reportIpcError } from '@/lib/report-ipc-error'
import { addAttachmentWithBytes, deleteDraft, saveDraft } from '@/lib/tauri'
import { cn } from '@/lib/utils'
import { useBlockStore } from '@/stores/blocks'
import { type PageBlockState, usePageBlockStore, usePageBlockStoreApi } from '@/stores/page-blocks'

/**
 * Unmount the roving editor from the given block and persist its content.
 * Uses `shouldSplitOnBlur` to decide between split and edit.
 * Returns the changed markdown, or null if unchanged.
 *
 * #770 gap 1 — drop the previous block's `block_drafts` row here. This
 * function is the programmatic-move path (auto-mount effect + `handleFocus`),
 * which does NOT go through `useEditorBlur`'s `discardDraft()`. Without the
 * delete a debounced draft row left behind by the previous block survives to
 * the next boot, where `flush_all_drafts` replays it as an `edit_block` op —
 * potentially clobbering newer content.
 *
 * #2409 — but the delete is GATED on the appended op actually committing,
 * mirroring the blur path (`useEditorBlur` Step 5 → `discardDraftFor`).
 * `edit`/`splitBlock` resolve `false` when the backend write failed and the
 * optimistic update was rolled back (they never reject in production). Firing
 * `deleteDraft` unconditionally — concurrently with the un-awaited edit IPC —
 * destroyed BOTH copies of the typed text when that save later failed (store
 * rollback + hard row DELETE, nothing left for boot-time `flush_all_drafts`).
 * On a failed save we therefore RE-SEED the row with the full live markdown
 * we just tried to persist (`changed`) — mirroring the blur path's
 * `failedContent` re-save — because the previous block's own autosave does not
 * run a final save on a programmatic move (it sees `isFocused → false`), so its
 * debounced row may be stale or absent. On `changed === null` no op is appended, so the existing
 * committed content is the canonical record and the row is always safe to
 * delete (a >2 s pause can still have persisted a row for content that ended
 * up unchanged at unmount). Best-effort delete: deleting an absent row is a
 * harmless no-op.
 */
function persistUnmount(
  re: RovingEditorHandle,
  prevId: string,
  editFn: (id: string, content: string) => Promise<boolean> | void,
  splitBlockFn: (id: string, content: string) => Promise<boolean> | void,
  rootParentId: string | null,
): string | null {
  const changed = re.unmount()
  // #770 gap 1 — drop the previous block's draft row so it can't resurrect at
  // boot. Best-effort; deleting an absent row is a harmless no-op.
  const deletePrevDraft = () => {
    void deleteDraft(prevId).catch((err: unknown) => {
      logger.warn(
        'EditableBlock',
        'deleteDraft failed during programmatic unmount',
        { prevId },
        err,
      )
    })
  }
  if (changed === null) {
    // Unchanged: no op appended → existing committed content is canonical.
    deletePrevDraft()
    return changed
  }
  // #2675 — programmatic focus moves (Enter-to-create, auto-mount) are a
  // first-class save path, so property-bearing content must route through the
  // shared inline-property commit flow here exactly like the blur and
  // imperative-flush paths (see inline-property-commit.ts). Every branch
  // bumps the block's flush sequence token so a stale in-flight async save
  // cannot clobber this newer one.
  let outcome: Promise<boolean> | void
  if (shouldSplitOnBlur(changed)) {
    bumpFlushSeq(prevId)
    outcome = splitBlockFn(prevId, changed)
  } else {
    const inlineProps = parseInlineProperties(changed)
    if (inlineProps.length > 0) {
      const mySeq = bumpFlushSeq(prevId)
      outcome = commitInlineProperties({
        blockId: prevId,
        content: changed,
        inlineProps,
        mySeq,
        edit: editFn,
        rootParentId,
      })
    } else {
      bumpFlushSeq(prevId)
      outcome = editFn(prevId, changed)
    }
  }
  // #2409 — defer the delete until the appended op resolves. Keep the row on a
  // failed save (`ok === false`) so the typed text survives for boot recovery.
  void Promise.resolve(outcome)
    .catch((err: unknown) => {
      // Store actions resolve false rather than reject; treat an escaped
      // rejection as a failed save (keep the row — the safe direction).
      logger.warn(
        'EditableBlock',
        'edit/split outcome rejected during programmatic unmount',
        { prevId },
        err,
      )
      return false as const
    })
    .then((ok) => {
      if (ok !== false) {
        deletePrevDraft()
        return
      }
      // #2409 — failed save: the appended op rolled back, so `changed` (the
      // full live markdown captured at unmount) is the ONLY surviving copy.
      // Unlike the blur path, the previous block's own `useDraftAutosave` does
      // NOT run a final content save here — it sees `isFocused → false`
      // (blockId → null), so Effect B's cleanup skips (`blockIdRef === null`).
      // Its debounced `block_drafts` row can therefore be up to
      // DRAFT_DEBOUNCE_MS stale, or absent entirely when a continuous typing
      // run never hit a debounce tick. Merely keeping that row would still lose
      // the most recent keystrokes (or everything, in the no-row case). Re-seed
      // the row with `changed` — mirroring the blur path's `failedContent`
      // re-save (`useDraftAutosave` discardDraftFor) — so boot-time
      // `flush_all_drafts` recovers the full typed text. Best-effort with the
      // standard pool_busy retry.
      void retryOnPoolBusy(() => saveDraft(prevId, changed)).catch((err: unknown) => {
        logger.warn(
          'EditableBlock',
          'draft re-save after failed programmatic save failed',
          { prevId },
          err,
        )
      })
    })
  return changed
}

/**
 * Shared attachment-processing loop used by both handleDrop and handlePaste.
 * Validates MIME + size, reads the file to bytes, calls
 * `addAttachmentWithBytes` (backend is the sole writer), and
 * shows success/error toasts.
 *
 * Inline-image wiring (#1434): when a pasted/dropped file is an IMAGE and the
 * block's editor is currently mounted (`rovingEditor`), the new attachment is
 * also inserted as an INLINE image node — `![filename](attachment:<id>)` —
 * referencing the attachment by id. The bytes never live in the markdown; only
 * the ref does, and `GatedImage` resolves it back to the bytes at render time.
 * Non-image files (and images dropped while no editor is mounted) keep the
 * existing block-attachment behaviour.
 */
/** Files smaller than this show no progress toast — the IPC round-trip is fast enough. */
const ATTACH_PROGRESS_THRESHOLD_BYTES = 1_048_576 // 1 MB

/** Whether a file's resolved MIME type is an image (drives inline insertion). */
function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/')
}

async function processFileAttachments(
  files: File[],
  blockId: string,
  t: TFunction,
  rovingEditor: RovingEditorHandle,
): Promise<void> {
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
      const row = await addAttachmentWithBytes({
        blockId,
        filename: info.filename,
        mimeType: info.mimeType,
        bytes,
      })
      if (progressToastId !== undefined) notify.dismiss(progressToastId)
      // #1434 — an image becomes an INLINE image node referencing the attachment
      // by id, but only while THIS block's editor is the mounted one (so the
      // node lands in the doc the user is editing, not a stale/other block). A
      // non-image, or an image dropped onto an unmounted block, stays a plain
      // block attachment.
      const editor = rovingEditor.editor
      if (isImageMime(info.mimeType) && editor !== null && rovingEditor.activeBlockId === blockId) {
        editor
          .chain()
          .focus()
          .insertImage({ src: attachmentRef(row.id), alt: info.filename })
          .run()
      }
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
  // `rootParentId` is immutable for the lifetime of a per-page store (#753),
  // so reading it once alongside the stable store actions is safe.
  const { edit, splitBlock, rootParentId } = usePageBlockStoreApi().getState()
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
    // #1489 — coalesce the markdown-change → React re-render onto the next
    // animation frame instead of calling `setLiveContent` synchronously inside
    // ProseMirror's transaction dispatch.
    //
    // The serializing callback fires from the editor's `update` event, which is
    // emitted SYNCHRONOUSLY from `EditorView.dispatch`. Calling `setLiveContent`
    // there re-renders this component (and the sibling toolbars that read the
    // editor) inside the same dispatch flush; that React commit writes back to
    // the editor's contenteditable DOM, which ProseMirror's `DOMObserver`
    // re-reads as a change and turns into ANOTHER `dispatch` → `update` →
    // `setLiveContent` … an infinite "Maximum update depth exceeded" loop. A
    // long single-line URL (or a `[text](url)` link) reliably triggers it; short
    // content settles before tipping the limit. A microtask is NOT enough — the
    // `DOMObserver` flushes on the same microtask queue — so we defer to the
    // next animation frame, which lets the current dispatch + DOM read fully
    // settle before the re-render. Coalescing keeps only the most recent
    // markdown; autosave still receives it (one frame later) so behavior is
    // unchanged for the user. When `requestAnimationFrame` is unavailable
    // (jsdom without the polyfill — there is no DOMObserver loop there) we apply
    // synchronously so unit tests observe the value immediately.
    let rafId: number | null = null
    let pending: string | null = null
    const hasRaf = typeof requestAnimationFrame === 'function'
    const flush = () => {
      rafId = null
      const next = pending
      pending = null
      // Re-check identity at flush time: a block switch may have landed between
      // the editor `update` and this frame.
      if (next !== null && rovingEditorRef.current.activeBlockId === blockId) {
        setLiveContent(next)
      }
    }
    // Register whenever focused — do NOT gate on `activeBlockId === blockId`
    // here. On a block→block focus switch React runs this effect before the
    // auto-mount effect (:179), so `activeBlockId` still points at the OLD
    // block and the newly-focused block would never register its callback
    // (silent draft-autosave loss, #1015). Block identity is enforced inside
    // the callback instead, so late/cross-block fires are ignored.
    rovingEditorRef.current.setOnMarkdownChange((md) => {
      if (rovingEditorRef.current.activeBlockId !== blockId) return
      if (!hasRaf) {
        setLiveContent(md)
        return
      }
      pending = md
      if (rafId === null) rafId = requestAnimationFrame(flush)
    })
    return () => {
      rovingEditorRef.current.setOnMarkdownChange(null)
      pending = null
      if (rafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId)
      }
      rafId = null
    }
  }, [isFocused, blockId])

  const { discardDraft } = useDraftAutosave(isFocused ? blockId : null, liveContent)

  // #2600 — commit content to the op log on a short idle debounce (in addition
  // to blur) so concurrent same-block edits interleave through the LoroText
  // char-CRDT instead of collapsing to "later blur wins". Selection-safe: the
  // editor is uncontrolled after mount, so the store update this dispatches
  // never re-feeds the live editor or perturbs the caret.
  useDebouncedContentCommit({ isFocused, blockId, liveContent, rovingEditorRef, edit })

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
        persistUnmount(re, re.activeBlockId, editRef.current, splitBlockRef.current, rootParentId)
      }
      re.mount(blockId, contentRef.current)
    }
  }, [isFocused, blockId, rootParentId])

  const handleFocus = useCallback(
    (id: string) => {
      // Unmount from previous block if any
      if (rovingEditorRef.current.activeBlockId && rovingEditorRef.current.activeBlockId !== id) {
        persistUnmount(
          rovingEditorRef.current,
          rovingEditorRef.current.activeBlockId,
          editRef.current,
          splitBlockRef.current,
          rootParentId,
        )
      }
      // Mount into the new block
      logger.debug('editor', 'focus', { blockId: id })
      setFocused(id)
      rovingEditorRef.current.mount(id, content)
    },
    [content, setFocused, rootParentId],
  )

  const { handleBlur } = useEditorBlur({
    rovingEditor,
    blockId,
    edit,
    splitBlock,
    setFocused,
    discardDraft,
    rootParentId,
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
      await processFileAttachments(files, blockId, t, rovingEditorRef.current)
    },
    [blockId, t],
  )

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData.files)
      if (files.length === 0) return // No files — let TipTap handle text paste
      e.preventDefault()
      await processFileAttachments(files, blockId, t, rovingEditorRef.current)
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
    <section
      ref={wrapperRef}
      id={`editor-${blockId}`}
      className={cn(
        'block-editor rounded-md ring-1 ring-border bg-accent/[0.06] shadow-(--shadow-resting)',
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
