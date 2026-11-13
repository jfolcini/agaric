/**
 * LocalSyncAddress — where this device's sync endpoint listens (#6526).
 *
 * The address a paired device's manual `host:port` field takes when the two do
 * not find each other over mDNS. Read on mount from the daemon's bound
 * endpoint; nothing is shown while the daemon has bound none (no paired
 * device yet). On the loopback fallback the row says there is no local
 * network, since no device can reach that address.
 *
 * Rendered by `DeviceManagement`, above the device ID.
 */

import type React from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingRow } from '@/components/ui/setting-row'
import { unwrap } from '@/lib/app-error'
import type { LocalSyncAddress as BoundAddress } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'

export function LocalSyncAddress(): React.ReactElement | null {
  const { t } = useTranslation()
  const [bound, setBound] = useState<BoundAddress | null>(null)

  useEffect(() => {
    let cancelled = false
    commands
      .getLocalSyncAddress()
      .then((res) => {
        const address = unwrap(res)
        if (!cancelled) setBound(address)
      })
      .catch((err: unknown) => {
        logger.warn('LocalSyncAddress', 'getLocalSyncAddress() rejected', undefined, err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (bound === null) return null
  return (
    <SettingRow
      className="mb-4"
      label={t('device.localAddressLabel')}
      description={
        bound.loopback ? t('device.localAddressNoNetwork') : t('device.localAddressDescription')
      }
    >
      {bound.loopback ? null : (
        <span className="font-mono text-sm" data-testid="local-sync-address">
          {bound.address}
        </span>
      )}
    </SettingRow>
  )
}
