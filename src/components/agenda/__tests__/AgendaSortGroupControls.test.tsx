import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import type { AgendaSortGroupControlsProps } from '@/components/agenda/AgendaSortGroupControls'
import { AgendaSortGroupControls } from '@/components/agenda/AgendaSortGroupControls'
import { t } from '@/lib/i18n'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AgendaSortGroupControls', () => {
  const defaultProps: AgendaSortGroupControlsProps = {
    groupBy: 'date',
    onGroupByChange: vi.fn(),
    sortBy: 'date',
    onSortByChange: vi.fn(),
  }

  function renderControls(overrides?: Partial<AgendaSortGroupControlsProps>) {
    const props = { ...defaultProps, ...overrides }
    return render(<AgendaSortGroupControls {...props} />)
  }

  const viewButton = () => screen.getByRole('button', { name: t('agenda.view') })

  async function openView(user: ReturnType<typeof userEvent.setup>) {
    await user.click(viewButton())
    return {
      group: screen.getByRole('list', { name: t('agenda.groupBy') }),
      sort: screen.getByRole('list', { name: t('agenda.sortBy') }),
    }
  }

  it('is one View button, its choices closed', () => {
    renderControls()
    expect(viewButton()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: t('agenda.groupBy') })).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: t('agenda.sortBy') })).not.toBeInTheDocument()
  })

  it('opens Group by and Sort by together, each marking its current choice', async () => {
    const user = userEvent.setup()
    renderControls({ groupBy: 'priority', sortBy: 'state' })

    const { group, sort } = await openView(user)

    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      t('agenda.groupDate'),
      t('agenda.groupPriority'),
      t('agenda.groupState'),
      t('agenda.groupPage'),
      t('agenda.groupNone'),
    ])
    expect(
      within(sort)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      t('agenda.sortDate'),
      t('agenda.sortPriority'),
      t('agenda.sortState'),
      t('agenda.sortPage'),
    ])
    expect(within(group).getByRole('button', { name: t('agenda.groupPriority') })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(within(group).getByRole('button', { name: t('agenda.groupDate') })).not.toHaveAttribute(
      'aria-current',
    )
    expect(within(sort).getByRole('button', { name: t('agenda.sortState') })).toHaveAttribute(
      'aria-current',
      'true',
    )
  })

  it('a choice in each list reports it and keeps the choices open', async () => {
    const user = userEvent.setup()
    const onGroupByChange = vi.fn()
    const onSortByChange = vi.fn()
    renderControls({ onGroupByChange, onSortByChange })

    const { group, sort } = await openView(user)
    await user.click(within(group).getByRole('button', { name: t('agenda.groupPage') }))
    await user.click(within(sort).getByRole('button', { name: t('agenda.sortPriority') }))

    expect(onGroupByChange).toHaveBeenCalledWith('page')
    expect(onSortByChange).toHaveBeenCalledWith('priority')
    expect(screen.getByRole('list', { name: t('agenda.sortBy') })).toBeInTheDocument()
  })

  it('Escape closes the choices', async () => {
    const user = userEvent.setup()
    renderControls()

    await openView(user)
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('list', { name: t('agenda.groupBy') })).not.toBeInTheDocument()
  })

  it('has no a11y violations, closed and open', async () => {
    const user = userEvent.setup()
    const { container, baseElement } = renderControls({ groupBy: 'none', sortBy: 'priority' })
    expect(await axe(container)).toHaveNoViolations()

    await openView(user)
    expect(await axe(baseElement)).toHaveNoViolations()
  })
})
