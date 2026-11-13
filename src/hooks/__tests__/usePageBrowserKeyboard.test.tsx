/**
 * usePageBrowserKeyboard hears keys at the document. Arrows move the list
 * cursor from anywhere; Enter and Space belong to the focused control and open
 * the cursor's row only from the list itself or with nothing focused.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { usePageBrowserKeyboard } from '@/hooks/usePageBrowserKeyboard'

function Harness({ onSelect, onPress }: { onSelect: (i: number) => void; onPress: () => void }) {
  const listRef = useRef<HTMLDivElement>(null)
  const { focusedIndex, handleKeyDown } = useListKeyboardNavigation({
    itemCount: 3,
    listRef,
    onSelect,
  })
  usePageBrowserKeyboard({
    navHandleKeyDown: handleKeyDown,
    listRef,
    selectAllPages: () => {},
    clearMultiSelection: () => {},
    multiSelectedSize: 0,
  })
  return (
    <>
      <button type="button" onClick={onPress}>
        Header
      </button>
      <div
        ref={listRef}
        role="grid"
        aria-label="Pages"
        tabIndex={0}
        data-testid="list"
        data-cursor={focusedIndex}
      >
        <button type="button" onClick={onPress}>
          Star
        </button>
      </div>
    </>
  )
}

function setup() {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  const onPress = vi.fn()
  render(<Harness onSelect={onSelect} onPress={onPress} />)
  return { user, onSelect, onPress, list: screen.getByTestId('list') }
}

describe('usePageBrowserKeyboard', () => {
  it.each(['Star', 'Header'])(
    'Enter and Space on the %s button press it and open no row',
    async (name) => {
      const { user, onSelect, onPress } = setup()
      screen.getByRole('button', { name }).focus()

      await user.keyboard('{Enter}')
      expect(onPress).toHaveBeenCalledTimes(1)
      await user.keyboard(' ')
      expect(onPress).toHaveBeenCalledTimes(2)
      expect(onSelect).not.toHaveBeenCalled()
    },
  )

  it('Enter and Space on the list, or with nothing focused, open the cursor row', async () => {
    const { user, onSelect, list } = setup()
    list.focus()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onSelect).toHaveBeenNthCalledWith(1, 1)

    list.blur()
    expect(document.activeElement).toBe(document.body)
    await user.keyboard(' ')
    expect(onSelect).toHaveBeenNthCalledWith(2, 1)
    expect(onSelect).toHaveBeenCalledTimes(2)
  })

  it('arrows on a focused button still move the cursor', async () => {
    const { user, list } = setup()
    screen.getByRole('button', { name: 'Star' }).focus()
    await user.keyboard('{ArrowDown}')
    expect(list).toHaveAttribute('data-cursor', '1')
    expect(list).toHaveFocus()
  })
})
