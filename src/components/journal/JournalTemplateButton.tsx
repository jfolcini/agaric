/**
 * JournalTemplateButton — the journal header's way to the space's journal
 * template page (#5373). A click opens that page when the space has one;
 * otherwise a popover offers the space's template pages to mark as the
 * journal template, or a new one.
 */

import { FilePlus, Settings2 } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { IconButton } from '@/components/ui/icon-button'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'
import { PopoverMenuItem } from '@/components/ui/popover-menu-item'
import { ScrollArea } from '@/components/ui/scroll-area'
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

interface JournalTemplateButtonProps {
  onNavigateToPage: NavigateToPageFn
}

export function JournalTemplateButton({
  onNavigateToPage,
}: JournalTemplateButtonProps): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [templatePages, setTemplatePages] = useState<BlockRow[]>([])

  async function openJournalTemplateOrPicker(): Promise<void> {
    const spaceId = useSpaceStore.getState().currentSpaceId
    try {
      const { template } = await loadJournalTemplate(spaceId)
      if (template) {
        onNavigateToPage(template.id, template.content ?? undefined)
        return
      }
      setTemplatePages(await loadTemplatePages(spaceId))
      setOpen(true)
    } catch (err) {
      reportIpcError(LOG_MODULE, 'slash.templateLoadFailed', err, t)
    }
  }

  async function pickTemplatePage(page: BlockRow): Promise<void> {
    setOpen(false)
    try {
      await setFlag(page.id, 'journal-template')
      onNavigateToPage(page.id, page.content ?? undefined)
    } catch (err) {
      reportIpcError(LOG_MODULE, 'pageHeader.journalTemplateFailed', err, t, { pageId: page.id })
    }
  }

  async function createJournalTemplate(): Promise<void> {
    setOpen(false)
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
            // The popover opens only once the lookup finds no journal template.
            e.preventDefault()
            void openJournalTemplateOrPicker()
          }}
        >
          <Settings2 className="h-4 w-4" />
        </IconButton>
      </PopoverTrigger>
      <MenuPopoverContent align="end" aria-label={t('journal.templatePickerLabel')}>
        {templatePages.length > 0 && (
          <>
            <ScrollArea className="max-h-64">
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {templatePages.map((page) => (
                  <li key={page.id}>
                    <PopoverMenuItem
                      className="truncate"
                      onClick={() => void pickTemplatePage(page)}
                    >
                      {page.content || t('block.untitled')}
                    </PopoverMenuItem>
                  </li>
                ))}
              </ul>
            </ScrollArea>
            <hr className="my-1 h-px border-none bg-border" />
          </>
        )}
        <PopoverMenuItem
          className="flex items-center gap-2"
          onClick={() => void createJournalTemplate()}
        >
          <FilePlus className="h-3.5 w-3.5" aria-hidden="true" />
          {t('journal.newTemplate')}
        </PopoverMenuItem>
      </MenuPopoverContent>
    </Popover>
  )
}
