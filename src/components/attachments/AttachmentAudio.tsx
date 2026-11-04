import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useEnteredViewport } from '@/hooks/useEnteredViewport'
import { bytesToBlob } from '@/lib/attachment-utils'
import type { AttachmentRow } from '@/lib/bindings'
import { readAttachment } from '@/lib/ipc-helpers'
import { logger } from '@/lib/logger'

/** A block's recording player, shared by the player and the transcript that seeks it. */
export interface RecordingPlayer {
  /** The mounted `<audio>`, or null until its bytes have loaded. */
  audio: HTMLAudioElement | null
  /** Seeks now if the player knows its length, or as soon as it does. */
  seek: (seconds: number) => void
  attach: (audio: HTMLAudioElement | null) => void
  heldSeek: React.RefObject<number | null>
}

export function useRecordingPlayer(): RecordingPlayer {
  // State, so the transcript subscribes once the player mounts; the ref keeps `seek` stable.
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const heldSeek = useRef<number | null>(null)
  const attach = useCallback((element: HTMLAudioElement | null) => {
    audioRef.current = element
    setAudio(element)
  }, [])
  const seek = useCallback((seconds: number) => {
    const element = audioRef.current
    if (element && Number.isFinite(element.duration)) element.currentTime = seconds
    else heldSeek.current = seconds
  }, [])
  return { audio, seek, attach, heldSeek }
}

/** A swipe on the block row deletes it; scrubbing the seek bar must not count as one. */
function stopTouchPropagation(e: React.TouchEvent): void {
  e.stopPropagation()
}

/**
 * Chromium's `MediaRecorder` (Android, Windows) writes WebM with no Duration
 * element, so `duration` stays `Infinity` and the controls show no length
 * until the note has played to the end. A seek past the end makes the element
 * scan for the last frame and report the real duration; the playhead then goes
 * back to the start, or to a seek the transcript asked for meanwhile
 * (`heldSeek`). A seek plays nothing.
 */
function resolveUnknownDuration(
  audio: HTMLAudioElement,
  heldSeek: React.RefObject<number | null> | undefined,
): () => void {
  const controller = new AbortController()
  const { signal } = controller
  const startAt = (otherwise: number | null) => {
    const time = heldSeek?.current ?? otherwise
    if (heldSeek) heldSeek.current = null
    if (time !== null) audio.currentTime = time
  }
  const rewindOnceKnown = () => {
    if (!Number.isFinite(audio.duration)) return
    audio.removeEventListener('durationchange', rewindOnceKnown)
    startAt(0)
  }
  audio.addEventListener(
    'loadedmetadata',
    () => {
      if (Number.isFinite(audio.duration)) {
        startAt(null)
        return
      }
      audio.addEventListener('durationchange', rewindOnceKnown, { signal })
      audio.currentTime = Number.MAX_SAFE_INTEGER
    },
    { signal },
  )
  return () => controller.abort()
}

/**
 * Inline `<audio controls>` player for an `audio/*` attachment (#5364). The
 * byte read waits for the player to near the viewport, and the blob URL is
 * revoked on unmount. When the bytes cannot be read, or the webview cannot
 * play them (#5730: a Mac M4A on Linux), it shows `fallback` so the recording
 * stays downloadable.
 */
export function AttachmentAudio({
  att,
  player,
  fallback,
}: {
  att: Pick<AttachmentRow, 'id' | 'filename' | 'mime_type'>
  /** Set when a transcript on the block seeks this player. */
  player?: RecordingPlayer | undefined
  fallback: React.ReactNode
}): React.ReactNode {
  const { t } = useTranslation()
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [inView, viewGateRef] = useEnteredViewport<HTMLSpanElement>()

  useEffect(() => {
    if (!inView) return
    let cancelled = false
    let objectUrl: string | null = null
    readAttachment(att.id)
      .then((bytes) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(bytesToBlob(bytes, att.mime_type))
        setUrl(objectUrl)
      })
      .catch((err) => {
        if (cancelled) return
        logger.warn('AttachmentAudio', 'read audio bytes failed', { id: att.id }, err)
        setError(true)
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [att.id, att.mime_type, inView])

  const attach = player?.attach
  const heldSeek = player?.heldSeek
  // Stable, so React attaches it once per element and runs the cleanup on unmount.
  const bindPlayer = useCallback(
    (audio: HTMLAudioElement) => {
      const stopResolving = resolveUnknownDuration(audio, heldSeek)
      attach?.(audio)
      return () => {
        stopResolving()
        attach?.(null)
      }
    },
    [attach, heldSeek],
  )

  if (error) return fallback

  if (!url) {
    return (
      <span
        ref={viewGateRef}
        className="text-xs text-muted-foreground"
        data-testid="attachment-audio-loading"
      >
        {t('attachment.loadingAudio')}
      </span>
    )
  }

  return (
    // `auto`, not `metadata`: the bytes are already in memory, and under
    // `metadata` WebKitGTK reports an Ogg Opus note's duration from however much
    // it happened to read, often a fraction of it (#5730).
    // oxlint-disable-next-line jsx-a11y/media-has-caption -- the transcript is an attachment beside the player, not a caption track
    <audio
      ref={bindPlayer}
      controls
      preload="auto"
      src={url}
      aria-label={t('attachment.audioLabel', { filename: att.filename })}
      className="max-w-full"
      onError={(e) => {
        logger.warn(
          'AttachmentAudio',
          'player cannot play the audio',
          { id: att.id, mimeType: att.mime_type },
          e.currentTarget.error,
        )
        setError(true)
      }}
      onTouchStart={stopTouchPropagation}
      onTouchMove={stopTouchPropagation}
      onTouchEnd={stopTouchPropagation}
    />
  )
}
