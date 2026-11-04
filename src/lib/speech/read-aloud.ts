/**
 * *Read aloud*'s one active reading (#5745): a queue of utterances spoken one at a time through
 * the webview's `speechSynthesis`, the block being spoken, and whether *Read aloud* can speak
 * here at all. Rows, menus and the palette read it through `useSyncExternalStore`.
 *
 * Store-shaped, but a plain module: AGENTS.md admits no new Zustand store without approval.
 *
 * - Voice and rate are the OS defaults: nothing is set on an utterance.
 * - A reading ends when its queue empties, on {@link stopReading}, or on an engine error, which
 *   a toast explains; an engine with no voice points to the OS speech settings.
 * - While it reads, a persistent toast offers Stop, and closing it stops too. The toast says it
 *   started (toasts are a live region); the announcer says when it ends.
 * - It speaks where the backend reports `Webview` (macOS, Windows) and the webview has
 *   `speechSynthesis`; elsewhere *Read aloud* is hidden. The backend is asked once, the first
 *   time something offers *Read aloud* ({@link checkReadAloudSupport}), never at boot.
 */

import { announce } from '@/lib/announcer'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import type { SpokenUtterance } from '@/lib/speech/spoken-text'

export interface ReadAloudSnapshot {
  /** Whether *Read aloud* can speak here; `false` until the backend says so. */
  readonly supported: boolean
  readonly reading: boolean
  /** The block whose text is being spoken; `null` while nothing is read. */
  readonly currentBlockId: string | null
}

interface Reading {
  readonly queue: SpokenUtterance[]
  /** What started it (a page store), so that page's unmount can end it. */
  readonly owner: object
  /** Held while it speaks: Chromium drops an utterance nothing references, and its `end` with it. */
  utterance: SpeechSynthesisUtterance | null
}

/** The engine errors that mean the webview has no voice to speak with. */
const NO_VOICE_ERRORS: ReadonlySet<string> = new Set([
  'synthesis-unavailable',
  'language-unavailable',
  'voice-unavailable',
])

const TOAST_ID = 'read-aloud'

let snapshot: ReadAloudSnapshot = { supported: false, reading: false, currentBlockId: null }
let active: Reading | null = null
let supportAsked = false
const listeners = new Set<() => void>()

export function subscribeReadAloud(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getReadAloudSnapshot(): ReadAloudSnapshot {
  return snapshot
}

function publish(next: Partial<ReadAloudSnapshot>): void {
  snapshot = { ...snapshot, ...next }
  for (const listener of listeners) listener()
}

/** Asks the backend, once, whether *Read aloud* can speak; the answer lands in the snapshot. */
export function checkReadAloudSupport(): void {
  if (supportAsked) return
  supportAsked = true
  if (!('speechSynthesis' in window)) return
  void commands
    .speechStatus()
    .then(unwrap)
    .then((status) => {
      if (status === 'Webview') publish({ supported: true })
    })
    .catch((err: unknown) => {
      logger.warn('read-aloud', 'speech_status failed; Read aloud stays hidden', undefined, err)
    })
}

/**
 * Reads `utterances` aloud in order, ending any reading under way. `owner` ties the reading to
 * what it was read from, so {@link stopReading} with that owner ends it.
 */
export function startReading(utterances: readonly SpokenUtterance[], owner: object): void {
  if (utterances.length === 0) {
    notify.info(t('readAloud.nothingToRead'))
    return
  }
  if (active !== null) finish(active, null)
  const reading: Reading = { queue: [...utterances], owner, utterance: null }
  active = reading
  notify(t('readAloud.reading'), {
    id: TOAST_ID,
    duration: Number.POSITIVE_INFINITY,
    action: { label: t('readAloud.stop'), onClick: () => stopReading() },
    // The Toaster's close button would otherwise hide the toast and leave the reading going.
    onDismiss: () => stopReading(),
    classNames: { actionButton: 'touch-hit-area' },
  })
  speakNext(reading)
}

/** Ends the reading under way; given an `owner`, only a reading that owner started. */
export function stopReading(owner?: object): void {
  if (active === null || (owner !== undefined && active.owner !== owner)) return
  finish(active, 'announce.readAloudStopped')
}

function speakNext(reading: Reading): void {
  const next = reading.queue.shift()
  if (next === undefined) {
    finish(reading, 'announce.readAloudFinished')
    return
  }
  const utterance = new SpeechSynthesisUtterance(next.text)
  utterance.addEventListener('end', () => {
    if (active === reading) speakNext(reading)
  })
  utterance.addEventListener('error', (event) => {
    if (active === reading) fail(reading, event.error)
  })
  reading.utterance = utterance
  publish({ reading: true, currentBlockId: next.blockId })
  window.speechSynthesis.speak(utterance)
}

function fail(reading: Reading, error: string): void {
  logger.warn('read-aloud', 'the speech engine stopped the reading', { error })
  finish(reading, null)
  notify.error(t(NO_VOICE_ERRORS.has(error) ? 'readAloud.noVoice' : 'readAloud.failed'))
}

function finish(reading: Reading, announcement: string | null): void {
  // Cleared first: `cancel()` makes the engine report the cut utterance as an `interrupted` or
  // `canceled` error, which must find no reading.
  active = null
  reading.queue.length = 0
  reading.utterance = null
  window.speechSynthesis.cancel()
  notify.dismiss(TOAST_ID)
  publish({ reading: false, currentBlockId: null })
  if (announcement !== null) announce(t(announcement))
}

/** Test-only: forget the reading and the support answer. */
export function __resetReadAloudForTests(): void {
  active = null
  supportAsked = false
  snapshot = { supported: false, reading: false, currentBlockId: null }
}
