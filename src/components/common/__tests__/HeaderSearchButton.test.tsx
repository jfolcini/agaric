import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { CommandPalette } from '@/components/common/CommandPalette'
import { HeaderSearchButton } from '@/components/common/HeaderSearchButton'
import { resetAllShortcuts, setCustomShortcut } from '@/lib/keyboard-config'
import { useCommandPaletteStore } from '@/stores/useCommandPaletteStore'

// The palette runs its search over IPC; this test is about opening it, not its results.
vi.mock('@/lib/ipc-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc-helpers')>()
  return {
    ...actual,
    searchBlocks: vi.fn().mockResolvedValue({ items: [], next_cursor: null, has_more: false }),
    searchBlocksPartitioned: vi.fn().mockResolvedValue({ pages: [], blocks: [], tags: [] }),
  }
})

function PaletteHost(): React.ReactElement {
  const open = useCommandPaletteStore((s) => s.open)
  return (
    <>
      <HeaderSearchButton />
      {open && <CommandPalette />}
    </>
  )
}

beforeEach(() => {
  localStorage.clear()
  resetAllShortcuts()
  useCommandPaletteStore.getState().close()
})

afterEach(() => {
  resetAllShortcuts()
  useCommandPaletteStore.getState().close()
})

describe('HeaderSearchButton', () => {
  it('shows the word Search and has no a11y violations', async () => {
    const { container } = render(<HeaderSearchButton />)
    expect(screen.getByRole('button')).toHaveTextContent('Search')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('opens the palette with its input focused on click', async () => {
    const user = userEvent.setup()
    render(<PaletteHost />)

    await user.click(screen.getByRole('button', { name: /^Search/ }))

    expect(useCommandPaletteStore.getState().open).toBe(true)
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveFocus())
  })

  it.each(['{Enter}', ' '])('opens the palette from the keyboard (%j)', async (key) => {
    const user = userEvent.setup()
    render(<HeaderSearchButton />)

    await user.tab()
    expect(screen.getByRole('button')).toHaveFocus()
    await user.keyboard(key)

    expect(useCommandPaletteStore.getState().open).toBe(true)
  })

  it('carries the paletteOpen binding in its name and tooltip', async () => {
    const user = userEvent.setup()
    render(<HeaderSearchButton />)
    const button = screen.getByRole('button')

    expect(button).toHaveAccessibleName('Search (Ctrl + K)')
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+K')
    await user.hover(button)
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('Search')
    expect(tooltip).toHaveTextContent('K')
    expect(tooltip).toHaveTextContent('Find in page')
  })

  it('follows a rebinding of paletteOpen', async () => {
    const user = userEvent.setup()
    setCustomShortcut('paletteOpen', 'Ctrl + Shift + P')
    render(<HeaderSearchButton />)
    const button = screen.getByRole('button')

    expect(button).toHaveAccessibleName('Search (Ctrl + Shift + P)')
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+P')
    await user.hover(button)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('P')
  })
})
