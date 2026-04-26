/**
 * Tests for NoPeersDialog (BUG-2).
 *
 * Validates:
 *  - Dialog renders title / body / Cancel + Open-sync-settings actions when open
 *  - Renders nothing when closed
 *  - "Open sync settings" CTA calls `onOpenSettings`
 *  - Cancel calls `onOpenChange(false)`
 *  - ESC closes via `onOpenChange(false)`
 *  - axe(container) audit passes
 */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { t } from '../../lib/i18n'
import { NoPeersDialog } from '../NoPeersDialog'

describe('NoPeersDialog', () => {
  it('renders nothing when closed', () => {
    render(<NoPeersDialog open={false} onOpenChange={vi.fn()} onOpenSettings={vi.fn()} />)
    expect(screen.queryByText(t('sync.noPeersTitle'))).not.toBeInTheDocument()
    expect(screen.queryByText(t('sync.noPeersBody'))).not.toBeInTheDocument()
  })

  it('renders title, body, and both action buttons when open', () => {
    render(<NoPeersDialog open={true} onOpenChange={vi.fn()} onOpenSettings={vi.fn()} />)
    expect(screen.getByText(t('sync.noPeersTitle'))).toBeInTheDocument()
    expect(screen.getByText(t('sync.noPeersBody'))).toBeInTheDocument()
    // Both actions surfaced as accessible buttons (i18n-keyed labels).
    expect(screen.getByRole('button', { name: t('sync.noPeersCta') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('sync.noPeersCancel') })).toBeInTheDocument()
  })

  it('uses the alertdialog role (Radix AlertDialog primitive)', () => {
    render(<NoPeersDialog open={true} onOpenChange={vi.fn()} onOpenSettings={vi.fn()} />)
    // The Radix AlertDialog content gets `role="alertdialog"`. This is
    // the right role for an interrupt with a default action — we want
    // assistive tech to announce it as such.
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('calls onOpenSettings when the primary CTA is clicked', async () => {
    const user = userEvent.setup()
    const onOpenSettings = vi.fn()
    render(<NoPeersDialog open={true} onOpenChange={vi.fn()} onOpenSettings={onOpenSettings} />)

    await user.click(screen.getByRole('button', { name: t('sync.noPeersCta') }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('does not call onOpenSettings when Cancel is clicked', async () => {
    const user = userEvent.setup()
    const onOpenSettings = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <NoPeersDialog open={true} onOpenChange={onOpenChange} onOpenSettings={onOpenSettings} />,
    )

    await user.click(screen.getByRole('button', { name: t('sync.noPeersCancel') }))
    expect(onOpenSettings).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('closes via onOpenChange(false) when Escape is pressed', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const onOpenSettings = vi.fn()
    render(
      <NoPeersDialog open={true} onOpenChange={onOpenChange} onOpenSettings={onOpenSettings} />,
    )

    // Radix AlertDialog binds ESC to the Cancel pathway → onOpenChange(false).
    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    // ESC must never fire the primary action.
    expect(onOpenSettings).not.toHaveBeenCalled()
  })

  it('has no a11y violations when open', async () => {
    const { container } = render(
      <NoPeersDialog open={true} onOpenChange={vi.fn()} onOpenSettings={vi.fn()} />,
    )
    // axe cold-load on first call per worker can exceed the default 1 s
    // waitFor budget — match the pattern used by Sidebar/HistoryView tests.
    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})
