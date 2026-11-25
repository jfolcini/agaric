/**
 * JournalTemplateRow — Settings › General's journal template (#5373): the
 * current space's page a new day is copied from. Picking one of the space's
 * template pages marks it and unmarks the one before; *None* unmarks it; the
 * new-template button creates one and opens it; *Open* opens the one set.
 */

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingRow, settingDescriptionId } from '@/components/ui/setting-row'
import { unwrap } from '@/lib/app-error'
import type { BlockRow } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { notifyPageAdded } from '@/lib/name-change-bus'
import { reportIpcError } from '@/lib/report-ipc-error'
import { loadJournalTemplate, loadTemplatePages } from '@/lib/template-utils'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

const LOG_MODULE = 'JournalTemplateRow'
const CONTROL_ID = 'journal-template-select'
const NONE = 'none'

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

interface Choices {
  template: BlockRow | null
  /** The space's template pages, the journal template among them. */
  pages: BlockRow[]
}

export function JournalTemplateRow(): React.ReactElement {
  const { t } = useTranslation()
  const spaceId = useSpaceStore((s) => s.currentSpaceId)
  // `null` until the first read lands: the list is not offered half-filled.
  const [choices, setChoices] = useState<Choices | null>(null)

  const load = useCallback(async () => {
    try {
      const [{ template }, pages] = await Promise.all([
        loadJournalTemplate(spaceId),
        loadTemplatePages(spaceId),
      ])
      const listed = template && !pages.some((p) => p.id === template.id)
      setChoices({ template, pages: listed ? [template, ...pages] : pages })
    } catch (err) {
      reportIpcError(LOG_MODULE, 'slash.templateLoadFailed', err, t)
    }
  }, [spaceId, t])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- kicks off the template-page IPC load for the space on screen; `load` sets the choices after its awaits, not a render-time derivation; see #4407
    void load()
  }, [load])

  const { template, pages } = choices ?? { template: null, pages: [] }

  async function pick(value: string): Promise<void> {
    try {
      if (value !== NONE) await setFlag(value, 'journal-template')
      if (template && template.id !== value) {
        unwrap(await commands.deleteProperty(template.id, 'journal-template'))
      }
    } catch (err) {
      reportIpcError(LOG_MODULE, 'pageHeader.journalTemplateFailed', err, t, { pageId: value })
    }
    await load()
  }

  async function create(): Promise<void> {
    const title = t('journal.templatePageTitle')
    try {
      if (spaceId == null) throw new Error('No active space; cannot create a journal template')
      // An existing page with this title is reused: `create_page_in_space`
      // resolves a taken title to that page (#4723).
      const pageId = unwrap(await commands.createPageInSpace(null, title, spaceId))
      notifyPageAdded(pageId, title, spaceId)
      await setFlag(pageId, 'template')
      await setFlag(pageId, 'journal-template')
      if (template && template.id !== pageId) {
        unwrap(await commands.deleteProperty(template.id, 'journal-template'))
      }
      useTabsStore.getState().navigateToPage(pageId, title)
    } catch (err) {
      reportIpcError(LOG_MODULE, 'templates.createFailed', err, t)
      await load()
    }
  }

  return (
    <SettingRow
      label={t('settings.journalTemplateLabel')}
      controlId={CONTROL_ID}
      description={t('settings.journalTemplateHelp')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={template?.id ?? NONE}
          onValueChange={(value) => void pick(value)}
          disabled={choices === null}
        >
          <SelectTrigger
            id={CONTROL_ID}
            className="sm:w-72"
            aria-describedby={settingDescriptionId(CONTROL_ID)}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('settings.journalTemplateNone')}</SelectItem>
            {pages.map((page) => (
              <SelectItem key={page.id} value={page.id}>
                {page.content || t('block.untitled')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {template && (
          <Button
            variant="outline"
            onClick={() =>
              useTabsStore
                .getState()
                .navigateToPage(template.id, template.content || t('block.untitled'))
            }
          >
            {t('settings.journalTemplateOpen')}
          </Button>
        )}
        <Button variant="outline" onClick={() => void create()}>
          {t('journal.newTemplate')}
        </Button>
      </div>
    </SettingRow>
  )
}
