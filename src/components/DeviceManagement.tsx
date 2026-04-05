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

import { Copy, Globe, RefreshCw, Smartphone, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { truncateId } from '@/lib/format'
import { useSyncWithTimeout } from '../hooks/useSyncWithTimeout'
import type { PeerRefRow } from '../lib/tauri'
import { deletePeerRef, getDeviceId, listPeerRefs, startSync, updatePeerName } from '../lib/tauri'
import { ListViewState } from './ListViewState'
import { LoadingSkeleton } from './LoadingSkeleton'
import { PairingDialog } from './PairingDialog'
import { PeerListItem } from './PeerListItem'
import { RenameDialog } from './RenameDialog'
import { UnpairConfirmDialog } from './UnpairConfirmDialog'

export function DeviceManagement(): React.ReactElement {
  const { t } = useTranslation()
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [peers, setPeers] = useState<PeerRefRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pairingOpen, setPairingOpen] = useState(false)
  const [unpairPeerId, setUnpairPeerId] = useState<string | null>(null)
  const [syncingPeerId, setSyncingPeerId] = useState<string | null>(null)
  const [syncingAll, setSyncingAll] = useState(false)
  const [renamingPeerId, setRenamingPeerId] = useState<string | null>(null)
  const [renamePeerId, setRenamePeerId] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const { execute: executeSyncWithTimeout } = useSyncWithTimeout()

  // #437: Auto-clear stale errors after 10 seconds
  useEffect(() => {
    if (!error) return
    const id = setTimeout(() => setError(null), 10_000)
    return () => clearTimeout(id)
  }, [error])

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [id, peerList] = await Promise.all([getDeviceId(), listPeerRefs()])
      setDeviceId(id)
      // Sort: named devices first (alphabetical), then unnamed by synced_at
      peerList.sort((a, b) => {
        if (a.device_name && !b.device_name) return -1
        if (!a.device_name && b.device_name) return 1
        if (a.device_name && b.device_name) return a.device_name.localeCompare(b.device_name)
        return 0 // preserve backend synced_at ordering for unnamed peers
      })
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
      try {
        await executeSyncWithTimeout(async () => {
          await startSync(peerId)
        })
        await loadData()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Sync failed'
        const displayMessage =
          message === 'Sync timed out'
            ? 'Sync took too long — check your connection and try again'
            : message
        console.error('Sync failed:', err)
        setError(displayMessage)
      }
      setSyncingPeerId(null)
    },
    [executeSyncWithTimeout, loadData],
  )

  const handleSyncAll = useCallback(async () => {
    setSyncingAll(true)
    setError(null)
    const failures: string[] = []
    for (const peer of peers) {
      setSyncingPeerId(peer.peer_id)
      try {
        await executeSyncWithTimeout(async () => {
          await startSync(peer.peer_id)
        })
      } catch (err) {
        console.error(`Sync failed for ${peer.peer_id}:`, err)
        failures.push(peer.device_name || truncateId(peer.peer_id))
      }
      setSyncingPeerId(null)
    }
    const failureMessage = failures.length > 0 ? `Sync failed for: ${failures.join(', ')}` : null
    await loadData()
    if (failureMessage) {
      setError(failureMessage)
    }
    setSyncingAll(false)
  }, [peers, executeSyncWithTimeout, loadData])

  const handlePairingClose = useCallback(
    (open: boolean) => {
      setPairingOpen(open)
      if (!open) loadData()
    },
    [loadData],
  )

  const handleRename = useCallback(
    async (name: string) => {
      if (!renamePeerId) return
      setRenamingPeerId(renamePeerId)
      try {
        await updatePeerName(renamePeerId, name || null)
        await loadData()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to rename')
      } finally {
        setRenamingPeerId(null)
        setRenamePeerId(null)
      }
    },
    [renamePeerId, loadData],
  )

  return (
    <div className="device-management space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="device-management-title flex items-center gap-2 text-base">
            <Smartphone className="h-4 w-4" />
            {t('device.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading && !deviceId && (
            <div aria-busy="true">
              <LoadingSkeleton count={2} height="h-10" className="device-management-loading" />
            </div>
          )}

          {error && (
            <div
              className="device-management-error flex items-center gap-2 mb-3"
              aria-live="polite"
            >
              <p className="text-sm text-destructive flex-1">{error}</p>
              <Button variant="outline" size="sm" onClick={() => loadData()}>
                {t('device.retryButton')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setError(null)}
                aria-label={t('device.dismissErrorLabel')}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}

          {deviceId && (
            <>
              {/* Local device ID */}
              <dl className="device-id-section rounded-lg border bg-muted/30 p-4 mb-4">
                <dt className="text-sm text-muted-foreground">{t('device.localDeviceIdLabel')}</dt>
                <dd className="device-id-value flex items-center gap-2 text-sm font-mono mt-1">
                  <span className="break-all">{deviceId}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 h-7 w-7 p-0"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(deviceId)
                        toast.success(t('device.deviceIdCopied'))
                      } catch {
                        toast.error(t('device.copyFailed'))
                      }
                    }}
                    aria-label={t('device.copyDeviceIdLabel')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </dd>
              </dl>

              {/* Manual IP hint */}
              <p className="manual-ip-hint text-xs text-muted-foreground mb-4">
                <Globe className="inline h-3 w-3 mr-1 align-text-bottom" />
                {t('status.manualIpHint')}
              </p>

              {/* Pair New Device button */}
              <Button
                onClick={() => setPairingOpen(true)}
                className="device-pair-btn w-full mb-4 touch-target"
              >
                {t('device.pairNewDeviceButton')}
              </Button>

              {/* Paired peers list */}
              <div className="device-peers">
                <h3 className="text-sm font-medium mb-2">
                  {t('device.pairedDevicesTitle')} ({peers.length})
                </h3>

                {peers.length >= 2 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="device-sync-all-btn w-full mb-2 touch-target"
                    onClick={handleSyncAll}
                    disabled={syncingAll || syncingPeerId !== null}
                    aria-label={t('device.syncAllLabel')}
                  >
                    {syncingAll ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />}
                    {t('device.syncAllButton')}
                  </Button>
                )}

                <ListViewState
                  loading={loading}
                  items={peers}
                  skeleton={null}
                  empty={
                    <p className="device-no-peers text-sm text-muted-foreground">
                      {t('device.noPairedDevices')}
                    </p>
                  }
                >
                  {(items) => (
                    <div className="space-y-2">
                      {items.map((peer) => (
                        <PeerListItem
                          key={peer.peer_id}
                          peer={peer}
                          syncingPeerId={syncingPeerId}
                          syncingAll={syncingAll}
                          renamingPeerId={renamingPeerId}
                          onSyncNow={handleSyncNow}
                          onUnpair={(peerId) => setUnpairPeerId(peerId)}
                          onRename={(peerId) => setRenamePeerId(peerId)}
                          onAddressUpdated={loadData}
                        />
                      ))}
                    </div>
                  )}
                </ListViewState>
              </div>
            </>
          )}

          {/* Screen reader status announcements */}
          <div aria-live="polite" className="sr-only">
            {loading && !deviceId && t('device.loadingMessage')}
            {syncingPeerId && t('device.syncingMessage', { id: syncingPeerId })}
            {syncingAll && t('device.syncingAllMessage')}
            {error && t('device.syncErrorMessage', { error })}
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
        deviceName={
          peers.find((p) => p.peer_id === unpairPeerId)?.device_name ??
          truncateId(unpairPeerId ?? '')
        }
        className="device-unpair-confirm"
      />

      {/* Rename dialog (#422) */}
      <RenameDialog
        open={!!renamePeerId}
        onOpenChange={(o) => {
          if (!o) setRenamePeerId(null)
        }}
        onConfirm={handleRename}
        currentName={peers.find((p) => p.peer_id === renamePeerId)?.device_name ?? ''}
      />
    </div>
  )
}
