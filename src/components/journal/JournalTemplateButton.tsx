/**
 * JournalTemplateButton — the journal header's menu for the space's journal
 * template page (#5373). The menu opens that page when the space has one;
 * otherwise it offers the space's template pages to mark as the journal
 * template, or a new one. A phone shows the same rows in the day's *Page
 * actions* sheet (`DayPageEditor`) instead, so the header needs no row of
 * its own there.
 */

import type { TFunction } from 'i18next'
import { FilePlus, LayoutTemplate, MoreVertical } from 'lucide-react'
import type React from 'react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { MENU_ITEM_CLASS } from '@/components/pages/PageHeaderMenu'
import { IconButton } from '@/components/ui/icon-button'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { TruncatedText } from '@/components/ui/truncated-text'
import { unwrap } from '@/lib/app-error'
import type { BlockRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import type { NavigateToPageFn } from '@/lib/block-events'
import { notifyPageAdded } from '@/lib/name-change-bus'
import { reportIpcError } from '@/lib/report-ipc-error'
import { loadJournalTemplate, loadTemplatePages } from '@/lib/template-utils'
import { useSpaceStore } from '@/stores/space'

const LOG_MODULE = 'JournalTemplateButton'

async function setFlag(pageId: string, key: 'template' | 'journal-template'): Promise<void> {
  unwrap(
    await commands.setProperty(pageId, key, {
      value_text: 'true',
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    }),
  )
}

export interface JournalTemplateChoices {
  template: BlockRow | null
  /** The space's template pages, read only when it has no journal template. */
  pages: BlockRow[]
}

/** What the menu offers, read when it opens; `null` (after a toast) if the read failed. */
export async function loadJournalTemplateChoices(
  t: TFunction,
): Promise<JournalTemplateChoices | null> {
  const spaceId = useSpaceStore.getState().currentSpaceId
  try {
    const { template } = await loadJournalTemplate(spaceId)
    return { template, pages: template ? [] : await loadTemplatePages(spaceId) }
  } catch (err) {
    reportIpcError(LOG_MODULE, 'slash.templateLoadFailed', err, t)
    return null
  }
}

interface JournalTemplateItemsProps {
  choices: JournalTemplateChoices
  onNavigateToPage: NavigateToPageFn
  /** Closes the menu the rows sit in; a row calls it before acting. */
  onClose: () => void
}

/** The menu's rows, for a parent `role="menu"`. */
export function JournalTemplateItems({
  choices,
  onNavigateToPage,
  onClose,
}: JournalTemplateItemsProps): React.ReactElement {
  const { t } = useTranslation()
  const pickerId = useId()
  const { template, pages } = choices

  async function pickTemplatePage(page: BlockRow): Promise<void> {
    onClose()
    try {
      await setFlag(page.id, 'journal-template')
      onNavigateToPage(page.id, page.content ?? undefined)
    } catch (err) {
      reportIpcError(LOG_MODULE, 'pageHeader.journalTemplateFailed', err, t, { pageId: page.id })
    }
  }

  async function createJournalTemplate(): Promise<void> {
    onClose()
    const spaceId = useSpaceStore.getState().currentSpaceId
    const title = t('journal.templatePageTitle')
    try {
      if (spaceId == null) throw new Error('No active space; cannot create a journal template')
      // An existing page with this title is reused: `create_page_in_space`
      // resolves a taken title to that page (#4723).
      const pageId = unwrap(await commands.createPageInSpace(null, title, spaceId))
      notifyPageAdded(pageId, title, spaceId)
      await setFlag(pageId, 'template')
      await setFlag(pageId, 'journal-template')
      onNavigateToPage(pageId, title)
    } catch (err) {
      reportIpcError(LOG_MODULE, 'templates.createFailed', err, t)
    }
  }

  if (template) {
    return (
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM_CLASS}
        onClick={() => {
          onClose()
          onNavigateToPage(template.id, template.content ?? undefined)
        }}
      >
        <LayoutTemplate className="h-3.5 w-3.5 shrink-0" />
        {t('journal.openTemplate')}
      </button>
    )
  }
  return (
    <>
      {pages.length > 0 && (
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a labelled run of menuitems inside role="menu"; no HTML element is a menu group
        <div role="group" aria-labelledby={pickerId}>
          <p id={pickerId} className="px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">
            {t('journal.templatePickerLabel')}
          </p>
          {pages.map((page) => (
            <button
              key={page.id}
              type="button"
              role="menuitem"
              className={MENU_ITEM_CLASS}
              onClick={() => void pickTemplatePage(page)}
            >
              <LayoutTemplate className="h-3.5 w-3.5 shrink-0" />
              <TruncatedText>{page.content || t('block.untitled')}</TruncatedText>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM_CLASS}
        onClick={() => void createJournalTemplate()}
      >
        <FilePlus className="h-3.5 w-3.5 shrink-0" />
        {t('journal.newTemplate')}
      </button>
    </>
  )
}

interface JournalTemplateButtonProps {
  onNavigateToPage: NavigateToPageFn
}

export function JournalTemplateButton({
  onNavigateToPage,
}: JournalTemplateButtonProps): React.ReactElement {
  const { t } = useTranslation()
  const [choices, setChoices] = useState<JournalTemplateChoices | null>(null)
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          variant="ghost"
          size="icon-xs"
          tooltip={t('journal.configureTemplate')}
          ariaLabel={t('journal.configureTemplate')}
          onClick={(e) => {
            if (open) return
            // Opens once the rows are read, so the menu does not grow under the pointer.
            e.preventDefault()
            void loadJournalTemplateChoices(t).then((next) => {
              if (next == null) return
              setChoices(next)
              setOpen(true)
            })
          }}
        >
          <MoreVertical />
        </IconButton>
      </PopoverTrigger>
      <MenuPopoverContent align="end" role="menu" aria-label={t('journal.configureTemplate')}>
        {choices && (
          <JournalTemplateItems
            choices={choices}
            onNavigateToPage={onNavigateToPage}
            onClose={() => setOpen(false)}
          />
        )}
      </MenuPopoverContent>
    </Popover>
  )
}
