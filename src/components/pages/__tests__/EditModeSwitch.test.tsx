/**
 * EditModeSwitch (#5691): a page's Blocks | Page switch, and Page disabled
 * with an ⓘ giving its reason where page mode cannot show the page.
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { EditModeSwitch } from '@/components/pages/EditModeSwitch'
import { t } from '@/lib/i18n'

const radio = (name: string) => screen.getByRole('radio', { name })

describe('EditModeSwitch', () => {
  it('marks the current mode and reports the other when it is chosen', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<EditModeSwitch mode="blocks" onChange={onChange} />)
    expect(radio(t('pageMode.blocks'))).toHaveAttribute('aria-checked', 'true')

    // The mode already on reports nothing: Radix would report it as ''.
    await user.click(radio(t('pageMode.blocks')))
    await user.click(radio(t('pageMode.page')))

    expect(onChange.mock.calls).toEqual([['page']])
  })

  it('Page’s tooltip names it and its shortcut', async () => {
    const user = userEvent.setup()
    render(<EditModeSwitch mode="blocks" onChange={() => {}} />)

    expect(
      screen.queryByRole('button', { name: t('pageMode.blockedInfo') }),
    ).not.toBeInTheDocument()
    await user.hover(radio(t('pageMode.page')))

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      `${t('pageMode.pageHint')} (Ctrl + E / Ctrl + Shift + M)`,
    )
  })

  it('where page mode cannot show the page, an ⓘ says why and choosing Page does nothing', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<EditModeSwitch mode="blocks" onChange={onChange} blocked="Can’t show tasks yet." />)
    const page = radio(t('pageMode.page'))

    expect(page).toHaveAttribute('aria-disabled', 'true')
    await user.click(screen.getByRole('button', { name: t('pageMode.blockedInfo') }))
    expect(
      await screen.findByRole('dialog', { name: t('pageMode.blockedInfo') }),
    ).toHaveTextContent('Can’t show tasks yet.')
    await user.keyboard('{Escape}')

    await user.click(page)
    expect(onChange).not.toHaveBeenCalled()

    await user.click(radio(t('pageMode.blocks')))
    await user.click(radio(t('pageMode.page')))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps focus on Page when a reason arrives while it is focused', () => {
    const { rerender } = render(<EditModeSwitch mode="blocks" onChange={() => {}} />)
    const page = screen.getByRole('radio', { name: t('pageMode.page') })
    page.focus()

    rerender(<EditModeSwitch mode="blocks" onChange={() => {}} blocked="Why not." />)

    expect(screen.getByRole('radio', { name: t('pageMode.page') })).toBe(page)
    expect(page).toHaveFocus()
  })

  it('has no a11y violations, offered or blocked', async () => {
    const { container, rerender } = render(<EditModeSwitch mode="page" onChange={() => {}} />)
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })

    rerender(<EditModeSwitch mode="blocks" onChange={() => {}} blocked="Why not." />)
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
