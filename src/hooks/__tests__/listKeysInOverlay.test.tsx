/**
 * A list that hears its keys at the document leaves every key pressed inside
 * an open overlay to the overlay: Escape in a confirm dialog closes it and
 * keeps the list's selection, and the arrows in a select's listbox move within
 * it, not the list cursor behind it. Pages, Trash and History gate their
 * listeners through `pressesFocusedControl`.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeBlock } from '@/__tests__/fixtures'
import { useHistoryKeyboardNav } from '@/hooks/useHistoryKeyboardNav'
import { pressesFocusedControl, useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { usePageBrowserKeyboard } from '@/hooks/usePageBrowserKeyboard'
import { useTrashListShortcuts } from '@/hooks/useTrashListShortcuts'

const KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Enter', ' ', 'a']

/** Markup with the focused element `#inside`, as Radix renders each overlay kind. */
const OVERLAYS = {
  dialog: '<div role="dialog"><button id="inside">Cancel</button></div>',
  alertdialog: '<div role="alertdialog"><button id="inside">No</button></div>',
  popper:
    '<div data-radix-popper-content-wrapper><div role="listbox"><div id="inside" role="option" tabindex="-1">All types</div></div></div>',
}

describe('pressesFocusedControl inside an open overlay', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  /** Dispatches `key` on `#inside`, or on <body> without one; returns the answer at the document. */
  function pressIn(overlay: string, key: string) {
    document.body.innerHTML = `<div id="list" role="grid" tabindex="0"></div>${overlay}`
    const results: boolean[] = []
    const listen = (e: KeyboardEvent) =>
      results.push(pressesFocusedControl(e, document.getElementById('list')))
    document.addEventListener('keydown', listen)
    const target = document.getElementById('inside') ?? document.body
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    document.removeEventListener('keydown', listen)
    expect(results).toHaveLength(1)
    return results[0]
  }

  it.each(Object.entries(OVERLAYS))('every key inside a %s is the overlay’s', (_kind, overlay) => {
    for (const key of KEYS) expect(pressIn(overlay, key), key).toBe(true)
  })

  it('the same keys with nothing focused are the list’s', () => {
    for (const key of KEYS) expect(pressIn('', key), key).toBe(false)
  })
})

interface HarnessProps {
  onClearSelection: () => void
}

/** A confirm dialog and an open select's listbox, as portals beside the list. */
function Overlays() {
  return (
    <>
      <div role="alertdialog" aria-label="Empty trash?">
        <button type="button">No</button>
      </div>
      <div data-radix-popper-content-wrapper="">
        {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- mirrors the markup Radix Select renders */}
        <div role="listbox" aria-label="Operation type">
          <div role="option" aria-selected={false} tabIndex={-1}>
            All types
          </div>
        </div>
        {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
      </div>
    </>
  )
}

const blocks = [makeBlock({ id: 'A' }), makeBlock({ id: 'B' }), makeBlock({ id: 'C' })]

function TrashHarness({ onClearSelection }: HarnessProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const { focusedIndex, handleKeyDown } = useListKeyboardNavigation({
    itemCount: 3,
    homeEnd: true,
    listRef,
  })
  useTrashListShortcuts({
    listRef,
    filteredBlocks: blocks,
    focusedIndex,
    selectedSize: 1,
    navHandleKeyDown: handleKeyDown,
    toggleSelection: () => {},
    selectAll: () => {},
    clearSelection: onClearSelection,
    requestBatchRestore: () => {},
    requestBatchPurge: () => {},
  })
  return (
    <>
      <div ref={listRef} role="grid" aria-label="List" tabIndex={0} data-cursor={focusedIndex} />
      <Overlays />
    </>
  )
}

function HistoryHarness({ onClearSelection }: HarnessProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const { focusedIndex } = useHistoryKeyboardNav({
    itemCount: 3,
    listRef,
    hasSelection: true,
    onToggleSelection: () => {},
    onSelectAll: () => {},
    onConfirmRevert: () => {},
    onClearSelection,
  })
  return (
    <>
      <div ref={listRef} role="grid" aria-label="List" tabIndex={-1} data-cursor={focusedIndex} />
      <Overlays />
    </>
  )
}

function PagesHarness({ onClearSelection }: HarnessProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const { focusedIndex, handleKeyDown } = useListKeyboardNavigation({
    itemCount: 3,
    homeEnd: true,
    listRef,
  })
  usePageBrowserKeyboard({
    navHandleKeyDown: handleKeyDown,
    listRef,
    selectAllPages: () => {},
    clearMultiSelection: onClearSelection,
    multiSelectedSize: 1,
  })
  return (
    <>
      <div ref={listRef} role="grid" aria-label="List" tabIndex={0} data-cursor={focusedIndex} />
      <Overlays />
    </>
  )
}

describe.each([
  ['Trash', TrashHarness],
  ['History', HistoryHarness],
  ['Pages', PagesHarness],
])('the %s list behind an open overlay', (_view, Harness) => {
  function setup() {
    const user = userEvent.setup()
    const onClearSelection = vi.fn()
    render(<Harness onClearSelection={onClearSelection} />)
    return { user, onClearSelection, list: screen.getByRole('grid', { name: 'List' }) }
  }

  it('keeps its selection on an Escape in a confirm dialog, and clears it on one from <body>', async () => {
    const { user, onClearSelection } = setup()
    screen.getByRole('button', { name: 'No' }).focus()
    await user.keyboard('{Escape}')
    expect(onClearSelection).not.toHaveBeenCalled()

    screen.getByRole('button', { name: 'No' }).blur()
    await user.keyboard('{Escape}')
    expect(onClearSelection).toHaveBeenCalledTimes(1)
  })

  it('keeps its cursor on arrows in a select’s listbox, and moves it on arrows from <body>', async () => {
    const { user, list } = setup()
    screen.getByRole('option', { name: 'All types' }).focus()
    await user.keyboard('{ArrowDown}{End}')
    expect(list).toHaveAttribute('data-cursor', '0')

    screen.getByRole('option', { name: 'All types' }).blur()
    await user.keyboard('{ArrowDown}')
    expect(list).toHaveAttribute('data-cursor', '1')
  })
})
