import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

vi.mock('@/components/ui/select', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react')
  const Ctx = React.createContext({})

  function Select({
    value,
    onValueChange,
    children,
  }: {
    value?: string
    onValueChange?: (v: string) => void
    children?: React.ReactNode
  }) {
    const triggerPropsRef = React.useRef({})
    return React.createElement(
      Ctx.Provider,
      { value: { value, onValueChange, triggerPropsRef } },
      children,
    )
  }

  function SelectTrigger({ size, className, ...props }: Record<string, unknown>) {
    const ctx = React.useContext(Ctx)
    Object.assign(ctx.triggerPropsRef.current, { size, className, ...props })
    return null
  }

  function SelectValue() {
    return null
  }

  function SelectContent({ children }: { children?: React.ReactNode }) {
    const ctx = React.useContext(Ctx)
    const tp = ctx.triggerPropsRef.current
    return React.createElement(
      'select',
      {
        value: ctx.value ?? '',
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => ctx.onValueChange?.(e.target.value),
        'aria-label': tp['aria-label'],
        id: tp.id,
      },
      children,
    )
  }

  function SelectItem({ value, children }: { value: string; children?: React.ReactNode }) {
    return React.createElement('option', { value }, children)
  }

  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

import { PropertyValuePicker } from '../PropertyValuePicker'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PropertyValuePicker', () => {
  const defaultProps = {
    selected: [] as string[],
    onChange: vi.fn(),
  }

  function renderPicker(overrides?: Partial<typeof defaultProps>) {
    const props = { ...defaultProps, ...overrides }
    return render(<PropertyValuePicker {...props} />)
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------
  it('renders property key select and value input', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'list_property_keys') return ['project', 'effort']
      return undefined
    })

    renderPicker()
    expect(screen.getByLabelText('Property key')).toBeInTheDocument()
    expect(screen.getByLabelText('Value (optional)')).toBeInTheDocument()
  })

  it('initializes key and value from selected prop with colon format', () => {
    vi.mocked(invoke).mockResolvedValue([])
    renderPicker({ selected: ['project:alpha'] })

    expect(screen.getByLabelText('Value (optional)')).toHaveValue('alpha')
  })

  it('initializes key only when no colon in selected value', () => {
    vi.mocked(invoke).mockResolvedValue([])
    renderPicker({ selected: ['custom_key'] })

    expect(screen.getByLabelText('Value (optional)')).toHaveValue('')
  })

  // -----------------------------------------------------------------------
  // Interaction
  // -----------------------------------------------------------------------
  it('calls onChange when property value is typed', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'list_property_keys') return ['project']
      return undefined
    })

    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker({ selected: ['project'], onChange })

    await user.type(screen.getByLabelText('Value (optional)'), 'beta')
    expect(onChange).toHaveBeenCalled()
  })

  it('calls onChange with key:value format', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'list_property_keys') return ['project']
      return undefined
    })

    const onChange = vi.fn()
    renderPicker({ selected: ['project:alpha'], onChange })

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]
    expect(lastCall?.[0]).toEqual(['project:alpha'])
  })

  it('calls onChange with empty array when no key selected', () => {
    vi.mocked(invoke).mockResolvedValue([])
    const onChange = vi.fn()
    renderPicker({ onChange })

    expect(onChange).toHaveBeenCalledWith([])
  })

  // -----------------------------------------------------------------------
  // A11y
  // -----------------------------------------------------------------------
  it('has no a11y violations', async () => {
    vi.mocked(invoke).mockResolvedValue([])
    const { container } = renderPicker()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with pre-filled values', async () => {
    vi.mocked(invoke).mockResolvedValue(['project'])
    const { container } = renderPicker({ selected: ['project:alpha'] })
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // -----------------------------------------------------------------------
  // Error-path tests (mockRejectedValueOnce)
  // -----------------------------------------------------------------------
  it('listPropertyKeys rejection falls back to empty property key list', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('DB read error'))

    renderPicker()

    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('list_property_keys')
    })

    // The select should only contain the placeholder option, no property keys
    const select = screen.getByLabelText('Property key')
    const options = select.querySelectorAll('option')
    expect(options).toHaveLength(1) // only the "__none__" placeholder
  })

  it('listPropertyKeys rejection still renders labels and input', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('network timeout'))

    renderPicker()

    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalled()
    })

    expect(screen.getByLabelText('Property key')).toBeInTheDocument()
    expect(screen.getByLabelText('Value (optional)')).toBeInTheDocument()
  })

  it('listPropertyKeys rejection does not prevent value input interaction', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('backend unavailable'))

    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker({ selected: ['effort'], onChange })

    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalled()
    })

    // User can still type in the value input even though property keys failed to load
    await user.type(screen.getByLabelText('Value (optional)'), '3h')
    expect(onChange).toHaveBeenCalledWith(['effort:3h'])
  })

  it('has no a11y violations when listPropertyKeys rejects', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('a11y error path'))

    const { container } = renderPicker()

    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalled()
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
