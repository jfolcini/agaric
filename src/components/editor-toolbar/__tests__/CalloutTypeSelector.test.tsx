/**
 * Tests for CalloutTypeSelector (#215; single-step searchable rework #3001) —
 * the toolbar callout variant picker.
 *
 * Covers the single-interaction contract: mouse click selects immediately,
 * typing filters the list (typeahead), ArrowDown+Enter selects by keyboard,
 * Esc closes, and the rendered picker has no a11y violations. Every selection
 * dispatches `insert-callout` with the chosen `{ type }` and calls `onClose`.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { CalloutTypeSelector } from '@/components/editor-toolbar/CalloutTypeSelector'
import { t } from '@/lib/i18n'

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

  it('renders a button for every callout variant', () => {
    render(<CalloutTypeSelector onClose={vi.fn()} />)
    for (const type of TYPES) {
      expect(screen.getByTestId(`callout-type-${type}`)).toBeInTheDocument()
    }
  })

  it('auto-focuses the filter input on open', () => {
    render(<CalloutTypeSelector onClose={vi.fn()} />)
    expect(screen.getByRole('textbox', { name: t('toolbar.callout') })).toHaveFocus()
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

  describe('typeahead filtering', () => {
    it('narrows the list to matches as the user types', async () => {
      const user = userEvent.setup()
      render(<CalloutTypeSelector onClose={vi.fn()} />)

      await user.type(screen.getByRole('textbox', { name: t('toolbar.callout') }), 'warn')

      expect(screen.getByTestId('callout-type-warning')).toBeInTheDocument()
      expect(screen.queryByTestId('callout-type-info')).not.toBeInTheDocument()
      expect(screen.queryByTestId('callout-type-note')).not.toBeInTheDocument()
    })

    it('Enter on a filter that narrows to one row selects it', async () => {
      const user = userEvent.setup()
      const { spy, cleanup } = listenForInsertCallout()
      const onClose = vi.fn()
      render(<CalloutTypeSelector onClose={onClose} />)

      await user.type(screen.getByRole('textbox', { name: t('toolbar.callout') }), 'error{Enter}')

      expect((spy.mock.calls[0]?.[0] as CustomEvent | undefined)?.detail).toEqual({ type: 'error' })
      expect(onClose).toHaveBeenCalledOnce()
      cleanup()
    })
  })

  describe('keyboard selection', () => {
    it('ArrowDown moves the highlight, Enter selects the new focused variant', async () => {
      const user = userEvent.setup()
      const { spy, cleanup } = listenForInsertCallout()
      const onClose = vi.fn()
      render(<CalloutTypeSelector onClose={onClose} />)

      // Full list order is info, warning, … — index 0 is `info`, ArrowDown → `warning`.
      await user.type(
        screen.getByRole('textbox', { name: t('toolbar.callout') }),
        '{ArrowDown}{Enter}',
      )

      expect((spy.mock.calls[0]?.[0] as CustomEvent | undefined)?.detail).toEqual({
        type: 'warning',
      })
      expect(onClose).toHaveBeenCalledOnce()
      cleanup()
    })

    it('Enter with no navigation selects the first variant', async () => {
      const user = userEvent.setup()
      const { spy, cleanup } = listenForInsertCallout()
      render(<CalloutTypeSelector onClose={vi.fn()} />)

      await user.type(screen.getByRole('textbox', { name: t('toolbar.callout') }), '{Enter}')

      expect((spy.mock.calls[0]?.[0] as CustomEvent | undefined)?.detail).toEqual({ type: 'info' })
      cleanup()
    })
  })

  describe('Esc closing', () => {
    it('Escape on the filter input closes the picker', () => {
      const onClose = vi.fn()
      render(<CalloutTypeSelector onClose={onClose} />)

      fireEvent.keyDown(screen.getByRole('textbox', { name: t('toolbar.callout') }), {
        key: 'Escape',
      })

      expect(onClose).toHaveBeenCalledOnce()
    })
  })

  it('has no a11y violations', async () => {
    const { container } = render(<CalloutTypeSelector onClose={vi.fn()} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
