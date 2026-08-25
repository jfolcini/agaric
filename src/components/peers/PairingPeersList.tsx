/**
 * PairingPeersList -- list of paired devices for the pairing dialog.
 *
 * Renders each known peer with its ID, last-sync time, reset badge, and an
 * Unpair button.
 *
 * Extracted from PairingDialog (#R-9).
 */

import { Smartphone } from 'lucide-react'
import type React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import type { PeerRef } from '@/lib/bindings'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { peerDisplayName } from '@/lib/peer-display-name'
import { comparePeers, lastSyncActivityAt } from '@/lib/peer-sync-activity'

export interface PairingPeersListProps {
  peers: PeerRef[]
  onUnpair: (peerId: string) => void
}

export function PairingPeersList({ peers, onUnpair }: PairingPeersListProps): React.ReactElement {
  const { t } = useTranslation()

  // #4084 (review) — sort here, exactly as `DeviceManagement` does on load.
  // The prop arrives straight from `list_peer_refs`, whose `ORDER BY
  // synced_at DESC` puts NULLs last under SQLite's DESC collation — so a
  // responder-only peer displayed "Last: 5 minutes ago" (from the
  // `MAX(synced_at, streamed_at)` fold below) while sitting at the very
  // bottom among the peers that genuinely never synced. Sorting inside the
  // component rather than at the one call site keeps the display order a
  // property of the list, so a future second caller cannot reintroduce the
  // split. Sorts a COPY — the prop belongs to the caller.
  const sortedPeers = useMemo(() => [...peers].toSorted(comparePeers), [peers])

  return (
    <>
      <Separator className="my-4" />
      <div className="pairing-peers">
        <h3 className="text-sm font-medium mb-2">{t('pairing.pairedDevicesTitle')}</h3>
        {sortedPeers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('pairing.noPairedDevices')}</p>
        ) : (
          <ScrollArea className="max-h-48">
            <div className="space-y-2">
              {sortedPeers.map((peer) => {
                // #4084: the later of synced_at / streamed_at. A device that
                // only ever succeeds as RESPONDER never advances synced_at
                // (#610 forbids it) and would otherwise read "never synced"
                // while syncing fine.
                const lastActivity = lastSyncActivityAt(peer)
                return (
                  <Card key={peer.peer_id} className="pairing-peer-item p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          {/* #4298: name precedence — the user's override,
                              then the name the peer supplied over the wire,
                              then its truncated id, via the same
                              `peerDisplayName` the device list resolves
                              through, so the two never disagree about what to
                              call the same peer. A raw peer_id is a 36-char
                              UUID; at 360px the untruncated string pushed
                              Unpair off the screen edge, which is why the
                              fallback is truncated. `title` keeps the full id
                              available on hover / to assistive tech
                              regardless of which name is shown. */}
                          <p className="text-sm font-mono truncate" title={peer.peer_id}>
                            {peerDisplayName(peer)}
                          </p>
                          {peer.unpaired_by_peer_at_ms != null ? (
                            /*
                              #4297 — mirrors `PeerListItem`. This list must not
                              disagree with the device list about the same peer,
                              and this is the surface the user is looking at
                              when they re-pair, so it is the one place the
                              "pair again" instruction can be acted on
                              immediately.
                            */
                            <div className="pairing-peer-unpaired space-y-0.5">
                              <Badge tone="destructive" className="mt-0.5 text-xs">
                                {t('device.unpairedByPeerBadge')}
                              </Badge>
                              <p className="text-xs text-destructive">
                                {t('device.unpairedByPeerDescription')}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {t('device.unpairedByPeerSince', {
                                  time: formatRelativeTime(peer.unpaired_by_peer_at_ms, t),
                                })}
                              </p>
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground truncate">
                              {t('device.lastSyncedAt', {
                                time:
                                  lastActivity != null
                                    ? formatRelativeTime(lastActivity, t)
                                    : t('sidebar.lastSyncedNever'),
                              })}
                            </p>
                          )}
                          {peer.reset_count > 0 && (
                            <Badge tone="outline" className="mt-0.5 text-xs">
                              {t('device.resetCount', { count: peer.reset_count })}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => onUnpair(peer.peer_id)}
                        className="pairing-unpair-btn shrink-0 touch-target"
                      >
                        {t('device.unpairButton')}
                      </Button>
                    </div>
                  </Card>
                )
              })}
            </div>
          </ScrollArea>
        )}
      </div>
    </>
  )
}
