/**
 * EditModeSwitch (#5691): a page's Blocks | Page switch, and Page disabled
 * with its reason where page mode cannot show the page.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

    await user.hover(radio(t('pageMode.page')))

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      `${t('pageMode.pageHint')} (Ctrl + Shift + M)`,
    )
  })

  it('a reason found while Page’s tooltip is open replaces its hint', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<EditModeSwitch mode="blocks" onChange={() => {}} />)
    await user.hover(radio(t('pageMode.page')))
    await screen.findByRole('tooltip')

    rerender(<EditModeSwitch mode="blocks" onChange={() => {}} blocked="Can’t show tasks yet." />)

    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toHaveTextContent('Can’t show tasks yet.')
    })
  })

  it('where page mode cannot show the page, Page says why and choosing it does nothing', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<EditModeSwitch mode="blocks" onChange={onChange} blocked="Can’t show tasks yet." />)
    const page = radio(t('pageMode.page'))

    expect(page).toHaveAttribute('aria-disabled', 'true')
    expect(page).toHaveAccessibleDescription('Can’t show tasks yet.')
    await user.hover(page)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Can’t show tasks yet.')

    await user.click(page)
    expect(onChange).not.toHaveBeenCalled()

    await user.click(radio(t('pageMode.blocks')))
    await user.click(radio(t('pageMode.page')))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('tells when the pointer or focus reaches it, so the page can be checked before a choice', () => {
    const onIntent = vi.fn()
    render(<EditModeSwitch mode="blocks" onChange={() => {}} onIntent={onIntent} />)
    const group = screen.getByRole('radiogroup', { name: t('pageMode.switchLabel') })

    fireEvent.pointerEnter(group)
    fireEvent.focus(radio(t('pageMode.blocks')))

    expect(onIntent).toHaveBeenCalledTimes(2)
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
