/**
 * Tests for useRovingTabindex — the shared WAI-ARIA toolbar roving-tabindex
 * hook (#1724).
 *
 * The hook is DOM-driven (it queries the container's real `<button>`
 * descendants), so it is exercised through a small harness component rather
 * than `renderHook`. Coverage here focuses on the behaviours that the
 * per-toolbar tests don't reach:
 *  - a single tab stop across the buttons,
 *  - Arrow / Home / End navigation with wrapping,
 *  - skipping `disabled` buttons,
 *  - excluding buttons inside an `aria-hidden` subtree (e.g. the
 *    FormattingToolbar measurement sentinel),
 *  - re-applying the tab stop when the button set changes.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { useRovingTabindex } from '../useRovingTabindex'

function Harness({
  withDisabled = false,
  withHiddenSentinel = false,
}: {
  withDisabled?: boolean
  withHiddenSentinel?: boolean
}): React.ReactElement {
  const roving = useRovingTabindex()
  return (
    <div
      tabIndex={-1}
      role="toolbar"
      aria-label="test"
      ref={roving.containerRef}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
    >
      <button type="button" data-testid="b0">
        zero
      </button>
      <button type="button" data-testid="b1" disabled={withDisabled}>
        one
      </button>
      <button type="button" data-testid="b2">
        two
      </button>
      {withHiddenSentinel && (
        <div aria-hidden="true">
          <button type="button" data-testid="sentinel">
            hidden
          </button>
        </div>
      )}
    </div>
  )
}

function tab(el: HTMLElement): string | null {
  return el.getAttribute('tabindex')
}

describe('useRovingTabindex', () => {
  it('gives exactly one button the tab stop (tabindex 0), rest -1', () => {
    render(<Harness />)
    expect(tab(screen.getByTestId('b0'))).toBe('0')
    expect(tab(screen.getByTestId('b1'))).toBe('-1')
    expect(tab(screen.getByTestId('b2'))).toBe('-1')
  })

  it('ArrowRight / ArrowLeft move focus and wrap', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const b0 = screen.getByTestId('b0')
    const b1 = screen.getByTestId('b1')
    const b2 = screen.getByTestId('b2')

    b0.focus()
    await user.keyboard('{ArrowRight}')
    expect(b1).toHaveFocus()
    expect(tab(b1)).toBe('0')

    await user.keyboard('{ArrowRight}')
    expect(b2).toHaveFocus()

    // wrap forward
    await user.keyboard('{ArrowRight}')
    expect(b0).toHaveFocus()

    // wrap backward
    await user.keyboard('{ArrowLeft}')
    expect(b2).toHaveFocus()
  })

  it('Home / End jump to first / last', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const b0 = screen.getByTestId('b0')
    const b2 = screen.getByTestId('b2')

    b0.focus()
    await user.keyboard('{End}')
    expect(b2).toHaveFocus()
    await user.keyboard('{Home}')
    expect(b0).toHaveFocus()
  })

  it('skips disabled buttons during navigation', async () => {
    const user = userEvent.setup()
    render(<Harness withDisabled />)
    const b0 = screen.getByTestId('b0')
    const b2 = screen.getByTestId('b2')

    // disabled b1 never owns the tab stop and is stepped over
    expect(tab(screen.getByTestId('b1'))).not.toBe('0')

    b0.focus()
    await user.keyboard('{ArrowRight}')
    expect(b2).toHaveFocus()
  })

  it('excludes buttons inside an aria-hidden subtree (measurement sentinel)', async () => {
    const user = userEvent.setup()
    render(<Harness withHiddenSentinel />)
    const sentinel = screen.getByTestId('sentinel')
    const b0 = screen.getByTestId('b0')
    const b2 = screen.getByTestId('b2')

    // The hidden sentinel button is never part of the roving set.
    expect(tab(sentinel)).not.toBe('0')

    // End lands on the last VISIBLE button, not the hidden sentinel.
    b0.focus()
    await user.keyboard('{End}')
    expect(b2).toHaveFocus()
    expect(sentinel).not.toHaveFocus()
  })

  it('non-arrow keys are ignored (no preventDefault, focus unchanged)', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const b0 = screen.getByTestId('b0')
    b0.focus()
    await user.keyboard('a')
    expect(b0).toHaveFocus()
  })

  function ResizableHarness(): React.ReactElement {
    const roving = useRovingTabindex()
    const [count, setCount] = useState(1)
    return (
      <div>
        <button type="button" data-testid="add" onClick={() => setCount((c) => c + 1)}>
          add
        </button>
        <div role="toolbar" aria-label="resizable" ref={roving.containerRef}>
          {Array.from({ length: count }, (_, i) => (
            <button type="button" key={i} data-testid={`t${i}`}>
              {i}
            </button>
          ))}
        </div>
      </div>
    )
  }

  it('keeps a single tab stop when buttons are added (overflow churn)', async () => {
    const user = userEvent.setup()
    render(<ResizableHarness />)
    expect(tab(screen.getByTestId('t0'))).toBe('0')

    await user.click(screen.getByTestId('add'))

    // First button still owns the tab stop; the new one is -1.
    expect(tab(screen.getByTestId('t0'))).toBe('0')
    expect(tab(screen.getByTestId('t1'))).toBe('-1')
  })
})
