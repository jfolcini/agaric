/**
 * PeerListItem — renders a single paired peer/device card.
 *
 * Extracted from DeviceManagement to reduce component size.
 * Shows device name (or truncated ID), last-synced time, reset count badge,
 * address info, and action buttons (rename, sync, unpair).
 */

import { Globe, Pencil, RefreshCw, Smartphone, Unplug } from 'lucide-react'
import type React from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { formatLastSynced, truncateId } from '@/lib/format'
import type { PeerRefRow } from '../lib/tauri'
import { setPeerAddress } from '../lib/tauri'

export interface PeerListItemProps {
  peer: PeerRefRow
  syncingPeerId: string | null
  syncingAll: boolean
  renamingPeerId: string | null
  onSyncNow: (peerId: string) => void
  onUnpair: (peerId: string) => void
  onRename: (peerId: string) => void
  onAddressUpdated: () => void
}

export function PeerListItem({
  peer,
  syncingPeerId,
  syncingAll,
  renamingPeerId,
  onSyncNow,
  onUnpair,
  onRename,
  onAddressUpdated,
}: PeerListItemProps): React.ReactElement {
  const { t } = useTranslation()
  const [addrOpen, setAddrOpen] = useState(false)
  const [addrInput, setAddrInput] = useState('')

  const handleSaveAddress = useCallback(() => {
    const addr = addrInput.trim()
    if (!addr) return
    setPeerAddress(peer.peer_id, addr)
      .then(() => {
        toast.success(t('status.addressUpdated'))
        onAddressUpdated()
        setAddrOpen(false)
      })
      .catch(() => toast.error(t('status.addressInvalid')))
  }, [addrInput, peer.peer_id, t, onAddressUpdated])

  return (
    <div
      className="device-peer-item flex items-center justify-between rounded-lg
        border bg-card p-4 transition-colors hover:bg-accent/50 active:bg-accent/70"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="device-peer-name text-sm font-medium truncate">
            {peer.device_name || truncateId(peer.peer_id)}
          </p>
          {peer.device_name && (
            <p
              className="device-peer-id text-xs font-mono
              text-muted-foreground truncate"
            >
              {truncateId(peer.peer_id)}
            </p>
          )}
          <p className="text-xs text-muted-foreground">Last: {formatLastSynced(peer.synced_at)}</p>
          {peer.reset_count > 0 && (
            <Badge variant="outline" className="mt-0.5 text-xs">
              {peer.reset_count} reset{peer.reset_count !== 1 ? 's' : ''}
            </Badge>
          )}
          <div className="peer-address flex items-center gap-1 mt-0.5">
            <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="text-xs text-muted-foreground truncate">
              {peer.last_address ?? t('device.noAddress')}
            </span>
            <Popover
              open={addrOpen}
              onOpenChange={(open) => {
                setAddrOpen(open)
                if (open) setAddrInput(peer.last_address ?? '')
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="peer-address-edit"
                  aria-label={t('device.editAddressLabel', {
                    name: peer.device_name || truncateId(peer.peer_id),
                  })}
                >
                  <Pencil />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 max-w-[calc(100vw-2rem)] p-3 space-y-2" align="start">
                <p className="text-xs font-medium">{t('device.editAddressTitle')}</p>
                <Input
                  className="h-7 text-xs"
                  placeholder="192.168.1.100:5000"
                  value={addrInput}
                  onChange={(e) => setAddrInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleSaveAddress()
                    }
                  }}
                  aria-label={t('device.addressInputLabel')}
                />
                <p className="text-[10px] text-muted-foreground">{t('device.addressHint')}</p>
                <Button
                  size="sm"
                  className="w-full"
                  onClick={handleSaveAddress}
                  disabled={!addrInput.trim()}
                >
                  {t('device.saveAddressButton')}
                </Button>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        <Button
          variant="ghost"
          size="sm"
          className="device-rename-btn touch-target"
          onClick={() => onRename(peer.peer_id)}
          disabled={renamingPeerId === peer.peer_id}
          aria-label={t('device.renameDeviceLabel', {
            name: peer.device_name || truncateId(peer.peer_id),
          })}
        >
          {renamingPeerId === peer.peer_id ? <Spinner /> : <Pencil />}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="device-sync-btn touch-target"
          onClick={() => onSyncNow(peer.peer_id)}
          disabled={syncingPeerId === peer.peer_id || syncingAll}
          aria-label={t('device.syncNowLabel', {
            id: truncateId(peer.peer_id),
          })}
        >
          {syncingPeerId === peer.peer_id ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />}
          {t('device.syncNowButton')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="device-unpair-btn touch-target"
          onClick={() => onUnpair(peer.peer_id)}
          aria-label={t('device.unpairDeviceLabel', {
            id: truncateId(peer.peer_id),
          })}
        >
          <Unplug className="h-3.5 w-3.5" />
          {t('device.unpairButton')}
        </Button>
      </div>
    </div>
  )
}
