/**
 * Tests for `ImportMergeDialog` — the question an import asks before it
 * merges files into existing pages (#6277 decision 7): it lists the pages and
 * answers the run, first yes on confirm, first no on cancel or Escape.
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { ImportMergeDialog } from '@/components/settings/ImportMergeDialog'
import type { MergeQuestion } from '@/components/settings/useImportRunner'
import { t } from '@/lib/i18n'

function question(titles: string[]): MergeQuestion {
  return {
    pages: titles.map((title, i) => ({ page_id: `PAGE${i}`, title })),
    answer: vi.fn(),
  }
}

describe('ImportMergeDialog', () => {
  it('lists the pages the import updates under a title counting them', () => {
    render(<ImportMergeDialog question={question(['Plan', 'Work/Meeting'])} />)

    const dialog = screen.getByRole('alertdialog')
    expect(within(dialog).getByText(t('data.importMergeTitle', { count: 2 }))).toBeInTheDocument()
    const items = within(screen.getByTestId('import-merge-pages')).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual(['Plan', 'Work/Meeting'])
  })

  it('renders nothing while the run asks nothing', () => {
    render(<ImportMergeDialog question={null} />)

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('answers yes first on confirm', async () => {
    const user = userEvent.setup()
    const asked = question(['Plan'])
    render(<ImportMergeDialog question={asked} />)

    await user.click(screen.getByRole('button', { name: t('data.importMergeConfirm') }))

    // Closing after the confirm answers again; the run takes the first answer.
    expect(asked.answer).toHaveBeenNthCalledWith(1, true)
  })

  it('answers no on cancel', async () => {
    const user = userEvent.setup()
    const asked = question(['Plan'])
    render(<ImportMergeDialog question={asked} />)

    await user.click(screen.getByRole('button', { name: t('dialog.cancel') }))

    expect(asked.answer).toHaveBeenNthCalledWith(1, false)
    expect(asked.answer).not.toHaveBeenCalledWith(true)
  })

  it('answers no on Escape', async () => {
    const user = userEvent.setup()
    const asked = question(['Plan'])
    render(<ImportMergeDialog question={asked} />)

    await user.keyboard('{Escape}')

    expect(asked.answer).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('has no a11y violations', async () => {
    const { baseElement } = render(<ImportMergeDialog question={question(['Plan', 'Roadmap'])} />)

    expect(await axe(baseElement)).toHaveNoViolations()
  })
})
