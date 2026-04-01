/**
 * DeviceManagement — panel for managing device identity and paired peers (#219).
 *
 * Embeddable in Settings / Status area. Shows:
 *  - Local device ID
 *  - List of paired peers (with last-synced time, reset count)
 *  - "Pair New Device" button (opens PairingDialog)
 *  - "Sync Now" per peer
 *  - "Unpair" per peer with confirmation
 *
 * Follows StatusPanel.tsx layout patterns.
 */

import { Loader2, RefreshCw, Smartphone, Unplug } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatLastSynced, truncateId } from '@/lib/format'
import type { PeerRefRow } from '../lib/tauri'
import { cancelSync, deletePeerRef, getDeviceId, listPeerRefs, startSync } from '../lib/tauri'
import { PairingDialog } from './PairingDialog'
import { UnpairConfirmDialog } from './UnpairConfirmDialog'

export function DeviceManagement(): React.ReactElement {
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [peers, setPeers] = useState<PeerRefRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pairingOpen, setPairingOpen] = useState(false)
  const [unpairPeerId, setUnpairPeerId] = useState<string | null>(null)
  const [syncingPeerId, setSyncingPeerId] = useState<string | null>(null)
  const [syncingAll, setSyncingAll] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [id, peerList] = await Promise.all([getDeviceId(), listPeerRefs()])
      setDeviceId(id)
      setPeers(peerList)
    } catch (err) {
      console.error('Failed to load device info:', err)
      setError('Failed to load device info')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const handleUnpair = useCallback(async (peerId: string) => {
    try {
      await deletePeerRef(peerId)
      setPeers((prev) => prev.filter((p) => p.peer_id !== peerId))
      setUnpairPeerId(null)
    } catch (err) {
      console.error('Failed to unpair device:', err)
      setError('Failed to unpair device')
    }
  }, [])

  const handleSyncNow = useCallback(
    async (peerId: string) => {
      setSyncingPeerId(peerId)
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      try {
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Sync timed out')), 60000)
        })
        await Promise.race([startSync(peerId), timeout])
        await loadData()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Sync failed'
        console.error('Sync failed:', err)
        setError(message)
        if (message === 'Sync timed out') {
          await cancelSync()
        }
      } finally {
        clearTimeout(timeoutId)
      }
      setSyncingPeerId(null)
    },
    [loadData],
  )

  const handleSyncAll = useCallback(async () => {
    setSyncingAll(true)
    setError(null)
    for (const peer of peers) {
      setSyncingPeerId(peer.peer_id)
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      try {
        const syncTimeout = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Sync timed out')), 60000)
        })
        await Promise.race([startSync(peer.peer_id), syncTimeout])
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Sync failed'
        console.error(`Sync failed for ${peer.peer_id}:`, err)
        setError(message)
        if (message === 'Sync timed out') {
          await cancelSync()
        }
        break
      } finally {
        clearTimeout(timeoutId)
      }
      setSyncingPeerId(null)
    }
    await loadData()
    setSyncingAll(false)
  }, [peers, loadData])

  const handlePairingClose = useCallback(
    (open: boolean) => {
      setPairingOpen(open)
      if (!open) loadData()
    },
    [loadData],
  )

  return (
    <div className="device-management space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="device-management-title flex items-center gap-2 text-base">
            <Smartphone className="h-4 w-4" />
            Device Management
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading && !deviceId && (
            <div className="device-management-loading space-y-2">
              <Skeleton className="h-10 w-full rounded-lg" />
              <Skeleton className="h-10 w-full rounded-lg" />
            </div>
          )}

          {error && (
            <div
              className="device-management-error flex items-center gap-2 mb-3"
              aria-live="polite"
            >
              <p className="text-sm text-destructive">{error}</p>
              <Button variant="outline" size="sm" onClick={() => loadData()}>
                Retry
              </Button>
            </div>
          )}

          {deviceId && (
            <>
              {/* Local device ID */}
              <dl className="device-id-section rounded-lg border bg-muted/30 p-4 mb-4">
                <dt className="text-sm text-muted-foreground">Local Device ID</dt>
                <dd className="device-id-value text-sm font-mono mt-1 break-all">{deviceId}</dd>
              </dl>

              {/* Pair New Device button */}
              <Button
                onClick={() => setPairingOpen(true)}
                className="device-pair-btn w-full mb-4 [@media(pointer:coarse)]:min-h-[44px]"
              >
                Pair New Device
              </Button>

              {/* Paired peers list */}
              <div className="device-peers">
                <h3 className="text-sm font-medium mb-2">Paired Devices ({peers.length})</h3>

                {peers.length >= 2 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="device-sync-all-btn w-full mb-2 [@media(pointer:coarse)]:min-h-[44px]"
                    onClick={handleSyncAll}
                    disabled={syncingAll || syncingPeerId !== null}
                    aria-label="Sync with all paired devices"
                  >
                    {syncingAll ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Sync All
                  </Button>
                )}

                {peers.length === 0 ? (
                  <p className="device-no-peers text-sm text-muted-foreground">
                    No paired devices. Click "Pair New Device" to get started.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {peers.map((peer) => (
                      <div
                        key={peer.peer_id}
                        className="device-peer-item flex items-center justify-between rounded-lg border bg-card p-3 transition-colors hover:bg-accent/50"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0">
                            <p className="device-peer-id text-sm font-mono truncate">
                              {truncateId(peer.peer_id)}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Last: {formatLastSynced(peer.synced_at)}
                            </p>
                            {peer.reset_count > 0 && (
                              <Badge variant="outline" className="mt-0.5 text-xs">
                                {peer.reset_count} reset{peer.reset_count !== 1 ? 's' : ''}
                              </Badge>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            variant="outline"
                            size="sm"
                            className="device-sync-btn [@media(pointer:coarse)]:min-h-[44px]"
                            onClick={() => handleSyncNow(peer.peer_id)}
                            disabled={syncingPeerId === peer.peer_id || syncingAll}
                            aria-label={`Sync now with device ${truncateId(peer.peer_id)}`}
                          >
                            {syncingPeerId === peer.peer_id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="h-3.5 w-3.5" />
                            )}
                            Sync Now
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            className="device-unpair-btn [@media(pointer:coarse)]:min-h-[44px]"
                            onClick={() => setUnpairPeerId(peer.peer_id)}
                            aria-label={`Unpair device ${truncateId(peer.peer_id)}`}
                          >
                            <Unplug className="h-3.5 w-3.5" />
                            Unpair
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* Screen reader status announcements */}
          <div aria-live="polite" className="sr-only">
            {loading && !deviceId && 'Loading device information...'}
            {syncingPeerId && `Syncing with device ${syncingPeerId}...`}
            {syncingAll && 'Syncing with all paired devices...'}
          </div>
        </CardContent>
      </Card>

      {/* Pairing Dialog */}
      <PairingDialog open={pairingOpen} onOpenChange={handlePairingClose} />

      {/* Unpair confirmation dialog */}
      <UnpairConfirmDialog
        open={!!unpairPeerId}
        onOpenChange={(o) => {
          if (!o) setUnpairPeerId(null)
        }}
        onConfirm={() => {
          if (unpairPeerId) handleUnpair(unpairPeerId)
        }}
        className="device-unpair-confirm"
      />
    </div>
  )
}
