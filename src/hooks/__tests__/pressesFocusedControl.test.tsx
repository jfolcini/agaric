/**
 * pressesFocusedControl: a list that hears keys at the document leaves Enter
 * and Space to the focused control, and takes them only from the list, one of
 * its rows, or with nothing in particular focused. Trash's Space toggle and
 * History's Space toggle and Enter revert are gated by it.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { useHistoryKeyboardNav } from '@/hooks/useHistoryKeyboardNav'
import { pressesFocusedControl, useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { useTrashListShortcuts } from '@/hooks/useTrashListShortcuts'

describe('pressesFocusedControl', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  /** Dispatches `key` on the element `id` names; returns the predicate's answer at the document. */
  function pressOn(id: string, key: string, { withList = true } = {}) {
    document.body.innerHTML = `
      <main id="main" tabindex="-1">
        <button id="header-button">Restore all</button>
        <div id="list" role="grid" tabindex="0">
          <div id="row" role="row" tabindex="0"><button id="row-button">Diff</button></div>
          <div id="clicked-row" role="row" tabindex="-1"></div>
        </div>
      </main>`
    const list = withList ? document.getElementById('list') : null
    const results: boolean[] = []
    const listen = (e: KeyboardEvent) => results.push(pressesFocusedControl(e, list))
    document.addEventListener('keydown', listen)
    const target = document.getElementById(id) ?? document.body
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    document.removeEventListener('keydown', listen)
    expect(results).toHaveLength(1)
    return results[0]
  }

  it.each(['header-button', 'row-button', 'clicked-row'])(
    'Enter and Space on %s are the control’s',
    (id) => {
      expect(pressOn(id, 'Enter')).toBe(true)
      expect(pressOn(id, ' ')).toBe(true)
    },
  )

  it.each(['list', 'row', 'main', 'body'])('Enter and Space on %s are the list’s', (id) => {
    expect(pressOn(id, 'Enter')).toBe(false)
    expect(pressOn(id, ' ')).toBe(false)
  })

  it('leaves every other key to the list', () => {
    expect(pressOn('header-button', 'ArrowDown')).toBe(false)
    expect(pressOn('header-button', 'Escape')).toBe(false)
  })

  it('without a list, only a press with nothing focused is the list’s', () => {
    expect(pressOn('main', ' ', { withList: false })).toBe(true)
    expect(pressOn('body', ' ', { withList: false })).toBe(false)
  })
})

const blocks = [makeBlock({ id: 'A' }), makeBlock({ id: 'B' })]

function TrashHarness({
  toggleSelection,
  onPress,
}: {
  toggleSelection: (id: string) => void
  onPress: () => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const { focusedIndex, handleKeyDown } = useListKeyboardNavigation({ itemCount: 2, listRef })
  useTrashListShortcuts({
    listRef,
    filteredBlocks: blocks,
    focusedIndex,
    selectedSize: 0,
    navHandleKeyDown: handleKeyDown,
    toggleSelection,
    selectAll: () => {},
    clearSelection: () => {},
    requestBatchRestore: () => {},
    requestBatchPurge: () => {},
  })
  return (
    <>
      <button type="button" onClick={onPress}>
        Restore all
      </button>
      <div ref={listRef} role="grid" aria-label="Trash items" tabIndex={0} />
    </>
  )
}

describe('useTrashListShortcuts with pressesFocusedControl', () => {
  it('Space on a button presses it and toggles no row', async () => {
    const user = userEvent.setup()
    const toggleSelection = vi.fn()
    const onPress = vi.fn()
    render(<TrashHarness toggleSelection={toggleSelection} onPress={onPress} />)

    screen.getByRole('button', { name: 'Restore all' }).focus()
    await user.keyboard(' ')
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(toggleSelection).not.toHaveBeenCalled()
  })

  it('Space on the list toggles the cursor row', async () => {
    const user = userEvent.setup()
    const toggleSelection = vi.fn()
    render(<TrashHarness toggleSelection={toggleSelection} onPress={() => {}} />)

    screen.getByRole('grid', { name: 'Trash items' }).focus()
    await user.keyboard('{ArrowDown} ')
    expect(toggleSelection).toHaveBeenCalledTimes(1)
    expect(toggleSelection).toHaveBeenCalledWith('B')
  })
})

function HistoryHarness({
  onToggleSelection,
  onConfirmRevert,
  onPress,
}: {
  onToggleSelection: (index: number) => void
  onConfirmRevert: () => void
  onPress: () => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useHistoryKeyboardNav({
    itemCount: 2,
    listRef,
    hasSelection: true,
    onToggleSelection,
    onSelectAll: () => {},
    onConfirmRevert,
    onClearSelection: () => {},
  })
  return (
    <>
      <button type="button" onClick={onPress}>
        Op type legend
      </button>
      <div ref={listRef} role="grid" aria-label="History entries" tabIndex={-1}>
        {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- mirrors HistoryListItem's CSS-grid row */}
        <div role="row" aria-selected tabIndex={0} data-testid="row">
          {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- mirrors HistoryListItem's CSS-grid cell */}
          <div role="gridcell">Edit #1</div>
        </div>
      </div>
    </>
  )
}

describe('useHistoryKeyboardNav with pressesFocusedControl', () => {
  function setup() {
    const user = userEvent.setup()
    const onToggleSelection = vi.fn()
    const onConfirmRevert = vi.fn()
    const onPress = vi.fn()
    render(
      <HistoryHarness
        onToggleSelection={onToggleSelection}
        onConfirmRevert={onConfirmRevert}
        onPress={onPress}
      />,
    )
    return { user, onToggleSelection, onConfirmRevert, onPress }
  }

  it('Enter and Space on a button press it, with a row selected, and neither revert nor toggle', async () => {
    const { user, onToggleSelection, onConfirmRevert, onPress } = setup()
    screen.getByRole('button', { name: 'Op type legend' }).focus()

    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onPress).toHaveBeenCalledTimes(2)
    expect(onConfirmRevert).not.toHaveBeenCalled()
    expect(onToggleSelection).not.toHaveBeenCalled()
  })

  it('Space on the list toggles the cursor row, and Enter on a row opens the revert', async () => {
    const { user, onToggleSelection, onConfirmRevert } = setup()
    screen.getByRole('grid', { name: 'History entries' }).focus()
    await user.keyboard(' ')
    expect(onToggleSelection).toHaveBeenCalledTimes(1)
    expect(onToggleSelection).toHaveBeenCalledWith(0)

    screen.getByTestId('row').focus()
    await user.keyboard('{Enter}')
    expect(onConfirmRevert).toHaveBeenCalledTimes(1)
  })
})
