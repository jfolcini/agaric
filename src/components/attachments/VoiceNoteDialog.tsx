/**
 * VoiceNoteDialog — the `/voice` recorder (#5364, slice 1).
 *
 * Records the microphone with the webview's `getUserMedia` + `MediaRecorder`,
 * the capture route the pairing QR scanner already uses, and saves the audio
 * as an attachment on the block the command ran in. The microphone is released
 * on stop, on cancel and on unmount: a track left running keeps recording and
 * keeps the OS microphone indicator lit.
 */

import { format } from 'date-fns'
import { Mic, RotateCcw, Square } from 'lucide-react'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { unwrap } from '@/lib/app-error'
import { recordAttachmentInvalidation } from '@/lib/attachment-invalidation'
import { commands } from '@/lib/bindings'
import { MAX_ATTACHMENT_BYTES } from '@/lib/file-utils'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { reportIpcError } from '@/lib/report-ipc-error'
import { cn } from '@/lib/utils'

/**
 * Opus at {@link RECORDING_BITS_PER_SECOND} is about 15 MB an hour. A webview
 * without it (WKWebView records AAC in `audio/mp4`) uses its own default.
 */
const PREFERRED_RECORDING_TYPE = 'audio/webm;codecs=opus'
const RECORDING_BITS_PER_SECOND = 32_000
/** How often the recorder hands over a chunk, and so how often the size cap is checked. */
const CHUNK_INTERVAL_MS = 1000
/**
 * Stop this far below the attachment cap: the chunk still in flight when the
 * recorder stops must not push the file over the cap, or the save is refused
 * and the recording is lost.
 */
const AUTO_STOP_BYTES = MAX_ATTACHMENT_BYTES - 1_048_576

type Phase = 'idle' | 'starting' | 'recording' | 'saving' | 'failed'

interface Recording {
  blob: Blob
  filename: string
}

interface Session {
  recorder: MediaRecorder
  timer: ReturnType<typeof setInterval>
  /**
   * Set by Cancel and by unmount. Every other way a recording ends saves it:
   * Stop, the size cap, and the recorder stopping itself when the microphone
   * goes away.
   */
  discarded: boolean
}

function releaseMicrophone(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

/** `getUserMedia` rejects with a `DOMException` whose `name` says why. */
function microphoneErrorKey(err: unknown): string {
  const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'voiceNote.micDenied'
  if (name === 'NotFoundError') return 'voiceNote.micNotFound'
  return 'voiceNote.micError'
}

function voiceNoteFilename(startedAt: Date, mimeType: string): string {
  const extension = mimeType.slice(mimeType.indexOf('/') + 1)
  return `voice-note-${format(startedAt, 'yyyy-MM-dd-HHmm')}.${extension}`
}

function formatElapsed(totalSeconds: number): string {
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${Math.floor(totalSeconds / 60)}:${seconds}`
}

export interface VoiceNoteDialogProps {
  /** The block the recording attaches to. */
  blockId: string
  onClose: () => void
}

/** Open while mounted: closing unmounts the recorder, whose cleanup releases the microphone. */
export function VoiceNoteDialog({ blockId, onClose }: VoiceNoteDialogProps): React.ReactElement {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <VoiceNoteRecorder blockId={blockId} onClose={onClose} />
    </Dialog>
  )
}

function VoiceNoteRecorder({
  blockId,
  onClose,
}: {
  blockId: string
  onClose: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const sessionRef = useRef<Session | null>(null)
  const unsavedRef = useRef<Recording | null>(null)
  const mountedRef = useRef(false)
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  const busy = phase === 'starting' || phase === 'saving'

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const session = sessionRef.current
      if (!session) return
      sessionRef.current = null
      session.discarded = true
      // `onstop` releases the microphone.
      session.recorder.stop()
    }
  }, [])

  // Disabling the primary button while busy drops its focus; hand it back.
  useEffect(() => {
    if (!busy) primaryButtonRef.current?.focus()
  }, [busy])

  const save = async (recording: Recording) => {
    setPhase('saving')
    try {
      const bytes = new Uint8Array(await recording.blob.arrayBuffer())
      unwrap(
        await commands.addAttachmentWithBytes(
          blockId,
          recording.filename,
          recording.blob.type,
          Array.from(bytes),
        ),
      )
      recordAttachmentInvalidation()
      notify.success(t('voiceNote.saved'))
      onClose()
    } catch (err) {
      reportIpcError('VoiceNoteDialog', 'voiceNote.saveFailed', err, t, {
        blockId,
        sizeBytes: recording.blob.size,
      })
      unsavedRef.current = recording
      setPhase('failed')
    }
  }

  const stopRecording = () => {
    const session = sessionRef.current
    if (!session) return
    sessionRef.current = null
    setPhase('saving')
    // `onstop` releases the microphone and saves, after the last chunk lands.
    session.recorder.stop()
  }

  const beginSession = (stream: MediaStream): Session => {
    const recorder = new MediaRecorder(stream, {
      ...(MediaRecorder.isTypeSupported(PREFERRED_RECORDING_TYPE)
        ? { mimeType: PREFERRED_RECORDING_TYPE }
        : {}),
      audioBitsPerSecond: RECORDING_BITS_PER_SECOND,
    })
    // oxlint-disable-next-line react/purity -- runs from the Record click, never during render
    const startedAt = new Date()
    const chunks: Blob[] = []
    let recordedBytes = 0
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return
      chunks.push(event.data)
      recordedBytes += event.data.size
      if (recordedBytes >= AUTO_STOP_BYTES && sessionRef.current === session) {
        notify.info(t('voiceNote.sizeLimitReached'))
        stopRecording()
      }
    }
    recorder.onstop = () => {
      clearInterval(session.timer)
      releaseMicrophone(stream)
      if (sessionRef.current === session) sessionRef.current = null
      if (session.discarded) return
      const mimeType = (recorder.mimeType || PREFERRED_RECORDING_TYPE).split(';')[0] ?? ''
      void save({
        blob: new Blob(chunks, { type: mimeType }),
        filename: voiceNoteFilename(startedAt, mimeType),
      })
    }
    recorder.start(CHUNK_INTERVAL_MS)
    const session: Session = {
      recorder,
      discarded: false,
      timer: setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startedAt.getTime()) / 1000))
      }, 1000),
    }
    return session
  }

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      logger.warn('VoiceNoteDialog', 'getUserMedia or MediaRecorder is unavailable')
      notify.error(t('voiceNote.micUnavailable'))
      return
    }
    setPhase('starting')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      logger.warn('VoiceNoteDialog', 'microphone access failed', undefined, err)
      notify.error(t(microphoneErrorKey(err)))
      setPhase('idle')
      return
    }
    // The dialog was closed while the permission prompt was up.
    if (!mountedRef.current) {
      releaseMicrophone(stream)
      return
    }
    try {
      sessionRef.current = beginSession(stream)
    } catch (err) {
      releaseMicrophone(stream)
      logger.warn('VoiceNoteDialog', 'MediaRecorder failed to start', undefined, err)
      notify.error(t('voiceNote.micError'))
      setPhase('idle')
      return
    }
    setElapsedSeconds(0)
    setPhase('recording')
  }

  const retrySave = () => {
    const recording = unsavedRef.current
    if (recording) void save(recording)
  }

  const primary = {
    idle: { label: t('voiceNote.record'), icon: <Mic />, onClick: () => void startRecording() },
    starting: { label: t('voiceNote.record'), icon: <Spinner />, onClick: undefined },
    recording: { label: t('voiceNote.stop'), icon: <Square />, onClick: stopRecording },
    saving: { label: t('voiceNote.saving'), icon: <Spinner />, onClick: undefined },
    failed: { label: t('voiceNote.retry'), icon: <RotateCcw />, onClick: retrySave },
  }[phase]

  const status = {
    idle: '',
    starting: '',
    recording: t('voiceNote.recording'),
    saving: t('voiceNote.saving'),
    failed: t('voiceNote.saveFailed'),
  }[phase]

  return (
    <DialogContent
      data-testid="voice-note-dialog"
      className="sm:max-w-sm"
      onOpenAutoFocus={(e) => {
        e.preventDefault()
        primaryButtonRef.current?.focus()
      }}
      // A stray click outside or an Escape (the key that leaves a block) must
      // not throw away a recording; Cancel is the explicit way out.
      onInteractOutside={(e) => {
        if (phase !== 'idle') e.preventDefault()
      }}
      onEscapeKeyDown={(e) => {
        if (phase !== 'idle') e.preventDefault()
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('voiceNote.title')}</DialogTitle>
        <DialogDescription>{t('voiceNote.description')}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col items-center gap-1 py-2">
        <span
          role="timer"
          aria-label={t('voiceNote.elapsed')}
          className="font-mono text-3xl tabular-nums"
        >
          {formatElapsed(elapsedSeconds)}
        </span>
        <span
          aria-live="polite"
          className={cn(
            'min-h-5 text-sm',
            phase === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {status}
        </span>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={phase === 'saving'}>
          {t('action.cancel')}
        </Button>
        <Button ref={primaryButtonRef} onClick={primary.onClick} disabled={busy}>
          {primary.icon}
          {primary.label}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
