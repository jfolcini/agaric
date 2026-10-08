/**
 * Tests for JournalTemplateButton (#5373), driven against the seeded tauri
 * mock so every write is read back, not inferred from the call.
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
import { JournalTemplateButton } from '@/components/journal/JournalTemplateButton'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { SEED_IDS, seedBlocks } from '@/lib/tauri-mock/seed'
import { loadJournalTemplate, loadTemplatePages } from '@/lib/template-utils'
import { useSpaceStore } from '@/stores/space'

const SPACE = 'SPACE_PERSONAL'
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

function renderButton() {
  const onNavigateToPage = vi.fn()
  const utils = render(<JournalTemplateButton onNavigateToPage={onNavigateToPage} />)
  return { ...utils, onNavigateToPage }
}

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: t('journal.configureTemplate') })
}

async function openPicker(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(trigger())
  return screen.findByRole('dialog', { name: t('journal.templatePickerLabel') })
}

describe('JournalTemplateButton', () => {
  it('renders an icon button named for the journal template', async () => {
    const { container } = renderButton()

    expect(trigger()).toBeInTheDocument()
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })

  it('opens the space’s journal template page without showing the picker', async () => {
    const user = userEvent.setup()
    await markJournalTemplate(SEED_IDS.PAGE_TMPL_MEETING)
    const { onNavigateToPage } = renderButton()

    await user.click(trigger())

    await waitFor(() => {
      expect(onNavigateToPage).toHaveBeenCalledWith(SEED_IDS.PAGE_TMPL_MEETING, MEETING_TEMPLATE)
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('lists only the space’s template pages, plus the New action', async () => {
    const user = userEvent.setup()
    renderButton()

    const picker = await openPicker(user)

    const items = within(picker).getAllByRole('button')
    expect(items.map((item) => item.textContent)).toEqual([
      MEETING_TEMPLATE,
      t('journal.newTemplate'),
    ])
    expect(await axe(picker)).toHaveNoViolations()
  })

  it('offers only the New action when the space has no template pages', async () => {
    const user = userEvent.setup()
    unwrap(await commands.deleteProperty(SEED_IDS.PAGE_TMPL_MEETING, 'template'))
    renderButton()

    const picker = await openPicker(user)

    const items = within(picker).getAllByRole('button')
    expect(items.map((item) => item.textContent)).toEqual([t('journal.newTemplate')])
  })

  it('marks a picked template page as the journal template and opens it', async () => {
    const user = userEvent.setup()
    const { onNavigateToPage } = renderButton()

    const picker = await openPicker(user)
    await user.click(within(picker).getByRole('button', { name: MEETING_TEMPLATE }))

    await waitFor(() => {
      expect(onNavigateToPage).toHaveBeenCalledWith(SEED_IDS.PAGE_TMPL_MEETING, MEETING_TEMPLATE)
    })
    const { template } = await loadJournalTemplate(SPACE)
    expect(template?.id).toBe(SEED_IDS.PAGE_TMPL_MEETING)
  })

  it('creates a page that is both a template and the journal template, and opens it', async () => {
    const user = userEvent.setup()
    const { onNavigateToPage } = renderButton()

    const picker = await openPicker(user)
    await user.click(within(picker).getByRole('button', { name: t('journal.newTemplate') }))

    await waitFor(() => {
      expect(onNavigateToPage).toHaveBeenCalledTimes(1)
    })
    const { template } = await loadJournalTemplate(SPACE)
    expect(template?.content).toBe(t('journal.templatePageTitle'))
    expect(onNavigateToPage).toHaveBeenCalledWith(template?.id, t('journal.templatePageTitle'))
    const templatePageIds = (await loadTemplatePages(SPACE)).map((page) => page.id)
    expect(templatePageIds).toContain(template?.id)
  })

  it('shows a toast and opens nothing when marking the picked page fails', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string, args?: InvokeArgs) =>
      cmd === 'set_property' ? Promise.reject(new Error('backend down')) : dispatch(cmd, args),
    )
    const { onNavigateToPage } = renderButton()

    const picker = await openPicker(user)
    await user.click(within(picker).getByRole('button', { name: MEETING_TEMPLATE }))

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('pageHeader.journalTemplateFailed'))
    })
    expect(onNavigateToPage).not.toHaveBeenCalled()
    const { template } = await loadJournalTemplate(SPACE)
    expect(template).toBeNull()
  })
})
