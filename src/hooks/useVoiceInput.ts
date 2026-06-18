/**
 * useVoiceInput — Web Speech API dictation for the mobile search input
 * (#132).
 *
 * Feature-detects `window.SpeechRecognition || webkitSpeechRecognition`
 * and exposes:
 *  - `supported` — whether dictation is available at all. The caller
 *    HIDES the mic button when this is false (no dead control on
 *    unsupported browsers — iOS Safari historically, jsdom always).
 *  - `listening` — whether a recognition session is currently active,
 *    for the button's pressed/active state.
 *  - `start()` / `stop()` — begin / end a session. `start` is a no-op
 *    when unsupported or already listening; it fires a haptic tick so
 *    the user feels the mic engage.
 *
 * On a (final) result the recognised transcript is handed to
 * `onResult`; the hook does NOT itself write the query — the consumer
 * owns where the text lands (it fills the search input). Single-shot:
 * `continuous = false`, so one utterance ends the session.
 *
 * All recognition objects are torn down on unmount / re-detect so a
 * dangling session can't fire `onResult` into an unmounted component.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { haptic } from '@/lib/haptics'
import { logger } from '@/lib/logger'

interface UseVoiceInputOptions {
  /** Called with the recognised transcript when a final result arrives. */
  onResult: (transcript: string) => void
  /** BCP-47 language tag for recognition. Defaults to the document language. */
  lang?: string
}

interface UseVoiceInputReturn {
  supported: boolean
  listening: boolean
  start: () => void
  stop: () => void
}

function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  // Prefer the standardised constructor; fall back to the WebKit prefix
  // (Chrome / Android WebView still expose only the prefixed name).
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
}

export function useVoiceInput({ onResult, lang }: UseVoiceInputOptions): UseVoiceInputReturn {
  // Snapshot support once — the constructor presence doesn't change over
  // a session's lifetime, and computing it lazily keeps SSR/jsdom safe.
  const Ctor = useMemo(() => getSpeechRecognitionCtor(), [])
  const supported = Ctor != null
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<SpeechRecognition | null>(null)

  // Keep the latest `onResult` in a ref so the recognition handlers
  // (wired once at start time) always call the current closure without
  // re-subscribing.
  const onResultRef = useRef(onResult)
  useEffect(() => {
    onResultRef.current = onResult
  }, [onResult])

  const stop = useCallback(() => {
    const rec = recognitionRef.current
    if (rec == null) return
    try {
      rec.stop()
    } catch {
      // Already stopped / never started — ignore.
    }
  }, [])

  const start = useCallback(() => {
    if (Ctor == null) return
    // Re-entrancy guard: a second tap while listening is a no-op (the
    // button toggles to "stop" in that state).
    if (recognitionRef.current != null) return

    let rec: SpeechRecognition
    try {
      rec = new Ctor()
    } catch (err) {
      logger.warn('useVoiceInput', 'failed to construct SpeechRecognition', {}, err)
      return
    }
    rec.lang =
      lang ?? (typeof document !== 'undefined' ? document.documentElement.lang || 'en-US' : 'en-US')
    rec.continuous = false
    rec.interimResults = false
    rec.maxAlternatives = 1

    rec.onresult = (event: SpeechRecognitionEvent) => {
      const result = event.results[event.resultIndex]
      const alternative = result?.[0]
      const transcript = alternative?.transcript?.trim()
      if (transcript) onResultRef.current(transcript)
    }
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- kept symmetric with onresult/onend (not flagged); all three are property-assigned and explicitly nulled in the teardown below to block late fires into an unmounted component
    rec.onerror = (event: SpeechRecognitionErrorEvent) => {
      // `no-speech` / `aborted` are expected user outcomes, not faults —
      // log at debug-equivalent (warn with context) and let `onend`
      // clear the listening state.
      logger.warn('useVoiceInput', 'speech recognition error', { error: event.error })
    }
    rec.onend = () => {
      recognitionRef.current = null
      setListening(false)
    }

    recognitionRef.current = rec
    try {
      rec.start()
      setListening(true)
      // #137 — a subtle tick confirms the mic engaged.
      haptic('tick')
    } catch (err) {
      // `start()` throws if invoked twice or without a mic permission
      // gesture; reset so the next tap can retry.
      recognitionRef.current = null
      setListening(false)
      logger.warn('useVoiceInput', 'failed to start speech recognition', {}, err)
    }
  }, [Ctor, lang])

  // Tear down any live session on unmount so a late `onend`/`onresult`
  // can't fire into an unmounted component.
  useEffect(() => {
    return () => {
      const rec = recognitionRef.current
      if (rec == null) return
      rec.onresult = null
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- symmetric teardown of the property-assigned handlers above
      rec.onerror = null
      rec.onend = null
      try {
        rec.abort()
      } catch {
        // Best-effort teardown.
      }
      recognitionRef.current = null
    }
  }, [])

  return { supported, listening, start, stop }
}
