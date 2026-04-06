/**
 * Tests for TagValuePicker component.
 *
 * Validates:
 *  - Renders combobox input with accessible label
 *  - Searches tags via listTagsByPrefix on input change
 *  - Shows matching tags in dropdown
 *  - Calls onChange with tag name on selection
 *  - Clears selection when typing
 *  - Keyboard navigation (ArrowDown/Up, Enter, Escape)
 *  - a11y compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { TagValuePicker } from '../TagValuePicker'

const mockedInvoke = vi.mocked(invoke)

const mockTags = [
  { tag_id: '01TAGWORKAAAAAAAAAAAAAAAA', name: 'work', usage_count: 5, updated_at: '2026-01-01' },
  {
    tag_id: '01TAGWORKOUTAAAAAAAAAAAA',
    name: 'workout',
    usage_count: 2,
    updated_at: '2026-01-01',
  },
  {
    tag_id: '01TAGPERSONALAAAAAAAAAA',
    name: 'personal',
    usage_count: 3,
    updated_at: '2026-01-01',
  },
]

function mockTagSearch() {
  mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'list_tags_by_prefix') {
      const a = args as Record<string, unknown>
      const prefix = ((a.prefix as string) ?? '').toLowerCase()
      return mockTags.filter((t) => t.name.toLowerCase().startsWith(prefix))
    }
    return []
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvoke.mockResolvedValue([])
})

describe('TagValuePicker', () => {
  const defaultProps = {
    selected: [] as string[],
    onChange: vi.fn(),
  }

  function renderPicker(overrides?: Partial<typeof defaultProps>) {
    const props = { ...defaultProps, ...overrides }
    return render(<TagValuePicker {...props} />)
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------
  it('renders a combobox input with accessible label', () => {
    renderPicker()
    const input = screen.getByLabelText('Tag name')
    expect(input).toBeInTheDocument()
    expect(input).toHaveAttribute('role', 'combobox')
  })

  it('initializes input with first selected value', () => {
    renderPicker({ selected: ['my-tag'] })
    expect(screen.getByLabelText('Tag name')).toHaveValue('my-tag')
  })

  it('initializes empty when no selected values', () => {
    renderPicker()
    expect(screen.getByLabelText('Tag name')).toHaveValue('')
  })

  it('does not show dropdown initially', () => {
    renderPicker()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // Search & selection
  // -----------------------------------------------------------------------
  it('shows matching tags after typing', async () => {
    mockTagSearch()
    const user = userEvent.setup()
    renderPicker()

    await user.type(screen.getByLabelText('Tag name'), 'wor')

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveTextContent('work')
    expect(options[1]).toHaveTextContent('workout')
  })

  it('calls onChange with tag name on selection', async () => {
    mockTagSearch()
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker({ onChange })

    await user.type(screen.getByLabelText('Tag name'), 'wor')

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    await user.click(screen.getAllByRole('option')[0] as HTMLElement)

    expect(onChange).toHaveBeenLastCalledWith(['work'])
  })

  it('hides dropdown after selection', async () => {
    mockTagSearch()
    const user = userEvent.setup()
    renderPicker()

    await user.type(screen.getByLabelText('Tag name'), 'wor')

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    await user.click(screen.getAllByRole('option')[0] as HTMLElement)

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('updates input value to selected tag name', async () => {
    mockTagSearch()
    const user = userEvent.setup()
    renderPicker()

    await user.type(screen.getByLabelText('Tag name'), 'wor')

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    await user.click(screen.getAllByRole('option')[0] as HTMLElement)

    expect(screen.getByLabelText('Tag name')).toHaveValue('work')
  })

  it('clears selection when typing after selection', async () => {
    mockTagSearch()
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker({ onChange })

    // Select a tag
    await user.type(screen.getByLabelText('Tag name'), 'wor')
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })
    await user.click(screen.getAllByRole('option')[0] as HTMLElement)
    expect(onChange).toHaveBeenLastCalledWith(['work'])

    // Type more — clears selection
    await user.type(screen.getByLabelText('Tag name'), 'x')
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('shows no dropdown when input is cleared', async () => {
    const user = userEvent.setup()
    renderPicker({ selected: ['tag'] })

    await user.clear(screen.getByLabelText('Tag name'))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('handles search errors gracefully', async () => {
    mockedInvoke.mockRejectedValue(new Error('Network error'))
    const user = userEvent.setup()
    renderPicker()

    await user.type(screen.getByLabelText('Tag name'), 'wor')

    // Should not crash, no dropdown shown
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })
  })

  it('displays usage count next to tag names', async () => {
    mockTagSearch()
    const user = userEvent.setup()
    renderPicker()

    await user.type(screen.getByLabelText('Tag name'), 'wor')

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    expect(screen.getByText('(5)')).toBeInTheDocument()
    expect(screen.getByText('(2)')).toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // Keyboard navigation
  // -----------------------------------------------------------------------
  it('navigates options with ArrowDown/ArrowUp', async () => {
    mockTagSearch()
    const user = userEvent.setup()
    renderPicker()

    const input = screen.getByLabelText('Tag name')
    await user.type(input, 'wor')

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'false')

    await user.keyboard('{ArrowUp}')
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('selects option with Enter key', async () => {
    mockTagSearch()
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker({ onChange })

    const input = screen.getByLabelText('Tag name')
    await user.type(input, 'wor')

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')

    expect(onChange).toHaveBeenLastCalledWith(['work'])
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('closes dropdown with Escape key', async () => {
    mockTagSearch()
    const user = userEvent.setup()
    renderPicker()

    await user.type(screen.getByLabelText('Tag name'), 'wor')

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  // -----------------------------------------------------------------------
  // A11y
  // -----------------------------------------------------------------------
  it('has no a11y violations', async () => {
    const { container } = renderPicker()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with pre-filled value', async () => {
    const { container } = renderPicker({ selected: ['existing-tag'] })
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with dropdown open', async () => {
    mockTagSearch()
    const user = userEvent.setup()
    const { container } = renderPicker()

    await user.type(screen.getByLabelText('Tag name'), 'wor')

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('sets aria-expanded based on dropdown state', async () => {
    mockTagSearch()
    const user = userEvent.setup()
    renderPicker()

    const input = screen.getByLabelText('Tag name')
    expect(input).toHaveAttribute('aria-expanded', 'false')

    await user.type(input, 'wor')

    await waitFor(() => {
      expect(input).toHaveAttribute('aria-expanded', 'true')
    })
  })
})
