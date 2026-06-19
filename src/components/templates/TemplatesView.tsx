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

import { EmptyState } from '@/components/common/EmptyState'
import { ListViewState } from '@/components/common/ListViewState'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FeaturePageHeader } from '@/components/ui/feature-page-header'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ListItem } from '@/components/ui/list-item'
import { SearchInput } from '@/components/ui/search-input'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { matchesSearchFolded } from '@/lib/fold-for-search'
import { notify } from '@/lib/notify'
import { reportIpcError } from '@/lib/report-ipc-error'
import {
  createPageInSpace,
  deleteProperty,
  paginationLimit,
  queryByProperty,
  setProperty,
} from '@/lib/tauri'
import { loadTemplatePagesWithPreview } from '@/lib/template-utils'
import { cn } from '@/lib/utils'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

interface TemplateItem {
  id: string
  content: string
  preview: string | null
  isJournalTemplate: boolean
}

/**
 * #215 — the dynamic template variables expanded by
 * `expandTemplateVariables` (`template-utils.ts`). Surfaced as a low-chrome
 * hint row beneath the create form so users discover them without reading
 * source comments. `token` is the literal syntax; `descKey` names the i18n
 * description shown in the tooltip. Keep in sync with the `LEGACY_RESOLVERS`
 * token → resolver map in `expandTemplateVariables` (#1450 Phase 1).
 */
const TEMPLATE_VARIABLES: ReadonlyArray<{ token: string; descKey: string }> = [
  { token: '<% today %>', descKey: 'templates.variableToday' },
  { token: '<% time %>', descKey: 'templates.variableTime' },
  { token: '<% datetime %>', descKey: 'templates.variableDatetime' },
  { token: '<% page title %>', descKey: 'templates.variablePageTitle' },
  { token: '<% today:DD/MM/YYYY %>', descKey: 'templates.variableTodayFormat' },
  { token: '<% date+7 %>', descKey: 'templates.variableDateMath' },
  { token: '<% weekday %>', descKey: 'templates.variableWeekday' },
  { token: '<% month %>', descKey: 'templates.variableMonth' },
  { token: '<% isoweek %>', descKey: 'templates.variableIsoweek' },
]

export function TemplatesView(): React.ReactElement {
  const { t } = useTranslation()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [pendingRemoval, setPendingRemoval] = useState<{ id: string; name: string } | null>(null)
  const [newTemplateName, setNewTemplateName] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const loadTemplates = useCallback(async () => {
    setLoading(true)
    try {
      const pages = await loadTemplatePagesWithPreview(currentSpaceId)
      // PEND-35 Tier 2.8 — `blockType: 'page'` is pushed into SQL via
      // Tier 3.4's `query_by_property` push-down filter so non-page
      // rows never cross the IPC boundary.
      // The membership cap MUST match `loadTemplatePagesWithPreview`'s
      // `paginationLimit(100)` above: this set is the source of the
      // per-template journal/page scope badge, so a smaller cap here would
      // mislabel any journal template ranked beyond the cap as `page` scope
      // (#1523).
      const journalResp = await queryByProperty({
        key: 'journal-template',
        valueText: 'true',
        limit: paginationLimit(100),
        spaceId: currentSpaceId,
        blockType: 'page',
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
  }, [t, currentSpaceId])

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
        notify.error(t('templates.createFailed'))
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
        notify.success(t('templates.templateRemoved', { name }))
      } catch (err) {
        reportIpcError('TemplatesView', 'templates.removeTemplateFailed', err, t, { id, name })
      }
    },
    [t],
  )

  const handleNavigate = useCallback((id: string, content: string) => {
    useTabsStore.getState().navigateToPage(id, content)
  }, [])

  // UX-248 — Unicode-aware fold.
  const filtered = templates.filter((tpl) => matchesSearchFolded(tpl.content, search))

  return (
    <section className="space-y-4" aria-label={t('sidebar.templates')}>
      {/* PEND-UX item 5 — `<h1>` landmark above the create form. The form
          stays a standalone block (it spans the row at sm+ breakpoints
          and would not fit comfortably inside the header's right-aligned
          `actions` slot). */}
      <FeaturePageHeader title={t('sidebar.templates')} className="templates-view-header" />

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

      {/* #215 — dynamic-variable discoverability hint. Low-chrome muted row;
          each token carries a tooltip describing what it expands to. */}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="font-medium cursor-help">{t('templates.variablesHintLabel')}</span>
          </TooltipTrigger>
          <TooltipContent>{t('templates.variablesHintIntro')}</TooltipContent>
        </Tooltip>
        {TEMPLATE_VARIABLES.map(({ token, descKey }) => (
          <Tooltip key={token}>
            <TooltipTrigger asChild>
              <code
                className="rounded bg-muted px-1 py-0.5 font-mono text-[0.7rem] cursor-help"
                data-testid={`template-variable-${token
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-|-$/g, '')}`}
              >
                {token}
              </code>
            </TooltipTrigger>
            <TooltipContent>{t(descKey)}</TooltipContent>
          </Tooltip>
        ))}
      </p>

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
              <SearchInput
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
                  <ListItem key={tpl.id} className="active:bg-accent/70 cursor-pointer">
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
                    {/* #215 — scope badge. Every template carries a scope
                        indicator so a journal template is distinguishable from
                        a regular page template at a glance. Journal templates
                        keep the `secondary` tone; page templates use the calmer
                        `outline` tone so the journal flag stays the louder one. */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          tone={tpl.isJournalTemplate ? 'secondary' : 'outline'}
                          className="shrink-0 text-xs"
                        >
                          {tpl.isJournalTemplate
                            ? t('templates.journalIndicator')
                            : t('templates.pageIndicator')}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        {tpl.isJournalTemplate
                          ? t('templates.journalTooltip')
                          : t('templates.pageTooltip')}
                      </TooltipContent>
                    </Tooltip>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t('templates.removeTemplateLabel', { name: tpl.content })}
                      className={cn(
                        'shrink-0',
                        'text-muted-foreground hover:text-destructive focus-visible:opacity-100',
                        '[@media(pointer:coarse)]:opacity-100',
                        'touch-target [@media(pointer:coarse)]:min-w-[44px]',
                      )}
                      onClick={() => setPendingRemoval({ id: tpl.id, name: tpl.content ?? '' })}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </ListItem>
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
        onConfirm={() => {
          if (pendingRemoval) {
            handleRemoveTemplate(pendingRemoval.id, pendingRemoval.name)
            setPendingRemoval(null)
          }
        }}
      />
    </section>
  )
}
