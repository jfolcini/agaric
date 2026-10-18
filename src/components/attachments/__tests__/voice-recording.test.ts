import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  canRecordVoiceNote,
  supportedRecordingType,
} from '@/components/attachments/voice-recording'

function stubRecorder(supported: readonly string[]): void {
  vi.stubGlobal('MediaRecorder', { isTypeSupported: (type: string) => supported.includes(type) })
}

/** WebKitGTK: `AudioEncoder` exists, and `<audio>` plays Ogg Opus or not as `playsOgg` says. */
function stubOggOpusEncoding({ playsOgg }: { playsOgg: boolean }): void {
  vi.stubGlobal('AudioEncoder', class {})
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((type) =>
    playsOgg && type === 'audio/ogg; codecs=opus' ? 'probably' : '',
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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
  })

  it('finds nothing where MediaRecorder does not exist', () => {
    vi.stubGlobal('MediaRecorder', undefined)
    expect(supportedRecordingType()).toBeUndefined()
  })
})

describe('canRecordVoiceNote', () => {
  it('needs no encoder where MediaRecorder records a format', () => {
    stubRecorder(['audio/webm;codecs=opus'])
    vi.stubGlobal('AudioEncoder', undefined)
    expect(canRecordVoiceNote()).toBe(true)
  })

  it('records Ogg Opus where MediaRecorder cannot but AudioEncoder exists and Ogg plays (WebKitGTK)', () => {
    stubRecorder([])
    stubOggOpusEncoding({ playsOgg: true })
    expect(canRecordVoiceNote()).toBe(true)
  })

  it('does not record a file the webview could not play back', () => {
    stubRecorder([])
    stubOggOpusEncoding({ playsOgg: false })
    expect(canRecordVoiceNote()).toBe(false)
  })

  it('cannot record without MediaRecorder or AudioEncoder', () => {
    vi.stubGlobal('MediaRecorder', undefined)
    vi.stubGlobal('AudioEncoder', undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably')
    expect(canRecordVoiceNote()).toBe(false)
  })
})
