/**
 * NewPageDialog — where every new page is made (#5637). The sidebar's New Page
 * button, the `createNewPage` chord, the palette command and the Pages view
 * all open it through `openNewPageDialog`.
 *
 * While the title is typed it lists pages with a similar name, found by the
 * `[[` picker's own matcher (`matchPages`). Whether a page already carries the
 * name follows the picker's own rule for a typed name: a title or an alias,
 * ignoring case. Then Open it is the primary action and Create is disabled.
 * A blank title creates the first free `Untitled N`.
 *
 * On a phone it is a bottom sheet (`useDialogOrSheet`), so the title input
 * sits just above the keyboard it opens.
 */

import { Plus } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { matchPages, type PageMatches, type PageRow } from '@/components/block-tree/page-matcher'
import { EmptyState } from '@/components/common/EmptyState'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { useDialogOrSheet } from '@/components/ui/use-dialog-or-sheet'
import type { PickerItem } from '@/editor/SuggestionList'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { usePageCreation } from '@/hooks/usePageCreation'
import { untitledOr } from '@/lib/block-title'
import { logger } from '@/lib/logger'

const SIMILAR_PAGES_SHOWN = 5
const SEARCH_DEBOUNCE_MS = 300

interface SimilarPage {
  id: string
  title: string
  /** The alias the name matched through, when it did. */
  alias: string | undefined
}

interface SearchResult {
  /** The trimmed title this result answers. */
  name: string
  existing: SimilarPage | undefined
  similar: SimilarPage[]
}

const NO_RESULT: SearchResult = { name: '', existing: undefined, similar: [] }

/**
 * The page that already carries `name`: a title or an alias equal to it,
 * ignoring case, as the `[[` picker resolves a typed name
 * (`matchBlockLinkItem`). The alias rows include the hits the picker folds
 * into a title hit.
 */
function findExisting(
  name: string,
  { aliasRows, items }: PageMatches,
  toPage: (item: PickerItem) => SimilarPage,
): SimilarPage | undefined {
  const lower = name.toLowerCase()
  const titled = items.find(
    (item) => !item.isCreate && !item.isAlias && (item.title ?? item.label).toLowerCase() === lower,
  )
  if (titled) return toPage(titled)
  const aliased = aliasRows.find((row) => row.alias.toLowerCase() === lower)
  return aliased && { id: aliased.id, title: aliased.title, alias: aliased.alias }
}

function toSearchResult(name: string, matches: PageMatches): SearchResult {
  const titles = new Map<string, string>(
    [...matches.rows, ...matches.aliasRows].map((row) => [row.id, row.title]),
  )
  const toPage = (item: PickerItem): SimilarPage => ({
    id: item.id,
    title: titles.get(item.id) ?? item.label,
    alias: item.aliasText,
  })
  const existing = findExisting(name, matches, toPage)
  return {
    name,
    existing,
    similar: matches.items
      .filter((item) => !item.isCreate && item.id !== existing?.id)
      .slice(0, SIMILAR_PAGES_SHOWN)
      .map(toPage),
  }
}

interface NewPageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pre-filled title, e.g. a namespace prefix (`Projects/`) or a search query. */
  initialTitle: string
  onOpenPage: (pageId: string, title: string) => void
}

export function NewPageDialog({
  open,
  onOpenChange,
  initialTitle,
  onOpenPage,
}: NewPageDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const { Root, Content, Header, Title, Description, Footer } = useDialogOrSheet('dialog')
  const formId = useId()
  const headingId = useId()
  const [title, setTitle] = useState(initialTitle)
  const [result, setResult] = useState<SearchResult>(NO_RESULT)
  const { isCreating, createError, clearCreateError, createPage } = usePageCreation()
  // Radix returns focus only to a `DialogTrigger`, and this dialog is opened
  // from anywhere, so it returns focus to what had it — unless a page was
  // opened, whose view takes focus instead.
  const [returnFocusTo] = useState(() => document.activeElement)
  const openedPageRef = useRef(false)

  // This dialog's own matcher cache, filled once on open the way `[[` fills
  // the picker's (its empty query): without it a query past two characters
  // gets FTS alone, which folds case but not accents and lags new pages, so
  // "cafe plans" would miss "Café plans" here while the picker finds it.
  const pagesListRef = useRef<PageRow[]>([])
  const generationRef = useRef(0)
  const requestSeqRef = useRef(0)
  const warmCacheRef = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => {
    warmCacheRef.current = matchPages('', { pagesListRef, generationRef, requestSeqRef }).catch(
      (err: unknown) => {
        logger.warn('NewPageDialog', 'page list warm-up failed', undefined, err)
      },
    )
  }, [])
  // Only the latest search may write `result`.
  const searchSeqRef = useRef(0)

  const runSearch = useCallback(async (value: string): Promise<SearchResult | null> => {
    const seq = ++searchSeqRef.current
    const name = value.trim()
    let next: SearchResult = { ...NO_RESULT, name }
    if (name !== '') {
      try {
        await warmCacheRef.current
        const matches = await matchPages(name, { pagesListRef, generationRef, requestSeqRef })
        next = toSearchResult(name, matches)
      } catch (err) {
        // A failed lookup must not block creating: the backend still
        // resolves an exact title to the existing page.
        logger.warn('NewPageDialog', 'similar-page search failed', { name }, err)
      }
    }
    if (seq !== searchSeqRef.current) return null
    setResult(next)
    return next
  }, [])

  const search = useDebouncedCallback((value) => {
    void runSearch(value)
  }, SEARCH_DEBOUNCE_MS)

  useEffect(() => {
    if (initialTitle.trim() !== '') search.schedule(initialTitle)
  }, [initialTitle, search])

  const name = title.trim()
  const existing = result.name === name ? result.existing : undefined
  const slash = name.lastIndexOf('/')
  const parentPath = slash > 0 ? name.slice(0, slash) : ''

  const openPage = (page: SimilarPage) => {
    search.cancel()
    openedPageRef.current = true
    onOpenPage(page.id, page.title)
    onOpenChange(false)
  }

  async function handleSubmit() {
    if (existing) {
      openPage(existing)
      return
    }
    search.cancel()
    // Re-check the name as it stands now: Enter can land inside the debounce.
    const fresh = name === '' ? NO_RESULT : await runSearch(name)
    // Superseded by newer typing, or now showing "already exists".
    if (fresh === null || fresh.existing) return
    const page = await createPage(name)
    if (page) openPage({ ...page, alias: undefined })
  }

  return (
    <Root open={open} onOpenChange={onOpenChange}>
      <Content
        data-testid="new-page-dialog"
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          if (!openedPageRef.current && returnFocusTo instanceof HTMLElement) returnFocusTo.focus()
        }}
      >
        <Header>
          <Title>{t('newPageDialog.title')}</Title>
          <Description>{t('newPageDialog.description')}</Description>
        </Header>
        <form
          id={formId}
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            void handleSubmit()
          }}
        >
          <Label htmlFor="new-page-name" className="sr-only">
            {t('newPageDialog.inputLabel')}
          </Label>
          <Input
            id="new-page-name"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              clearCreateError()
              search.schedule(e.target.value)
            }}
            placeholder={t('newPageDialog.placeholder')}
            aria-invalid={createError ? true : undefined}
            autoComplete="off"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog exists to take a title; typing starts at once, as it did when the chord created a page directly
            autoFocus
          />
          {parentPath !== '' && (
            <p className="text-xs text-muted-foreground" data-testid="new-page-parent-path">
              {t('newPageDialog.parentPath', { path: parentPath })}
            </p>
          )}
          {existing && (
            <output className="block rounded-md border border-alert-warning-border bg-alert-warning p-2 text-sm text-alert-warning-foreground">
              {existing.alias
                ? t('newPageDialog.aliasExists', {
                    alias: existing.alias,
                    title: untitledOr(existing.title),
                  })
                : t('newPageDialog.exists', { title: untitledOr(existing.title) })}
            </output>
          )}
          {createError && (
            <p role="alert" className="text-sm text-destructive">
              {createError}
            </p>
          )}
        </form>
        {/* Nothing to compare while the title is blank, and nothing to add
            under "already exists" when no other page is similar. */}
        {name !== '' && (existing === undefined || result.similar.length > 0) && (
          <section aria-labelledby={headingId} className="flex min-h-0 flex-col gap-2">
            <h3 id={headingId} className="text-sm font-medium">
              {t('newPageDialog.similarHeading')}
            </h3>
            {result.similar.length === 0 ? (
              <EmptyState compact headingLevel="p" message={t('newPageDialog.noSimilar')} />
            ) : (
              <ScrollArea viewportClassName="max-h-60">
                <ul className="space-y-1" data-testid="similar-pages">
                  {result.similar.map((page) => (
                    <li
                      key={page.id}
                      data-page-id={page.id}
                      className="flex items-center gap-2 rounded-md py-1 pl-2"
                    >
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{untitledOr(page.title)}</span>
                        {page.alias && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {t('newPageDialog.aliasOf', { alias: page.alias })}
                          </span>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t('newPageDialog.openPage', { title: untitledOr(page.title) })}
                        onClick={() => openPage(page)}
                      >
                        {t('newPageDialog.open')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
          </section>
        )}
        <Footer>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('newPageDialog.cancel')}
          </Button>
          {existing ? (
            <>
              <Button variant="outline" disabled>
                <Plus />
                {t('newPageDialog.create')}
              </Button>
              <Button type="submit" form={formId}>
                {t('newPageDialog.openExisting')}
              </Button>
            </>
          ) : (
            <Button type="submit" form={formId} disabled={isCreating}>
              {isCreating ? <Spinner /> : <Plus />}
              {t('newPageDialog.create')}
            </Button>
          )}
        </Footer>
      </Content>
    </Root>
  )
}
