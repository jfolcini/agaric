/**
 * DeviceManagement — panel for managing device identity and paired peers (#219).
 *
 * Embeddable in Settings / Status area. Shows:
 *  - Local device ID
 *  - List of paired peers (with last-synced time, reset count)
 *  - `t('device.pairNewDeviceButton')` button (opens PairingDialog)
 *  - `t('device.syncNowButton')` per peer
 *  - `t('device.unpairButton')` per peer with confirmation
 *
 * Follows StatusPanel.tsx layout patterns.
 */

import { Copy, Globe, RefreshCw, ShieldAlert, Smartphone, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ListViewState } from '@/components/common/ListViewState'
import { PairingDialog } from '@/components/dialogs/PairingDialog'
import { RenameDialog } from '@/components/dialogs/RenameDialog'
import { UnpairConfirmDialog } from '@/components/dialogs/UnpairConfirmDialog'
import { PeerListItem } from '@/components/peers/PeerListItem'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { useBindExposure } from '@/hooks/useBindExposure'
import { useIpcCommand } from '@/hooks/useIpcCommand'
import { useMdnsStatus } from '@/hooks/useMdnsStatus'
import { mapPeerRefToInfo } from '@/hooks/useSyncTrigger'
import { useSyncWithTimeout } from '@/hooks/useSyncWithTimeout'
import { unwrap } from '@/lib/app-error'
import type { PeerRef } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { writeText } from '@/lib/clipboard'
import { formatErrorForDisplay } from '@/lib/error-display'
import { truncateId } from '@/lib/format'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { comparePeers } from '@/lib/peer-sync-activity'
import { PREFERENCES, usePreference } from '@/lib/preferences'
import { reportIpcError } from '@/lib/report-ipc-error'
import { startSync } from '@/lib/tauri'
import { useSyncStore } from '@/stores/sync'

export function DeviceManagement(): React.ReactElement {
  const { t } = useTranslation()
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [peers, setPeers] = useState<PeerRef[]>([])
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
  const mdnsStatus = useMdnsStatus()

  // #3864 — internet-facing sync bind. Dismissal is stored as the
  // acknowledged *address*, so a later bind to a different public address
  // warns again; see `PREFERENCES.internetFacingBindAck` for why it is
  // dismissible at all and why the port is not part of the key.
  const internetFacingBind = useBindExposure()
  const [acknowledgedBindAddress, setAcknowledgedBindAddress] = usePreference(
    PREFERENCES.internetFacingBindAck,
  )
  // Narrowed to one nullable value rather than a boolean + a null check, so
  // the render has a single condition and no second guard that can never be
  // the reason the banner is hidden.
  const unacknowledgedBind =
    internetFacingBind !== null && internetFacingBind.address !== acknowledgedBindAddress
      ? internetFacingBind
      : null

  // #437: Auto-clear stale errors after 10 seconds
  useEffect(() => {
    if (!error) return
    const id = setTimeout(() => setError(null), 10_000)
    return () => clearTimeout(id)
  }, [error])

  useEffect(() => {
    const id = setInterval(() => setTick((tick) => tick + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  // Load device id + peer list in parallel via the shared
  // useIpcCommand hook. Inline error display via `setError` (no toast —
  // matches existing behavior).
  const { execute: executeLoadData } = useIpcCommand<void, [string, PeerRef[]]>({
    call: () =>
      Promise.all([
        commands.getDeviceId().then((r) => unwrap(r)),
        commands.listPeerRefs().then((r) => unwrap(r)),
      ]),
    module: 'DeviceManagement',
    errorLogMessage: 'Failed to load device info',
    onSuccess: ([id, peerList]) => {
      setDeviceId(id)
      // #1673: Sort a COPY (don't mutate the IPC payload) with a total-order
      // comparator: named devices first (alphabetical), then unnamed by
      // last sync activity desc (#4084: MAX(synced_at, streamed_at)), with
      // peer_id as the final stable tiebreak.
      const sorted = [...peerList].toSorted(comparePeers)
      setPeers(sorted)
      // #1076: mirror the backend peer list into the shared sync store so
      // the StatusPanel Sync panel and the sidebar status dot reflect the
      // actual paired devices (they read `useSyncStore.peers`).
      useSyncStore.getState().setPeers(sorted.map(mapPeerRefToInfo))
    },
    onError: () => {
      setError(t('device.loadFailed'))
    },
  })

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    await executeLoadData()
    setLoading(false)
  }, [executeLoadData])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Unpair a peer device. The success path filters the row
  // out of the local list and closes the confirm dialog; on error we
  // surface an inline error banner (no toast — matches existing flow).
  const { execute: executeUnpair } = useIpcCommand<{ peerId: string }, void>({
    call: ({ peerId }) =>
      commands.deletePeerRef(peerId).then((r) => {
        unwrap(r)
      }),
    module: 'DeviceManagement',
    errorLogMessage: 'Failed to unpair device',
    onSuccess: (_result, { peerId }) => {
      setPeers((prev) => {
        const next = prev.filter((p) => p.peer_id !== peerId)
        // #1076: mirror the removal into the shared store so the sidebar
        // dot flips back to "no peers" the moment the last device unpairs.
        useSyncStore.getState().setPeers(next.map(mapPeerRefToInfo))
        return next
      })
      setUnpairPeerId(null)
    },
    onError: () => {
      setError(t('device.unpairFailed'))
    },
  })

  const handleUnpair = useCallback(
    async (peerId: string) => {
      await executeUnpair({ peerId })
    },
    [executeUnpair],
  )

  const handleSyncNow = useCallback(
    async (peerId: string) => {
      setSyncingPeerId(peerId)
      try {
        await executeSyncWithTimeout(async () => {
          await startSync(peerId)
        })
        await loadData()
      } catch (err) {
        const message = formatErrorForDisplay(err, { fallback: t('device.syncFailed') })
        const displayMessage = message === 'Sync timed out' ? t('device.syncTimedOut') : message
        logger.error('DeviceManagement', 'Sync failed', undefined, err)
        setError(displayMessage)
      }
      setSyncingPeerId(null)
    },
    [executeSyncWithTimeout, loadData, t],
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
        logger.error('DeviceManagement', `Sync failed for ${peer.peer_id}`, undefined, err)
        failures.push(peer.device_name || truncateId(peer.peer_id))
      }
      setSyncingPeerId(null)
    }
    const failureMessage =
      failures.length > 0 ? t('device.syncFailedForList', { devices: failures.join(', ') }) : null
    await loadData()
    if (failureMessage) {
      setError(failureMessage)
    }
    setSyncingAll(false)
  }, [peers, executeSyncWithTimeout, loadData, t])

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
        unwrap(await commands.updatePeerName(renamePeerId, name || null))
        await loadData()
      } catch (e) {
        setError(formatErrorForDisplay(e, { fallback: t('device.renameFailed') }))
      } finally {
        setRenamingPeerId(null)
        setRenamePeerId(null)
      }
    },
    [renamePeerId, loadData, t],
  )

  return (
    <div className="device-management space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="device-management-title flex items-center gap-2">
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
                <dt className="text-sm text-muted-foreground" data-testid="local-device-id-label">
                  {t('device.localDeviceIdLabel')}
                </dt>
                <dd className="device-id-value flex items-center gap-2 text-sm font-mono mt-1">
                  <span className="break-all" data-testid="local-device-id-value">
                    {deviceId}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 h-7 w-7 p-0"
                    onClick={async () => {
                      try {
                        await writeText(deviceId)
                        notify.success(t('device.deviceIdCopied'))
                      } catch (err) {
                        reportIpcError('DeviceManagement', 'device.copyFailed', err, t)
                      }
                    }}
                    aria-label={t('device.copyDeviceIdLabel')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </dd>
              </dl>

              {/* #2506 — mDNS-disabled banner. Only rendered once the daemon
                  has actually reported a failed init (live event or
                  mount-time backfill); the always-on hint below covers the
                  general "mDNS might be unavailable" case. */}
              {mdnsStatus.disabled && (
                <p
                  className="mdns-disabled-hint text-xs text-destructive mb-4"
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- block-level banner with mb-4 stacking; native <output> is inline-level and would collapse it
                  role="status"
                  data-testid="mdns-disabled-hint"
                >
                  <Globe className="inline h-3 w-3 mr-1 align-text-bottom" />
                  {t('device.mdnsDisabledHint', { reason: mdnsStatus.reason ?? '' })}
                </p>
              )}

              {/* #3864 — internet-facing sync bind. Rendered only once the
                  daemon has reported a globally-routable bind AND the user has
                  not already acknowledged that exact address; a notice a user
                  cannot clear is a notice they stop reading, and the reporting
                  maintainer's own desktop hits this branch on every boot. */}
              {unacknowledgedBind !== null && (
                <div
                  className="internet-facing-bind-hint rounded-md border border-destructive/40 p-3 mb-4"
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- block-level banner with mb-4 stacking; native <output> is inline-level and would collapse it
                  role="status"
                  data-testid="internet-facing-bind-hint"
                >
                  <p className="text-xs text-destructive">
                    <ShieldAlert className="inline h-3 w-3 mr-1 align-text-bottom" />
                    {t('device.internetFacingBindHint', {
                      address: unacknowledgedBind.address,
                      port: unacknowledgedBind.port,
                    })}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="internet-facing-bind-dismiss mt-2 h-7 text-xs"
                    onClick={() => setAcknowledgedBindAddress(unacknowledgedBind.address)}
                    aria-label={t('device.internetFacingBindAckLabel')}
                    data-testid="internet-facing-bind-dismiss"
                  >
                    {t('device.internetFacingBindAck')}
                  </Button>
                </div>
              )}

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
                    <p
                      className="device-no-peers text-sm text-muted-foreground"
                      data-testid="device-no-peers"
                    >
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
