/**
 * PageHeader — editable page title + tag badge row.
 *
 * Rendered at the top of PageEditor. Contains the contentEditable title
 * and a tag badge row with an inline tag picker popover.
 */

import { ArrowLeft, Smile } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmojiPickerDialog } from '@/components/EmojiPicker'
import { PageQuickActions } from '@/components/PageQuickActions'
import { Breadcrumb, type BreadcrumbCrumb } from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { announce } from '@/lib/announcer'
import { writeText } from '@/lib/clipboard'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { spliceEmojiIntoText } from '@/lib/insert-emoji-at-caret'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

import { useBlockTags } from '../hooks/useBlockTags'
import { useEmojiRecents } from '../hooks/useEmojiRecents'
import { usePageAliases } from '../hooks/usePageAliases'
import { usePageDeleteAction } from '../hooks/usePageDeleteAction'
import { usePageTemplateMeta } from '../hooks/usePageTemplateMeta'
import { matchesShortcutBinding } from '../lib/keyboard-config'
import { editBlock, exportPageMarkdown, getBlock, setProperty } from '../lib/tauri'
import { useNavigationStore } from '../stores/navigation'
import { usePageBlockStoreApi } from '../stores/page-blocks'
import { useResolveStore } from '../stores/resolve'
import { useSpaceStore } from '../stores/space'
import { useTabsStore } from '../stores/tabs'
import { useUndoStore } from '../stores/undo'
import { FeatureErrorBoundary } from './FeatureErrorBoundary'
import { PageAliasSection } from './PageAliasSection'
import { PageHeaderMenu } from './PageHeaderMenu'
import { PageOutline } from './PageOutline'
import { PagePropertyTable } from './PagePropertyTable'
import { PageTagSection } from './PageTagSection'
import { PageTitleEditor } from './PageTitleEditor'
import { ViewHeader } from './ViewHeader'

export interface PageHeaderProps {
  pageId: string
  title: string
  onBack?: (() => void) | undefined
}

export function PageHeader({ pageId, title, onBack }: PageHeaderProps) {
  const { t } = useTranslation()
  const pageStore = usePageBlockStoreApi()

  // --- Page-delete flow (PEND-68 Part A) ---
  // `usePageDeleteAction` owns the confirm dialog + success-toast-with-
  // Undo wiring. The header has TWO delete entry points — the dedicated
  // trash button in the quick-actions cluster AND the kebab "Delete
  // page" item — and both route through `requestDelete()`. Because the
  // hook renders a single `ConfirmDialog` instance, there is no double-
  // confirm risk from the two trigger paths.
  const { requestDelete, deletingId, confirmDialog: deleteConfirmDialog } = usePageDeleteAction()
  const isDeletingThis = deletingId === pageId

  // --- Breadcrumb navigation for namespaced pages ---
  const navigateToNamespace = useCallback(() => {
    useNavigationStore.getState().setView('pages')
  }, [])

  const breadcrumbItems = useMemo<BreadcrumbCrumb[]>(() => {
    if (!title.includes('/')) return []
    const segments = title.split('/')
    return segments.map((segment, i) => {
      const isLast = i === segments.length - 1
      return {
        id: `${i}-${segment}`,
        label: segment,
        ...(isLast ? {} : { onSelect: () => navigateToNamespace() }),
      }
    })
  }, [title, navigateToNamespace])

  // --- Title editing ---
  const titleRef = useRef<HTMLDivElement>(null)
  const [editableTitle, setEditableTitle] = useState(title)
  // Caret offset (JS string index) within the title's plain text, captured
  // while the title is focused so the emoji picker can splice at the caret
  // even after focus moves to the dialog. Falls back to end-of-text.
  const titleCaretRef = useRef<number | null>(null)
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false)
  const { push: pushEmojiRecent } = useEmojiRecents()
  const [tagQuery, setTagQuery] = useState('')
  const [showTagPicker, setShowTagPicker] = useState(false)
  const [forceTagSection, setForceTagSection] = useState(false)
  const tagPickerForcedRef = useRef(false)

  // Two-phase approach: mount tag section first, then open picker on next render
  useEffect(() => {
    if (forceTagSection) {
      setShowTagPicker(true)
      setForceTagSection(false)
    }
  }, [forceTagSection])

  const handleTagPickerChange = useCallback((open: boolean) => {
    // Suppress the immediate close that Radix triggers on freshly mounted Popovers
    if (!open && tagPickerForcedRef.current) {
      tagPickerForcedRef.current = false
      return
    }
    setShowTagPicker(open)
  }, [])

  // --- Page-level undo/redo ---
  const canRedo = useUndoStore((state) => {
    const pageState = state.pages.get(pageId)
    return pageState != null && pageState.redoStack.length > 0
  })

  const createUndoRedoHandler = useCallback(
    (action: 'undo' | 'redo') => () => {
      const successKey = action === 'undo' ? 'pageHeader.undone' : 'pageHeader.redone'
      const errorKey = action === 'undo' ? 'pageHeader.undoFailed' : 'pageHeader.redoFailed'
      useUndoStore
        .getState()
        [action](pageId)
        .then(async (result) => {
          if (result) {
            notify(t(successKey), { duration: 1500 })
            await pageStore.getState().load()
            try {
              const pageBlock = await getBlock(pageId)
              if (pageBlock?.content) {
                useTabsStore.getState().replacePage(pageId, pageBlock.content)
                useResolveStore.getState().set(pageId, pageBlock.content, false)
              }
            } catch (err) {
              logger.warn(
                'PageHeader',
                'Failed to refresh page title after undo/redo',
                {
                  pageId,
                },
                err,
              )
            }
          }
        })
        .catch((err: unknown) => {
          logger.error('PageHeader', 'Undo/redo operation failed', { pageId }, err)
          notify.error(t(errorKey))
        })
    },
    [pageId, t, pageStore],
  )

  const handlePageUndo = createUndoRedoHandler('undo')
  const handlePageRedo = createUndoRedoHandler('redo')

  // --- Kebab + property-expand state ---
  // Delete-dialog state lives in `usePageDeleteAction` (see top of the
  // component); the kebab and the dedicated trash button both call its
  // `requestDelete()` so only ONE `ConfirmDialog` ever mounts.
  const [kebabOpen, setKebabOpen] = useState(false)
  const [forcePropertyExpanded, setForcePropertyExpanded] = useState(false)

  // --- Template + space metadata (extracted to `usePageTemplateMeta`) ---
  // The hook loads the four property-derived bits the kebab menu needs
  // and owns the template-toggle handlers; `closeKebab` is the
  // post-action hook used to dismiss the menu after a toggle resolves.
  const closeKebab = useCallback(() => setKebabOpen(false), [])
  const {
    isTemplate,
    isJournalTemplate,
    isSpaceBlock,
    pageSpaceId,
    setPageSpaceId,
    handleToggleTemplate,
    handleToggleJournalTemplate,
  } = usePageTemplateMeta(pageId, t, closeKebab)

  // --- Alias state (extracted to `usePageAliases`) ---
  const {
    aliases,
    editingAliases,
    aliasInput,
    setAliasInput,
    startEditing: startEditingAliases,
    stopEditing: stopEditingAliases,
    handleAddAlias,
    handleRemoveAlias,
  } = usePageAliases(pageId, t)

  const handleExport = useCallback(async () => {
    try {
      const markdown = await exportPageMarkdown(pageId)
      await writeText(markdown)
      notify.success(t('pageHeader.exportCopied'))
      announce(t('announce.exported'))
    } catch (err) {
      logger.error('PageHeader', 'Failed to export page markdown', { pageId }, err)
      notify.error(t('pageHeader.exportFailed'))
      announce(t('announce.exportFailed'))
    }
    setKebabOpen(false)
  }, [pageId, t])

  // --- Keyboard shortcut for export (Ctrl+Shift+E) ---
  useEffect(() => {
    function handleExportShortcut(e: KeyboardEvent) {
      if (matchesShortcutBinding(e, 'exportPageMarkdown')) {
        e.preventDefault()
        exportPageMarkdown(pageId)
          .then(async (markdown) => {
            await writeText(markdown)
            notify.success(t('pageHeader.exportCopied'))
            announce(t('announce.exported'))
          })
          .catch((err: unknown) => {
            logger.error(
              'PageHeader',
              'Failed to export page markdown via shortcut',
              { pageId },
              err,
            )
            notify.error(t('pageHeader.exportFailed'))
            announce(t('announce.exportFailed'))
          })
      }
    }
    document.addEventListener('keydown', handleExportShortcut)
    return () => document.removeEventListener('keydown', handleExportShortcut)
  }, [pageId, t])

  // Both delete entry points (dedicated trash button + kebab "Delete
  // page" item) call this. `usePageDeleteAction` opens its single
  // ConfirmDialog and, on confirm, runs the IPC + emits the success
  // toast with an Undo action. We pass `onDeleted` so the header can
  // still navigate back + announce to AT — preserving the previous
  // behaviour of `handleDeletePage`. The hook's own success toast
  // covers the sighted-user feedback (was `notify.success(...)` here).
  const handleRequestDelete = useCallback(() => {
    setKebabOpen(false)
    requestDelete(pageId, title, {
      onDeleted: () => {
        announce(t('announce.pageDeleted'))
        onBack?.()
      },
      onFailed: () => {
        announce(t('announce.pageDeleteFailed'))
      },
    })
  }, [onBack, pageId, requestDelete, t, title])

  const handleKebabAddAlias = useCallback(() => {
    startEditingAliases()
    setKebabOpen(false)
  }, [startEditingAliases])

  const handleKebabAddTag = useCallback(() => {
    tagPickerForcedRef.current = true
    setForceTagSection(true)
    setKebabOpen(false)
  }, [])

  const handleKebabAddProperty = useCallback(() => {
    setForcePropertyExpanded(true)
    setKebabOpen(false)
  }, [])

  const handleOpenInNewTab = useCallback(() => {
    useTabsStore.getState().openInNewTab(pageId, editableTitle || title)
    setKebabOpen(false)
  }, [pageId, editableTitle, title])

  // --- FEAT-3 Phase 2 — Move to space ---
  // Subscribe to `availableSpaces` so the sub-menu updates live when a
  // peer creates/renames a space over sync. The list passed into the
  // menu is already sorted (the space store guarantees alphabetical
  // order from the backend `list_spaces_inner` query) so we just strip
  // the current owner and hand the result to `PageHeaderMenu`.
  const availableSpaces = useSpaceStore((s) => s.availableSpaces)
  const moveTargets = availableSpaces.filter((s) => s.id !== pageSpaceId)

  const handleMoveToSpace = useCallback(
    async (targetSpaceId: string) => {
      setKebabOpen(false)
      const target = availableSpaces.find((s) => s.id === targetSpaceId)
      const targetName = target?.name ?? ''
      try {
        await setProperty({ blockId: pageId, key: 'space', valueRef: targetSpaceId })
        setPageSpaceId(targetSpaceId)
        notify.success(t('space.movedToast', { space: targetName }))
        announce(t('announce.pageMoved'))
        // Refresh the page block store so any space-scoped subviews
        // (outline, property table) pick up the new ownership.
        await pageStore.getState().load()
      } catch (err) {
        logger.error('PageHeader', 'Failed to move page to space', { pageId, targetSpaceId }, err)
        notify.error(t('space.moveFailed'))
        announce(t('announce.pageMoveFailed'))
      }
    },
    [availableSpaces, pageId, pageStore, setPageSpaceId, t],
  )

  // Sync editableTitle when prop changes (e.g., navigating to a different page)
  useEffect(() => {
    setEditableTitle(title)
    if (titleRef.current && titleRef.current.textContent !== title) {
      titleRef.current.textContent = title
    }
  }, [title])

  // Read the caret offset within the title contentEditable as a plain-text
  // index. In edit mode the title is a single text node, so the collapsed
  // selection's `startOffset` is the JS string index; returns null when the
  // selection is outside the title or unavailable.
  const readTitleCaret = useCallback((): number | null => {
    const el = titleRef.current
    if (!el) return null
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    if (!el.contains(range.startContainer)) return null
    return range.startOffset
  }, [])

  // Only overwrite the stored caret when a live offset is readable — on blur
  // the selection is gone (`readTitleCaret` → null) and we must keep the last
  // in-edit caret so a subsequent emoji insert lands where the user left off.
  const captureTitleCaret = useCallback(() => {
    const caret = readTitleCaret()
    if (caret !== null) titleCaretRef.current = caret
  }, [readTitleCaret])

  const handleTitleInput = useCallback(
    (e: React.FormEvent<HTMLDivElement>) => {
      setEditableTitle(e.currentTarget.textContent ?? '')
      captureTitleCaret()
    },
    [captureTitleCaret],
  )

  const handleTitleKeyUp = useCallback(() => {
    captureTitleCaret()
  }, [captureTitleCaret])

  // Persist a new title through the same IPC + store-sync path the blur
  // handler uses. Reverts on empty/failure. Shared by blur and emoji insert.
  const persistTitle = useCallback(
    async (next: string): Promise<void> => {
      const newTitle = next.trim()
      if (!newTitle) {
        setEditableTitle(title)
        if (titleRef.current) titleRef.current.textContent = title
        return
      }
      if (newTitle === title) return
      try {
        await editBlock(pageId, newTitle)
        useUndoStore.getState().onNewAction(pageId)
        useTabsStore.getState().replacePage(pageId, newTitle)
        useResolveStore.getState().set(pageId, newTitle, false)
        announce(t('announce.pageRenamed'))
        notify.success(t('pageHeader.pageRenamed'))
      } catch (err) {
        logger.error('PageHeader', 'Failed to rename page', { pageId }, err)
        notify.error(t('pageHeader.renameFailed'))
        announce(t('announce.pageRenameFailed'))
        setEditableTitle(title)
        if (titleRef.current) titleRef.current.textContent = title
      }
    },
    [title, pageId, t],
  )

  const handleTitleBlur = useCallback(async () => {
    captureTitleCaret()
    await persistTitle(editableTitle)
  }, [editableTitle, persistTitle, captureTitleCaret])

  // Insert a picked emoji into the title at the last-known caret (or append)
  // and persist immediately — the title contentEditable has already blurred
  // (the picker button stole focus), so there is no blur to save on.
  const handleTitleEmojiSelect = useCallback(
    (char: string) => {
      pushEmojiRecent(char)
      const caret = titleCaretRef.current
      const { value, caret: nextCaret } = spliceEmojiIntoText(
        editableTitle,
        char,
        caret ?? editableTitle.length,
        caret ?? editableTitle.length,
      )
      setEditableTitle(value)
      titleCaretRef.current = nextCaret
      if (titleRef.current) titleRef.current.textContent = value
      void persistTitle(value)
    },
    [editableTitle, persistTitle, pushEmojiRecent],
  )

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      ;(e.target as HTMLElement).blur()
    }
  }, [])

  // --- Tag badges ---
  const { allTags, appliedTagIds, handleAddTag, handleRemoveTag, handleCreateTag } =
    useBlockTags(pageId)

  const appliedTags = allTags.filter((t_) => appliedTagIds.has(t_.id))
  const availableTags = allTags
    .filter((t_) => !appliedTagIds.has(t_.id))
    // UX-248 — Unicode-aware fold.
    .filter((t_) => matchesSearchFolded(t_.name, tagQuery))

  const handleTagAdd = useCallback(
    async (tagId: string) => {
      await handleAddTag(tagId)
      setTagQuery('')
      setShowTagPicker(false)
    },
    [handleAddTag],
  )

  const handleTagCreate = useCallback(async () => {
    const name = tagQuery.trim()
    if (!name) return
    await handleCreateTag(name)
    setTagQuery('')
    setShowTagPicker(false)
  }, [tagQuery, handleCreateTag])

  return (
    <>
      <ViewHeader>
        <div className="page-header space-y-2">
          {/* Title row */}
          <div className="flex items-center gap-2">
            {onBack && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onBack}
                aria-label={t('pageHeader.goBack')}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <PageTitleEditor
              title={title}
              editableTitle={editableTitle}
              titleRef={titleRef}
              onInput={handleTitleInput}
              onBlur={handleTitleBlur}
              onKeyDown={handleTitleKeyDown}
              onKeyUp={handleTitleKeyUp}
            />
            {/* #286 — insert a native emoji into the page title at the caret.
                Opens the shared <EmojiPickerDialog>; the title contentEditable
                blurs (saving any pending edit) before the picker opens, so the
                handler splices at the last-known caret and persists itself. */}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setEmojiPickerOpen(true)}
              aria-label={t('pageHeader.insertEmoji')}
            >
              <Smile className="h-4 w-4" />
            </Button>
            {/* PEND-68 Part A — unified star + dedicated delete affordance.
                The kebab below KEEPS its "Delete page" item as a secondary
                path; both routes call `requestDelete()` on the shared
                `usePageDeleteAction` so only one ConfirmDialog mounts. */}
            <PageQuickActions
              pageId={pageId}
              title={title}
              variant="header"
              deleting={isDeletingThis}
              onDeleteRequest={handleRequestDelete}
            />
            <PageOutline />
            <PageHeaderMenu
              canRedo={canRedo}
              kebabOpen={kebabOpen}
              isTemplate={isTemplate}
              isJournalTemplate={isJournalTemplate}
              onUndo={handlePageUndo}
              onRedo={handlePageRedo}
              onKebabOpenChange={setKebabOpen}
              onAddAlias={handleKebabAddAlias}
              onAddTag={handleKebabAddTag}
              onAddProperty={handleKebabAddProperty}
              onToggleTemplate={handleToggleTemplate}
              onToggleJournalTemplate={handleToggleJournalTemplate}
              onExport={handleExport}
              onDeleteRequest={handleRequestDelete}
              onOpenInNewTab={handleOpenInNewTab}
              isSpaceBlock={isSpaceBlock}
              moveTargets={moveTargets}
              onMoveToSpace={handleMoveToSpace}
            />
          </div>

          {/* Breadcrumb for namespaced page titles (UX-257). Consumes the
              shared `Breadcrumb` primitive — chevron separators, no
              `touch-target` per-crumb (the primitive handles 44 px hit-area
              on touch via `[@media(pointer:coarse)]:py-2`). */}
          {breadcrumbItems.length > 0 && (
            <Breadcrumb
              items={breadcrumbItems}
              ariaLabel={t('pageHeader.breadcrumbLabel')}
              className="mt-1"
            />
          )}

          {/* Aliases */}
          <PageAliasSection
            aliases={aliases}
            editingAliases={editingAliases}
            aliasInput={aliasInput}
            onAliasInputChange={setAliasInput}
            onAddAlias={handleAddAlias}
            onRemoveAlias={handleRemoveAlias}
            onStartEditing={startEditingAliases}
            onStopEditing={stopEditingAliases}
          />

          {/* Tag badges row */}
          {(appliedTags.length > 0 || showTagPicker || forceTagSection) && (
            <PageTagSection
              appliedTags={appliedTags}
              availableTags={availableTags}
              allTags={allTags}
              tagQuery={tagQuery}
              showTagPicker={showTagPicker}
              onTagQueryChange={setTagQuery}
              onTagPickerChange={handleTagPickerChange}
              onAddTag={handleTagAdd}
              onRemoveTag={handleRemoveTag}
              onCreateTag={handleTagCreate}
            />
          )}

          {/* Wrapped in FeatureErrorBoundary so a custom property editor
              throwing on a malformed value doesn't blank the page header
              (UX Tier 3). */}
          <FeatureErrorBoundary name="PagePropertyTable">
            <PagePropertyTable pageId={pageId} forceExpanded={forcePropertyExpanded} />
          </FeatureErrorBoundary>
        </div>
      </ViewHeader>

      {/* Single delete-confirm dialog (PEND-68 Part A) — both the dedicated
          trash button in the quick-actions cluster and the kebab "Delete
          page" item route through `usePageDeleteAction.requestDelete`, so
          only this dialog mounts. */}
      {deleteConfirmDialog}

      {/* #286 — page-title emoji picker. Inserts the chosen emoji at the
          title caret and persists. Shared dialog primitive (#319). */}
      <EmojiPickerDialog
        open={emojiPickerOpen}
        onOpenChange={setEmojiPickerOpen}
        onSelect={handleTitleEmojiSelect}
      />
    </>
  )
}
