/**
 * The `/voice` recorder's two routes (#5730). `MediaRecorder` and the Web Audio
 * + WebCodecs objects are fakes (`@/__tests__/mocks/web-audio`); a real
 * microphone and encoder are driven by `e2e/voice-note-record.spec.ts` and
 * `e2e-tauri/voice-note-record.e2e.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FakeAudioContext,
  FakeAudioEncoder,
  FakeAudioWorkletNode,
  FLUSHED_PACKET,
  OPUS_HEAD,
  fakeMicrophone,
  installWebAudioFakes,
  lastOf,
} from '@/__tests__/mocks/web-audio'
import { OggOpusWriter } from '@/components/attachments/ogg-opus'
import { startVoiceRecorder } from '@/components/attachments/voice-recorder'
import { logger } from '@/lib/logger'

const CELT_20MS = 19 << 3

function packet(length: number, fill: number): Uint8Array {
  const bytes = new Uint8Array(length).fill(fill)
  bytes[0] = CELT_20MS
  return bytes
}

async function bytesOf(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())]
}

function stubMediaRecorder(supported: readonly string[]): void {
  vi.stubGlobal(
    'MediaRecorder',
    class {
      static isTypeSupported(type: string): boolean {
        return supported.includes(type)
      }
      readonly mimeType: string
      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        this.mimeType = options?.mimeType ?? ''
      }
      start(): void {}
    },
  )
}

beforeEach(() => {
  installWebAudioFakes()
  stubMediaRecorder([])
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('startVoiceRecorder route', () => {
  it('records with MediaRecorder wherever it has a format, even with an encoder present', async () => {
    stubMediaRecorder(['audio/mp4'])
    const { stream } = fakeMicrophone()

    await startVoiceRecorder(stream, () => {})

    expect(FakeAudioContext.instances).toHaveLength(0)
    expect(FakeAudioEncoder.instances).toHaveLength(0)
  })

  it('encodes Opus itself where MediaRecorder has no format', async () => {
    const { stream } = fakeMicrophone()

    await startVoiceRecorder(stream, () => {})

    const config = { codec: 'opus', sampleRate: 44_100, numberOfChannels: 1, bitrate: 32_000 }
    expect(FakeAudioEncoder.isConfigSupported).toHaveBeenCalledWith(config)
    expect(lastOf(FakeAudioEncoder.instances).config).toEqual(config)
    const context = lastOf(FakeAudioContext.instances)
    expect(context.audioWorklet.addModule).toHaveBeenCalledWith(
      expect.stringContaining('voice-capture-worklet'),
    )
    const node = lastOf(FakeAudioWorkletNode.instances)
    expect(node).toMatchObject({
      name: 'voice-capture',
      options: { channelCount: 1, channelCountMode: 'explicit' },
    })
    expect(context.source.connect).toHaveBeenCalledWith(node)
  })
})

describe('the Opus recorder', () => {
  it('encodes the captured samples and stops into an Ogg Opus file', async () => {
    const { stream, track } = fakeMicrophone()
    const sizes: number[] = []
    const recorder = await startVoiceRecorder(stream, (bytes) => sizes.push(bytes))
    const node = lastOf(FakeAudioWorkletNode.instances)
    const encoder = lastOf(FakeAudioEncoder.instances)

    node.feed(new Float32Array(2048).fill(0.25))
    node.feed(new Float32Array(2048).fill(-0.25))
    expect(encoder.encoded.map((data) => [data.timestamp, data.numberOfFrames])).toEqual([
      [0, 2048],
      [Math.round((2048 * 1_000_000) / 44_100), 2048],
    ])
    expect(encoder.encoded[0]).toMatchObject({
      format: 'f32-planar',
      sampleRate: 44_100,
      numberOfChannels: 1,
    })

    const packets = [packet(60, 1), packet(70, 2), packet(80, 3)]
    for (const p of packets) encoder.emit(p)
    const expected = new OggOpusWriter(OPUS_HEAD)
    const expectedSizes = packets.map((p) => {
      expected.addPacket(p)
      return expected.byteLength
    })
    expect(sizes).toEqual(expectedSizes)

    recorder.stop()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(lastOf(FakeAudioContext.instances).close).toHaveBeenCalledOnce()
    expect(encoder.flush).toHaveBeenCalledOnce()

    const blob = await recorder.recording
    expect(blob.type).toBe('audio/ogg')
    expected.addPacket(FLUSHED_PACKET)
    expect(await bytesOf(blob)).toEqual(await bytesOf(expected.finish()))
    expect(encoder.state).toBe('closed')
  })

  it('stops once however often it is told to', async () => {
    const { stream, track } = fakeMicrophone()
    const recorder = await startVoiceRecorder(stream, () => {})
    lastOf(FakeAudioEncoder.instances).emit(packet(60, 1))

    recorder.stop()
    recorder.stop()

    expect(track.stop).toHaveBeenCalledOnce()
    expect(lastOf(FakeAudioContext.instances).close).toHaveBeenCalledOnce()
    await expect(recorder.recording).resolves.toBeInstanceOf(Blob)
  })

  it('ends with what it has when the microphone goes away', async () => {
    const mic = fakeMicrophone()
    const recorder = await startVoiceRecorder(mic.stream, () => {})
    lastOf(FakeAudioEncoder.instances).emit(packet(60, 1))

    mic.endOnItsOwn()

    expect(lastOf(FakeAudioContext.instances).close).toHaveBeenCalledOnce()
    expect((await recorder.recording).type).toBe('audio/ogg')
  })

  it('keeps the audio encoded before an encoder error, and releases everything', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const { stream, track } = fakeMicrophone()
    const recorder = await startVoiceRecorder(stream, () => {})
    const encoder = lastOf(FakeAudioEncoder.instances)
    encoder.emit(packet(60, 1))

    const failure = new DOMException('encoder crashed', 'EncodingError')
    encoder.fail(failure)

    expect(track.stop).toHaveBeenCalledOnce()
    expect(lastOf(FakeAudioContext.instances).close).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledWith(
      'voice-recorder',
      'the Opus encoder failed',
      undefined,
      failure,
    )
    // Samples still in flight from the worklet have nowhere to go.
    expect(lastOf(FakeAudioWorkletNode.instances).closed).toBe(true)
    const expected = new OggOpusWriter(OPUS_HEAD)
    expected.addPacket(packet(60, 1))
    expect(await bytesOf(await recorder.recording)).toEqual(await bytesOf(expected.finish()))
  })

  it('rejects when the encoder fails before any audio', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const { stream, track } = fakeMicrophone()
    const recorder = await startVoiceRecorder(stream, () => {})

    const failure = new DOMException('encoder crashed', 'EncodingError')
    lastOf(FakeAudioEncoder.instances).fail(failure)

    await expect(recorder.recording).rejects.toBe(failure)
    expect(track.stop).toHaveBeenCalledOnce()
    expect(lastOf(FakeAudioContext.instances).close).toHaveBeenCalledOnce()
  })

  it('rejects a stream with no OpusHead, which no player could read', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const { stream, track } = fakeMicrophone()
    const recorder = await startVoiceRecorder(stream, () => {})

    lastOf(FakeAudioEncoder.instances).emit(packet(60, 1), null)

    await expect(recorder.recording).rejects.toThrow('the Opus encoder gave no OpusHead')
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('refuses to start where the encoder cannot take the microphone rate, and closes the context', async () => {
    FakeAudioEncoder.supported = false
    const { stream, track } = fakeMicrophone()

    await expect(startVoiceRecorder(stream, () => {})).rejects.toThrow(
      'AudioEncoder cannot encode Opus at 44100 Hz',
    )

    expect(lastOf(FakeAudioContext.instances).close).toHaveBeenCalledOnce()
    // The caller still owns the stream it passed.
    expect(track.stop).not.toHaveBeenCalled()
  })

  it('refuses to start when the worklet module does not load, and closes the context', async () => {
    const refused = new DOMException('Not allowed by CSP', 'SecurityError')
    FakeAudioContext.moduleFailure = refused
    const { stream } = fakeMicrophone()

    await expect(startVoiceRecorder(stream, () => {})).rejects.toBe(refused)

    expect(lastOf(FakeAudioContext.instances).close).toHaveBeenCalledOnce()
    expect(FakeAudioEncoder.instances).toHaveLength(0)
  })

  it('logs a context that fails to close instead of dropping the error', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { stream } = fakeMicrophone()
    const recorder = await startVoiceRecorder(stream, () => {})
    const failure = new DOMException('already closed', 'InvalidStateError')
    lastOf(FakeAudioContext.instances).close.mockRejectedValueOnce(failure)
    lastOf(FakeAudioEncoder.instances).emit(packet(60, 1))

    recorder.stop()
    await recorder.recording

    expect(warn).toHaveBeenCalledWith(
      'voice-recorder',
      'closing the audio context failed',
      undefined,
      failure,
    )
  })
})
