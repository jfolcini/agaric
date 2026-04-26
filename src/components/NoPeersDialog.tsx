/**
 * NoPeersDialog — sidebar Sync click guard (BUG-2).
 *
 * The sidebar Sync button is the user's primary signpost for "I want to
 * sync now". When no devices are paired, `useSyncTrigger.syncAll()`
 * silently short-circuits at the `peers.length === 0` branch — the
 * button click looks like a no-op and there's no path to the pairing
 * flow.
 *
 * This dialog is the UI-side guard: if the user clicks Sync and there
 * are zero paired peers, App opens this dialog instead of firing the
 * hook. It explains the situation in plain English and offers a primary
 * CTA that navigates to Settings → Sync where the pairing UI lives.
 *
 * The hook itself is unchanged — its empty-peers short-circuit stays in
 * place as defense-in-depth so a code path that bypasses the dialog
 * (a future hotkey, deep-link, etc.) still won't toast spurious
 * "Sync complete".
 *
 * Built on top of `ConfirmDialog` (Radix AlertDialog) — same a11y guarantees
 * (focus trap, ESC to dismiss, ARIA title/description) as every other
 * confirmation dialog in the app, with no per-component primitive
 * reinvention. All copy is i18n-keyed (`sync.noPeers*`).
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/ConfirmDialog'

interface NoPeersDialogProps {
  /** Whether the dialog is open. */
  open: boolean
  /** Open-state controller (closes via Cancel / ESC / overlay click). */
  onOpenChange: (open: boolean) => void
  /**
   * Invoked when the user clicks the primary "Open sync settings" CTA.
   * The parent is responsible for closing the dialog and navigating to
   * Settings → Sync — this component is a pure UI affordance with no
   * navigation knowledge of its own.
   */
  onOpenSettings: () => void
}

/**
 * Discoverable replacement for the silent `peers.length === 0` no-op
 * (BUG-2). Pure presentational — all behaviour is driven by the parent
 * via props.
 */
export function NoPeersDialog({
  open,
  onOpenChange,
  onOpenSettings,
}: NoPeersDialogProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('sync.noPeersTitle')}
      description={t('sync.noPeersBody')}
      cancelLabel={t('sync.noPeersCancel')}
      actionLabel={t('sync.noPeersCta')}
      onAction={onOpenSettings}
      contentTestId="no-peers-dialog"
      cancelTestId="no-peers-dialog-cancel"
      actionTestId="no-peers-dialog-open-settings"
    />
  )
}
