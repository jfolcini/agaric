/**
 * InternetRelaySetting — the opt-in internet fallback for sync (#4549).
 *
 * One device-local `app_settings` row (`commands.getSyncRelaySettings` /
 * `setSyncRelaySettings`), off by default. When on, the sync daemon binds its
 * endpoint with iroh's relay transport against one pinned relay, so two devices
 * on a LAN a VPN tunnel has captured — discovery works, every unicast dial dies —
 * still have a path. The daemon reads the row once at start, so the copy says
 * the change takes effect at the next launch.
 *
 * Rendered by `DeviceManagement`, above the paired-devices list.
 */

import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ToggleRow } from '@/components/ui/toggle-row'
import { unwrap } from '@/lib/app-error'
import type { SyncRelaySettings } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

/** Mirrors `SyncRelaySettings::default()` in `src-tauri/src/commands/sync_cmds.rs`. */
const DEFAULT_SETTINGS: SyncRelaySettings = { enabled: false }

export function InternetRelaySetting(): React.ReactElement {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<SyncRelaySettings>(DEFAULT_SETTINGS)
  // The switch is live before the initial load resolves. A save in that window
  // is the newer fact, so a load that lands afterwards must not overwrite it
  // (#5135 review: the row was persisted on while the UI showed off).
  const savedRef = useRef(false)

  /** The stored row, or `null` once its failure has been reported. */
  const readStored = useCallback(async (): Promise<SyncRelaySettings | null> => {
    try {
      return unwrap(await commands.getSyncRelaySettings())
    } catch (err) {
      logger.warn('InternetRelaySetting', 'loading the relay setting failed', undefined, err)
      notify.error(t('device.internetRelayLoadFailed'))
      return null
    }
  }, [t])

  useEffect(() => {
    let cancelled = false
    void readStored().then((loaded) => {
      if (loaded && !cancelled && !savedRef.current) setSettings(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [readStored])

  const save = useCallback(
    async (next: SyncRelaySettings) => {
      const previous = settings
      savedRef.current = true
      setSettings(next)
      try {
        unwrap(await commands.setSyncRelaySettings(next))
      } catch (err) {
        logger.warn('InternetRelaySetting', 'saving the relay setting failed', undefined, err)
        notify.error(t('device.internetRelaySaveFailed'))
        // `previous` is a guess at the row: the initial load may have landed
        // (and been suppressed) meanwhile. Re-read rather than guess.
        setSettings((await readStored()) ?? previous)
      }
    },
    [readStored, settings, t],
  )

  return (
    <div className="mb-4">
      <ToggleRow
        id="internet-relay-enabled"
        label={t('device.internetRelayLabel')}
        description={t('device.internetRelayDescription')}
        checked={settings.enabled}
        onCheckedChange={(checked) => void save({ enabled: checked })}
        data-testid="internet-relay-switch"
      />
    </div>
  )
}
