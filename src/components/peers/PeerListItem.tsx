/**
 * PeerListItem — renders a single paired peer/device card.
 *
 * Extracted from DeviceManagement to reduce component size.
 * Shows device name (or truncated ID), last-synced time, reset count badge,
 * address info, and action buttons (rename, sync, unpair).
 *
 * #4298: "device name" is now a precedence, not a column — the user's local
 * override, then the name the peer advertised over the wire, then the truncated
 * id. It is resolved once through `peerDisplayName` so the heading and every
 * aria-label in this card name the same device the same way.
 *
 * #4297: a peer that has unpaired US takes the place of the last-synced time
 * with a destructive "pairing lost" state, because that timestamp counts from
 * the last session that succeeded and would otherwise render a permanently
 * dead pairing as a healthy one.
 */

import { Globe, Pencil, RefreshCw, Smartphone, Unplug } from 'lucide-react'
import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { unwrap } from '@/lib/app-error'
import type { PeerRef } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { truncateId } from '@/lib/format'
import { formatRelativeTime } from '@/lib/format-relative-time'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { peerDisplayName, peerName } from '@/lib/peer-display-name'
import { lastSyncActivityAt } from '@/lib/peer-sync-activity'

export interface PeerListItemProps {
  peer: PeerRef
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

  // #4084 — see the comment at the render site.
  const lastActivityAt = lastSyncActivityAt(peer)

  // #4298 — what to call this device: the user's override, then the name the
  // peer supplied over the wire, then its truncated id. Resolved once so the
  // heading, the rename label and the address-edit label cannot disagree.
  const displayName = peerDisplayName(peer)

  // #4297 — non-null means this peer has told us, on the wire, that it holds
  // no pairing with this device: it was unpaired from the other end and this
  // side was never notified. See the render site.
  const unpairedByPeerAt = peer.unpaired_by_peer_at_ms

  // Real-time format validation for the address popover.
  // Empty input returns null so the freshly-opened popover stays quiet;
  // 'format' / 'port' are markers translated at render time.
  const addressError = useMemo<string | null>(() => {
    const trimmed = addrInput.trim()
    if (trimmed === '') return null
    const match = /^[\w.-]+:\d{1,5}$/.exec(trimmed)
    if (!match) return 'format'
    const port = Number.parseInt(trimmed.split(':')[1] ?? '', 10)
    if (Number.isNaN(port) || port < 1 || port > 65535) return 'port'
    return null
  }, [addrInput])

  const handleSaveAddress = useCallback(() => {
    const addr = addrInput.trim()
    if (!addr) return
    commands
      .setPeerAddress(peer.peer_id, addr)
      .then((result) => unwrap(result))
      .then(() => {
        notify.success(t('status.addressUpdated'))
        onAddressUpdated()
        setAddrOpen(false)
      })
      .catch((err) => {
        logger.warn('PeerListItem', 'set_peer_address failed', { peer_id: peer.peer_id }, err)
        // Include the expected format in the toast so the user
        // doesn't have to reopen the popover hint to recover.
        notify.error(t('status.addressInvalidWithFormat', { format: '192.168.1.100:5000' }))
      })
  }, [addrInput, peer.peer_id, t, onAddressUpdated])

  // Explicit Cancel button for the address-edit popover. Outside-
  // click already dismisses the popover, but Cancel makes the affordance
  // observable for keyboard / screen-reader users.
  const handleCancelAddress = useCallback(() => {
    setAddrOpen(false)
  }, [])

  return (
    // Mobile-first: the card stacks below `sm` and becomes a row at `sm:` and
    // up — the same shape `TrashRowItem` uses for this card idiom. On a 360px
    // phone the old single unstacking row let three `whitespace-nowrap`
    // buttons claim their width first, squeezing the device name to nothing
    // and wrapping "Last: …" over three lines.
    <div
      className="device-peer-item flex flex-col gap-3 rounded-lg border bg-card p-4
        transition-colors hover:bg-accent/50 active:bg-accent/70
        sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex w-full min-w-0 flex-col gap-1 sm:flex-1">
        <div className="flex min-w-0 items-start gap-3">
          <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            {/* The rename pencil lives on the NAME line, not in the action
                stack: it renames *this device*, and a full-width icon-only
                button in a stacked action column looks wrong. `ml-auto`
                right-aligns it against the card edge. */}
            <div className="flex min-w-0 items-center gap-2">
              <p className="device-peer-name min-w-0 text-sm font-medium truncate">{displayName}</p>
              <Button
                variant="ghost"
                size="sm"
                className="device-rename-btn touch-target ml-auto shrink-0"
                onClick={() => onRename(peer.peer_id)}
                disabled={renamingPeerId === peer.peer_id}
                aria-label={t('device.renameDeviceLabel', {
                  name: displayName,
                })}
              >
                {renamingPeerId === peer.peer_id ? <Spinner /> : <Pencil />}
              </Button>
            </div>
            {/* #4298: the id line is the SUBTITLE under a name, so it is shown
              whenever the row has a name to be the subtitle of — the user's
              override or, since #4298, the one the peer supplied. Keying it on
              `device_name` alone would drop the id from every peer-named row,
              which is the one place a user needs it to tell two identically
              named devices apart. Gating on a name at all is what stops it
              rendering twice on an unnamed row, where the name line IS the
              truncated id. */}
            {peerName(peer) != null && (
              <p
                className="device-peer-id text-xs font-mono
                text-muted-foreground truncate"
              >
                {truncateId(peer.peer_id)}
              </p>
            )}
            {unpairedByPeerAt != null ? (
              /*
                #4297 — the device on the other end unpaired, and unpairing
                sends nothing over the wire: the local row is simply deleted
                there. The only evidence this side ever gets is that every dial
                it makes is refused, which the daemon now records on the row.

                The `Last:` line is REPLACED rather than kept alongside,
                because it is the thing actively lying. It renders
                MAX(synced_at, streamed_at) — the last session that *worked* —
                so it keeps counting up and a pairing dead for a week still
                reads "Last: 6 days ago" next to a device that will never sync
                again. The timestamp shown instead is when we found out, which
                is the one instant on this row that stays true.
              */
              <div className="device-peer-unpaired space-y-0.5">
                <Badge tone="destructive" className="mt-0.5 text-xs">
                  <Unplug className="h-3 w-3" />
                  {t('device.unpairedByPeerBadge')}
                </Badge>
                <p className="text-xs text-destructive" role="alert">
                  {t('device.unpairedByPeerDescription')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('device.unpairedByPeerSince', {
                    time: formatRelativeTime(unpairedByPeerAt, t),
                  })}
                </p>
              </div>
            ) : (
              /* `truncate` (not plain wrapping): in a narrow column the
                 relative-time string used to break over three lines and make
                 the card twice as tall as its own content. */
              <p className="text-xs text-muted-foreground truncate">
                {/*
                  #4084 — the later of `synced_at` (we pulled) and
                  `streamed_at` (they pulled from us), not `synced_at` alone. A
                  session is one-directional and #610 forbids the streamer
                  advancing `synced_at`, so a device that only ever succeeds as
                  responder used to render "never synced" while syncing
                  perfectly.
                */}
                {t('device.lastSyncedAt', {
                  time:
                    lastActivityAt != null
                      ? formatRelativeTime(lastActivityAt, t)
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
        {/* The address line is a sibling of the name column, not a child of
            it: its edit pencil inflates to 44×44 under `pointer:coarse`, and
            inside the name column that width came straight out of the device
            name. `pl-7` (icon 1rem + gap 0.75rem) keeps it visually aligned
            under the name. */}
        <div className="peer-address flex min-w-0 items-center gap-1 pl-7">
          <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 text-xs text-muted-foreground truncate">
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
                  name: displayName,
                })}
              >
                <Pencil />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-64 max-w-[calc(100vw-2rem)] p-3 space-y-2"
              align="start"
              aria-label={t('device.editAddressPopoverLabel')}
            >
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
                aria-invalid={addressError != null}
                aria-describedby={addressError != null ? 'peer-address-error' : undefined}
              />
              {/* inline format validation. Disables Save and
                    surfaces the format / port error before the user
                    has to round-trip through the toast path. */}
              {addressError && (
                <p id="peer-address-error" className="text-xs text-destructive" role="alert">
                  {t(
                    addressError === 'port'
                      ? 'device.addressPortInvalid'
                      : 'device.addressFormatInvalid',
                  )}
                </p>
              )}
              {/* bumped from text-xs to text-xs (12px) so
                    the format example is legible at default zoom. */}
              <p className="text-xs text-muted-foreground">{t('device.addressHint')}</p>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="peer-address-cancel flex-1"
                  onClick={handleCancelAddress}
                >
                  {t('device.cancelAddressButton')}
                </Button>
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={handleSaveAddress}
                  disabled={!addrInput.trim() || addressError != null}
                >
                  {t('device.saveAddressButton')}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {/* Measured in a real browser: at a 360px viewport this card is only
          230px wide (the 48px mobile rail + panel/card padding eat the rest),
          leaving ~196px of action area — while `Sync Now` + `Unpair` need
          264px side by side. So they stack full-width on mobile, the idiom
          this panel already uses for `.device-pair-btn` / `.device-sync-all-btn`
          and `PairingEntryForm`. They return to a row at `sm:` and up.
          NB: no `touch-target` here — its `min-width:44px` would replace the
          flex item's implicit `min-width:auto` and let a button shrink below
          its own `whitespace-nowrap` label. `size="sm"` already supplies the
          44px height via `[@media(pointer:coarse)]:h-11`. */}
      <div
        className="device-peer-actions flex w-full flex-col gap-2
          sm:w-auto sm:shrink-0 sm:flex-row sm:items-center"
      >
        <Button
          variant="outline"
          size="sm"
          className="device-sync-btn w-full sm:w-auto"
          onClick={() => onSyncNow(peer.peer_id)}
          disabled={syncingPeerId === peer.peer_id || syncingAll}
          aria-label={t('device.syncNowLabel', {
            name: displayName,
          })}
        >
          {syncingPeerId === peer.peer_id ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />}
          {t('device.syncNowButton')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="device-unpair-btn w-full sm:w-auto"
          onClick={() => onUnpair(peer.peer_id)}
          aria-label={t('device.unpairDeviceLabel', {
            name: displayName,
          })}
        >
          <Unplug className="h-3.5 w-3.5" />
          {t('device.unpairButton')}
        </Button>
      </div>
    </div>
  )
}
