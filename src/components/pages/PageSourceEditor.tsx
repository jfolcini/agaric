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
 * Page, beside them, goes to page mode instead of closing (#5691): at once for a
 * buffer as loaded, after the save for a changed one, which a refusal, a
 * conflict or an unconfirmed emptying keeps here as Save's would.
 *
 * Edit, Preview and Changes switch what is shown in the buffer's place: the
 * buffer as the page will show it (`PageSourcePreview`, loaded lazily like
 * the buffer), and the line diff against the page as loaded
 * (`PageSourceChanges`), whose hunks Save counts. The diff reads the text as
 * it was when typing paused, or when Changes opened, so a page edited at length
 * is not diffed on every keystroke.
 */

import { Copy } from 'lucide-react'
import type React from 'react'
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import type { PageSourceBufferHandle } from '@/components/pages/PageSourceBuffer'
import { PageSourceChanges } from '@/components/pages/PageSourceChanges'
import { PageSourceConflictDialog } from '@/components/pages/PageSourceConflictDialog'
import { notifyPageSourceSaved } from '@/components/pages/PageSourceSaveReport'
import { findUnresolvedUlidTokens } from '@/components/pages/ulid-tokens'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { SourceLines } from '@/editor/source-buffer'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { useIsTouch } from '@/hooks/useIsTouch'
import { unwrap, validationCode } from '@/lib/app-error'
import { commands, type PageBuffer } from '@/lib/bindings'
import { writeText } from '@/lib/clipboard'
import { formatErrorForDisplay } from '@/lib/error-display'
import { getShortcutKeys, matchesShortcutBinding } from '@/lib/keyboard-config'
import { diffLines } from '@/lib/line-diff'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { PREFERENCES, readPreference, removePreference, writePreference } from '@/lib/preferences'
import { ValidationCode } from '@/lib/search-query/validation-codes'
import { usePageBlockStore } from '@/stores/page-blocks'
import { latestUndoEntry } from '@/stores/undo'

const LazyPageSourceBuffer = lazy(() =>
  import('@/components/pages/PageSourceBuffer').then((m) => ({ default: m.PageSourceBuffer })),
)
const LazyPageSourcePreview = lazy(() =>
  import('@/components/pages/PageSourcePreview').then((m) => ({ default: m.PageSourcePreview })),
)

const MODES = ['edit', 'preview', 'changes'] as const
type Mode = (typeof MODES)[number]
const MODE_LABELS = {
  edit: 'pageSource.modeEdit',
  preview: 'pageSource.preview',
  changes: 'pageSource.changes',
} as const

// Styled here, not in the lazy buffer, so its chunk shares no design-system
// module with startup that would split one off the startup chunks.
// The frame holds the toolbar and the text, as block mode's `.block-editor`
// box does, so the ring of focus anywhere in it goes round both.
const BUFFER_FRAME_CLASS =
  'rounded-md border border-input shadow-xs transition-[color,box-shadow] dark:bg-input/30 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring'
// `.ProseMirror` sets a one-line min-height outside any layer.
const BUFFER_CLASS = 'w-full px-3 py-2 font-mono outline-hidden min-h-[50vh]!'

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
  /**
   * The buffer the edit started from: a save sends its `source` as the base,
   * and the conflict dialog lists what changed on the page since its lines.
   */
  base: PageBuffer
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
  base: PageBuffer
  page: SourceLines
  lines: SourceLines
}

/** A buffer back at the page leaves no draft. */
function storeDraft(pageId: string, { base, page, lines }: Typed): void {
  if (sameLines(lines, page)) removePreference(PREFERENCES.pageSourceDraft, pageId)
  else writePreference(PREFERENCES.pageSourceDraft, { dialect: 'document', base, ...lines }, pageId)
}

/** The line, counted from 0, a refused save names (`line N: …`, #5160 X3), or null. */
export function refusedLine(message: string): number | null {
  const match = /^line (\d+): /.exec(message)
  return match === null ? null : Number(match[1]) - 1
}

/**
 * The link to page mode, its tooltip naming it and its shortcut as the header's switch does; where
 * page mode cannot show the page, `aria-disabled` with the reason, which pressing it leaves as is.
 */
function PageModeLink({
  blocked,
  disabled,
  onClick,
}: {
  blocked: string | null | undefined
  disabled: boolean
  onClick: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const blockedId = useId()
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="link"
            className="mr-auto px-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            aria-disabled={blocked ? true : undefined}
            aria-describedby={blocked ? blockedId : undefined}
            onClick={onClick}
            disabled={disabled}
          >
            {t('pageMode.page')}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {blocked || `${t('pageMode.pageHint')} (${getShortcutKeys('togglePageMode')})`}
        </TooltipContent>
      </Tooltip>
      {blocked && (
        <span id={blockedId} className="sr-only">
          {blocked}
        </span>
      )}
    </>
  )
}

export interface PageSourceEditorProps {
  pageId: string
  onClose: () => void
  /** Page mode in place of the buffer, from its link. */
  onSwitchToPage: () => void
  /** Why page mode cannot show the page, the link disabled saying so. */
  pageModeBlocked?: string | null | undefined
}

export function PageSourceEditor({
  pageId,
  onClose,
  onSwitchToPage,
  pageModeBlocked,
}: PageSourceEditorProps): React.ReactElement {
  const { t } = useTranslation()
  const isTouch = useIsTouch()
  const applyPageSource = usePageBlockStore((s) => s.applyPageSource)
  const hintId = useId()
  const draftNoteId = useId()
  const legacyNoteId = useId()
  const editTabId = useId()
  const editPanelId = useId()
  const [opened, setOpened] = useState<Opened | null>(null)
  const [mode, setMode] = useState<Mode>('edit')
  // The buffer as last typed, for what shows beside it; null until it changes.
  const [typedLines, setTypedLines] = useState<SourceLines | null>(null)
  // The text the diff is of once typing pauses; before that, the text the buffer opened with.
  const [diffedText, setDiffedText] = useState<string | null>(null)
  // A draft an earlier version stored, which this one cannot open (#5160 D-f, #5691).
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
  // Where a save that lands leaves: closed, or page mode. Each save sets it, so a
  // refused or cancelled one leaves nothing for the next.
  const exitTo = useRef<'close' | 'page'>('close')
  const exit = (): void => {
    if (exitTo.current === 'page') onSwitchToPage()
    else onClose()
  }

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        // No `flushActiveDraft()` (#2969): entering source mode cleared focus, so
        // no block is left to flush. The kebab's blur committed it, and a commit
        // landing after this read makes the save stale: the conflict dialog.
        const buffer = unwrap(await commands.getPageBuffer(pageId, 'document'))
        if (cancelled) return
        // A draft keeps its own base, so a save of it still catches whatever
        // changed on the page since the draft was written.
        const draft = readPreference(PREFERENCES.pageSourceDraft, pageId)
        const page = linesOf(buffer)
        if (draft?.lineIds == null) {
          setOpened({
            base: buffer,
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
    if (typed.current === null) return
    storeDraft(pageId, typed.current)
    setDiffedText(typed.current.lines.text)
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

  const shown = typedLines ?? opened?.initial ?? null
  const pageText = opened?.page.text ?? ''
  const diffText = diffedText ?? opened?.initial.text ?? ''
  const diff = useMemo(() => diffLines(pageText, diffText), [pageText, diffText])
  const unchanged = opened === null || shown === null || sameLines(shown, opened.page)
  const saveLabel =
    unchanged || diff.hunks.length === 0
      ? t('action.save')
      : t('pageSource.saveChanges', { count: diff.hunks.length })

  const showConflict = async (): Promise<void> => {
    try {
      setConflict(unwrap(await commands.getPageBuffer(pageId, 'document')))
    } catch (err) {
      logger.warn('PageSourceEditor', 'Failed to reload page source', { pageId }, err)
      setSaveError(t('pageSource.loadFailed'))
    }
  }

  const submit = async (against: string, merge: boolean): Promise<void> => {
    if (savingRef.current || opened === null) return
    savingRef.current = true
    setSaving(true)
    setSaveError(null)
    try {
      const before = latestUndoEntry(pageId)
      const { text, lineIds } = currentLines(opened)
      const report = await applyPageSource(text, against, merge, lineIds)
      discardDraft()
      notifyPageSourceSaved(pageId, report, before)
      exit()
    } catch (err) {
      if (validationCode(err) === ValidationCode.RequiresRefresh) {
        await showConflict()
      } else {
        logger.warn('PageSourceEditor', 'Failed to save page source', { pageId }, err)
        const message = formatErrorForDisplay(err, { fallback: t('pageSource.saveFailed') })
        setSaveError(message)
        const line = refusedLine(message)
        if (line !== null) {
          // From Preview or Changes, the buffer the line is in is hidden.
          flushSync(() => setMode('edit'))
          bufferRef.current?.selectLine(line)
        }
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const save = (then: 'close' | 'page'): void => {
    if (opened === null) return
    exitTo.current = then
    const lines = currentLines(opened)
    if (sameLines(lines, opened.page)) {
      discardDraft()
      exit()
    } else if (lines.text.trim() === '' && opened.base.text.trim() !== '') {
      setConfirmingDeleteAll(true)
    } else {
      void warnUnresolvedTokens(lines.text)
      void submit(opened.base.source, false)
    }
  }

  const handleSave = (): void => save('close')

  const handleSwitchToPage = (): void => {
    if (!pageModeBlocked) save('page')
  }

  // A warning, not a refusal: the save goes ahead (#5686).
  const warnUnresolvedTokens = async (text: string): Promise<void> => {
    const unresolved = await findUnresolvedUlidTokens(text)
    if (unresolved.length === 0) return
    const tokens = [...new Set(unresolved.map((token) => text.slice(token.from, token.to)))]
    notify.warning(
      t('pageSource.unresolvedTokens', { count: tokens.length, tokens: tokens.join(', ') }),
    )
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
    setTypedLines(lines)
    draftSaver.schedule()
  }

  const handleKeyDown = (e: KeyboardEvent): boolean => {
    // An input method's Escape cancels the composition, not the buffer.
    if (e.isComposing) return false
    if (matchesShortcutBinding(e, 'savePageSource')) {
      handleSave()
      return true
    }
    if (matchesShortcutBinding(e, 'togglePageMode')) {
      // The header's switch, back as page mode opens, would toggle it off again on the same key.
      e.stopPropagation()
      handleSwitchToPage()
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
      base: conflict,
      page,
      initial: page,
      draftRestored: false,
      generation: opened.generation + 1,
    })
    setTypedLines(null)
    setDiffedText(null)
    setConflict(null)
    setSaveError(null)
  }

  const handleOverwrite = (): void => {
    if (conflict === null) return
    setConflict(null)
    void submit(conflict.source, false)
  }

  // Against the buffer's own base, so the backend sees what changed on each side.
  const handleMerge = (): void => {
    if (conflict === null || opened === null) return
    setConflict(null)
    void submit(opened.base.source, true)
  }

  const switchMode = (value: string): void => {
    const next = MODES.find((m) => m === value)
    if (next === undefined) return
    // The diff may be a pause behind the buffer.
    if (next === 'changes' && typed.current !== null) setDiffedText(typed.current.lines.text)
    setMode(next)
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
      <Tabs value={mode} onValueChange={switchMode}>
        <TabsList aria-label={t('pageSource.view')} className="mb-2">
          {MODES.map((m) => (
            <TabsTrigger
              key={m}
              value={m}
              {...(m === 'edit' && {
                id: editTabId,
                'aria-controls': editPanelId,
                // On click, not on select: Radix selects on mousedown, and the
                // mousedown's own focus would take the caret back.
                onClick: () => bufferRef.current?.focus(),
              })}
            >
              {t(MODE_LABELS[m])}
            </TabsTrigger>
          ))}
        </TabsList>
        {/* Not a TabsContent: that unmounts while hidden, and the buffer holds the edit. */}
        <div
          role="tabpanel"
          id={editPanelId}
          aria-labelledby={editTabId}
          hidden={mode !== 'edit'}
          className="flex flex-col gap-2"
        >
          <Suspense fallback={loading}>
            <div className={BUFFER_FRAME_CLASS}>
              <LazyPageSourceBuffer
                key={opened.generation}
                ref={bufferRef}
                pageId={pageId}
                initial={opened.initial}
                pageIds={opened.page.lineIds}
                readOnly={saving}
                hidden={mode !== 'edit'}
                saveLabel={saveLabel}
                nothingToSave={unchanged}
                label={t('pageSource.editorLabel')}
                describedBy={opened.draftRestored ? `${draftNoteId} ${hintId}` : hintId}
                className={BUFFER_CLASS}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onSave={handleSave}
                onCancel={handleCancel}
              />
            </div>
          </Suspense>
          <p id={hintId} className="text-xs text-muted-foreground">
            {t('pageSource.hint')}
          </p>
        </div>
        <TabsContent value="preview">
          {shown !== null && (
            <Suspense fallback={loading}>
              <LazyPageSourcePreview lines={shown} />
            </Suspense>
          )}
        </TabsContent>
        <TabsContent value="changes">
          <PageSourceChanges diff={diff} />
        </TabsContent>
      </Tabs>
      {saveError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {saveError}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <PageModeLink blocked={pageModeBlocked} disabled={saving} onClick={handleSwitchToPage} />
        {/* On touch, Save and Cancel are on the buffer's toolbar pinned above the keyboard (X9). */}
        {(!isTouch || mode !== 'edit') && (
          <>
            <Button variant="outline" onClick={handleCancel} disabled={saving}>
              {t('action.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={saving || unchanged}>
              {saving && <Spinner />}
              {saveLabel}
            </Button>
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirmingDeleteAll}
        onOpenChange={setConfirmingDeleteAll}
        titleKey="pageSource.deleteAllTitle"
        descriptionKey="pageSource.deleteAllBody"
        confirmKey="pageSource.deleteAll"
        variant="destructive"
        onConfirm={() => {
          void submit(opened.base.source, false)
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
        current={conflict}
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
