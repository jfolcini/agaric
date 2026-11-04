import type React from 'react'
import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import type { RecordingPlayer } from '@/components/attachments/AttachmentAudio'
import {
  currentSegmentIndex,
  parseTranscript,
  type TranscriptSegment,
} from '@/components/attachments/transcript'
import { renderRichContent } from '@/components/RichContentRenderer'
import { Button } from '@/components/ui/button'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import type { AttachmentRow } from '@/lib/bindings'
import { readAttachment } from '@/lib/ipc-helpers'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'

const unsubscribeNothing = () => {}

/**
 * Memoized so a `timeupdate` that moves the playhead to the next segment
 * re-renders only the two rows whose `current` changed: a two-hour transcript
 * has well over a thousand.
 */
const TranscriptRow = memo(
  ({
    segment,
    current,
    onSeek,
  }: {
    segment: TranscriptSegment
    current: boolean
    onSeek: (seconds: number) => void
  }): React.ReactElement => {
    const { t } = useTranslation()
    const { start, label, markdown } = segment
    return (
      <li
        data-testid="transcript-segment"
        aria-current={current ? 'true' : undefined}
        className={cn(
          'flex items-baseline gap-2 rounded-md px-1',
          current && 'bg-accent text-accent-foreground',
        )}
      >
        {start !== null && (
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 tabular-nums"
            aria-label={t('attachment.seekTo', { time: label })}
            onClick={(e) => {
              e.stopPropagation()
              onSeek(start)
            }}
          >
            {label}
          </Button>
        )}
        <div className="min-w-0 break-words">
          {renderRichContent(markdown, { interactive: false })}
        </div>
      </li>
    )
  },
)

/**
 * A recording's `.transcript.md` (#5410), collapsed until opened. Each
 * timestamped paragraph (format: `transcript.ts`) gets a button that seeks the
 * block's player, and the segment under the playhead is marked current while
 * the transcript is open. A transcript with no timestamps renders as plain
 * Markdown. The bytes are read on first opening; a failed read shows
 * `fallback`.
 */
export function TranscriptAttachment({
  att,
  player,
  fallback,
}: {
  att: Pick<AttachmentRow, 'id' | 'filename'>
  player: RecordingPlayer
  fallback: React.ReactNode
}): React.ReactNode {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!expanded || text !== null) return
    let cancelled = false
    readAttachment(att.id)
      .then((bytes) => {
        if (!cancelled) setText(new TextDecoder('utf-8').decode(bytes))
      })
      .catch((err) => {
        if (cancelled) return
        logger.warn('TranscriptAttachment', 'read transcript bytes failed', { id: att.id }, err)
        setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [att.id, expanded, text])

  const segments = useMemo(() => (text === null ? null : parseTranscript(text)), [text])
  const timed = useMemo(() => {
    const rows: number[] = []
    const starts: number[] = []
    segments?.forEach(({ start }, row) => {
      if (start === null) return
      rows.push(row)
      starts.push(start)
    })
    return { rows, starts }
  }, [segments])

  const { audio, seek } = player
  const subscribe = useCallback(
    (onTimeChange: () => void) => {
      if (!expanded || !audio) return unsubscribeNothing
      audio.addEventListener('timeupdate', onTimeChange)
      return () => audio.removeEventListener('timeupdate', onTimeChange)
    },
    [audio, expanded],
  )
  const currentRow = useSyncExternalStore(subscribe, () =>
    expanded && audio
      ? (timed.rows[currentSegmentIndex(timed.starts, audio.currentTime)] ?? -1)
      : -1,
  )

  if (error) return fallback

  return (
    <div
      className="w-full max-w-full overflow-hidden rounded-md border border-border bg-muted/30 text-left"
      data-testid="transcript-attachment"
    >
      <div className="flex items-center gap-1.5 px-1 py-0.5 text-xs text-muted-foreground">
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation()
            setExpanded((open) => !open)
          }}
        >
          <ChevronToggle isExpanded={expanded} loading={expanded && text === null} />
          {t('attachment.transcript')}
        </Button>
        <span className="truncate">{att.filename}</span>
      </div>
      {expanded && text !== null && (
        <div
          className="border-t border-border px-2 py-2 text-sm"
          data-testid="transcript-attachment-body"
        >
          {segments === null ? (
            <div className="prose-sm max-w-none break-words">
              {renderRichContent(text, { interactive: false })}
            </div>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
              {segments.map((segment, row) => (
                <TranscriptRow
                  // oxlint-disable-next-line react/no-array-index-key -- a paragraph has no id, and the list is rebuilt only when the text changes
                  key={row}
                  segment={segment}
                  current={row === currentRow}
                  onSeek={seek}
                />
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}
