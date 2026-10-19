/**
 * The running session's progress in a paired device's row (#5842), rendered
 * through `PeerListItem` from the sync store's per-peer entry.
 */

import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { PeerListItem } from '@/components/peers/PeerListItem'
import { LIVE_REGION_INTERVAL_MS } from '@/components/peers/PeerSyncProgress'
import type { PeerRef, SyncProgressUpdate } from '@/lib/bindings'
import { useSyncStore } from '@/stores/sync'

const PEER_ID = 'PEER_PROGRESS_1'

const peer: PeerRef = {
  peer_id: PEER_ID,
  last_hash: null,
  last_sent_hash: null,
  streamed_at: null,
  synced_at: null,
  reset_count: 0,
  last_reset_at: null,
  cert_hash: null,
  device_name: 'Phone',
  remote_device_name: null,
  last_address: null,
  endpoint_id: null,
  unpaired_by_peer_at_ms: null,
}

function renderRow() {
  return render(
    <PeerListItem
      peer={peer}
      syncingPeerId={null}
      syncingAll={false}
      renamingPeerId={null}
      onSyncNow={vi.fn()}
      onUnpair={vi.fn()}
      onRename={vi.fn()}
      onAddressUpdated={vi.fn()}
    />,
  )
}

function report(update: SyncProgressUpdate, peerId = PEER_ID) {
  act(() => useSyncStore.getState().recordPeerProgress(peerId, update))
}

const ops = (state: string, sent: number, received: number): SyncProgressUpdate => ({
  kind: 'sync',
  state,
  remote_device_id: PEER_ID,
  ops_sent: sent,
  ops_received: received,
})

const files = (phase: string, filesDone: number, bytesDone: number): SyncProgressUpdate => ({
  kind: 'files',
  phase,
  remote_device_id: PEER_ID,
  files_done: filesDone,
  files_total: 4,
  bytes_done: bytesDone,
  bytes_total: 4096,
})

const liveRegion = () => screen.getByRole('status')

beforeEach(() => {
  useSyncStore.getState().reset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PeerSyncProgress in the device row', () => {
  it('shows nothing while the peer is not syncing', () => {
    renderRow()

    expect(screen.queryByText(/^Syncing:/)).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(liveRegion()).toHaveTextContent('')
  })

  it('shows the messages sent and received during the op phase', () => {
    renderRow()
    report(ops('streaming', 3, 2))

    expect(screen.getByText('Syncing: 3 messages sent, 2 received')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('ignores another peer', () => {
    renderRow()
    report(ops('streaming', 3, 2), 'SOME_OTHER_PEER')

    expect(screen.queryByText(/^Syncing:/)).not.toBeInTheDocument()
  })

  it('shows files and bytes with a determinate progressbar during the attachment phase', () => {
    renderRow()
    report(files('receiving', 1, 1024))

    expect(
      screen.getByText('Receiving attachments: 1 of 4 files, 1.0 KB of 4.0 KB'),
    ).toBeInTheDocument()
    const bar = screen.getByRole<HTMLProgressElement>('progressbar', {
      name: 'Attachment transfer with Phone',
    })
    expect(bar.value).toBe(1024)
    expect(bar.max).toBe(4096)
  })

  it('clears the row when the session completes', () => {
    renderRow()
    report(ops('streaming', 1, 1))
    report(ops('complete', 2, 2))
    expect(screen.queryByText(/^Syncing:/)).not.toBeInTheDocument()

    report(files('sending', 0, 0))
    report(files('complete', 4, 4096))
    expect(screen.queryByText(/^Sending attachments:/)).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('changes the screen-reader copy at most once per interval, ending on the latest', () => {
    vi.useFakeTimers()
    renderRow()

    report(files('receiving', 1, 1024))
    act(() => {
      vi.advanceTimersByTime(0)
    })
    expect(liveRegion()).toHaveTextContent('Receiving attachments: 1 of 4 files')

    report(files('receiving', 2, 2048))
    report(files('receiving', 3, 3072))
    act(() => {
      vi.advanceTimersByTime(LIVE_REGION_INTERVAL_MS - 1)
    })
    expect(liveRegion()).toHaveTextContent('Receiving attachments: 1 of 4 files')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(liveRegion()).toHaveTextContent('Receiving attachments: 3 of 4 files')
  })

  it('has no a11y violations mid-transfer', async () => {
    const { container } = renderRow()
    report(files('sending', 2, 2048))

    expect(await axe(container)).toHaveNoViolations()
  })
})
