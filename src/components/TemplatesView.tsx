/**
 * TemplatesView — browse and manage template pages.
 *
 * Lists pages with property `template` = 'true', shows a preview of the
 * first child block, and allows navigating to or removing template status.
 */

import { LayoutTemplate, Plus, Search, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { reportIpcError } from '@/lib/report-ipc-error'
import { createPageInSpace, deleteProperty, queryByProperty, setProperty } from '../lib/tauri'
import { loadTemplatePagesWithPreview } from '../lib/template-utils'
import { useNavigationStore } from '../stores/navigation'
import { useSpaceStore } from '../stores/space'
import { EmptyState } from './EmptyState'
import { ListViewState } from './ListViewState'

interface TemplateItem {
  id: string
  content: string
  preview: string | null
  isJournalTemplate: boolean
}

export function TemplatesView(): React.ReactElement {
  const { t } = useTranslation()
  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [pendingRemoval, setPendingRemoval] = useState<{ id: string; name: string } | null>(null)
  const [newTemplateName, setNewTemplateName] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const loadTemplates = useCallback(async () => {
    setLoading(true)
    try {
      const pages = await loadTemplatePagesWithPreview()
      const journalResp = await queryByProperty({
        key: 'journal-template',
        valueText: 'true',
        limit: 10,
      })
      const journalIds = new Set(journalResp.items.map((b) => b.id))
      setTemplates(
        pages.map((p) => ({
          id: p.id,
          content: p.content,
          preview: p.preview,
          isJournalTemplate: journalIds.has(p.id),
        })),
      )
    } catch (err) {
      reportIpcError('TemplatesView', 'slash.templateLoadFailed', err, t)
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    loadTemplates()
  }, [loadTemplates])

  const handleCreateTemplate = useCallback(async () => {
    const name = newTemplateName.trim()
    if (!name) return
    setIsCreating(true)
    try {
      // BUG-1 / H-3b — route page creation through `createPageInSpace`
      // so templates land with their `space` ref property set
      // atomically. The legacy `createBlock({ blockType: 'page' })`
      // call leaked unscoped templates that disappeared from the
      // PageBrowser list (and the Templates list once filtered by
      // space).
      const currentSpaceId = useSpaceStore.getState().currentSpaceId
      if (currentSpaceId == null) {
        toast.error(t('templates.createFailed'))
        setIsCreating(false)
        return
      }
      const newId = await createPageInSpace({ content: name, spaceId: currentSpaceId })
      await setProperty({ blockId: newId, key: 'template', valueText: 'true' })
      setTemplates((prev) => [
        { id: newId, content: name, preview: null, isJournalTemplate: false },
        ...prev,
      ])
      setNewTemplateName('')
    } catch (err) {
      reportIpcError('TemplatesView', 'templates.createFailed', err, t, { name })
    }
    setIsCreating(false)
  }, [newTemplateName, t])

  const handleRemoveTemplate = useCallback(
    async (id: string, name: string) => {
      try {
        await deleteProperty(id, 'template')
        setTemplates((prev) => prev.filter((tpl) => tpl.id !== id))
        toast.success(t('templates.templateRemoved', { name }))
      } catch (err) {
        reportIpcError('TemplatesView', 'templates.removeTemplateFailed', err, t, { id, name })
      }
    },
    [t],
  )

  const handleNavigate = useCallback((id: string, content: string) => {
    useNavigationStore.getState().navigateToPage(id, content)
  }, [])

  // UX-248 — Unicode-aware fold.
  const filtered = templates.filter((tpl) => matchesSearchFolded(tpl.content, search))

  return (
    <section className="space-y-4" aria-label={t('sidebar.templates')}>
      {/* Create template form — always visible, including empty state */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          handleCreateTemplate()
        }}
        className="flex flex-col sm:flex-row sm:items-center gap-2"
      >
        <Label htmlFor="new-template-name" className="sr-only">
          {t('templates.newTemplateInputLabel')}
        </Label>
        <Input
          id="new-template-name"
          value={newTemplateName}
          onChange={(e) => setNewTemplateName(e.target.value)}
          placeholder={t('templates.newTemplatePlaceholder')}
          className="flex-1"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={isCreating || !newTemplateName.trim()}
          aria-label={t('templates.create')}
        >
          {isCreating ? <Spinner /> : <Plus className="h-4 w-4" />}
          {t('templates.create')}
        </Button>
      </form>

      <ListViewState
        loading={loading}
        items={templates}
        skeleton={<LoadingSkeleton count={3} height="h-14" data-testid="templates-loading" />}
        empty={<EmptyState icon={LayoutTemplate} message={t('templates.empty')} />}
      >
        {() => (
          <>
            {/* Search input — only show when there are templates */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('templates.search')}
                aria-label={t('templates.search')}
                className="pl-9"
              />
            </div>

            {/* Template list */}
            {filtered.length > 0 && (
              <ul className="space-y-1">
                {filtered.map((tpl) => (
                  <li
                    key={tpl.id}
                    className="group flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent/50 active:bg-accent/70 cursor-pointer"
                  >
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 flex-col text-left"
                            aria-label={t('templates.navigateLabel', { name: tpl.content })}
                            onClick={() => handleNavigate(tpl.id, tpl.content)}
                          >
                            <span className="text-sm font-medium truncate">{tpl.content}</span>
                            {tpl.preview && (
                              <span className="text-xs text-muted-foreground truncate">
                                {tpl.preview}
                              </span>
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{t('templates.navigateLabel', { name: tpl.content })}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    {tpl.isJournalTemplate && (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="secondary" className="shrink-0 text-xs">
                              {t('templates.journalIndicator')}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent>{t('templates.journalTooltip')}</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t('templates.removeTemplateLabel', { name: tpl.content })}
                      className={[
                        'shrink-0 opacity-0 group-hover:opacity-100 transition-opacity',
                        'text-muted-foreground hover:text-destructive focus-visible:opacity-100',
                        '[@media(pointer:coarse)]:opacity-100',
                        'touch-target [@media(pointer:coarse)]:min-w-[44px]',
                      ].join(' ')}
                      onClick={() => setPendingRemoval({ id: tpl.id, name: tpl.content ?? '' })}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {/* No search results */}
            {filtered.length === 0 && search.length > 0 && (
              <EmptyState
                icon={Search}
                message={t('templates.noSearchResultsWithTotal', {
                  total: templates.length,
                })}
                compact
              />
            )}
          </>
        )}
      </ListViewState>
      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null)
        }}
        title={t('templates.removeConfirmTitle')}
        description={t('templates.removeConfirmDesc', { name: pendingRemoval?.name ?? '' })}
        onAction={() => {
          if (pendingRemoval) {
            handleRemoveTemplate(pendingRemoval.id, pendingRemoval.name)
            setPendingRemoval(null)
          }
        }}
      />
    </section>
  )
}
