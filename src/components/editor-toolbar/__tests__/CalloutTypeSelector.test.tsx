/**
 * Tests for CalloutTypeSelector (#215, #3001) — the toolbar callout variant list.
 *
 * A short fixed list and no filter box. A pointer press or a keyboard Enter on a row
 * dispatches `insert-callout` with the chosen `{ type }` and calls `onClose`.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { CalloutTypeSelector } from '@/components/editor-toolbar/CalloutTypeSelector'

// #2222: `dispatchBlockCommand` no longer broadcasts a legacy document
// CustomEvent (the broadcast had zero production listeners; the focus-keyed
// command bus is the only delivery path). These tests observe producer
// dispatches as document events, so shim the bus back onto `document`: the
// existing assertions keep pinning the producer contract — typed
// BLOCK_EVENTS key mapped to the expected event name, plus the detail
// payload — and fail if a producer stops dispatching or changes its detail.
vi.mock('@/stores/block-command-bus', async () => {
  const actual = await vi.importActual<typeof import('@/stores/block-command-bus')>(
    '@/stores/block-command-bus',
  )
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

/** Subscribe to the shimmed `insert-callout` document event for a test. */
function listenForInsertCallout(): { spy: ReturnType<typeof vi.fn>; cleanup: () => void } {
  const spy = vi.fn()
  document.addEventListener('insert-callout', spy as EventListener)
  return {
    spy,
    cleanup: () => document.removeEventListener('insert-callout', spy as EventListener),
  }
}

describe('CalloutTypeSelector', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders a row for every callout variant, in order', () => {
    render(<CalloutTypeSelector onClose={vi.fn()} />)
    expect(screen.getAllByRole('button').map((b) => b.dataset['testid'])).toEqual(
      TYPES.map((type) => `callout-type-${type}`),
    )
  })

  it('has no search box', () => {
    render(<CalloutTypeSelector onClose={vi.fn()} />)
    expect(screen.getAllByRole('button')).toHaveLength(TYPES.length)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  describe('single-step mouse selection', () => {
    it.each(TYPES)(
      'clicking %s dispatches insert-callout with that type and closes (no reopen)',
      async (type) => {
        const user = userEvent.setup()
        const { spy, cleanup } = listenForInsertCallout()
        const onClose = vi.fn()
        render(<CalloutTypeSelector onClose={onClose} />)

        await user.click(screen.getByTestId(`callout-type-${type}`))

        expect(spy).toHaveBeenCalledOnce()
        expect((spy.mock.calls[0]?.[0] as CustomEvent | undefined)?.detail).toEqual({ type })
        expect(onClose).toHaveBeenCalledOnce()
        cleanup()
      },
    )
  })

  it('Enter on a focused row selects it, once', async () => {
    const user = userEvent.setup()
    const { spy, cleanup } = listenForInsertCallout()
    const onClose = vi.fn()
    render(<CalloutTypeSelector onClose={onClose} />)

    screen.getByTestId('callout-type-tip').focus()
    await user.keyboard('{Enter}')

    expect(spy).toHaveBeenCalledOnce()
    expect((spy.mock.calls[0]?.[0] as CustomEvent | undefined)?.detail).toEqual({ type: 'tip' })
    expect(onClose).toHaveBeenCalledOnce()
    cleanup()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<CalloutTypeSelector onClose={vi.fn()} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
