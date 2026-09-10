import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

import { mockInvokeCommands, type TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import { PropertyValuePicker } from '@/components/properties/PropertyValuePicker'
import { _resetPropertyKeysCacheForTest } from '@/hooks/usePropertyKeysCache'

const mockedInvoke = vi.mocked(invoke)

function stubInvoke(handlers: Readonly<TypedInvokeHandlers>): void {
  mockedInvoke.mockImplementation(mockInvokeCommands(handlers))
}

beforeEach(() => {
  vi.clearAllMocks()
  // Cache is module-level, so flush between tests so each
  // case observes its own `invoke('list_property_keys')` fetch.
  _resetPropertyKeysCacheForTest()
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
    stubInvoke({ list_property_keys: () => ['project', 'effort'] })

    renderPicker()
    expect(screen.getByLabelText('Property key')).toBeInTheDocument()
    expect(screen.getByLabelText('Value (optional)')).toBeInTheDocument()
  })

  it('initializes key and value from selected prop with colon format', () => {
    stubInvoke({ list_property_keys: () => [] })
    renderPicker({ selected: ['project:alpha'] })

    expect(screen.getByLabelText('Value (optional)')).toHaveValue('alpha')
  })

  it('initializes key only when no colon in selected value', () => {
    stubInvoke({ list_property_keys: () => [] })
    renderPicker({ selected: ['custom_key'] })

    expect(screen.getByLabelText('Value (optional)')).toHaveValue('')
  })

  // -----------------------------------------------------------------------
  // Interaction
  // -----------------------------------------------------------------------
  it('calls onChange when property value is typed', async () => {
    stubInvoke({ list_property_keys: () => ['project'] })

    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker({ selected: ['project'], onChange })

    await user.type(screen.getByLabelText('Value (optional)'), 'beta')
    expect(onChange).toHaveBeenCalled()
  })

  it('calls onChange with key:value format', async () => {
    stubInvoke({ list_property_keys: () => ['project'] })

    const onChange = vi.fn()
    renderPicker({ selected: ['project:alpha'], onChange })

    const lastCall = onChange.mock.calls.at(-1)
    expect(lastCall?.[0]).toEqual(['project:alpha'])
  })

  it('calls onChange with empty array when no key selected', () => {
    stubInvoke({ list_property_keys: () => [] })
    const onChange = vi.fn()
    renderPicker({ onChange })

    expect(onChange).toHaveBeenCalledWith([])
  })

  // -----------------------------------------------------------------------
  // A11y
  // -----------------------------------------------------------------------
  it('has no a11y violations', async () => {
    stubInvoke({ list_property_keys: () => [] })
    const { container } = renderPicker()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with pre-filled values', async () => {
    stubInvoke({ list_property_keys: () => ['project'] })
    const { container } = renderPicker({ selected: ['project:alpha'] })
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // -----------------------------------------------------------------------
  // Error-path tests: `mockInvokeCommands` takes a handler that rejects, so
  // the rejection path is typed like every other stub here.
  // -----------------------------------------------------------------------
  it('listPropertyKeys rejection falls back to empty property key list', async () => {
    stubInvoke({
      list_property_keys: () => Promise.reject(new Error('DB read error')),
    })

    renderPicker()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('list_property_keys')
    })

    // The select should only contain the placeholder option, no property keys
    const select = screen.getByLabelText('Property key')
    const options = select.querySelectorAll('option')
    expect(options).toHaveLength(1) // only the "__none__" placeholder
  })

  it('listPropertyKeys rejection still renders labels and input', async () => {
    stubInvoke({
      list_property_keys: () => Promise.reject(new Error('network timeout')),
    })

    renderPicker()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalled()
    })

    expect(screen.getByLabelText('Property key')).toBeInTheDocument()
    expect(screen.getByLabelText('Value (optional)')).toBeInTheDocument()
  })

  it('listPropertyKeys rejection does not prevent value input interaction', async () => {
    stubInvoke({
      list_property_keys: () => Promise.reject(new Error('backend unavailable')),
    })

    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker({ selected: ['effort'], onChange })

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalled()
    })

    // User can still type in the value input even though property keys failed to load
    await user.type(screen.getByLabelText('Value (optional)'), '3h')
    expect(onChange).toHaveBeenCalledWith(['effort:3h'])
  })

  it('has no a11y violations when listPropertyKeys rejects', async () => {
    stubInvoke({
      list_property_keys: () => Promise.reject(new Error('a11y error path')),
    })

    const { container } = renderPicker()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalled()
    })

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
