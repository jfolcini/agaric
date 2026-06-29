/**
 * SnapshotTransferProgress — surfaces snapshot catch-up streaming
 * progress in the Sync panel (#2133).
 *
 * The snapshot catch-up blob streams up to 256 MB over the sync
 * connection in 5 MB frames; the backend now emits per-frame
 * `SyncProgressUpdate::Snapshot` events that `useSyncTrigger` writes into
 * `useSyncStore` (`snapshotPhase` / `snapshotBytesDone` /
 * `snapshotBytesTotal`). This component renders a percentage label plus a
 * thin determinate progress bar, mirroring how attachment file-transfer
 * progress is shown.
 *
 * Renders `null` when no snapshot transfer is active (`snapshotPhase ===
 * null`), so it is inert during ordinary delta syncs.
 */

import { useTranslation } from 'react-i18next'

import { Spinner } from '@/components/ui/spinner'
import { useSyncStore } from '@/stores/sync'

/**
 * Clamp a bytes-done/bytes-total ratio to an integer percentage in
 * `[0, 100]`. A zero (or missing) total yields 0 rather than NaN/∞ so the
 * bar is well-defined on the zero-size snapshot edge.
 */
export function snapshotProgressPercent(bytesDone: number, bytesTotal: number): number {
  if (bytesTotal <= 0) return 0
  const pct = Math.round((bytesDone / bytesTotal) * 100)
  return Math.min(100, Math.max(0, pct))
}

export function SnapshotTransferProgress() {
  const phase = useSyncStore((s) => s.snapshotPhase)
  const bytesDone = useSyncStore((s) => s.snapshotBytesDone)
  const bytesTotal = useSyncStore((s) => s.snapshotBytesTotal)
  const { t } = useTranslation()

  // Inert when no snapshot transfer is active. `!phase` (not
  // `=== null`) so a consumer that omits the field entirely — e.g. a
  // partial store mock — is treated as "no transfer" rather than
  // rendering a NaN-valued bar.
  if (!phase) return null

  const percent = snapshotProgressPercent(bytesDone, bytesTotal)
  const label =
    phase === 'sending'
      ? t('status.snapshotSending')
      : phase === 'receiving'
        ? t('status.snapshotReceiving')
        : t('status.snapshotComplete')

  return (
    <div className="snapshot-transfer-progress space-y-1" data-testid="snapshot-transfer-progress">
      <div className="flex items-center gap-2 text-sm">
        <Spinner size="sm" />
        <span className="snapshot-transfer-label font-medium">{label}</span>
        <span className="snapshot-transfer-percent ml-auto tabular-nums text-muted-foreground">
          {t('status.snapshotPercent', { percent })}
        </span>
      </div>
      {/* No design-system Progress primitive yet — use the native
          <progress> element (the lint-approved, natively-accessible
          determinate bar), mirroring DataSettingsTab's import bars. */}
      <progress
        className="snapshot-transfer-bar w-full h-1.5"
        data-testid="snapshot-transfer-bar"
        aria-label={t('status.snapshotProgressLabel')}
        value={percent}
        max={100}
      />
    </div>
  )
}
