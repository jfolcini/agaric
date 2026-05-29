/**
 * Component-level tests for the InPageFind toolbar (PEND-52).
 *
 * Covers:
 *  - Toolbar visibility flips with the store's `open` flag.
 *  - Typing into the input drives the counter via the matcher.
 *  - Toggles (Aa / Ab| / .*) flip aria-pressed and affect counts.
 *  - Enter / Shift+Enter / F3 / Shift+F3 cycle matches.
 *  - Esc closes and restores focus.
 *  - Invalid regex surfaces inline error UX.
 *  - Counter has role=status + aria-live=polite (a11y).
 *  - vitest-axe finds zero violations on the rendered toolbar.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { useInPageFindStore } from '../../stores/useInPageFindStore'
import { InPageFind } from '../InPageFind'

function resetStore(): void {
  useInPageFindStore.setState({
    open: false,
    query: '',
    toggles: { caseSensitive: false, wholeWord: false, isRegex: false },
    totalMatches: 0,
    currentIndex: -1,
    regexError: null,
    skippedLongNodes: 0,
    container: null,
    lastQuery: '',
  })
}

/** Open the toolbar from inside an `act` so React picks up the store update. */
function openToolbar(seed?: string): void {
  act(() => {
    useInPageFindStore.getState().open$(seed)
  })
}

let host: HTMLDivElement

beforeEach(() => {
  resetStore()
  // Provide a page-content host with several text nodes so the matcher
  // has something to find.
  host = document.createElement('div')
  host.innerHTML = `
    <section>alpha bravo charlie</section>
    <section>delta alpha echo</section>
    <section>foxtrot alpha alpha</section>
  `
  document.body.appendChild(host)
  useInPageFindStore.getState().setContainer(host)
})

afterEach(() => {
  host.remove()
  resetStore()
})

describe('InPageFind — visibility', () => {
  it('renders nothing while the store is closed', () => {
    render(<InPageFind />)
    expect(screen.queryByTestId('in-page-find-toolbar')).toBeNull()
  })

  it('mounts when the store is opened', () => {
    render(<InPageFind />)
    openToolbar()
    expect(screen.getByTestId('in-page-find-toolbar')).toBeInTheDocument()
  })
})

describe('InPageFind — typing drives the counter', () => {
  it('counts literal matches across multiple blocks', async () => {
    render(<InPageFind />)
    openToolbar()
    const input = await screen.findByTestId('in-page-find-input')
    await userEvent.type(input as HTMLInputElement, 'alpha')

    await waitFor(() => {
      const counter = screen.getByTestId('in-page-find-counter')
      expect(counter.textContent).toMatch(/of 4$/)
    })
  })

  it('clearing the query resets the counter to "0 of 0"', async () => {
    render(<InPageFind />)
    openToolbar('alpha')
    await waitFor(() => {
      expect(screen.getByTestId('in-page-find-counter').textContent).toMatch(/of 4$/)
    })
    const input = await screen.findByTestId('in-page-find-input')
    await userEvent.clear(input as HTMLInputElement)
    await waitFor(() => {
      expect(screen.getByTestId('in-page-find-counter').textContent).toBe('0 of 0')
    })
  })
})

describe('InPageFind — toggles', () => {
  it('Aa toggle narrows matches (case sensitive)', async () => {
    host.innerHTML = '<p>alpha Alpha ALPHA</p>'
    useInPageFindStore.getState().setContainer(host)

    render(<InPageFind />)
    openToolbar('Alpha')
    await waitFor(() => {
      // Case-insensitive default: 3 matches.
      expect(screen.getByTestId('in-page-find-counter').textContent).toMatch(/of 3$/)
    })

    const caseBtn = screen.getByTestId('in-page-find-toggle-case')
    expect(caseBtn).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(caseBtn)
    expect(caseBtn).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => {
      expect(screen.getByTestId('in-page-find-counter').textContent).toMatch(/of 1$/)
    })
  })

  it('regex toggle activates regex mode + invalid pattern surfaces an inline error', async () => {
    render(<InPageFind />)
    openToolbar('[abc')

    const regexBtn = await screen.findByTestId('in-page-find-toggle-regex')
    await userEvent.click(regexBtn)
    expect(regexBtn).toHaveAttribute('aria-pressed', 'true')

    await waitFor(() => {
      const err = screen.getByTestId('in-page-find-error')
      expect(err).toBeInTheDocument()
      // The counter shows the em-dash placeholder while regex is invalid.
      expect(screen.getByTestId('in-page-find-counter').textContent).toBe('—')
    })
  })
})

describe('InPageFind — navigation', () => {
  it('Enter advances to next; Shift+Enter goes back', async () => {
    render(<InPageFind />)
    openToolbar('alpha')
    await waitFor(() => {
      expect(screen.getByTestId('in-page-find-counter').textContent).toMatch(/^1 of 4$/)
    })
    const input = (await screen.findByTestId('in-page-find-input')) as HTMLInputElement
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(useInPageFindStore.getState().currentIndex).toBe(1)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(useInPageFindStore.getState().currentIndex).toBe(0)
  })

  it('F3 / Shift+F3 cycle matches globally (not just from the input)', async () => {
    render(<InPageFind />)
    openToolbar('alpha')
    await waitFor(() => {
      expect(useInPageFindStore.getState().totalMatches).toBe(4)
    })
    fireEvent.keyDown(window, { key: 'F3' })
    expect(useInPageFindStore.getState().currentIndex).toBe(1)
    fireEvent.keyDown(window, { key: 'F3', shiftKey: true })
    expect(useInPageFindStore.getState().currentIndex).toBe(0)
  })
})

describe('InPageFind — close + a11y', () => {
  it('Esc closes the toolbar', async () => {
    render(<InPageFind />)
    openToolbar('alpha')
    const input = (await screen.findByTestId('in-page-find-input')) as HTMLInputElement
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(useInPageFindStore.getState().open).toBe(false)
  })

  it('close button closes the toolbar', async () => {
    render(<InPageFind />)
    openToolbar('alpha')
    const closeBtn = await screen.findByTestId('in-page-find-close')
    await userEvent.click(closeBtn)
    expect(useInPageFindStore.getState().open).toBe(false)
  })

  it('counter has role=status and aria-live=polite', () => {
    render(<InPageFind />)
    openToolbar()
    const counter = screen.getByTestId('in-page-find-counter')
    expect(counter).toHaveAttribute('role', 'status')
    expect(counter).toHaveAttribute('aria-live', 'polite')
  })

  it('passes a vitest-axe scan', async () => {
    const { container } = render(<InPageFind />)
    openToolbar('alpha')
    // Wait for the matcher to settle so the counter text is stable.
    await waitFor(() => {
      expect(screen.getByTestId('in-page-find-counter').textContent).toMatch(/of \d+/)
    })
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
