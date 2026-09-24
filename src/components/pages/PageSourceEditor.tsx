/**
 * PageSourceEditor — the page edited as one markdown buffer (#5140).
 *
 * Replaces the block tree while open. Save writes the buffer through
 * `apply_page_source` as one undo entry; a page changed elsewhere since the
 * buffer was loaded opens `PageSourceConflictDialog`, whose Merge saves the
 * buffer with those changes folded in. Unsaved text survives leaving the page
 * as a localStorage draft, cleared by Save or Cancel.
 */

import type React from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { PageSourceConflictDialog } from '@/components/pages/PageSourceConflictDialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { unwrap, validationCode } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { formatErrorForDisplay } from '@/lib/error-display'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { PREFERENCES, readPreference, removePreference, writePreference } from '@/lib/preferences'
import { ValidationCode } from '@/lib/search-query/validation-codes'
import { usePageBlockStore } from '@/stores/page-blocks'

/** A buffer back at its base leaves no draft. */
function storeDraft(pageId: string, draft: { base: string; text: string }): void {
  if (draft.text === draft.base) removePreference(PREFERENCES.pageSourceDraft, pageId)
  else writePreference(PREFERENCES.pageSourceDraft, draft, pageId)
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
  // `base` is the source the buffer was loaded from, null until it is.
  const [base, setBase] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [loadFailed, setLoadFailed] = useState(false)
  const [draftRestored, setDraftRestored] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false)
  // The page's source now, after a save found it changed since `base`.
  const [conflict, setConflict] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const attachTextarea = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node
    node?.focus()
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        // No `flushActiveDraft()` (#2969): entering source mode cleared focus, so
        // no block is left to flush. The kebab's blur committed it, and a commit
        // landing after this read makes the save stale: the conflict dialog.
        const source = unwrap(await commands.getPageSource(pageId))
        if (cancelled) return
        // A draft keeps its own base, so a save of it still catches whatever
        // changed on the page since the draft was written.
        const draft = readPreference(PREFERENCES.pageSourceDraft, pageId)
        setBase(draft?.base ?? source)
        setText(draft?.text ?? source)
        setDraftRestored(draft !== null)
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

  const draftSaver = useDebouncedCallback((next: string) => {
    if (base !== null) storeDraft(pageId, { base, text: next })
  }, 300)
  // The buffer as last typed, stored again on unmount: the debounce timer dies
  // with the component, and the draft is the only copy of those keystrokes.
  const typedDraft = useRef<{ base: string; text: string } | null>(null)
  useEffect(
    () => () => {
      if (typedDraft.current !== null) storeDraft(pageId, typedDraft.current)
    },
    [pageId],
  )

  const discardDraft = (): void => {
    draftSaver.cancel()
    typedDraft.current = null
    removePreference(PREFERENCES.pageSourceDraft, pageId)
  }

  const showConflict = async (): Promise<void> => {
    try {
      setConflict(unwrap(await commands.getPageSource(pageId)))
    } catch (err) {
      logger.warn('PageSourceEditor', 'Failed to reload page source', { pageId }, err)
      setSaveError(t('pageSource.loadFailed'))
    }
  }

  const submit = async (against: string, force: boolean, merge: boolean): Promise<void> => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setSaveError(null)
    try {
      const report = await applyPageSource(text, against, force, merge)
      discardDraft()
      if (report.warnings.length > 0) {
        notify.warning(t('pageSource.warnings', { warnings: report.warnings.join('; ') }))
      }
      onClose()
    } catch (err) {
      if (validationCode(err) === ValidationCode.RequiresRefresh) {
        await showConflict()
      } else {
        logger.warn('PageSourceEditor', 'Failed to save page source', { pageId }, err)
        setSaveError(formatErrorForDisplay(err, { fallback: t('pageSource.saveFailed') }))
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const handleSave = (): void => {
    if (base === null) return
    if (text === base) {
      discardDraft()
      onClose()
    } else if (text.trim() === '' && base.trim() !== '') {
      setConfirmingDeleteAll(true)
    } else {
      void submit(base, false, false)
    }
  }

  const handleCancel = (): void => {
    discardDraft()
    onClose()
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setText(e.target.value)
    if (base !== null) typedDraft.current = { base, text: e.target.value }
    draftSaver.schedule(e.target.value)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSave()
    }
  }

  const handleReload = (): void => {
    if (conflict === null) return
    discardDraft()
    setBase(conflict)
    setText(conflict)
    setConflict(null)
    setDraftRestored(false)
    setSaveError(null)
  }

  const handleOverwrite = (): void => {
    if (conflict === null) return
    setConflict(null)
    void submit(conflict, true, false)
  }

  // Against the buffer's own base, so the backend sees what changed on each side.
  const handleMerge = (): void => {
    if (conflict === null || base === null) return
    setConflict(null)
    void submit(base, false, true)
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

  if (base === null) {
    return (
      <output aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        <span>{t('ui.loading')}</span>
      </output>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {draftRestored && (
        <p id={draftNoteId} className="text-sm text-muted-foreground">
          {t('pageSource.draftRestored')}
        </p>
      )}
      <Textarea
        ref={attachTextarea}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        readOnly={saving}
        spellCheck={false}
        aria-label={t('pageSource.editorLabel')}
        aria-describedby={`${draftNoteId} ${hintId}`}
        data-testid="page-source-editor"
        className="min-h-[50vh] [@media(pointer:coarse)]:min-h-[50vh] font-mono"
      />
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
          void submit(base, false, false)
        }}
      />
      <PageSourceConflictDialog
        base={base}
        current={conflict}
        onMerge={handleMerge}
        onReload={handleReload}
        onOverwrite={handleOverwrite}
        onKeepEditing={() => setConflict(null)}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          textareaRef.current?.focus()
        }}
      />
    </div>
  )
}
