import { useVirtualizer } from '@tanstack/react-virtual'
import type React from 'react'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
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
import { scrollParentY } from '@/lib/scroll-parent'
import { cn } from '@/lib/utils'
import { useInPageFindStore } from '@/stores/useInPageFindStore'

const unsubscribeNothing = () => {}
const ESTIMATED_ROW_HEIGHT = 26
const OVERSCAN = 20

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
    index,
    offset,
    measureRef,
  }: {
    segment: TranscriptSegment
    current: boolean
    onSeek: (seconds: number) => void
    index: number
    /** Where a windowed row sits in the list; a row in flow has none. */
    offset?: number
    measureRef?: (el: Element | null) => void
  }): React.ReactElement => {
    const { t } = useTranslation()
    const { start, label, markdown } = segment
    return (
      <li
        ref={measureRef}
        data-index={index}
        data-testid="transcript-segment"
        aria-current={current ? 'true' : undefined}
        className={cn(
          'flex items-baseline gap-2 rounded-md px-1 pb-0.5',
          offset !== undefined && 'absolute top-0 left-0 w-full',
          current && 'bg-accent text-accent-foreground',
        )}
        style={offset === undefined ? undefined : { transform: `translateY(${offset}px)` }}
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
            <TranscriptRows segments={segments} currentRow={currentRow} onSeek={seek} />
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A transcript's rows, windowed against the page's own scroller: a two-hour
 * meeting has about 1,500, and mounting them all at once lays out for about a
 * second on a mid-range device (`perf: opening a two-hour transcript`). Every
 * row mounts while find-in-page is open, because find walks the rendered DOM,
 * and when no ancestor scrolls, since then nothing can tell which rows show.
 */
function TranscriptRows({
  segments,
  currentRow,
  onSeek,
}: {
  segments: TranscriptSegment[]
  currentRow: number
  onSeek: (seconds: number) => void
}): React.ReactElement {
  const findOpen = useInPageFindStore((s) => s.open)
  const listRef = useRef<HTMLOListElement>(null)
  // `undefined` until the list has looked for its scroller, so the first
  // render mounts no rows rather than all of them.
  const [scroller, setScroller] = useState<HTMLElement | null | undefined>(undefined)
  const [margin, setMargin] = useState(0)
  useLayoutEffect(() => {
    const list = listRef.current
    if (list === null) return
    const parent = scrollParentY(list)
    setScroller(parent)
    if (parent === null) return
    const measure = () =>
      setMargin(
        Math.round(
          list.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop,
        ),
      )
    measure()
    // Anything above the list that changes height moves where its rows start.
    const observer = new ResizeObserver(measure)
    observer.observe(parent.firstElementChild ?? parent)
    return () => observer.disconnect()
  }, [])

  const windowed = scroller !== null && !findOpen
  // oxlint-disable-next-line react/incompatible-library -- as in VirtualizedBlockList (#4409): only numbers and the constructor-bound `measureElement` reach the memoised rows.
  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => scroller ?? null,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: OVERSCAN,
    scrollMargin: margin,
    enabled: windowed && scroller !== undefined,
  })

  if (!windowed) {
    return (
      <ol ref={listRef} className="m-0 flex list-none flex-col p-0">
        {segments.map((segment, row) => (
          <TranscriptRow
            // oxlint-disable-next-line react/no-array-index-key -- a paragraph has no id, and the list is rebuilt only when the text changes
            key={row}
            index={row}
            segment={segment}
            current={row === currentRow}
            onSeek={onSeek}
          />
        ))}
      </ol>
    )
  }
  return (
    <ol
      ref={listRef}
      className="relative m-0 list-none p-0"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {scroller !== undefined &&
        virtualizer.getVirtualItems().map((item) => {
          const segment = segments[item.index]
          if (segment === undefined) return null
          return (
            <TranscriptRow
              key={item.index}
              index={item.index}
              offset={item.start - margin}
              measureRef={virtualizer.measureElement}
              segment={segment}
              current={item.index === currentRow}
              onSeek={onSeek}
            />
          )
        })}
    </ol>
  )
}
