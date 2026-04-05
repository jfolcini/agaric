/**
 * PageHeader — editable page title + tag badge row.
 *
 * Rendered at the top of PageEditor. Contains the contentEditable title
 * and a tag badge row with an inline tag picker popover.
 */

import { ArrowLeft, MoreVertical, Plus, Redo2, Undo2, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
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
import { useBlockStore } from '../stores/blocks'
import { useNavigationStore } from '../stores/navigation'
import { useResolveStore } from '../stores/resolve'
import { useUndoStore } from '../stores/undo'
import { PagePropertyTable } from './PagePropertyTable'

export interface PageHeaderProps {
  pageId: string
  title: string
  onBack?: (() => void) | undefined
}

export function PageHeader({ pageId, title, onBack }: PageHeaderProps) {
  const { t } = useTranslation()

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
            await useBlockStore.getState().load(pageId)
            try {
              const pageBlock = await getBlock(pageId)
              if (pageBlock?.content) {
                useNavigationStore.getState().replacePage(pageId, pageBlock.content)
                useResolveStore.getState().set(pageId, pageBlock.content, false)
              }
            } catch {
              // Page title refresh is best-effort
            }
          }
        })
        .catch(() => toast.error(t(errorKey)))
    },
    [pageId, t],
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
      .catch(() => {})
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
      } catch {
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
    } catch {
      toast.error(t('pageHeader.exportFailed'))
    }
    setKebabOpen(false)
  }, [pageId, t])

  const handleDeletePage = useCallback(async () => {
    try {
      await deleteBlock(pageId)
      toast.success(t('pageHeader.pageDeleted'))
      onBack?.()
    } catch {
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

  // --- Alias state ---
  const [aliases, setAliases] = useState<string[]>([])
  const [editingAliases, setEditingAliases] = useState(false)
  const [aliasInput, setAliasInput] = useState('')

  // Fetch aliases on mount / page change
  useEffect(() => {
    if (!pageId) return
    getPageAliases(pageId)
      .then((result) => setAliases(Array.isArray(result) ? result : []))
      .catch(() => toast.error(t('pageHeader.loadAliasesFailed')))
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
      } catch {
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

  return (
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
        {/* biome-ignore lint/a11y/useSemanticElements: contentEditable div is intentional for inline title editing */}
        <div
          ref={titleRef}
          role="textbox"
          tabIndex={0}
          aria-label={t('pageHeader.pageTitle')}
          contentEditable
          suppressContentEditableWarning
          className={[
            'flex-1 text-xl font-semibold outline-none rounded-md px-1',
            'focus:ring-2 focus:ring-ring/50',
            'hover:bg-accent/5 focus-within:bg-accent/5 transition-colors',
          ].join(' ')}
          onInput={handleTitleInput}
          onBlur={handleTitleBlur}
          onKeyDown={handleTitleKeyDown}
        >
          {title}
        </div>
        {/* Page-level undo / redo */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('pageHeader.undoAction')}
            onClick={handlePageUndo}
          >
            <Undo2 size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('pageHeader.redoAction')}
            disabled={!canRedo}
            onClick={handlePageRedo}
          >
            <Redo2 size={14} />
          </Button>
          {/* Kebab overflow menu */}
          <Popover open={kebabOpen} onOpenChange={setKebabOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label={t('pageHeader.pageActions')}>
                <MoreVertical size={14} />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-56 p-1 max-w-[calc(100vw-2rem)]"
              aria-label={t('pageHeader.pageActions')}
            >
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target"
                onClick={handleKebabAddAlias}
              >
                {t('pageHeader.menuAddAlias')}
              </button>
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target"
                onClick={handleKebabAddTag}
              >
                {t('pageHeader.menuAddTag')}
              </button>
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target"
                onClick={handleKebabAddProperty}
              >
                {t('pageHeader.menuAddProperty')}
              </button>
              <hr className="my-1 h-px bg-border border-none" />
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target"
                onClick={handleToggleTemplate}
              >
                {isTemplate ? t('pageHeader.removeTemplate') : t('pageHeader.saveAsTemplate')}
              </button>
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target"
                onClick={handleToggleJournalTemplate}
              >
                {isJournalTemplate
                  ? t('pageHeader.removeJournalTemplate')
                  : t('pageHeader.setJournalTemplate')}
              </button>
              <hr className="my-1 h-px bg-border border-none" />
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent touch-target"
                onClick={handleExport}
              >
                {t('pageHeader.exportMarkdown')}
              </button>
              <hr className="my-1 h-px bg-border border-none" />
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-accent touch-target"
                onClick={() => {
                  setKebabOpen(false)
                  setDeleteDialogOpen(true)
                }}
              >
                {t('pageHeader.deletePage')}
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Breadcrumb for namespaced page titles */}
      {title.includes('/') &&
        (() => {
          const segments = title.split('/')
          return (
            <nav
              className="flex items-center gap-1 text-xs text-muted-foreground px-1 mt-1"
              aria-label="Page breadcrumb"
            >
              {segments.slice(0, -1).map((segment, i) => {
                const ancestorPath = segments.slice(0, i + 1).join('/')
                return (
                  <span key={ancestorPath} className="flex items-center gap-1">
                    {i > 0 && <span className="text-muted-foreground/50">/</span>}
                    <button
                      type="button"
                      className="hover:text-foreground hover:underline transition-colors"
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
      {(aliases.length > 0 || editingAliases) && (
        <div className="flex flex-wrap items-center gap-1.5 px-1">
          {aliases.length > 0 && <span className="font-medium">{t('pageHeader.aliases')}</span>}
          {aliases.map((alias) => (
            <Badge key={alias} variant="secondary" className="gap-1">
              {alias}
              {editingAliases && (
                <button
                  type="button"
                  className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20"
                  onClick={() => {
                    const next = aliases.filter((a) => a !== alias)
                    setAliases(next)
                    setPageAliases(pageId, next).catch(() =>
                      toast.error(t('pageHeader.aliasUpdateFailed')),
                    )
                  }}
                  aria-label={t('pageHeader.removeAlias', { alias })}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </Badge>
          ))}
          {editingAliases ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault()
                if (aliasInput.trim()) {
                  const next = [...aliases, aliasInput.trim()]
                  setAliases(next)
                  setPageAliases(pageId, next).catch(() =>
                    toast.error(t('pageHeader.aliasUpdateFailed')),
                  )
                  setAliasInput('')
                }
              }}
            >
              <Input
                type="text"
                className="w-24 [@media(pointer:coarse)]:w-full h-7 text-xs"
                placeholder={t('pageHeader.newAliasPlaceholder')}
                value={aliasInput}
                onChange={(e) => setAliasInput(e.target.value)}
                aria-label={t('pageHeader.newAliasInput')}
              />
              <Button type="submit" variant="ghost" size="xs">
                {t('pageHeader.add')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setEditingAliases(false)}
              >
                {t('pageHeader.done')}
              </Button>
            </form>
          ) : (
            <Button
              variant="ghost"
              size="xs"
              className="gap-1 text-muted-foreground"
              onClick={() => setEditingAliases(true)}
            >
              {t('pageHeader.edit')}
            </Button>
          )}
        </div>
      )}

      {/* Tag badges row */}
      {(appliedTags.length > 0 || showTagPicker || forceTagSection) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {appliedTags.map((tag) => (
            <Badge key={tag.id} variant="secondary" className="gap-1">
              {tag.name}
              <button
                type="button"
                className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20"
                onClick={() => handleRemoveTag(tag.id)}
                aria-label={t('pageHeader.removeTag', { name: tag.name })}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}

          <Popover open={showTagPicker} onOpenChange={handleTagPickerChange}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                className="gap-1 text-muted-foreground"
                aria-label={t('pageHeader.addTag')}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-64 space-y-2 p-3 max-w-[calc(100vw-2rem)]"
              aria-label={t('pageHeader.tagPicker')}
            >
              <Input
                placeholder={t('pageHeader.searchTags')}
                value={tagQuery}
                onChange={(e) => setTagQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && availableTags.length === 0 && tagQuery.trim()) {
                    e.preventDefault()
                    handleTagCreate()
                  }
                }}
                aria-label={t('pageHeader.searchTagsLabel')}
              />
              <ScrollArea className="max-h-40">
                {availableTags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => handleTagAdd(tag.id)}
                  >
                    {tag.name}
                  </button>
                ))}
                {tagQuery.trim() && !allTags.some((t_) => t_.name === tagQuery.trim()) && (
                  <button
                    type="button"
                    className="w-full rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent"
                    onClick={handleTagCreate}
                  >
                    {t('pageHeader.createTag', { name: tagQuery.trim() })}
                  </button>
                )}
                {availableTags.length === 0 && !tagQuery.trim() && (
                  <p className="px-2 py-1 text-sm text-muted-foreground">
                    {t('pageHeader.noMoreTags')}
                  </p>
                )}
              </ScrollArea>
            </PopoverContent>
          </Popover>
        </div>
      )}

      <PagePropertyTable pageId={pageId} forceExpanded={forcePropertyExpanded} />

      {/* Delete page confirmation dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('pageHeader.deletePageTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('pageHeader.deletePageDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('pageHeader.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeletePage}>
              {t('pageHeader.deletePage')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
