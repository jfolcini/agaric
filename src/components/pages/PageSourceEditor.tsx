/**
 * PageSourceEditor — the page edited as one markdown buffer (#5140, #5160).
 *
 * Replaces the block tree while open. The text is `PageSourceBuffer`, loaded
 * lazily, whose lines carry their block ids beside the text. Save writes the
 * text and those ids through `apply_page_source` as one undo entry; a page
 * changed elsewhere since the buffer was loaded opens
 * `PageSourceConflictDialog`, whose Merge saves the buffer with those changes
 * folded in. A saved buffer leaves a report (`notifyPageSourceSaved`). Cancel
 * and Escape ask first when the buffer is not the page as loaded. Unsaved text
 * survives leaving the page as a localStorage draft, cleared by Save or Cancel.
 */

import { Copy } from 'lucide-react'
import type React from 'react'
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import type { PageSourceBufferHandle } from '@/components/pages/PageSourceBuffer'
import { PageSourceConflictDialog } from '@/components/pages/PageSourceConflictDialog'
import { latestUndoEntry, notifyPageSourceSaved } from '@/components/pages/PageSourceSaveReport'
import { Button } from '@/components/ui/button'
import { SHARED_INPUT_CLASSES } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import type { SourceLines } from '@/editor/source-buffer'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { unwrap, validationCode } from '@/lib/app-error'
import { commands, type PageBuffer } from '@/lib/bindings'
import { writeText } from '@/lib/clipboard'
import { formatErrorForDisplay } from '@/lib/error-display'
import { matchesShortcutBinding } from '@/lib/keyboard-config'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { PREFERENCES, readPreference, removePreference, writePreference } from '@/lib/preferences'
import { ValidationCode } from '@/lib/search-query/validation-codes'
import { cn } from '@/lib/utils'
import { usePageBlockStore } from '@/stores/page-blocks'

const LazyPageSourceBuffer = lazy(() =>
  import('@/components/pages/PageSourceBuffer').then((m) => ({ default: m.PageSourceBuffer })),
)

// Styled here, not in the lazy buffer, so its chunk shares no design-system
// module with startup that would split one off the startup chunks.
const BUFFER_CLASS = cn(
  'w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono shadow-xs transition-[color,box-shadow] outline-hidden selection:bg-primary selection:text-primary-foreground dark:bg-input/30',
  SHARED_INPUT_CLASSES,
  // `.ProseMirror` sets a one-line min-height outside any layer.
  'min-h-[50vh]!',
)

function sameLines(a: SourceLines, b: SourceLines): boolean {
  return (
    a.text === b.text &&
    a.lineIds.length === b.lineIds.length &&
    a.lineIds.every((id, i) => id === b.lineIds[i])
  )
}

function linesOf(buffer: PageBuffer): SourceLines {
  return { text: buffer.text, lineIds: buffer.line_ids }
}

/** What the buffer opened with. */
interface Opened {
  /** The source the buffer's edit started from, which a save sends as its base. */
  base: string
  /** The page as loaded, which a buffer back at it does not need saved. */
  page: SourceLines
  /** The lines the buffer opened with: the page's, or a restored draft's. */
  initial: SourceLines
  draftRestored: boolean
  /** A new buffer each time the page is reloaded into it. */
  generation: number
}

/** The buffer as last typed, and what decides whether it is a draft. */
interface Typed {
  base: string
  page: SourceLines
  lines: SourceLines
}

/** A buffer back at the page leaves no draft. */
function storeDraft(pageId: string, { base, page, lines }: Typed): void {
  if (sameLines(lines, page)) removePreference(PREFERENCES.pageSourceDraft, pageId)
  else writePreference(PREFERENCES.pageSourceDraft, { base, ...lines }, pageId)
}

/** The line, counted from 0, a refused save names (`line N: …`, #5160 X3), or null. */
export function refusedLine(message: string): number | null {
  const match = /^line (\d+): /.exec(message)
  return match === null ? null : Number(match[1]) - 1
}

export interface PageSourceEditorProps {
  pageId: string
  onClose: () => void
}

export function PageSourceEditor({ pageId, onClose }: PageSourceEditorProps): React.ReactElement {
  const { t } = useTranslation()
  const applyPageSource = usePageBlockStore((s) => s.applyPageSource)
  const hintId = useId()
  const draftNoteId = useId()
  const legacyNoteId = useId()
  const [opened, setOpened] = useState<Opened | null>(null)
  // A draft an earlier version stored, its ids as `^ID` anchors in its text (#5160 D-f).
  const [legacyDraft, setLegacyDraft] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  // The page now, after a save found it changed since `opened.base`.
  const [conflict, setConflict] = useState<PageBuffer | null>(null)
  const bufferRef = useRef<PageSourceBufferHandle | null>(null)
  // Stored again on unmount: the debounce timer dies with the component, and
  // the draft is the only copy of those keystrokes.
  const typed = useRef<Typed | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        // No `flushActiveDraft()` (#2969): entering source mode cleared focus, so
        // no block is left to flush. The kebab's blur committed it, and a commit
        // landing after this read makes the save stale: the conflict dialog.
        const buffer = unwrap(await commands.getPageBuffer(pageId))
        if (cancelled) return
        // A draft keeps its own base, so a save of it still catches whatever
        // changed on the page since the draft was written.
        const draft = readPreference(PREFERENCES.pageSourceDraft, pageId)
        const page = linesOf(buffer)
        if (draft?.lineIds == null) {
          setOpened({
            base: buffer.source,
            page,
            initial: page,
            draftRestored: false,
            generation: 0,
          })
          setLegacyDraft(draft?.text ?? null)
        } else {
          const initial = { text: draft.text, lineIds: draft.lineIds }
          setOpened({ base: draft.base, page, initial, draftRestored: true, generation: 0 })
        }
      } catch (err) {
        logger.error('PageSourceEditor', 'Failed to load page source', { pageId }, err)
        if (!cancelled) setLoadFailed(true)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [pageId])

  const draftSaver = useDebouncedCallback(() => {
    if (typed.current !== null) storeDraft(pageId, typed.current)
  }, 300)
  useEffect(
    () => () => {
      if (typed.current !== null) storeDraft(pageId, typed.current)
    },
    [pageId],
  )

  const discardDraft = (): void => {
    draftSaver.cancel()
    typed.current = null
    removePreference(PREFERENCES.pageSourceDraft, pageId)
  }

  const currentLines = (open: Opened): SourceLines => typed.current?.lines ?? open.initial

  const showConflict = async (): Promise<void> => {
    try {
      setConflict(unwrap(await commands.getPageBuffer(pageId)))
    } catch (err) {
      logger.warn('PageSourceEditor', 'Failed to reload page source', { pageId }, err)
      setSaveError(t('pageSource.loadFailed'))
    }
  }

  const submit = async (against: string, force: boolean, merge: boolean): Promise<void> => {
    if (savingRef.current || opened === null) return
    savingRef.current = true
    setSaving(true)
    setSaveError(null)
    try {
      const before = latestUndoEntry(pageId)
      const { text, lineIds } = currentLines(opened)
      const report = await applyPageSource(text, against, force, merge, lineIds)
      discardDraft()
      notifyPageSourceSaved(pageId, report, before)
      onClose()
    } catch (err) {
      if (validationCode(err) === ValidationCode.RequiresRefresh) {
        await showConflict()
      } else {
        logger.warn('PageSourceEditor', 'Failed to save page source', { pageId }, err)
        const message = formatErrorForDisplay(err, { fallback: t('pageSource.saveFailed') })
        setSaveError(message)
        const line = refusedLine(message)
        if (line !== null) bufferRef.current?.selectLine(line)
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const handleSave = (): void => {
    if (opened === null) return
    const lines = currentLines(opened)
    if (sameLines(lines, opened.page)) {
      discardDraft()
      onClose()
    } else if (lines.text.trim() === '' && opened.base.trim() !== '') {
      setConfirmingDeleteAll(true)
    } else {
      void submit(opened.base, false, false)
    }
  }

  const discardAndClose = (): void => {
    discardDraft()
    onClose()
  }

  const handleCancel = (): void => {
    if (opened !== null && !sameLines(currentLines(opened), opened.page)) setConfirmingDiscard(true)
    else discardAndClose()
  }

  // The dialog closes first: while its focus trap is up, it would pull back the
  // focus the page hands out when the buffer closes.
  const confirmDiscard = (): void => {
    flushSync(() => setConfirmingDiscard(false))
    discardAndClose()
  }

  const handleChange = (lines: SourceLines): void => {
    if (opened === null) return
    typed.current = { base: opened.base, page: opened.page, lines }
    draftSaver.schedule(lines.text)
  }

  const handleKeyDown = (e: KeyboardEvent): boolean => {
    // An input method's Escape cancels the composition, not the buffer.
    if (e.isComposing) return false
    if (
      matchesShortcutBinding(e, 'savePageSource') ||
      (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
    ) {
      handleSave()
      return true
    }
    if (e.key === 'Escape') {
      // The buffer owns this Escape: no document-level listener may also act on it.
      e.stopPropagation()
      handleCancel()
      return true
    }
    return false
  }

  const handleReload = (): void => {
    if (conflict === null || opened === null) return
    discardDraft()
    const page = linesOf(conflict)
    setOpened({
      base: conflict.source,
      page,
      initial: page,
      draftRestored: false,
      generation: opened.generation + 1,
    })
    setConflict(null)
    setSaveError(null)
  }

  const handleOverwrite = (): void => {
    if (conflict === null) return
    setConflict(null)
    void submit(conflict.source, true, false)
  }

  // Against the buffer's own base, so the backend sees what changed on each side.
  const handleMerge = (): void => {
    if (conflict === null || opened === null) return
    setConflict(null)
    void submit(opened.base, false, true)
  }

  const copyLegacyDraft = async (): Promise<void> => {
    if (legacyDraft === null) return
    try {
      await writeText(legacyDraft)
      notify.success(t('pageSource.legacyDraftCopied'))
    } catch (err) {
      logger.warn('PageSourceEditor', 'Failed to copy the earlier draft', { pageId }, err)
      notify.error(t('pageSource.copyFailed'))
    }
  }

  if (loadFailed) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="text-sm text-destructive">
          {t('pageSource.loadFailed')}
        </p>
        <Button variant="outline" onClick={onClose}>
          {t('ui.close')}
        </Button>
      </div>
    )
  }

  const loading = (
    <output aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner />
      <span>{t('ui.loading')}</span>
    </output>
  )

  if (opened === null) return loading

  return (
    <div className="flex flex-col gap-2">
      {legacyDraft !== null && (
        <div className="flex flex-col gap-2">
          <p id={legacyNoteId} className="text-sm text-muted-foreground">
            {t('pageSource.legacyDraft')}
          </p>
          <Textarea
            readOnly
            value={legacyDraft}
            aria-labelledby={legacyNoteId}
            spellCheck={false}
            className="max-h-48 font-mono"
          />
          <Button variant="outline" className="self-start" onClick={() => void copyLegacyDraft()}>
            <Copy aria-hidden="true" />
            {t('pageSource.copyLegacyDraft')}
          </Button>
        </div>
      )}
      {opened.draftRestored && (
        <p id={draftNoteId} className="text-sm text-muted-foreground">
          {t('pageSource.draftRestored')}
        </p>
      )}
      <Suspense fallback={loading}>
        <LazyPageSourceBuffer
          key={opened.generation}
          ref={bufferRef}
          initial={opened.initial}
          readOnly={saving}
          label={t('pageSource.editorLabel')}
          describedBy={opened.draftRestored ? `${draftNoteId} ${hintId}` : hintId}
          className={BUFFER_CLASS}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
      </Suspense>
      <p id={hintId} className="text-xs text-muted-foreground">
        {t('pageSource.hint')}
      </p>
      {saveError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={handleCancel} disabled={saving}>
          {t('action.cancel')}
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Spinner />}
          {t('action.save')}
        </Button>
      </div>
      <ConfirmDialog
        open={confirmingDeleteAll}
        onOpenChange={setConfirmingDeleteAll}
        titleKey="pageSource.deleteAllTitle"
        descriptionKey="pageSource.deleteAllBody"
        confirmKey="pageSource.deleteAll"
        variant="destructive"
        onConfirm={() => {
          void submit(opened.base, false, false)
        }}
      />
      <ConfirmDialog
        open={confirmingDiscard}
        onOpenChange={setConfirmingDiscard}
        titleKey="pageSource.discardTitle"
        descriptionKey="pageSource.discardBody"
        confirmKey="pageSource.discard"
        cancelKey="pageSource.keepEditing"
        variant="destructive"
        onConfirm={confirmDiscard}
      />
      <PageSourceConflictDialog
        base={opened.base}
        current={conflict?.source ?? null}
        onMerge={handleMerge}
        onReload={handleReload}
        onOverwrite={handleOverwrite}
        onKeepEditing={() => setConflict(null)}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          bufferRef.current?.focus()
        }}
      />
    </div>
  )
}
