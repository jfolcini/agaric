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
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { formatLastSynced } from '@/lib/format'
import type { PeerRefRow } from '../lib/tauri'

export interface PairingPeersListProps {
  peers: PeerRefRow[]
  onUnpair: (peerId: string) => void
}

export function PairingPeersList({ peers, onUnpair }: PairingPeersListProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <>
      <Separator className="my-4" />
      <div className="pairing-peers">
        <h3 className="text-sm font-medium mb-2">{t('pairing.pairedDevicesTitle')}</h3>
        {peers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('pairing.noPairedDevices')}</p>
        ) : (
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {peers.map((peer) => (
              <Card key={peer.peer_id} className="pairing-peer-item p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="text-sm font-mono truncate">{peer.peer_id}</p>
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
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => onUnpair(peer.peer_id)}
                    className="pairing-unpair-btn shrink-0 touch-target"
                  >
                    Unpair
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
