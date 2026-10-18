/**
 * VoiceNoteDialog — the `/voice` recorder (#5364, slice 1).
 *
 * Records the microphone through `getUserMedia`, the capture route the pairing
 * QR scanner already uses, and a `VoiceRecorder` (`voice-recorder.ts`), and
 * saves the audio as an attachment on the block the command ran in. The
 * microphone is released on stop, on cancel and on unmount: a track left
 * running keeps recording and keeps the OS microphone indicator lit.
 */

import { format } from 'date-fns'
import { Mic, RotateCcw, Square } from 'lucide-react'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  releaseMicrophone,
  startVoiceRecorder,
  type VoiceRecorder,
} from '@/components/attachments/voice-recorder'
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
  recorder: VoiceRecorder
  timer: ReturnType<typeof setInterval>
  /**
   * Set by Cancel and by unmount. Every other way a recording ends saves it:
   * Stop, the size cap, and the recorder stopping itself when the microphone
   * goes away or the encoder fails.
   */
  discarded: boolean
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
    // The recording settles, and `awaitRecording` saves it, once the last audio is in.
    session.recorder.stop()
  }

  const awaitRecording = (session: Session, startedAt: Date) => {
    const end = () => {
      clearInterval(session.timer)
      if (sessionRef.current === session) sessionRef.current = null
    }
    void session.recorder.recording.then(
      (blob) => {
        end()
        if (session.discarded) return
        void save({ blob, filename: voiceNoteFilename(startedAt, blob.type) })
      },
      (err: unknown) => {
        end()
        if (session.discarded) return
        logger.error('VoiceNoteDialog', 'the recording failed', undefined, err)
        notify.error(t('voiceNote.micError'))
        setPhase('idle')
      },
    )
  }

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      logger.warn('VoiceNoteDialog', 'getUserMedia is unavailable')
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
    // oxlint-disable-next-line react/purity -- runs from the Record click, never during render
    const startedAt = new Date()
    let session: Session | null = null
    let recorder: VoiceRecorder
    try {
      recorder = await startVoiceRecorder(stream, (bytes) => {
        if (bytes >= AUTO_STOP_BYTES && session !== null && sessionRef.current === session) {
          notify.info(t('voiceNote.sizeLimitReached'))
          stopRecording()
        }
      })
    } catch (err) {
      releaseMicrophone(stream)
      logger.warn('VoiceNoteDialog', 'the recorder failed to start', undefined, err)
      notify.error(t('voiceNote.micError'))
      setPhase('idle')
      return
    }
    session = {
      recorder,
      discarded: false,
      timer: setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startedAt.getTime()) / 1000))
      }, 1000),
    }
    awaitRecording(session, startedAt)
    // The dialog was closed while the recorder was starting.
    if (!mountedRef.current) {
      session.discarded = true
      recorder.stop()
      return
    }
    sessionRef.current = session
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
