import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '@/lib/i18n'
import type { AgendaSortGroupControlsProps } from '../AgendaSortGroupControls'
import { AgendaSortGroupControls } from '../AgendaSortGroupControls'

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

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------
  it('renders sort and group control buttons', () => {
    renderControls()
    expect(screen.getByLabelText(t('agenda.groupBy'))).toBeInTheDocument()
    expect(screen.getByLabelText(t('agenda.sortBy'))).toBeInTheDocument()
  })

  it('shows current group and sort selections', () => {
    renderControls({ groupBy: 'priority', sortBy: 'state' })
    expect(screen.getByLabelText(t('agenda.groupBy'))).toHaveTextContent(t('agenda.groupPriority'))
    expect(screen.getByLabelText(t('agenda.sortBy'))).toHaveTextContent(t('agenda.sortState'))
  })

  it('renders with toolbar role', () => {
    renderControls()
    expect(screen.getByRole('toolbar')).toBeInTheDocument()
  })

  it('shows date labels by default', () => {
    renderControls()
    expect(screen.getByLabelText(t('agenda.groupBy'))).toHaveTextContent(t('agenda.groupDate'))
    expect(screen.getByLabelText(t('agenda.sortBy'))).toHaveTextContent(t('agenda.sortDate'))
  })

  // -----------------------------------------------------------------------
  // Group by interaction
  // -----------------------------------------------------------------------
  it('clicking group-by shows options and selecting calls onGroupByChange', async () => {
    const user = userEvent.setup()
    const onGroupByChange = vi.fn()
    renderControls({ onGroupByChange })

    await user.click(screen.getByLabelText(t('agenda.groupBy')))

    const groupList = screen.getByRole('list', { name: t('agenda.groupBy') })
    expect(within(groupList).getByText(t('agenda.groupDate'))).toBeInTheDocument()
    expect(within(groupList).getByText(t('agenda.groupPriority'))).toBeInTheDocument()
    expect(within(groupList).getByText(t('agenda.groupState'))).toBeInTheDocument()
    expect(within(groupList).getByText(t('agenda.groupNone'))).toBeInTheDocument()

    await user.click(within(groupList).getByText(t('agenda.groupPriority')))
    expect(onGroupByChange).toHaveBeenCalledWith('priority')
  })

  it('marks the current group option with aria-current', async () => {
    const user = userEvent.setup()
    renderControls({ groupBy: 'priority' })

    await user.click(screen.getByLabelText(t('agenda.groupBy')))

    const groupList = screen.getByRole('list', { name: t('agenda.groupBy') })
    const priorityBtn = within(groupList).getByText(t('agenda.groupPriority'))
    expect(priorityBtn).toHaveAttribute('aria-current', 'true')

    const dateBtn = within(groupList).getByText(t('agenda.groupDate'))
    expect(dateBtn).not.toHaveAttribute('aria-current')
  })

  // -----------------------------------------------------------------------
  // Sort by interaction
  // -----------------------------------------------------------------------
  it('clicking sort-by shows options and selecting calls onSortByChange', async () => {
    const user = userEvent.setup()
    const onSortByChange = vi.fn()
    renderControls({ onSortByChange })

    await user.click(screen.getByLabelText(t('agenda.sortBy')))

    const sortList = screen.getByRole('list', { name: t('agenda.sortBy') })
    expect(within(sortList).getByText(t('agenda.sortDate'))).toBeInTheDocument()
    expect(within(sortList).getByText(t('agenda.sortPriority'))).toBeInTheDocument()
    expect(within(sortList).getByText(t('agenda.sortState'))).toBeInTheDocument()

    await user.click(within(sortList).getByText(t('agenda.sortState')))
    expect(onSortByChange).toHaveBeenCalledWith('state')
  })

  it('marks the current sort option with aria-current', async () => {
    const user = userEvent.setup()
    renderControls({ sortBy: 'state' })

    await user.click(screen.getByLabelText(t('agenda.sortBy')))

    const sortList = screen.getByRole('list', { name: t('agenda.sortBy') })
    const stateBtn = within(sortList).getByText(t('agenda.sortState'))
    expect(stateBtn).toHaveAttribute('aria-current', 'true')
  })

  it('sort options do not include None', async () => {
    const user = userEvent.setup()
    renderControls()

    await user.click(screen.getByLabelText(t('agenda.sortBy')))

    const sortList = screen.getByRole('list', { name: t('agenda.sortBy') })
    expect(within(sortList).queryByText(t('agenda.groupNone'))).not.toBeInTheDocument()
  })

  it('renders page group option', async () => {
    const user = userEvent.setup()
    const onGroupByChange = vi.fn()
    renderControls({ onGroupByChange })

    await user.click(screen.getByLabelText(t('agenda.groupBy')))

    const groupList = screen.getByRole('list', { name: t('agenda.groupBy') })
    expect(within(groupList).getByText(t('agenda.groupPage'))).toBeInTheDocument()

    await user.click(within(groupList).getByText(t('agenda.groupPage')))
    expect(onGroupByChange).toHaveBeenCalledWith('page')
  })

  it('renders page sort option', async () => {
    const user = userEvent.setup()
    const onSortByChange = vi.fn()
    renderControls({ onSortByChange })

    await user.click(screen.getByLabelText(t('agenda.sortBy')))

    const sortList = screen.getByRole('list', { name: t('agenda.sortBy') })
    expect(within(sortList).getByText(t('agenda.sortPage'))).toBeInTheDocument()

    await user.click(within(sortList).getByText(t('agenda.sortPage')))
    expect(onSortByChange).toHaveBeenCalledWith('page')
  })

  // -----------------------------------------------------------------------
  // A11y
  // -----------------------------------------------------------------------
  it('has no a11y violations', async () => {
    const { container } = renderControls()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with non-default selections', async () => {
    const { container } = renderControls({ groupBy: 'none', sortBy: 'priority' })
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
