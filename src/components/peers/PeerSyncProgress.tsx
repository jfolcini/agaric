/**
 * PeerSyncProgress — one paired device's running session, in its device row
 * (#5842): sync messages sent and received, then the attachment exchange with
 * files and bytes done of total. Nothing renders once the session ends.
 *
 * The progress arrives over the `startSync` channel, so it shows for sessions
 * this app started (Sync now, Sync all, and `useSyncTrigger`'s own runs). A
 * session the other device dialled in reports nothing here: the daemon's
 * `sync:progress` event carries op counts only, never the attachment bytes.
 */

import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { formatBytes } from '@/lib/format'
import { useSyncStore } from '@/stores/sync'

/** How often the screen-reader copy may change, so a fast transfer does not flood it. */
export const LIVE_REGION_INTERVAL_MS = 3000

export function PeerSyncProgress({
  peerId,
  name,
}: {
  peerId: string
  name: string
}): React.ReactElement {
  const { t } = useTranslation()
  const progress = useSyncStore((s) => s.peerProgress[peerId])

  let text = ''
  if (progress?.phase === 'ops') {
    text = t('device.syncProgressOps', { sent: progress.opsSent, received: progress.opsReceived })
  } else if (progress != null) {
    text = t(
      progress.phase === 'sending' ? 'device.syncProgressSending' : 'device.syncProgressReceiving',
      {
        filesDone: progress.filesDone,
        filesTotal: progress.filesTotal,
        bytesDone: formatBytes(progress.bytesDone),
        bytesTotal: formatBytes(progress.bytesTotal),
      },
    )
  }

  const [spoken, setSpoken] = useState(text)
  const lastSpokenAt = useRef(0)
  useEffect(() => {
    const wait = Math.max(0, lastSpokenAt.current + LIVE_REGION_INTERVAL_MS - Date.now())
    const timer = setTimeout(() => {
      lastSpokenAt.current = Date.now()
      setSpoken(text)
    }, wait)
    return () => clearTimeout(timer)
  }, [text])

  return (
    <>
      {progress != null && (
        <div className="device-peer-progress space-y-1">
          {/* Hidden from screen readers, which read the throttled copy below. */}
          <p className="text-xs text-muted-foreground truncate" aria-hidden="true">
            {text}
          </p>
          {progress.phase !== 'ops' && progress.bytesTotal > 0 && (
            <progress
              className="h-1 w-full"
              aria-label={t('device.syncProgressBarLabel', { name })}
              value={progress.bytesDone}
              max={progress.bytesTotal}
            />
          )}
        </div>
      )}
      {/* `output` is a polite live region (role `status`), always mounted: one that
          appears with its text is often not read. */}
      <output className="sr-only">{spoken}</output>
    </>
  )
}
