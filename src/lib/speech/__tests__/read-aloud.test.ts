/**
 * The *Read aloud* controller (#5745): one reading at a time, spoken through a fake
 * `speechSynthesis`, with its toast, announcements and the backend's support answer.
 */

import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type FakeSpeech, installFakeSpeech } from '@/__tests__/helpers/fake-speech'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { announce } from '@/lib/announcer'
import type { SpeechStatus } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import {
  __resetReadAloudForTests,
  checkReadAloudSupport,
  getReadAloudSnapshot,
  startReading,
  stopReading,
  subscribeReadAloud,
} from '@/lib/speech/read-aloud'

vi.mock('@/lib/announcer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/announcer')>()),
  announce: vi.fn(),
}))

/** What a reading is read from: a page store, in the app. */
const PAGE = {}

const UTTERANCES = [
  { blockId: 'A', text: 'first' },
  { blockId: 'A', text: 'first, continued' },
  { blockId: 'B', text: 'second' },
]

let speech: FakeSpeech

beforeEach(() => {
  vi.clearAllMocks()
  __resetReadAloudForTests()
  speech = installFakeSpeech()
})

afterEach(() => {
  // Before the fake goes: a test that failed mid-reading must not end it on a later unmount.
  __resetReadAloudForTests()
  vi.unstubAllGlobals()
})

describe('a reading', () => {
  it('speaks its utterances in order, one at a time, marking the block being spoken', () => {
    startReading(UTTERANCES, PAGE)
    expect(speech.spoken.map((u) => u.text)).toEqual(['first'])
    expect(getReadAloudSnapshot()).toMatchObject({ reading: true, currentBlockId: 'A' })

    speech.endCurrent()
    expect(speech.spoken.map((u) => u.text)).toEqual(['first', 'first, continued'])
    expect(getReadAloudSnapshot().currentBlockId).toBe('A')

    speech.endCurrent()
    expect(speech.spoken.map((u) => u.text)).toEqual(['first', 'first, continued', 'second'])
    expect(getReadAloudSnapshot().currentBlockId).toBe('B')

    speech.endCurrent()
    expect(getReadAloudSnapshot()).toMatchObject({ reading: false, currentBlockId: null })
    expect(speech.spoken).toHaveLength(3)
  })

  it('shows a persistent toast with Stop, and announces its finish', () => {
    startReading(UTTERANCES.slice(2), PAGE)
    expect(vi.mocked(toast)).toHaveBeenCalledWith(
      t('readAloud.reading'),
      expect.objectContaining({ id: 'read-aloud', duration: Number.POSITIVE_INFINITY }),
    )
    expect(vi.mocked(announce)).not.toHaveBeenCalled()

    speech.endCurrent()
    expect(vi.mocked(announce)).toHaveBeenLastCalledWith(t('announce.readAloudFinished'))
    expect(vi.mocked(toast.dismiss)).toHaveBeenCalledWith('read-aloud')
  })

  it('stops from the toast’s Stop action', () => {
    startReading(UTTERANCES, PAGE)
    const options = vi.mocked(toast).mock.lastCall?.[1] as {
      action: { label: string; onClick: () => void }
    }
    expect(options.action.label).toBe(t('readAloud.stop'))
    options.action.onClick()
    expect(getReadAloudSnapshot().reading).toBe(false)
    expect(speech.cancel).toHaveBeenCalledTimes(1)
  })

  it('stops when its toast is closed', () => {
    startReading(UTTERANCES, PAGE)
    const options = vi.mocked(toast).mock.lastCall?.[1] as { onDismiss: () => void }
    options.onDismiss()
    expect(getReadAloudSnapshot().reading).toBe(false)
    expect(speech.cancel).toHaveBeenCalledTimes(1)
  })

  it('says there is nothing to read, and starts nothing, for no utterances', () => {
    startReading([], PAGE)
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith(t('readAloud.nothingToRead'))
    expect(speech.spoken).toHaveLength(0)
    expect(getReadAloudSnapshot().reading).toBe(false)
  })

  it('notifies its subscribers as the block being spoken changes', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeReadAloud(listener)
    startReading(UTTERANCES.slice(2), PAGE)
    expect(listener).toHaveBeenCalledTimes(1)
    speech.endCurrent()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})

describe('stopping', () => {
  it('cancels the engine, clears the queue and the marked block, and announces it', () => {
    startReading(UTTERANCES, PAGE)
    stopReading()
    expect(speech.cancel).toHaveBeenCalledTimes(1)
    expect(getReadAloudSnapshot()).toMatchObject({ reading: false, currentBlockId: null })
    expect(vi.mocked(announce)).toHaveBeenLastCalledWith(t('announce.readAloudStopped'))
    // The engine reports the utterance it cut as `interrupted`: no error toast.
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    // The cut utterance's `end` speaks nothing more.
    speech.endCurrent()
    expect(speech.spoken).toHaveLength(1)
  })

  it('with an owner, ends only the reading that owner started', () => {
    startReading(UTTERANCES, PAGE)
    stopReading({})
    expect(getReadAloudSnapshot().reading).toBe(true)
    stopReading(PAGE)
    expect(getReadAloudSnapshot().reading).toBe(false)
  })

  it('a new reading replaces the one under way', () => {
    startReading(UTTERANCES, PAGE)
    startReading([{ blockId: 'C', text: 'other' }], PAGE)
    expect(speech.spoken.map((u) => u.text)).toEqual(['first', 'other'])
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    expect(getReadAloudSnapshot().currentBlockId).toBe('C')
    // The first reading's cut utterance does not advance the second.
    speech.spoken[0]?.end()
    expect(speech.spoken).toHaveLength(2)
  })
})

describe('engine errors', () => {
  it('stop the reading with a toast saying the engine failed', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    startReading(UTTERANCES, PAGE)
    speech.failCurrent('synthesis-failed')
    expect(getReadAloudSnapshot().reading).toBe(false)
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('readAloud.failed'))
    // The error toast says it stopped; the announcer does not say it again.
    expect(vi.mocked(announce)).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('read-aloud', 'the speech engine stopped the reading', {
      error: 'synthesis-failed',
    })
    speech.endCurrent()
    expect(speech.spoken).toHaveLength(1)
  })

  it.each(['synthesis-unavailable', 'language-unavailable'])(
    '%s points to the OS speech settings',
    (error) => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {})
      startReading(UTTERANCES, PAGE)
      speech.failCurrent(error)
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('readAloud.noVoice'))
    },
  )
})

describe('support', () => {
  it('is reported when the backend speaks through the webview', async () => {
    vi.mocked(invoke).mockImplementation(mockInvokeCommands({ speech_status: () => 'Webview' }))
    checkReadAloudSupport()
    await vi.waitFor(() => expect(getReadAloudSnapshot().supported).toBe(true))
  })

  it('is not reported where the backend has no engine', async () => {
    const status = vi.fn((): SpeechStatus => 'Unsupported')
    vi.mocked(invoke).mockImplementation(mockInvokeCommands({ speech_status: status }))
    checkReadAloudSupport()
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(getReadAloudSnapshot().supported).toBe(false)
  })

  it('asks the backend once', async () => {
    const status = vi.fn((): SpeechStatus => 'Webview')
    vi.mocked(invoke).mockImplementation(mockInvokeCommands({ speech_status: status }))
    checkReadAloudSupport()
    checkReadAloudSupport()
    await vi.waitFor(() => expect(getReadAloudSnapshot().supported).toBe(true))
    expect(status).toHaveBeenCalledTimes(1)
  })

  it('asks nothing where the webview has no speechSynthesis', () => {
    vi.unstubAllGlobals()
    checkReadAloudSupport()
    expect(vi.mocked(invoke)).not.toHaveBeenCalled()
    expect(getReadAloudSnapshot().supported).toBe(false)
  })

  it('stays hidden, with a warning, when speech_status fails', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({ speech_status: () => Promise.reject(new Error('ipc down')) }),
    )
    checkReadAloudSupport()
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(warn).toHaveBeenCalledWith(
      'read-aloud',
      'speech_status failed; Read aloud stays hidden',
      undefined,
      expect.anything(),
    )
    expect(getReadAloudSnapshot().supported).toBe(false)
  })
})
