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

// Mock @floating-ui/dom — JSDOM has no layout engine, so mirror the pattern
// used by suggestion-renderer.test.ts / LinkPreviewTooltip.test.tsx. The
// `autoUpdate` mock invokes the update callback once on registration and
// re-invokes it on `window` `resize`, returning a cleanup fn — that is the
// minimal contract callers depend on.
vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn().mockResolvedValue({ x: 42, y: 84 }),
  autoUpdate: vi.fn((_anchor: Element, _floating: Element, update: () => void) => {
    update()
    const handler = () => update()
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }),
  flip: vi.fn(() => ({})),
  shift: vi.fn(() => ({})),
  offset: vi.fn(() => ({})),
}))

import { autoUpdate, computePosition } from '@floating-ui/dom'
import { logger } from '../../lib/logger'
import { BlockPropertyEditor, type BlockPropertyEditorProps } from '../BlockPropertyEditor'

// Make rAF synchronous so the deferred outside-click registration runs
// immediately within the test's microtask flush.
beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
})

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
    render(<BlockPropertyEditor {...makeProps()} />)
    expect(document.querySelector('[role="dialog"]')).not.toBeInTheDocument()
    expect(document.querySelector('.property-key-editor')).not.toBeInTheDocument()
    expect(document.querySelector('[data-editor-portal]')).not.toBeInTheDocument()
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

  // ── MAINT-103: portal + floating-ui ─────────────────────────────────────
  describe('portal rendering', () => {
    it('renders the value popup as a portal in document.body, not inside the trigger tree', () => {
      const { container } = render(
        <BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />,
      )
      const popup = document.querySelector('[role="dialog"]')
      expect(popup).toBeInTheDocument()
      expect(popup).toHaveAttribute('data-editor-portal')
      // The popup must NOT live inside the rendered React subtree — that's
      // the whole point of MAINT-103 (escapes overflow:hidden ancestors).
      expect(container.contains(popup)).toBe(false)
      expect(popup?.parentElement).toBe(document.body)
    })

    it('renders the key-rename popup as a portal with property-key-editor + data-editor-portal', () => {
      const { container } = render(
        <BlockPropertyEditor {...makeProps({ editingKey: { oldKey: 'effort', value: '2h' } })} />,
      )
      const popup = document.querySelector('.property-key-editor')
      expect(popup).toBeInTheDocument()
      expect(popup).toHaveAttribute('data-editor-portal')
      expect(container.contains(popup)).toBe(false)
      expect(popup?.parentElement).toBe(document.body)
    })

    it('calls computePosition + autoUpdate when the value popup mounts', async () => {
      render(
        <BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />,
      )
      await waitFor(() => {
        expect(autoUpdate).toHaveBeenCalled()
        expect(computePosition).toHaveBeenCalled()
      })
    })

    it('recomputes position on window resize', async () => {
      render(
        <BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />,
      )
      await waitFor(() => {
        expect(computePosition).toHaveBeenCalled()
      })
      vi.mocked(computePosition).mockClear()
      fireEvent(window, new Event('resize'))
      await waitFor(() => {
        expect(computePosition).toHaveBeenCalled()
      })
    })

    it('cleans up the portal when editingProp returns to null', () => {
      const { rerender } = render(
        <BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />,
      )
      expect(document.querySelector('[data-editor-portal]')).toBeInTheDocument()
      rerender(<BlockPropertyEditor {...makeProps({ editingProp: null })} />)
      expect(document.querySelector('[data-editor-portal]')).not.toBeInTheDocument()
    })

    it('logs a warning when computePosition rejects (stale state lifecycle)', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const err = new Error('computePosition boom')
      vi.mocked(computePosition).mockRejectedValueOnce(err)

      render(
        <BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />,
      )

      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith(
          'BlockPropertyEditor',
          'value popup computePosition failed',
          { key: 'effort' },
          err,
        )
      })
      warnSpy.mockRestore()
    })

    it('logs a warning when the anchor is detached while the popup is open', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

      render(
        <BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />,
      )
      await waitFor(() => {
        expect(autoUpdate).toHaveBeenCalled()
      })

      // Pull the update callback handed to autoUpdate, simulate the anchor
      // being torn out of the document tree, then invoke it manually — this
      // is the desync `update()` guards against (mirrors
      // `suggestion-renderer.ts:onUpdate`). We override `isConnected` rather
      // than calling `.remove()` so React's reconciliation can still unmount
      // the element cleanly during test teardown.
      const calls = vi.mocked(autoUpdate).mock.calls
      const lastCall = calls[calls.length - 1]
      expect(lastCall).toBeDefined()
      const update = lastCall?.[2] as () => void
      const anchor = document.querySelector(
        '[data-testid="block-property-editor-anchor"]',
      ) as HTMLElement | null
      expect(anchor).toBeInTheDocument()
      Object.defineProperty(anchor, 'isConnected', { configurable: true, get: () => false })

      warnSpy.mockClear()
      update()

      expect(warnSpy).toHaveBeenCalledWith(
        'BlockPropertyEditor',
        'anchor unmounted while value popup open',
        expect.objectContaining({ key: 'effort' }),
      )
      warnSpy.mockRestore()
    })

    it('dismisses the value popup on outside click', async () => {
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'effort', value: '2h' },
            setEditingProp,
          })}
        />,
      )

      // Wait for the deferred (rAF) registration of the outside-click handler.
      await waitFor(() => {
        expect(document.querySelector('[role="dialog"]')).toBeInTheDocument()
      })

      // Click on document.body (outside both the popup and the anchor).
      fireEvent.pointerDown(document.body)
      expect(setEditingProp).toHaveBeenCalledWith(null)
    })

    it('does not dismiss on click inside the popup', async () => {
      const setEditingProp = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'effort', value: '2h' },
            setEditingProp,
          })}
        />,
      )
      await waitFor(() => {
        expect(document.querySelector('[role="dialog"]')).toBeInTheDocument()
      })
      const popup = document.querySelector('[role="dialog"]') as HTMLElement
      fireEvent.pointerDown(popup)
      expect(setEditingProp).not.toHaveBeenCalled()
    })

    it('focuses the input on mount', async () => {
      render(
        <BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />,
      )
      const input = await screen.findByRole('textbox')
      expect(input).toHaveFocus()
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
        page_id: null,
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
        page_id: null,
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

    // UX-248 — Unicode-aware fold via `matchesSearchFolded`.
    it('ref picker matches Turkish İstanbul when query is lowercase istanbul', () => {
      const unicodePages = [
        {
          id: 'P1',
          content: 'İstanbul trip',
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
          page_id: null,
        },
        {
          id: 'P2',
          content: 'Ankara plans',
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
          page_id: null,
        },
      ]
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingProp: { key: 'ref', value: '' },
            isRefProp: true,
            refPages: unicodePages,
            refSearch: 'istanbul',
          })}
        />,
      )
      expect(screen.getByText('İstanbul trip')).toBeInTheDocument()
      expect(screen.queryByText('Ankara plans')).not.toBeInTheDocument()
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
      render(
        <BlockPropertyEditor {...makeProps({ editingKey: { oldKey: 'effort', value: '2h' } })} />,
      )
      const popup = document.querySelector('.property-key-editor')
      expect(popup).toBeInTheDocument()
      const input = popup?.querySelector('input') as HTMLInputElement
      expect(input).toHaveValue('effort')
    })

    it('renames key on blur with new name', async () => {
      const setEditingKey = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'effort', value: '2h' },
            setEditingKey,
          })}
        />,
      )
      const input = document.querySelector('.property-key-editor input') as HTMLInputElement
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
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'effort', value: '2h' },
            setEditingKey,
          })}
        />,
      )
      const input = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.blur(input)

      await waitFor(() => {
        expect(setEditingKey).toHaveBeenCalledWith(null)
      })
      expect(mockSetProperty).not.toHaveBeenCalled()
    })

    it('shows toast on rename error', async () => {
      mockSetProperty.mockRejectedValueOnce(new Error('fail'))
      const setEditingKey = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'effort', value: '2h' },
            setEditingKey,
          })}
        />,
      )
      const input = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'time' } })
      fireEvent.blur(input)

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Failed to rename property')
      })
    })

    it('closes on Escape key', () => {
      const setEditingKey = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'effort', value: '2h' },
            setEditingKey,
          })}
        />,
      )
      const input = document.querySelector('.property-key-editor input') as HTMLInputElement
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(setEditingKey).toHaveBeenCalledWith(null)
    })

    it('dismisses on outside click', async () => {
      const setEditingKey = vi.fn()
      render(
        <BlockPropertyEditor
          {...makeProps({
            editingKey: { oldKey: 'effort', value: '2h' },
            setEditingKey,
          })}
        />,
      )
      await waitFor(() => {
        expect(document.querySelector('.property-key-editor')).toBeInTheDocument()
      })
      fireEvent.pointerDown(document.body)
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

  it('has no a11y violations on the portal contents (text input mode)', async () => {
    render(<BlockPropertyEditor {...makeProps({ editingProp: { key: 'effort', value: '2h' } })} />)
    const portal = document.querySelector('[data-editor-portal]') as HTMLElement
    expect(portal).toBeInTheDocument()
    await waitFor(async () => {
      const results = await axe(portal)
      expect(results).toHaveNoViolations()
    })
  })
})
