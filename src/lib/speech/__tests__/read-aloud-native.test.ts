/**
 * *Read aloud* on Android (#5745): the webview has no `speechSynthesis`, so the controller
 * speaks through the backend's `TextToSpeech` engine (`speak_text` / `stop_speaking`), and
 * shows only once that engine says it can speak.
 */

import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import type { SpeakOutcome, SpeechStatus } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import {
  __resetReadAloudForTests,
  checkReadAloudSupport,
  getReadAloudSnapshot,
  startReading,
  stopReading,
} from '@/lib/speech/read-aloud'

vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  isAndroid: () => true,
}))

const PAGE = {}

const UTTERANCES = [
  { blockId: 'A', text: 'first' },
  { blockId: 'B', text: 'second' },
]

/** A backend engine whose utterances end when a test says so. */
function nativeEngine({ available = true }: { available?: boolean } = {}) {
  const pending: Array<{ text: string; end: (outcome: SpeakOutcome) => void }> = []
  const stops: Array<() => void> = []
  const handlers = {
    get_speech_status: vi.fn((): SpeechStatus => 'Native'),
    get_speech_engine_available: vi.fn(() => available),
    speak_text: vi.fn(
      (args: unknown) =>
        new Promise<SpeakOutcome>((resolve) => {
          pending.push({ text: (args as { text: string }).text, end: resolve })
        }),
    ),
    stop_speaking: vi.fn(
      () =>
        new Promise<null>((resolve) => {
          stops.push(() => resolve(null))
        }),
    ),
  }
  vi.mocked(invoke).mockImplementation(mockInvokeCommands(handlers))
  return {
    handlers,
    spoken: () => pending.map((p) => p.text),
    end: (index: number, outcome: SpeakOutcome = 'Done') => pending[index]?.end(outcome),
    finishStop: (index: number) => stops[index]?.(),
  }
}

async function supportNative(): Promise<void> {
  checkReadAloudSupport()
  await vi.waitFor(() => expect(getReadAloudSnapshot().supported).toBe(true))
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetReadAloudForTests()
})

afterEach(() => {
  __resetReadAloudForTests()
})

describe('support on Android', () => {
  it('is reported once the backend engine says it can speak', async () => {
    const engine = nativeEngine()
    await supportNative()
    expect(engine.handlers.get_speech_engine_available).toHaveBeenCalledTimes(1)
  })

  it('stays hidden when the engine failed to start or has no voice', async () => {
    const engine = nativeEngine({ available: false })
    checkReadAloudSupport()
    await vi.waitFor(() => expect(engine.handlers.get_speech_engine_available).toHaveBeenCalled())
    for (let hop = 0; hop < 5; hop += 1) await Promise.resolve()
    expect(getReadAloudSnapshot().supported).toBe(false)
  })

  it('stays hidden, with a warning, when the availability check fails', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_speech_status: () => 'Native',
        get_speech_engine_available: () => Promise.reject(new Error('plugin not loaded')),
      }),
    )
    checkReadAloudSupport()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(getReadAloudSnapshot().supported).toBe(false)
  })
})

describe('a native reading', () => {
  it('speaks its utterances through the backend in order, marking the block being spoken', async () => {
    const engine = nativeEngine()
    await supportNative()

    startReading(UTTERANCES, PAGE)
    await vi.waitFor(() => expect(engine.spoken()).toEqual(['first']))
    expect(getReadAloudSnapshot()).toMatchObject({ reading: true, currentBlockId: 'A' })

    engine.end(0)
    await vi.waitFor(() => expect(engine.spoken()).toEqual(['first', 'second']))
    expect(getReadAloudSnapshot().currentBlockId).toBe('B')

    engine.end(1)
    await vi.waitFor(() => expect(getReadAloudSnapshot().reading).toBe(false))
  })

  it('stops the engine on Stop, and a cut utterance does not move the reading on', async () => {
    const engine = nativeEngine()
    await supportNative()
    startReading(UTTERANCES, PAGE)
    await vi.waitFor(() => expect(engine.spoken()).toHaveLength(1))

    stopReading()
    expect(engine.handlers.stop_speaking).toHaveBeenCalledTimes(1)
    expect(getReadAloudSnapshot()).toMatchObject({ reading: false, currentBlockId: null })

    engine.end(0, 'Stopped')
    for (let hop = 0; hop < 5; hop += 1) await Promise.resolve()
    expect(engine.spoken()).toEqual(['first'])
  })

  it('ends quietly when the engine reports a stop the reading did not ask for', async () => {
    const engine = nativeEngine()
    await supportNative()
    startReading(UTTERANCES, PAGE)
    await vi.waitFor(() => expect(engine.spoken()).toHaveLength(1))

    // Another app took the engine.
    engine.end(0, 'Stopped')
    await vi.waitFor(() => expect(getReadAloudSnapshot().reading).toBe(false))
    expect(engine.spoken()).toEqual(['first'])
  })

  it('speaks a new reading only after the stop sent for the last one has landed', async () => {
    const engine = nativeEngine()
    await supportNative()
    startReading(UTTERANCES.slice(0, 1), PAGE)
    await vi.waitFor(() => expect(engine.spoken()).toHaveLength(1))
    stopReading()

    startReading(UTTERANCES.slice(1), PAGE)
    for (let hop = 0; hop < 5; hop += 1) await Promise.resolve()
    expect(engine.spoken()).toEqual(['first'])

    engine.finishStop(0)
    await vi.waitFor(() => expect(engine.spoken()).toEqual(['first', 'second']))
  })

  it('leaves the replaced reading’s utterance for the engine to cut, sending no stop', async () => {
    const engine = nativeEngine()
    await supportNative()
    startReading(UTTERANCES.slice(0, 1), PAGE)
    await vi.waitFor(() => expect(engine.spoken()).toHaveLength(1))

    startReading(UTTERANCES.slice(1), PAGE)
    await vi.waitFor(() => expect(engine.spoken()).toEqual(['first', 'second']))
    expect(engine.handlers.stop_speaking).not.toHaveBeenCalled()
  })

  it('ends with a toast saying the engine failed when speak_text rejects', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_speech_status: () => 'Native',
        get_speech_engine_available: () => true,
        speak_text: () => Promise.reject(new Error('the speech engine failed')),
        stop_speaking: () => null,
      }),
    )
    await supportNative()

    startReading(UTTERANCES, PAGE)
    await vi.waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('readAloud.failed')),
    )
    expect(getReadAloudSnapshot()).toMatchObject({ reading: false, currentBlockId: null })
  })

  it('logs the engine’s own message when speak_text rejects with an AppError', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_speech_status: () => 'Native',
        get_speech_engine_available: () => true,
        speak_text: () =>
          Promise.reject({
            kind: 'invalid_operation',
            message: 'the speech engine failed: synthesis error -3',
          }),
        stop_speaking: () => null,
      }),
    )
    await supportNative()

    startReading(UTTERANCES, PAGE)
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('read-aloud', 'the speech engine stopped the reading', {
        error: 'the speech engine failed: synthesis error -3',
      }),
    )
  })

  it('sends nothing for a reading stopped while it waited on the last stop', async () => {
    const engine = nativeEngine()
    await supportNative()
    startReading(UTTERANCES.slice(0, 1), PAGE)
    await vi.waitFor(() => expect(engine.spoken()).toHaveLength(1))
    stopReading()
    startReading(UTTERANCES.slice(1), PAGE)
    stopReading()

    engine.finishStop(0)
    engine.finishStop(1)
    for (let hop = 0; hop < 5; hop += 1) await Promise.resolve()
    expect(engine.spoken()).toEqual(['first'])
  })

  it('lets the reading that replaced it read on when the replaced utterance reports its stop', async () => {
    const engine = nativeEngine()
    await supportNative()
    startReading(UTTERANCES.slice(0, 1), PAGE)
    await vi.waitFor(() => expect(engine.spoken()).toHaveLength(1))
    startReading(UTTERANCES.slice(1), PAGE)
    await vi.waitFor(() => expect(engine.spoken()).toHaveLength(2))

    // The engine reports the utterance the new reading's QUEUE_FLUSH cut off.
    engine.end(0, 'Stopped')
    for (let hop = 0; hop < 5; hop += 1) await Promise.resolve()
    expect(getReadAloudSnapshot()).toMatchObject({ reading: true, currentBlockId: 'B' })
  })

  it('lets the reading that replaced it read on when the replaced utterance fails', async () => {
    let rejectFirst: (err: unknown) => void = () => {}
    let calls = 0
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({
        get_speech_status: () => 'Native',
        get_speech_engine_available: () => true,
        speak_text: () => {
          calls += 1
          return calls === 1
            ? new Promise<SpeakOutcome>((_, reject) => {
                rejectFirst = reject
              })
            : new Promise<SpeakOutcome>(() => {})
        },
        stop_speaking: () => null,
      }),
    )
    await supportNative()
    startReading(UTTERANCES.slice(0, 1), PAGE)
    await vi.waitFor(() => expect(calls).toBe(1))
    startReading(UTTERANCES.slice(1), PAGE)
    await vi.waitFor(() => expect(calls).toBe(2))

    rejectFirst({ kind: 'invalid_operation', message: 'the speech engine failed' })
    for (let hop = 0; hop < 5; hop += 1) await Promise.resolve()
    expect(getReadAloudSnapshot()).toMatchObject({ reading: true, currentBlockId: 'B' })
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
  })
})
