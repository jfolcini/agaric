import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

const mockSetProperty = vi.fn().mockResolvedValue({})
vi.mock('../../lib/tauri', () => ({
  setProperty: (...args: unknown[]) => mockSetProperty(...args),
}))

const mockToastError = vi.fn()
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}))

import { BlockPropertyEditor, type BlockPropertyEditorProps } from '../BlockPropertyEditor'

function makeProps(overrides: Partial<BlockPropertyEditorProps> = {}): BlockPropertyEditorProps {
  return {
    blockId: 'BLOCK_1',
    editingProp: null,
    setEditingProp: vi.fn(),
    editingKey: null,
    setEditingKey: vi.fn(),
    selectOptions: null,
    isRefProp: false,
    refPages: [],
    refSearch: '',
    setRefSearch: vi.fn(),
    ...overrides,
  }
}

describe('BlockPropertyEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing when editingProp and editingKey are null', () => {
    const { container } = render(<BlockPropertyEditor {...makeProps()} />)
    expect(container.querySelector('[role="dialog"]')).not.toBeInTheDocument()
    expect(container.querySelector('.property-key-editor')).not.toBeInTheDocument()
  })

  it('renders text input when editingProp is set without selectOptions', () => {
    render(<BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    const input = screen.getByRole('textbox')
    expect(input).toBeInTheDocument()
    expect(input).toHaveValue('2h')
  })

  it('saves value on blur when text has changed', async () => {
    const setEditingProp = vi.fn()
    render(
      <BlockPropertyEditor
        {...makeProps({
          editingProp: { key: 'effort', value: '2h' },
          setEditingProp,
        })}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '4h' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(mockSetProperty).toHaveBeenCalledWith({
        blockId: 'BLOCK_1',
        key: 'effort',
        valueText: '4h',
      })
    })
    await waitFor(() => {
      expect(setEditingProp).toHaveBeenCalledWith(null)
    })
  })

  it('does not save when text has not changed', async () => {
    const setEditingProp = vi.fn()
    render(
      <BlockPropertyEditor
        {...makeProps({
          editingProp: { key: 'effort', value: '2h' },
          setEditingProp,
        })}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.blur(input)

    await waitFor(() => {
      expect(setEditingProp).toHaveBeenCalledWith(null)
    })
    expect(mockSetProperty).not.toHaveBeenCalled()
  })

  it('closes on Escape key', () => {
    const setEditingProp = vi.fn()
    render(
      <BlockPropertyEditor
        {...makeProps({
          editingProp: { key: 'effort', value: '2h' },
          setEditingProp,
        })}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(setEditingProp).toHaveBeenCalledWith(null)
  })

  it('blurs input on Enter key', () => {
    const setEditingProp = vi.fn()
    render(
      <BlockPropertyEditor
        {...makeProps({
          editingProp: { key: 'effort', value: '2h' },
          setEditingProp,
        })}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter' })
    // blur triggers setEditingProp(null)
    expect(setEditingProp).toHaveBeenCalledWith(null)
  })

  it('shows toast on save error', async () => {
    mockSetProperty.mockRejectedValueOnce(new Error('fail'))
    const setEditingProp = vi.fn()
    render(
      <BlockPropertyEditor
        {...makeProps({
          editingProp: { key: 'effort', value: '2h' },
          setEditingProp,
        })}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'new' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled()
    })
  })

  describe('select options dropdown', () => {
    it('renders select options when available', () => {
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'status', value: 'open' },
            selectOptions: ['open', 'closed', 'review'],
          })}
        />,
      )
      expect(screen.getByTestId('select-options-dropdown')).toBeInTheDocument()
      expect(screen.getByText('open')).toBeInTheDocument()
      expect(screen.getByText('closed')).toBeInTheDocument()
      expect(screen.getByText('review')).toBeInTheDocument()
    })

    it('highlights current value', () => {
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'status', value: 'open' },
            selectOptions: ['open', 'closed'],
          })}
        />,
      )
      const openBtn = screen.getByText('open')
      expect(openBtn.className).toContain('font-medium')
    })

    it('calls setProperty on option click', async () => {
      const user = userEvent.setup()
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'status', value: 'open' },
            selectOptions: ['open', 'closed'],
            setEditingProp,
          })}
        />,
      )
      await user.click(screen.getByText('closed'))

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith({
          blockId: 'BLOCK_1',
          key: 'status',
          valueText: 'closed',
        })
      })
      expect(setEditingProp).toHaveBeenCalledWith(null)
    })
  })

  describe('ref picker', () => {
    const pages = [
      {
        id: 'P1',
        content: 'Page Alpha',
        block_type: 'page',
        parent_id: null,
        position: null,
        deleted_at: null,
        is_conflict: false,
        conflict_type: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
      },
      {
        id: 'P2',
        content: 'Page Beta',
        block_type: 'page',
        parent_id: null,
        position: null,
        deleted_at: null,
        is_conflict: false,
        conflict_type: null,
        todo_state: null,
        priority: null,
        due_date: null,
        scheduled_date: null,
      },
    ]

    it('renders ref picker when isRefProp is true', () => {
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'ref', value: 'P1' },
            isRefProp: true,
            refPages: pages,
          })}
        />,
      )
      expect(screen.getByTestId('ref-picker')).toBeInTheDocument()
      expect(screen.getByTestId('ref-search-input')).toBeInTheDocument()
      expect(screen.getByText('Page Alpha')).toBeInTheDocument()
      expect(screen.getByText('Page Beta')).toBeInTheDocument()
    })

    it('filters pages by search text', () => {
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'ref', value: '' },
            isRefProp: true,
            refPages: pages,
            refSearch: 'alpha',
          })}
        />,
      )
      expect(screen.getByText('Page Alpha')).toBeInTheDocument()
      expect(screen.queryByText('Page Beta')).not.toBeInTheDocument()
    })

    it('shows no results message when filtered list is empty', () => {
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'ref', value: '' },
            isRefProp: true,
            refPages: pages,
            refSearch: 'zzzzz',
          })}
        />,
      )
      expect(screen.getByTestId('ref-no-results')).toBeInTheDocument()
    })

    it('calls setRefSearch on input change', async () => {
      const user = userEvent.setup()
      const setRefSearch = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'ref', value: '' },
            isRefProp: true,
            refPages: pages,
            setRefSearch,
          })}
        />,
      )
      await user.type(screen.getByTestId('ref-search-input'), 'a')
      expect(setRefSearch).toHaveBeenCalled()
    })

    it('calls setProperty with valueRef on page selection', async () => {
      const user = userEvent.setup()
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'ref', value: '' },
            isRefProp: true,
            refPages: pages,
            setEditingProp,
          })}
        />,
      )
      await user.click(screen.getByText('Page Beta'))

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith({
          blockId: 'BLOCK_1',
          key: 'ref',
          valueRef: 'P2',
        })
      })
      expect(setEditingProp).toHaveBeenCalledWith(null)
    })
  })

  describe('key rename popover', () => {
    it('renders key rename input when editingKey is set', () => {
      const { container } = render(
        <BlockPropertyEditor {...makeProps({ editingKey: { oldKey: 'effort', value: '2h' } })} />,
      )
      expect(container.querySelector('.property-key-editor')).toBeInTheDocument()
      const input = container.querySelector('.property-key-editor input') as HTMLInputElement
      expect(input).toHaveValue('effort')
    })

    it('renames key on blur with new name', async () => {
      const setEditingKey = vi.fn()
      const { container } = render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'effort', value: '2h' },
            setEditingKey,
          })}
        />,
      )
      const input = container.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'time' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith({
          blockId: 'BLOCK_1',
          key: 'time',
          valueText: '2h',
        })
      })
      await waitFor(() => {
        expect(mockSetProperty).toHaveBeenCalledWith({
          blockId: 'BLOCK_1',
          key: 'effort',
          valueText: null,
        })
      })
      expect(setEditingKey).toHaveBeenCalledWith(null)
    })

    it('does not rename when key has not changed', async () => {
      const setEditingKey = vi.fn()
      const { container } = render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'effort', value: '2h' },
            setEditingKey,
          })}
        />,
      )
      const input = container.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.blur(input)

      await waitFor(() => {
        expect(setEditingKey).toHaveBeenCalledWith(null)
      })
      expect(mockSetProperty).not.toHaveBeenCalled()
    })

    it('shows toast on rename error', async () => {
      mockSetProperty.mockRejectedValueOnce(new Error('fail'))
      const setEditingKey = vi.fn()
      const { container } = render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'effort', value: '2h' },
            setEditingKey,
          })}
        />,
      )
      const input = container.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'time' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalled()
      })
    })

    it('closes on Escape key', () => {
      const setEditingKey = vi.fn()
      const { container } = render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'effort', value: '2h' },
            setEditingKey,
          })}
        />,
      )
      const input = container.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(setEditingKey).toHaveBeenCalledWith(null)
    })
  })

  it('has no a11y violations (text input mode)', async () => {
    const { container } = render(
      <BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />,
    )
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations (select mode)', async () => {
    const { container } = render(
      <BlockPropertyEditor
        {...makeProps({
          editingProp: { key: 'status', value: 'open' },
          selectOptions: ['open', 'closed'],
        })}
      />,
    )
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations (ref picker mode)', async () => {
    const { container } = render(
      <BlockPropertyEditor
        {...makeProps({
          editingProp: { key: 'ref', value: '' },
          isRefProp: true,
          refPages: [],
        })}
      />,
    )
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
