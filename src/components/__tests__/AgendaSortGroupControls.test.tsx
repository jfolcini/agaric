import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
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
    expect(screen.getByLabelText('Group by')).toBeInTheDocument()
    expect(screen.getByLabelText('Sort by')).toBeInTheDocument()
  })

  it('shows current group and sort selections', () => {
    renderControls({ groupBy: 'priority', sortBy: 'state' })
    expect(screen.getByLabelText('Group by')).toHaveTextContent('Priority')
    expect(screen.getByLabelText('Sort by')).toHaveTextContent('State')
  })

  it('renders with toolbar role', () => {
    renderControls()
    expect(screen.getByRole('toolbar')).toBeInTheDocument()
  })

  it('shows date labels by default', () => {
    renderControls()
    expect(screen.getByLabelText('Group by')).toHaveTextContent('Date')
    expect(screen.getByLabelText('Sort by')).toHaveTextContent('Date')
  })

  // -----------------------------------------------------------------------
  // Group by interaction
  // -----------------------------------------------------------------------
  it('clicking group-by shows options and selecting calls onGroupByChange', async () => {
    const user = userEvent.setup()
    const onGroupByChange = vi.fn()
    renderControls({ onGroupByChange })

    await user.click(screen.getByLabelText('Group by'))

    const groupList = screen.getByRole('list', { name: 'Group by' })
    expect(within(groupList).getByText('Date')).toBeInTheDocument()
    expect(within(groupList).getByText('Priority')).toBeInTheDocument()
    expect(within(groupList).getByText('State')).toBeInTheDocument()
    expect(within(groupList).getByText('None')).toBeInTheDocument()

    await user.click(within(groupList).getByText('Priority'))
    expect(onGroupByChange).toHaveBeenCalledWith('priority')
  })

  it('marks the current group option with aria-current', async () => {
    const user = userEvent.setup()
    renderControls({ groupBy: 'priority' })

    await user.click(screen.getByLabelText('Group by'))

    const groupList = screen.getByRole('list', { name: 'Group by' })
    const priorityBtn = within(groupList).getByText('Priority')
    expect(priorityBtn).toHaveAttribute('aria-current', 'true')

    const dateBtn = within(groupList).getByText('Date')
    expect(dateBtn).not.toHaveAttribute('aria-current')
  })

  // -----------------------------------------------------------------------
  // Sort by interaction
  // -----------------------------------------------------------------------
  it('clicking sort-by shows options and selecting calls onSortByChange', async () => {
    const user = userEvent.setup()
    const onSortByChange = vi.fn()
    renderControls({ onSortByChange })

    await user.click(screen.getByLabelText('Sort by'))

    const sortList = screen.getByRole('list', { name: 'Sort by' })
    expect(within(sortList).getByText('Date')).toBeInTheDocument()
    expect(within(sortList).getByText('Priority')).toBeInTheDocument()
    expect(within(sortList).getByText('State')).toBeInTheDocument()

    await user.click(within(sortList).getByText('State'))
    expect(onSortByChange).toHaveBeenCalledWith('state')
  })

  it('marks the current sort option with aria-current', async () => {
    const user = userEvent.setup()
    renderControls({ sortBy: 'state' })

    await user.click(screen.getByLabelText('Sort by'))

    const sortList = screen.getByRole('list', { name: 'Sort by' })
    const stateBtn = within(sortList).getByText('State')
    expect(stateBtn).toHaveAttribute('aria-current', 'true')
  })

  it('sort options do not include None', async () => {
    const user = userEvent.setup()
    renderControls()

    await user.click(screen.getByLabelText('Sort by'))

    const sortList = screen.getByRole('list', { name: 'Sort by' })
    expect(within(sortList).queryByText('None')).not.toBeInTheDocument()
  })

  it('renders page group option', async () => {
    const user = userEvent.setup()
    const onGroupByChange = vi.fn()
    renderControls({ onGroupByChange })

    await user.click(screen.getByLabelText('Group by'))

    const groupList = screen.getByRole('list', { name: 'Group by' })
    expect(within(groupList).getByText('Page')).toBeInTheDocument()

    await user.click(within(groupList).getByText('Page'))
    expect(onGroupByChange).toHaveBeenCalledWith('page')
  })

  it('renders page sort option', async () => {
    const user = userEvent.setup()
    const onSortByChange = vi.fn()
    renderControls({ onSortByChange })

    await user.click(screen.getByLabelText('Sort by'))

    const sortList = screen.getByRole('list', { name: 'Sort by' })
    expect(within(sortList).getByText('Page')).toBeInTheDocument()

    await user.click(within(sortList).getByText('Page'))
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
