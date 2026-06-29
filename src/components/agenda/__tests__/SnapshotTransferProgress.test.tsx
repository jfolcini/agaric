/**
 * Tests for SnapshotTransferProgress (#2133).
 *
 * Validates:
 *  - Renders nothing when no snapshot transfer is active.
 *  - Renders a labelled determinate progress bar for sending/receiving.
 *  - Percentage derives from bytesDone/bytesTotal and clamps the edges.
 *  - Reacts to live store updates (interaction via the store setter).
 *  - a11y compliance (axe).
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import {
  SnapshotTransferProgress,
  snapshotProgressPercent,
} from '@/components/agenda/SnapshotTransferProgress'
import { t } from '@/lib/i18n'
import { useSyncStore } from '@/stores/sync'

beforeEach(() => {
  useSyncStore.getState().reset()
})

afterEach(() => {
  cleanup()
})

describe('snapshotProgressPercent', () => {
  it('rounds the ratio to an integer percentage', () => {
    expect(snapshotProgressPercent(5_000_000, 20_000_000)).toBe(25)
    expect(snapshotProgressPercent(1, 3)).toBe(33)
  })

  it('returns 0 for a zero-or-missing total (zero-size snapshot edge)', () => {
    expect(snapshotProgressPercent(0, 0)).toBe(0)
    expect(snapshotProgressPercent(10, 0)).toBe(0)
  })

  it('clamps to [0, 100]', () => {
    expect(snapshotProgressPercent(30, 10)).toBe(100)
    expect(snapshotProgressPercent(-5, 10)).toBe(0)
  })
})

describe('SnapshotTransferProgress', () => {
  it('renders nothing when no snapshot transfer is active', () => {
    render(<SnapshotTransferProgress />)
    expect(screen.queryByTestId('snapshot-transfer-progress')).not.toBeInTheDocument()
  })

  it('renders a labelled progress bar while receiving', () => {
    useSyncStore.getState().setSnapshotProgress('receiving', 5_000_000, 20_000_000)

    render(<SnapshotTransferProgress />)

    expect(screen.getByTestId('snapshot-transfer-progress')).toBeInTheDocument()
    expect(screen.getByText(t('status.snapshotReceiving'))).toBeInTheDocument()
    expect(screen.getByText(t('status.snapshotPercent', { percent: 25 }))).toBeInTheDocument()

    const bar = screen.getByRole('progressbar') as HTMLProgressElement
    expect(bar.value).toBe(25)
    expect(bar.max).toBe(100)
  })

  it('shows the sending label during the send phase', () => {
    useSyncStore.getState().setSnapshotProgress('sending', 2_500_000, 10_000_000)

    render(<SnapshotTransferProgress />)

    expect(screen.getByText(t('status.snapshotSending'))).toBeInTheDocument()
    expect((screen.getByRole('progressbar') as HTMLProgressElement).value).toBe(25)
  })

  it('reacts to live store updates and disappears on reset', async () => {
    useSyncStore.getState().setSnapshotProgress('receiving', 0, 10_000_000)

    render(<SnapshotTransferProgress />)
    expect((screen.getByRole('progressbar') as HTMLProgressElement).value).toBe(0)

    // Advance the transfer — the bar must track the new ratio.
    useSyncStore.getState().setSnapshotProgress('receiving', 5_000_000, 10_000_000)
    await waitFor(() => {
      expect((screen.getByRole('progressbar') as HTMLProgressElement).value).toBe(50)
    })

    // Terminal reset — the affordance disappears.
    useSyncStore.getState().resetSnapshotProgress()
    await waitFor(() => {
      expect(screen.queryByTestId('snapshot-transfer-progress')).not.toBeInTheDocument()
    })
  })

  it('renders a zero-percent bar for a zero-size snapshot', () => {
    useSyncStore.getState().setSnapshotProgress('receiving', 0, 0)

    render(<SnapshotTransferProgress />)

    expect((screen.getByRole('progressbar') as HTMLProgressElement).value).toBe(0)
    expect(screen.getByText(t('status.snapshotPercent', { percent: 0 }))).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    useSyncStore.getState().setSnapshotProgress('receiving', 5_000_000, 20_000_000)
    const { container } = render(<SnapshotTransferProgress />)
    await waitFor(
      async () => {
        expect(await axe(container)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})
