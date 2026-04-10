/**
 * PageHeader — editable page title + tag badge row.
 *
 * Rendered at the top of PageEditor. Contains the contentEditable title
 * and a tag badge row with an inline tag picker popover.
 */

import { ArrowLeft } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { logger } from '@/lib/logger'
import { useBlockTags } from '../hooks/useBlockTags'
import {
  deleteBlock,
  deleteProperty,
  editBlock,
  exportPageMarkdown,
  getBlock,
  getPageAliases,
  getProperties,
  setPageAliases,
  setProperty,
} from '../lib/tauri'
import { useNavigationStore } from '../stores/navigation'
import { usePageBlockStoreApi } from '../stores/page-blocks'
import { useResolveStore } from '../stores/resolve'
import { useUndoStore } from '../stores/undo'
import { PageAliasSection } from './PageAliasSection'
import { PageHeaderMenu } from './PageHeaderMenu'
import { PageOutline } from './PageOutline'
import { PagePropertyTable } from './PagePropertyTable'
import { PageTagSection } from './PageTagSection'
import { PageTitleEditor } from './PageTitleEditor'

export interface PageHeaderProps {
  pageId: string
  title: string
  onBack?: (() => void) | undefined
}

export function PageHeader({ pageId, title, onBack }: PageHeaderProps) {
  const { t } = useTranslation()
  const pageStore = usePageBlockStoreApi()

  // --- Breadcrumb navigation for namespaced pages ---
  const navigateToNamespace = useCallback(() => {
    useNavigationStore.getState().setView('pages')
  }, [])

  // --- Title editing ---
  const titleRef = useRef<HTMLDivElement>(null)
  const [editableTitle, setEditableTitle] = useState(title)
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
            toast(t(successKey), { duration: 1500 })
            await pageStore.getState().load()
            try {
              const pageBlock = await getBlock(pageId)
              if (pageBlock?.content) {
                useNavigationStore.getState().replacePage(pageId, pageBlock.content)
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
          toast.error(t(errorKey))
        })
    },
    [pageId, t, pageStore.getState],
  )

  const handlePageUndo = createUndoRedoHandler('undo')
  const handlePageRedo = createUndoRedoHandler('redo')

  // --- Template state ---
  const [isTemplate, setIsTemplate] = useState(false)
  const [isJournalTemplate, setIsJournalTemplate] = useState(false)
  const [kebabOpen, setKebabOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [forcePropertyExpanded, setForcePropertyExpanded] = useState(false)

  useEffect(() => {
    if (!pageId) return
    getProperties(pageId)
      .then((props) => {
        setIsTemplate(props.some((p) => p.key === 'template' && p.value_text === 'true'))
        setIsJournalTemplate(
          props.some((p) => p.key === 'journal-template' && p.value_text === 'true'),
        )
      })
      .catch((err: unknown) => {
        logger.warn(
          'PageHeader',
          'Failed to load template properties',
          {
            pageId,
          },
          err,
        )
      })
  }, [pageId])

  const createTemplateToggle =
    (
      key: string,
      currentState: boolean,
      setState: (v: boolean) => void,
      removedKey: string,
      savedKey: string,
      failedKey: string,
    ) =>
    async () => {
      try {
        if (currentState) {
          await deleteProperty(pageId, key)
          setState(false)
          toast.success(t(removedKey))
        } else {
          await setProperty({ blockId: pageId, key, valueText: 'true' })
          setState(true)
          toast.success(t(savedKey))
        }
      } catch (err) {
        logger.error(
          'PageHeader',
          'Failed to toggle template property',
          {
            pageId,
            key,
          },
          err,
        )
        toast.error(t(failedKey))
      }
      setKebabOpen(false)
    }

  const handleToggleTemplate = createTemplateToggle(
    'template',
    isTemplate,
    setIsTemplate,
    'pageHeader.templateRemoved',
    'pageHeader.templateSaved',
    'pageHeader.templateFailed',
  )
  const handleToggleJournalTemplate = createTemplateToggle(
    'journal-template',
    isJournalTemplate,
    setIsJournalTemplate,
    'pageHeader.journalTemplateRemoved',
    'pageHeader.journalTemplateSaved',
    'pageHeader.journalTemplateFailed',
  )

  const handleExport = useCallback(async () => {
    try {
      const markdown = await exportPageMarkdown(pageId)
      await navigator.clipboard.writeText(markdown)
      toast.success(t('pageHeader.exportCopied'))
    } catch (err) {
      logger.error('PageHeader', 'Failed to export page markdown', { pageId }, err)
      toast.error(t('pageHeader.exportFailed'))
    }
    setKebabOpen(false)
  }, [pageId, t])

  const handleDeletePage = useCallback(async () => {
    try {
      await deleteBlock(pageId)
      toast.success(t('pageHeader.pageDeleted'))
      onBack?.()
    } catch (err) {
      logger.error('PageHeader', 'Failed to delete page', { pageId }, err)
      toast.error(t('pageHeader.deleteFailed'))
    }
    setDeleteDialogOpen(false)
    setKebabOpen(false)
  }, [pageId, onBack, t])

  const handleKebabAddAlias = useCallback(() => {
    setEditingAliases(true)
    setKebabOpen(false)
  }, [])

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
    useNavigationStore.getState().openInNewTab(pageId, editableTitle || title)
    setKebabOpen(false)
  }, [pageId, editableTitle, title])

  // --- Alias state ---
  const [aliases, setAliases] = useState<string[]>([])
  const [editingAliases, setEditingAliases] = useState(false)
  const [aliasInput, setAliasInput] = useState('')

  // Fetch aliases on mount / page change
  useEffect(() => {
    if (!pageId) return
    getPageAliases(pageId)
      .then((result) => setAliases(Array.isArray(result) ? result : []))
      .catch((err: unknown) => {
        logger.error('PageHeader', 'Failed to load page aliases', { pageId }, err)
        toast.error(t('pageHeader.loadAliasesFailed'))
      })
  }, [pageId, t])

  // Sync editableTitle when prop changes (e.g., navigating to a different page)
  useEffect(() => {
    setEditableTitle(title)
    if (titleRef.current && titleRef.current.textContent !== title) {
      titleRef.current.textContent = title
    }
  }, [title])

  const handleTitleInput = useCallback((e: React.FormEvent<HTMLDivElement>) => {
    setEditableTitle(e.currentTarget.textContent ?? '')
  }, [])

  const handleTitleBlur = useCallback(async () => {
    const newTitle = editableTitle.trim()
    if (!newTitle) {
      setEditableTitle(title)
      if (titleRef.current) titleRef.current.textContent = title
      return
    }
    if (newTitle !== title) {
      try {
        await editBlock(pageId, newTitle)
        useUndoStore.getState().onNewAction(pageId)
        useNavigationStore.getState().replacePage(pageId, newTitle)
        useResolveStore.getState().set(pageId, newTitle, false)
      } catch (err) {
        logger.error('PageHeader', 'Failed to rename page', { pageId }, err)
        toast.error(t('pageHeader.renameFailed'))
        setEditableTitle(title)
        if (titleRef.current) titleRef.current.textContent = title
      }
    }
  }, [editableTitle, title, pageId, t])

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
    .filter((t_) => !tagQuery || t_.name.toLowerCase().includes(tagQuery.toLowerCase()))

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

  const handleAddAlias = useCallback(() => {
    if (aliasInput.trim()) {
      const next = [...aliases, aliasInput.trim()]
      setAliases(next)
      setPageAliases(pageId, next).catch((err: unknown) => {
        logger.error('PageHeader', 'Failed to update page aliases', { pageId }, err)
        toast.error(t('pageHeader.aliasUpdateFailed'))
      })
      setAliasInput('')
    }
  }, [aliasInput, aliases, pageId, t])

  const handleRemoveAlias = useCallback(
    (alias: string) => {
      const next = aliases.filter((a) => a !== alias)
      setAliases(next)
      setPageAliases(pageId, next).catch((err: unknown) => {
        logger.error('PageHeader', 'Failed to update page aliases', { pageId }, err)
        toast.error(t('pageHeader.aliasUpdateFailed'))
      })
    },
    [aliases, pageId, t],
  )

  return (
    <div className="page-header sticky top-0 z-10 bg-background -mx-4 px-4 md:-mx-6 md:px-6 pb-4 border-b border-border/40 space-y-2">
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
          onDeleteRequest={() => {
            setKebabOpen(false)
            setDeleteDialogOpen(true)
          }}
          onOpenInNewTab={handleOpenInNewTab}
        />
      </div>

      {/* Breadcrumb for namespaced page titles */}
      {title.includes('/') &&
        (() => {
          const segments = title.split('/')
          return (
            <nav
              className="flex items-center gap-1 text-xs text-muted-foreground px-1 mt-1"
              aria-label={t('pageHeader.breadcrumbLabel')}
            >
              {segments.slice(0, -1).map((segment, i) => {
                const ancestorPath = segments.slice(0, i + 1).join('/')
                return (
                  <span key={ancestorPath} className="flex items-center gap-1">
                    {i > 0 && <span className="text-muted-foreground/50">/</span>}
                    <button
                      type="button"
                      className="hover:text-foreground hover:underline transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded touch-target"
                      onClick={() => navigateToNamespace()}
                    >
                      {segment}
                    </button>
                  </span>
                )
              })}
              <span className="text-muted-foreground/50">/</span>
              <span className="font-medium text-foreground">{segments[segments.length - 1]}</span>
            </nav>
          )
        })()}

      {/* Aliases */}
      <PageAliasSection
        aliases={aliases}
        editingAliases={editingAliases}
        aliasInput={aliasInput}
        onAliasInputChange={setAliasInput}
        onAddAlias={handleAddAlias}
        onRemoveAlias={handleRemoveAlias}
        onStartEditing={() => setEditingAliases(true)}
        onStopEditing={() => setEditingAliases(false)}
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

      <PagePropertyTable pageId={pageId} forceExpanded={forcePropertyExpanded} />

      {/* Delete page confirmation dialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t('pageHeader.deletePageTitle')}
        description={t('pageHeader.deletePageDescription')}
        cancelLabel={t('pageHeader.cancel')}
        actionLabel={t('pageHeader.deletePage')}
        onAction={handleDeletePage}
      />
    </div>
  )
}
