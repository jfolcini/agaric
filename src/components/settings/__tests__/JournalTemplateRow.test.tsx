/**
 * Tests for JournalTemplateRow (#5373), driven against the seeded tauri mock
 * so every write is read back, not inferred from the call.
 *
 * Seed: "Meeting Notes Template" is the space's one template page; no page
 * is the journal template.
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { JournalTemplateRow } from '@/components/settings/JournalTemplateRow'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { loadJournalTemplate, loadTemplatePages } from '@/lib/template-utils'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

const SPACE = SEED_IDS.SPACE_PERSONAL
const MEETING_TEMPLATE = 'Meeting Notes Template'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  seedBlocks()
  useSpaceStore.setState({
    currentSpaceId: SPACE,
    availableSpaces: [{ id: SPACE, name: 'Personal', accent_color: null }],
    isReady: true,
  })
  mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) => dispatch(cmd, args))
})

async function markJournalTemplate(pageId: string): Promise<void> {
  unwrap(
    await commands.setProperty(pageId, 'journal-template', {
      value_text: 'true',
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    }),
  )
}

const select = () => screen.getByRole('combobox', { name: t('settings.journalTemplateLabel') })

/** Pick `name` once the list has loaded (the shared Select mock is a native `<select>`). */
async function choose(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await waitFor(() => expect(select()).toBeEnabled())
  await user.selectOptions(select(), name)
}

describe('JournalTemplateRow', () => {
  it('shows None with no journal template, offers New and no Open, and passes axe', async () => {
    const { container } = render(<JournalTemplateRow />)

    await waitFor(() => expect(select()).toBeEnabled())
    expect(select()).toHaveDisplayValue(t('settings.journalTemplateNone'))
    expect(screen.getByRole('button', { name: t('journal.newTemplate') })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: t('settings.journalTemplateOpen') }),
    ).not.toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('lists None and the space’s template pages', async () => {
    render(<JournalTemplateRow />)
    await waitFor(() => expect(select()).toBeEnabled())

    const options = within(select()).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      t('settings.journalTemplateNone'),
      MEETING_TEMPLATE,
    ])
  })

  it('marks a picked template page as the journal template', async () => {
    const user = userEvent.setup()
    render(<JournalTemplateRow />)

    await choose(user, MEETING_TEMPLATE)

    await waitFor(async () => {
      expect((await loadJournalTemplate(SPACE)).template?.id).toBe(SEED_IDS.PAGE_TMPL_MEETING)
    })
    await waitFor(() => expect(select()).toHaveDisplayValue(MEETING_TEMPLATE))
  })

  it('None unmarks the journal template', async () => {
    const user = userEvent.setup()
    await markJournalTemplate(SEED_IDS.PAGE_TMPL_MEETING)
    render(<JournalTemplateRow />)
    await waitFor(() => expect(select()).toHaveDisplayValue(MEETING_TEMPLATE))

    await choose(user, t('settings.journalTemplateNone'))

    await waitFor(async () => {
      expect((await loadJournalTemplate(SPACE)).template).toBeNull()
    })
  })

  it('Open opens the journal template', async () => {
    const user = userEvent.setup()
    const navigateToPage = vi.spyOn(useTabsStore.getState(), 'navigateToPage')
    await markJournalTemplate(SEED_IDS.PAGE_TMPL_MEETING)
    render(<JournalTemplateRow />)

    await user.click(await screen.findByRole('button', { name: t('settings.journalTemplateOpen') }))

    expect(navigateToPage).toHaveBeenCalledWith(SEED_IDS.PAGE_TMPL_MEETING, MEETING_TEMPLATE)
  })

  it('New creates a template that replaces the journal template, and opens it', async () => {
    const user = userEvent.setup()
    const navigateToPage = vi.spyOn(useTabsStore.getState(), 'navigateToPage')
    await markJournalTemplate(SEED_IDS.PAGE_TMPL_MEETING)
    render(<JournalTemplateRow />)

    await user.click(screen.getByRole('button', { name: t('journal.newTemplate') }))

    await waitFor(() => expect(navigateToPage).toHaveBeenCalledTimes(1))
    const { template, duplicateWarning } = await loadJournalTemplate(SPACE)
    expect(template?.content).toBe(t('journal.templatePageTitle'))
    expect(duplicateWarning).toBeNull()
    expect(navigateToPage).toHaveBeenCalledWith(template?.id, t('journal.templatePageTitle'))
    expect((await loadTemplatePages(SPACE)).map((p) => p.id)).toContain(template?.id)
  })

  it('shows a toast and leaves the journal template unset when marking fails', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) =>
      cmd === 'set_property' ? Promise.reject(new Error('backend down')) : dispatch(cmd, args),
    )
    render(<JournalTemplateRow />)

    await choose(user, MEETING_TEMPLATE)

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('pageHeader.journalTemplateFailed'))
    })
    expect((await loadJournalTemplate(SPACE)).template).toBeNull()
    await waitFor(() => expect(select()).toHaveDisplayValue(t('settings.journalTemplateNone')))
  })
})
