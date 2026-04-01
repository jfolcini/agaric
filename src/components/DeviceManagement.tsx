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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import type { PeerRefRow } from '../lib/tauri'
import { deletePeerRef, getDeviceId, listPeerRefs, startSync } from '../lib/tauri'
import { PairingDialog } from './PairingDialog'

export function DeviceManagement(): React.ReactElement {
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [peers, setPeers] = useState<PeerRefRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pairingOpen, setPairingOpen] = useState(false)
  const [unpairPeerId, setUnpairPeerId] = useState<string | null>(null)
  const [syncingPeerId, setSyncingPeerId] = useState<string | null>(null)

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

  const handleSyncNow = useCallback(async (peerId: string) => {
    setSyncingPeerId(peerId)
    try {
      await startSync(peerId)
    } catch (err) {
      console.error('Sync failed:', err)
      setError('Sync failed')
    }
    setSyncingPeerId(null)
  }, [])

  function formatLastSynced(syncedAt: string | null): string {
    if (!syncedAt) return 'Never synced'
    try {
      const date = new Date(syncedAt)
      const now = new Date()
      const diffMs = now.getTime() - date.getTime()
      const diffMin = Math.floor(diffMs / 60000)
      if (diffMin < 1) return 'Just now'
      if (diffMin < 60) return `${diffMin} min ago`
      const diffHours = Math.floor(diffMin / 60)
      if (diffHours < 24) return `${diffHours}h ago`
      const diffDays = Math.floor(diffHours / 24)
      return `${diffDays}d ago`
    } catch {
      return syncedAt
    }
  }

  function truncateId(id: string, len = 12): string {
    if (id.length <= len) return id
    return `${id.slice(0, len)}...`
  }

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
            <p className="device-management-error text-sm text-destructive mb-3" aria-live="polite">
              {error}
            </p>
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
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="outline"
                            size="sm"
                            className="device-sync-btn [@media(pointer:coarse)]:min-h-[44px]"
                            onClick={() => handleSyncNow(peer.peer_id)}
                            disabled={syncingPeerId === peer.peer_id}
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
          </div>
        </CardContent>
      </Card>

      {/* Pairing Dialog */}
      <PairingDialog open={pairingOpen} onOpenChange={setPairingOpen} />

      {/* Unpair confirmation dialog */}
      <AlertDialog
        open={!!unpairPeerId}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) setUnpairPeerId(null)
        }}
      >
        <AlertDialogContent className="device-unpair-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Unpair device?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the paired device. You will need to pair again to sync.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="device-unpair-yes"
              onClick={() => {
                if (unpairPeerId) handleUnpair(unpairPeerId)
              }}
            >
              Yes, unpair
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
