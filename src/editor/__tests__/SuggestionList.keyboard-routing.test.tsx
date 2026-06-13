/**
 * Integration + a11y tests for suggestion-popup keyboard routing (T4 / #1025).
 *
 * `SuggestionList` is unit-tested in isolation, but nothing verifies the
 * end-to-end suppression: when the popup is OPEN, ArrowUp on the first item
 * must NOT leak to block navigation (`onFocusPrev`), ArrowDown on the last
 * must NOT fire `onFocusNext`, Enter applies the item without moving block
 * focus, and the focused (`tabIndex=0`) listbox is axe-clean.
 *
 * The production suppression lives in `use-block-keyboard.ts`
 * (`isSuggestionPopupVisible()` reads a visible `.suggestion-popup` from the
 * DOM). So these tests render the REAL `SuggestionList` inside a real
 * `.suggestion-popup` wrapper, then route the SAME arrow events through both
 * `handleBlockKeyDown` (block-level) and the popup's imperative ref
 * (popup-level) — mirroring how a keystroke fans out in production.
 */

import { act, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import type { PickerItem, SuggestionListRef } from '../SuggestionList'
import { SuggestionList } from '../SuggestionList'
import {
  type BlockKeyboardCallbacks,
  type DeleteBlockOpts,
  type EditorLike,
  handleBlockKeyDown,
} from '../use-block-keyboard'

const sampleItems: PickerItem[] = [
  { id: '1', label: 'Alpha' },
  { id: '2', label: 'Beta' },
  { id: '3', label: 'Gamma' },
]

function makeKeyEvent(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key })
}

/** Block-level keyboard event stub (matches the existing use-block-keyboard tests). */
function makeBlockEvent(key: string) {
  return {
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: vi.fn(),
  }
}

/** Editor with caret at `from`, doc size `docSize`. */
function makeEditor(from: number, docSize: number): EditorLike {
  return {
    state: { selection: { from, to: from, empty: true }, doc: { content: { size: docSize } } },
    isEmpty: false,
  }
}

function makeCallbacks(): BlockKeyboardCallbacks & { _calls: Record<string, number> } {
  const _calls: Record<string, number> = {}
  const track = (name: string) => () => {
    _calls[name] = (_calls[name] ?? 0) + 1
  }
  return {
    onFocusPrev: track('onFocusPrev'),
    onFocusNext: track('onFocusNext'),
    onDeleteBlock: (_opts: DeleteBlockOpts) => track('onDeleteBlock')(),
    onIndent: track('onIndent'),
    onDedent: track('onDedent'),
    onFlush: () => {
      track('onFlush')()
      return null
    },
    onMergeWithPrev: track('onMergeWithPrev'),
    onEnterSave: track('onEnterSave'),
    onEscapeCancel: track('onEscapeCancel'),
    onMoveUp: track('onMoveUp'),
    onMoveDown: track('onMoveDown'),
    onToggleTodo: track('onToggleTodo'),
    onToggleCollapse: track('onToggleCollapse'),
    _calls,
  }
}

/**
 * Render the SuggestionList inside a visible `.suggestion-popup` wrapper so the
 * production `isSuggestionPopupVisible()` DOM probe sees it (jsdom/happy-dom
 * lack a real layout, so we stub `checkVisibility`).
 */
function renderPopup(items: PickerItem[], command: (item: PickerItem) => void) {
  const ref = createRef<SuggestionListRef>()
  const popup = document.createElement('div')
  popup.className = 'suggestion-popup'
  popup.checkVisibility = () => true
  document.body.appendChild(popup)
  const utils = render(<SuggestionList ref={ref} items={items} command={command} label="Tags" />, {
    container: popup,
  })
  return { ref, popup, ...utils }
}

afterEach(() => {
  document.querySelectorAll('.suggestion-popup').forEach((el) => {
    el.remove()
  })
  vi.clearAllMocks()
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('T4 — ArrowUp on first item does not leak to block nav', () => {
  it('block handler suppresses onFocusPrev; popup ref moves selection instead', () => {
    const command = vi.fn()
    const { ref } = renderPopup(sampleItems, command)
    const cbs = makeCallbacks()
    // Caret at start (from=1) — without a popup this would navigate to the
    // previous block.
    const editor = makeEditor(1, 20)

    // Block-level handler runs first (capture phase in production).
    handleBlockKeyDown(makeBlockEvent('ArrowUp'), editor, cbs)
    expect(cbs._calls['onFocusPrev']).toBeUndefined()

    // The same ArrowUp reaches the popup ref, which moves selection (wraps to
    // last item from the first).
    act(() => {
      const handled = ref.current?.onKeyDown({ event: makeKeyEvent('ArrowUp') })
      expect(handled).toBe(true)
    })
    expect(screen.getByText('Gamma')).toHaveAttribute('aria-selected', 'true')
  })
})

describe('T4 — ArrowDown on last item does not leak to block nav', () => {
  it('block handler suppresses onFocusNext while the popup is open', () => {
    const command = vi.fn()
    const { ref } = renderPopup(sampleItems, command)
    const cbs = makeCallbacks()
    // Caret at doc-end (from=docSize-1) — would navigate to the next block.
    const editor = makeEditor(19, 20)

    // Drive popup selection to the LAST item first.
    act(() => {
      ref.current?.onKeyDown({ event: makeKeyEvent('ArrowDown') })
      ref.current?.onKeyDown({ event: makeKeyEvent('ArrowDown') })
    })
    expect(screen.getByText('Gamma')).toHaveAttribute('aria-selected', 'true')

    handleBlockKeyDown(makeBlockEvent('ArrowDown'), editor, cbs)
    expect(cbs._calls['onFocusNext']).toBeUndefined()
  })
})

describe('T4 — Enter applies the item without changing block focus', () => {
  it('Enter selects via the popup ref and does not fire block-nav callbacks', () => {
    const command = vi.fn()
    const { ref } = renderPopup(sampleItems, command)
    const cbs = makeCallbacks()

    // Move to Beta, then Enter.
    act(() => {
      ref.current?.onKeyDown({ event: makeKeyEvent('ArrowDown') })
    })
    let handled: boolean | undefined
    act(() => {
      handled = ref.current?.onKeyDown({ event: makeKeyEvent('Enter') })
    })

    expect(handled).toBe(true)
    expect(command).toHaveBeenCalledTimes(1)
    expect(command).toHaveBeenCalledWith({ id: '2', label: 'Beta' })

    // No block-level focus movement occurred for the Enter selection.
    expect(cbs._calls['onFocusPrev']).toBeUndefined()
    expect(cbs._calls['onFocusNext']).toBeUndefined()
  })
})

describe('T4 — all arrow block-nav is suppressed while the popup is visible', () => {
  it.each(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const)(
    '%s does not move block focus when a popup is open',
    (key) => {
      const command = vi.fn()
      renderPopup(sampleItems, command)
      const cbs = makeCallbacks()
      // Boundary positions: pos 0 (start) and doc-end both trigger nav absent a popup.
      const atStart = key === 'ArrowUp' || key === 'ArrowLeft'
      const editor = makeEditor(atStart ? 0 : 19, 20)

      handleBlockKeyDown(makeBlockEvent(key), editor, cbs)

      expect(cbs._calls['onFocusPrev']).toBeUndefined()
      expect(cbs._calls['onFocusNext']).toBeUndefined()
    },
  )

  it('CONTROL: with NO popup, ArrowUp at start DOES navigate (suppression is popup-driven)', () => {
    const cbs = makeCallbacks()
    const editor = makeEditor(1, 20)
    handleBlockKeyDown(makeBlockEvent('ArrowUp'), editor, cbs)
    expect(cbs._calls['onFocusPrev']).toBe(1)
  })
})

describe('T4 — a11y: focused listbox has no violations', () => {
  it('axe-audits the focused (tabIndex=0) listbox + aria wiring', async () => {
    const command = vi.fn()
    const { ref, popup } = renderPopup(sampleItems, command)

    // Move selection so aria-activedescendant points at a non-default item:
    // this is the wiring that only matters once the listbox is focusable.
    act(() => {
      ref.current?.onKeyDown({ event: makeKeyEvent('ArrowDown') })
    })

    const listbox = screen.getByRole('listbox')
    expect(listbox).toHaveAttribute('tabindex', '0')
    expect(listbox).toHaveAttribute('aria-label', 'Tags')
    // aria-activedescendant tracks the selected option's id.
    expect(listbox).toHaveAttribute('aria-activedescendant', 'suggestion-2')
    expect(document.getElementById('suggestion-2')).not.toBeNull()

    const results = await axe(popup)
    expect(results).toHaveNoViolations()
  })
})
