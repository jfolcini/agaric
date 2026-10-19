/**
 * Tests for MenuSheet, the phone form of a long action menu (#5931).
 */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { MenuSheet } from '@/components/ui/menu-sheet'

function renderSheet(onOpenChange = vi.fn()) {
  render(
    <MenuSheet open onOpenChange={onOpenChange} title="Block actions">
      <div role="menu" aria-label="Block actions">
        <button type="button" role="menuitem">
          Delete
        </button>
      </div>
    </MenuSheet>,
  )
  return onOpenChange
}

describe('MenuSheet', () => {
  it('is a bottom sheet named by its title, holding the rows and no close button', async () => {
    renderSheet()
    const sheet = screen.getByRole('dialog', { name: 'Block actions' })
    expect(sheet).toHaveAttribute('data-slot', 'sheet-content')
    expect(sheet.className).toContain('bottom-0')
    expect(within(sheet).getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()
    expect(within(sheet).queryByRole('button', { name: 'Close' })).toBeNull()
    expect(await axe(sheet)).toHaveNoViolations()
  })

  it('Escape asks to close it', async () => {
    const user = userEvent.setup()
    const onOpenChange = renderSheet()
    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
