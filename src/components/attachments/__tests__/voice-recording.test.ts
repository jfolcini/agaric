import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  canRecordVoiceNote,
  supportedRecordingType,
} from '@/components/attachments/voice-recording'

function stubRecorder(supported: readonly string[]): void {
  vi.stubGlobal('MediaRecorder', { isTypeSupported: (type: string) => supported.includes(type) })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('supportedRecordingType', () => {
  it('prefers Opus in WebM', () => {
    stubRecorder(['audio/webm;codecs=opus', 'audio/mp4'])
    expect(supportedRecordingType()).toBe('audio/webm;codecs=opus')
    expect(canRecordVoiceNote()).toBe(true)
  })

  it('falls back to MP4 where WebM is unsupported (WKWebView)', () => {
    stubRecorder(['audio/mp4'])
    expect(supportedRecordingType()).toBe('audio/mp4')
    expect(canRecordVoiceNote()).toBe(true)
  })

  it('finds nothing where MediaRecorder supports none of the formats (WebKitGTK)', () => {
    stubRecorder(['audio/ogg;codecs=opus'])
    expect(supportedRecordingType()).toBeUndefined()
    expect(canRecordVoiceNote()).toBe(false)
  })

  it('finds nothing where MediaRecorder does not exist', () => {
    vi.stubGlobal('MediaRecorder', undefined)
    expect(supportedRecordingType()).toBeUndefined()
    expect(canRecordVoiceNote()).toBe(false)
  })
})
