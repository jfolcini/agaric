/**
 * Tests for CalloutTypeSelector (#215) — the toolbar callout variant picker.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { CalloutTypeSelector } from '@/components/editor-toolbar/CalloutTypeSelector'

// #2222: `dispatchBlockEvent` no longer broadcasts a legacy document
// CustomEvent (the broadcast had zero production listeners; the focus-keyed
// command bus is the only delivery path). These tests observe producer
// dispatches as document events, so shim the bus back onto `document`: the
// existing assertions keep pinning the producer contract — typed
// BLOCK_EVENTS key mapped to the expected event name, plus the detail
// payload — and fail if a producer stops dispatching or changes its detail.
vi.mock('@/lib/block-command-bus', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/block-command-bus')>('@/lib/block-command-bus')
  const { BLOCK_EVENTS } =
    await vi.importActual<typeof import('@/lib/block-event-names')>('@/lib/block-event-names')
  return {
    ...actual,
    dispatchBlockCommand: (name: keyof typeof BLOCK_EVENTS, detail?: unknown) => {
      document.dispatchEvent(new CustomEvent(BLOCK_EVENTS[name], { detail }))
    },
  }
})

const TYPES = ['info', 'warning', 'tip', 'error', 'note'] as const

describe('CalloutTypeSelector', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders a button for every callout variant', () => {
    render(<CalloutTypeSelector onClose={vi.fn()} />)
    for (const type of TYPES) {
      expect(screen.getByTestId(`callout-type-${type}`)).toBeInTheDocument()
    }
  })

  it.each(TYPES)('selecting %s dispatches insert-callout with that type and closes', (type) => {
    const spy = vi.fn()
    document.addEventListener('insert-callout', spy as EventListener)
    const onClose = vi.fn()
    render(<CalloutTypeSelector onClose={onClose} />)

    fireEvent.pointerDown(screen.getByTestId(`callout-type-${type}`))

    expect(spy).toHaveBeenCalledOnce()
    expect((spy.mock.calls[0]?.[0] as CustomEvent | undefined)?.detail).toEqual({ type })
    expect(onClose).toHaveBeenCalledOnce()
    document.removeEventListener('insert-callout', spy as EventListener)
  })

  it('has no a11y violations', async () => {
    const { container } = render(<CalloutTypeSelector onClose={vi.fn()} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
