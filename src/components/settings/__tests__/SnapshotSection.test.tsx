/**
 * Tests for SnapshotSection: the Data tab row that says when the last daily
 * snapshot was taken and, on desktop, opens the folder holding it (#6554).
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { stubInvoke } from '@/__tests__/helpers/invoke'
import { SnapshotSection } from '@/components/settings/SnapshotSection'
import { formatTimestamp } from '@/lib/format'

const mockedInvoke = vi.mocked(invoke)

const TAKEN_MS = Date.UTC(2026, 2, 14, 9, 30)

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true })
}

const desktopUserAgent = navigator.userAgent

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  setUserAgent(desktopUserAgent)
})

describe('SnapshotSection', () => {
  it('says when the last snapshot was taken', async () => {
    stubInvoke(mockedInvoke, { get_last_snapshot_ms: () => TAKEN_MS })
    render(<SnapshotSection />)
    expect(
      await screen.findByText(`Last snapshot: ${formatTimestamp(TAKEN_MS)}`),
    ).toBeInTheDocument()
  })

  it('says so when no snapshot has been taken yet', async () => {
    stubInvoke(mockedInvoke, { get_last_snapshot_ms: () => null })
    render(<SnapshotSection />)
    expect(await screen.findByText(/No snapshot yet/)).toBeInTheDocument()
  })

  it('says the time could not be read when the lookup is rejected', async () => {
    stubInvoke(mockedInvoke, {
      get_last_snapshot_ms: () => Promise.reject({ kind: 'internal', message: 'boom' }),
    })
    render(<SnapshotSection />)
    expect(await screen.findByText(/could not be read/)).toBeInTheDocument()
    expect(screen.queryByText(/Last snapshot:/)).not.toBeInTheDocument()
  })

  it('opens the data folder from the desktop button', async () => {
    const user = userEvent.setup()
    const opened = vi.fn(() => null)
    stubInvoke(mockedInvoke, { get_last_snapshot_ms: () => TAKEN_MS, open_data_folder: opened })
    render(<SnapshotSection />)
    await user.click(screen.getByRole('button', { name: 'Open folder' }))
    expect(opened).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('reports a folder that will not open', async () => {
    const user = userEvent.setup()
    stubInvoke(mockedInvoke, {
      get_last_snapshot_ms: () => TAKEN_MS,
      open_data_folder: () => Promise.reject({ kind: 'internal', message: 'boom' }),
    })
    render(<SnapshotSection />)
    await user.click(screen.getByRole('button', { name: 'Open folder' }))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Could not open the data folder')
    })
  })

  it('offers no folder button on a phone, where the folder is private to the app', async () => {
    setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8)')
    stubInvoke(mockedInvoke, { get_last_snapshot_ms: () => TAKEN_MS })
    render(<SnapshotSection />)
    await screen.findByText(/Last snapshot:/)
    expect(screen.queryByRole('button', { name: 'Open folder' })).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    stubInvoke(mockedInvoke, { get_last_snapshot_ms: () => TAKEN_MS })
    const { container } = render(<SnapshotSection />)
    await screen.findByText(/Last snapshot:/)
    expect(await axe(container)).toHaveNoViolations()
  })
})
