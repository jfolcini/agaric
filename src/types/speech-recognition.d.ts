/**
 * Minimal ambient types for the Web Speech API (#132).
 *
 * TypeScript's bundled `DOM` lib does NOT ship `SpeechRecognition` (it
 * lives in the separate, non-standard `dom.speech` lib that browsers
 * implement inconsistently). We declare only the surface the voice-input
 * hook touches — construct, `start`/`stop`/`abort`, the `result` /
 * `error` / `end` events — rather than pull in a full polyfill typing.
 *
 * Both the standardised `SpeechRecognition` and the WebKit-prefixed
 * `webkitSpeechRecognition` constructors are exposed on `window`; the
 * hook feature-detects and prefers the unprefixed one.
 */

interface SpeechRecognitionAlternative {
  readonly transcript: string
  readonly confidence: number
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean
  readonly length: number
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
}

interface SpeechRecognitionResultList {
  readonly length: number
  item(index: number): SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultList
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string
  readonly message: string
}

interface SpeechRecognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: ((event: Event) => void) | null
  onstart: ((event: Event) => void) | null
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition
}

interface Window {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}
