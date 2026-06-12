/**
 * Tests for the #132 useVoiceInput hook — Web Speech API dictation with
 * feature-detection, single-shot recognition, and clean teardown.
 *
 * SpeechRecognition is mocked: happy-dom ships no implementation, so we
 * attach a fake constructor to `window` and drive its event handlers.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useVoiceInput } from '../useVoiceInput'

class FakeRecognition {
  lang = ''
  continuous = false
  interimResults = false
  maxAlternatives = 0
  onresult: ((e: SpeechRecognitionEvent) => void) | null = null
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null = null
  onend: ((e: Event) => void) | null = null
  onstart: ((e: Event) => void) | null = null
  start = vi.fn()
  stop = vi.fn(() => {
    this.onend?.(new Event('end'))
  })
  abort = vi.fn()

  emitResult(transcript: string): void {
    this.onresult?.({
      resultIndex: 0,
      results: {
        length: 1,
        item: () => ({
          length: 1,
          isFinal: true,
          item: () => ({ transcript, confidence: 1 }),
          0: { transcript, confidence: 1 },
        }),
        0: {
          length: 1,
          isFinal: true,
          item: () => ({ transcript, confidence: 1 }),
          0: { transcript, confidence: 1 },
        },
      },
    } as unknown as SpeechRecognitionEvent)
  }
}

let lastInstance: FakeRecognition | null = null

// A real constructor (class) so `new Ctor()` returns a FakeRecognition
// whose methods are genuine spies. `vi.fn(() => …)` can't be used here:
// arrow functions aren't constructible, and a plain `vi.fn` mock ignores
// the returned object under `new`.
function MakeRecognition(this: FakeRecognition): FakeRecognition {
  lastInstance = new FakeRecognition()
  return lastInstance
}

function installSpeech(): void {
  window.SpeechRecognition = MakeRecognition as unknown as SpeechRecognitionConstructor
}

function uninstallSpeech(): void {
  delete window.SpeechRecognition
  delete window.webkitSpeechRecognition
  lastInstance = null
}

describe('useVoiceInput', () => {
  beforeEach(() => {
    uninstallSpeech()
  })
  afterEach(() => {
    uninstallSpeech()
    vi.restoreAllMocks()
  })

  it('reports unsupported when no SpeechRecognition constructor exists', () => {
    const { result } = renderHook(() => useVoiceInput({ onResult: vi.fn() }))
    expect(result.current.supported).toBe(false)
  })

  it('reports supported and starts a session', () => {
    installSpeech()
    const { result } = renderHook(() => useVoiceInput({ onResult: vi.fn() }))
    expect(result.current.supported).toBe(true)
    act(() => result.current.start())
    expect(lastInstance?.start).toHaveBeenCalledTimes(1)
    expect(result.current.listening).toBe(true)
  })

  it('detects the webkit-prefixed constructor', () => {
    window.webkitSpeechRecognition = MakeRecognition as unknown as SpeechRecognitionConstructor
    const { result } = renderHook(() => useVoiceInput({ onResult: vi.fn() }))
    expect(result.current.supported).toBe(true)
  })

  it('hands the transcript to onResult and clears listening on end', () => {
    installSpeech()
    const onResult = vi.fn()
    const { result } = renderHook(() => useVoiceInput({ onResult }))
    act(() => result.current.start())
    act(() => lastInstance?.emitResult('hello world'))
    expect(onResult).toHaveBeenCalledWith('hello world')
    act(() => lastInstance?.onend?.(new Event('end')))
    expect(result.current.listening).toBe(false)
  })

  it('start() is a no-op when unsupported', () => {
    const { result } = renderHook(() => useVoiceInput({ onResult: vi.fn() }))
    act(() => result.current.start())
    expect(result.current.listening).toBe(false)
  })

  it('start() is re-entrancy guarded while already listening', () => {
    installSpeech()
    const { result } = renderHook(() => useVoiceInput({ onResult: vi.fn() }))
    act(() => result.current.start())
    const first = lastInstance
    act(() => result.current.start())
    // Same instance — no second recognition object constructed.
    expect(lastInstance).toBe(first)
    expect(first?.start).toHaveBeenCalledTimes(1)
  })

  it('stop() ends the session', () => {
    installSpeech()
    const { result } = renderHook(() => useVoiceInput({ onResult: vi.fn() }))
    act(() => result.current.start())
    act(() => result.current.stop())
    expect(result.current.listening).toBe(false)
  })

  it('fires a haptic tick on start when the Vibration API is present', () => {
    installSpeech()
    const vibrate = vi.fn()
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
    const { result } = renderHook(() => useVoiceInput({ onResult: vi.fn() }))
    act(() => result.current.start())
    expect(vibrate).toHaveBeenCalledWith(10)
    delete (navigator as { vibrate?: unknown }).vibrate
  })

  it('aborts a live session on unmount', () => {
    installSpeech()
    const { result, unmount } = renderHook(() => useVoiceInput({ onResult: vi.fn() }))
    act(() => result.current.start())
    const inst = lastInstance
    unmount()
    expect(inst?.abort).toHaveBeenCalled()
  })
})
