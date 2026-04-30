/**
 * Tests for useBlockActions / BlockActionsProvider.
 *
 * Validates:
 *  - Empty fallback when used outside a provider (referentially stable)
 *  - Provider publishes the action bag to descendants
 *  - Multiple consumers see the same value identity
 *  - Truthiness checks gate optional callbacks correctly
 */

import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type BlockActions, BlockActionsProvider, useBlockActions } from '../useBlockActions'

function Probe({ onResult }: { onResult: (actions: BlockActions) => void }) {
  const actions = useBlockActions()
  onResult(actions)
  return null
}

describe('useBlockActions', () => {
  it('returns an empty object outside a provider', () => {
    const observed: BlockActions[] = []
    render(<Probe onResult={(a) => observed.push(a)} />)
    expect(observed).toHaveLength(1)
    expect(Object.keys(observed[0] ?? {})).toEqual([])
    expect(observed[0]?.onDelete).toBeUndefined()
  })

  it('returns a referentially stable fallback across renders', () => {
    const observed: BlockActions[] = []
    const { rerender } = render(<Probe onResult={(a) => observed.push(a)} />)
    rerender(<Probe onResult={(a) => observed.push(a)} />)
    expect(observed).toHaveLength(2)
    // Same identity → stable Object.freeze({}) sentinel
    expect(observed[0]).toBe(observed[1])
  })

  it('publishes the provided action bag to descendants', () => {
    const onDelete = vi.fn()
    const onZoomIn = vi.fn()
    const observed: BlockActions[] = []

    render(
      <BlockActionsProvider value={{ onDelete, onZoomIn }}>
        <Probe onResult={(a) => observed.push(a)} />
      </BlockActionsProvider>,
    )

    expect(observed).toHaveLength(1)
    const actions = observed[0]
    expect(actions?.onDelete).toBe(onDelete)
    expect(actions?.onZoomIn).toBe(onZoomIn)
    // Other entries remain undefined.
    expect(actions?.onIndent).toBeUndefined()
  })

  it('multiple consumers see the same published reference', () => {
    const value = { onIndent: vi.fn() }
    const observed: BlockActions[] = []

    render(
      <BlockActionsProvider value={value}>
        <Probe onResult={(a) => observed.push(a)} />
        <Probe onResult={(a) => observed.push(a)} />
      </BlockActionsProvider>,
    )

    expect(observed).toHaveLength(2)
    expect(observed[0]).toBe(observed[1])
    expect(observed[0]?.onIndent).toBe(value.onIndent)
  })

  it('lets callers gate optional callbacks via truthiness', () => {
    const onMoveUp = vi.fn()
    const observed: BlockActions[] = []

    render(
      <BlockActionsProvider value={{ onMoveUp }}>
        <Probe onResult={(a) => observed.push(a)} />
      </BlockActionsProvider>,
    )

    expect(observed).toHaveLength(1)
    const actions = observed[0]
    expect(actions?.onMoveUp ? 'wired' : 'not-wired').toBe('wired')
    expect(actions?.onMoveDown ? 'wired' : 'not-wired').toBe('not-wired')
  })
})
