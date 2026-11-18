/**
 * Tests for SnapshotSection: the Data tab row that says when the last daily
 * snapshot was taken, on desktop opens the folder holding it (#6554), and
 * restores one at the next launch (#6744).
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { stubInvoke } from '@/__tests__/helpers/invoke'
import { SnapshotSection } from '@/components/settings/SnapshotSection'
import type { DailySnapshot } from '@/lib/bindings'
import { formatTimestamp } from '@/lib/format'
import { t } from '@/lib/i18n'
import { relaunchApp } from '@/lib/relaunch-app'

vi.mock('@/lib/relaunch-app', () => ({ relaunchApp: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

const TAKEN_MS = Date.UTC(2026, 2, 14, 9, 30)

const NEWEST: DailySnapshot = { day: '2026-03-14', taken_ms: TAKEN_MS }
const OLDER: DailySnapshot = { day: '2026-03-13', taken_ms: Date.UTC(2026, 2, 13, 8, 5) }

/** Open the restore dialog over two snapshots; `request` answers the restore. */
async function openRestoreDialog(request: () => Promise<null> | null): Promise<HTMLElement> {
  stubInvoke(mockedInvoke, {
    get_last_snapshot_ms: () => TAKEN_MS,
    list_daily_snapshots: () => [NEWEST, OLDER],
    request_snapshot_restore: request,
  })
  render(<SnapshotSection />)
  await screen.findByText(/Last snapshot:/)
  await userEvent.click(screen.getByRole('button', { name: t('data.snapshotRestoreButton') }))
  return screen.findByRole('alertdialog')
}

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

  it('offers no restore until a snapshot exists', async () => {
    stubInvoke(mockedInvoke, { get_last_snapshot_ms: () => null })
    render(<SnapshotSection />)
    await screen.findByText(/No snapshot yet/)
    expect(screen.getByRole('button', { name: t('data.snapshotRestoreButton') })).toBeDisabled()
  })

  it('asks before restoring, with the newest snapshot chosen', async () => {
    const requested = vi.fn(() => null)
    const dialog = await openRestoreDialog(requested)

    expect(within(dialog).getByText(t('data.snapshotRestoreDesc'))).toBeInTheDocument()
    const choice = within(dialog).getByLabelText(t('data.snapshotRestoreSelectLabel'))
    expect(choice).toHaveValue(NEWEST.day)
    expect(
      within(choice)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([formatTimestamp(NEWEST.taken_ms), formatTimestamp(OLDER.taken_ms)])
    expect(requested).not.toHaveBeenCalled()
    expect(relaunchApp).not.toHaveBeenCalled()
  })

  it('restores the chosen snapshot and restarts', async () => {
    const user = userEvent.setup()
    const requested = vi.fn(() => null)
    const dialog = await openRestoreDialog(requested)

    await user.selectOptions(
      within(dialog).getByLabelText(t('data.snapshotRestoreSelectLabel')),
      OLDER.day,
    )
    await user.click(within(dialog).getByRole('button', { name: t('data.snapshotRestoreConfirm') }))

    await waitFor(() => {
      expect(relaunchApp).toHaveBeenCalledTimes(1)
    })
    expect(mockedInvoke).toHaveBeenCalledWith('request_snapshot_restore', { day: OLDER.day })
    expect(requested).toHaveBeenCalledTimes(1)
  })

  it('restores nothing when the dialog is cancelled', async () => {
    const user = userEvent.setup()
    const requested = vi.fn(() => null)
    const dialog = await openRestoreDialog(requested)

    await user.click(within(dialog).getByRole('button', { name: t('dialog.cancel') }))

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    expect(requested).not.toHaveBeenCalled()
    expect(relaunchApp).not.toHaveBeenCalled()
  })

  it('says why and does not restart when the restore is refused', async () => {
    const user = userEvent.setup()
    const dialog = await openRestoreDialog(() =>
      Promise.reject({ kind: 'not_found', message: 'the daily snapshot of 2026-03-14' }),
    )

    await user.click(within(dialog).getByRole('button', { name: t('data.snapshotRestoreConfirm') }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        t('data.snapshotRestoreFailed', { reason: 'the daily snapshot of 2026-03-14' }),
      )
    })
    expect(relaunchApp).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('reports snapshots that cannot be listed, and asks nothing', async () => {
    const user = userEvent.setup()
    stubInvoke(mockedInvoke, {
      get_last_snapshot_ms: () => TAKEN_MS,
      list_daily_snapshots: () => Promise.reject({ kind: 'io', message: 'boom' }),
    })
    render(<SnapshotSection />)
    await screen.findByText(/Last snapshot:/)

    await user.click(screen.getByRole('button', { name: t('data.snapshotRestoreButton') }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(t('data.snapshotRestoreListFailed'))
    })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('has no a11y violations with the restore dialog open', async () => {
    const dialog = await openRestoreDialog(() => null)
    expect(await axe(dialog)).toHaveNoViolations()
  })

  it('has no a11y violations', async () => {
    stubInvoke(mockedInvoke, { get_last_snapshot_ms: () => TAKEN_MS })
    const { container } = render(<SnapshotSection />)
    await screen.findByText(/Last snapshot:/)
    expect(await axe(container)).toHaveNoViolations()
  })
})
