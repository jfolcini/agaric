/**
 * Tests for NoPeersPairing (#6520): the "No devices paired" CTA opens the
 * pairing dialog itself, and on a phone first closes the navigation drawer the
 * Sync button lives in.
 */

import { type InvokeArgs, invoke } from '@tauri-apps/api/core'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { NoPeersPairing } from '@/components/dialogs/NoPeersPairing'
import { SidebarProvider, useSidebar } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/useIsMobile'
import { t } from '@/lib/i18n'
import { dispatch } from '@/lib/tauri-mock/handlers'

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

const mockedUseIsMobile = vi.mocked(useIsMobile)

/** The phone drawer's state and its trigger, standing in for the sidebar Sheet. */
function Drawer() {
  const { openMobile, setOpenMobile } = useSidebar()
  return (
    <>
      <button type="button" onClick={() => setOpenMobile(true)}>
        Open drawer
      </button>
      <output data-testid="drawer">{openMobile ? 'open' : 'closed'}</output>
    </>
  )
}

/** The sidebar Sync button's no-peers branch, as App wires it. */
function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <SidebarProvider>
      <Drawer />
      <button type="button" onClick={() => setOpen(true)}>
        Sync
      </button>
      <NoPeersPairing open={open} onOpenChange={setOpen} />
    </SidebarProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedUseIsMobile.mockReturnValue(false)
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: InvokeArgs) =>
    dispatch(cmd, args),
  )
})

describe('NoPeersPairing', () => {
  it('opens the pairing dialog in place of the no-peers one', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Sync' }))

    await user.click(await screen.findByRole('button', { name: t('sync.noPeersCta') }))

    expect(
      await screen.findByRole('dialog', { name: t('pairing.dialogTitle') }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('closes the phone drawer before opening pairing', async () => {
    mockedUseIsMobile.mockReturnValue(true)
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Open drawer' }))
    expect(screen.getByTestId('drawer')).toHaveTextContent('open')
    await user.click(screen.getByRole('button', { name: 'Sync' }))

    await user.click(await screen.findByRole('button', { name: t('sync.noPeersCta') }))

    expect(await screen.findByRole('dialog', { name: t('pairing.dialogTitle') })).toBeVisible()
    expect(screen.getByTestId('drawer')).toHaveTextContent('closed')
  })

  it('has no a11y violations while asking', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Sync' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(await axe(dialog)).toHaveNoViolations()
  })
})
