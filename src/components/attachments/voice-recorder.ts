/**
 * The `/voice` recorder behind one interface, on two routes (#5730):
 * `MediaRecorder` wherever it records one of `RECORDING_TYPES`, and elsewhere
 * (WebKitGTK) Web Audio capture → WebCodecs `AudioEncoder('opus')` →
 * `OggOpusWriter`.
 */

import { OggOpusWriter } from '@/components/attachments/ogg-opus'
import workletUrl from '@/components/attachments/voice-capture-worklet?worker&url'
import { supportedRecordingType } from '@/components/attachments/voice-recording'
import { logger } from '@/lib/logger'

/**
 * Opus at this rate is about 15 MB an hour. WebKitGTK's encoder overshoots it
 * by about half; the size cap counts the bytes actually recorded.
 */
export const RECORDING_BITS_PER_SECOND = 32_000
/** How often `MediaRecorder` hands over a chunk, and so how often the size cap is checked. */
const CHUNK_INTERVAL_MS = 1000

export interface VoiceRecorder {
  /**
   * The audio, its MIME type on the blob. Settles once the recording ends:
   * on `stop()`, or on its own when the microphone goes away or the encoder
   * fails. Rejects only when nothing was recorded.
   */
  readonly recording: Promise<Blob>
  /** Ends the recording and releases the microphone. */
  stop(): void
}

export function releaseMicrophone(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

/**
 * Records `stream` on the route this webview supports, and from then on owns
 * it: every way the recording ends releases the microphone. If it throws, the
 * caller still owns the stream. `onBytes` gets the recording's size so far.
 */
export async function startVoiceRecorder(
  stream: MediaStream,
  onBytes: (bytes: number) => void,
): Promise<VoiceRecorder> {
  const mimeType = supportedRecordingType()
  if (mimeType !== undefined) return startMediaRecorder(stream, mimeType, onBytes)
  const context = new AudioContext()
  try {
    return await startOpusRecorder(stream, context, onBytes)
  } catch (err) {
    closeAudioContext(context)
    throw err
  }
}

function startMediaRecorder(
  stream: MediaStream,
  mimeType: string,
  onBytes: (bytes: number) => void,
): VoiceRecorder {
  const recorder = new MediaRecorder(stream, {
    mimeType,
    audioBitsPerSecond: RECORDING_BITS_PER_SECOND,
  })
  const chunks: Blob[] = []
  let bytes = 0
  recorder.ondataavailable = (event) => {
    if (event.data.size === 0) return
    chunks.push(event.data)
    bytes += event.data.size
    onBytes(bytes)
  }
  // `onstop` follows the last chunk, also when the recorder stops on its own.
  const recording = new Promise<Blob>((resolve) => {
    recorder.onstop = () => {
      releaseMicrophone(stream)
      resolve(new Blob(chunks, { type: recorder.mimeType.split(';')[0] ?? '' }))
    }
  })
  recorder.start(CHUNK_INTERVAL_MS)
  return { recording, stop: () => recorder.stop() }
}

function closeAudioContext(context: AudioContext): void {
  context.close().catch((err: unknown) => {
    logger.warn('voice-recorder', 'closing the audio context failed', undefined, err)
  })
}

function copyBytes(source: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice()
    : new Uint8Array(source).slice()
}

async function startOpusRecorder(
  stream: MediaStream,
  context: AudioContext,
  onBytes: (bytes: number) => void,
): Promise<VoiceRecorder> {
  const { sampleRate } = context
  const config: AudioEncoderConfig = {
    codec: 'opus',
    sampleRate,
    numberOfChannels: 1,
    bitrate: RECORDING_BITS_PER_SECOND,
  }
  const { supported } = await AudioEncoder.isConfigSupported(config)
  if (supported !== true) throw new Error(`AudioEncoder cannot encode Opus at ${sampleRate} Hz`)
  await context.audioWorklet.addModule(workletUrl)
  // An explicit single channel makes Web Audio downmix a stereo microphone.
  const capture = new AudioWorkletNode(context, 'voice-capture', {
    channelCount: 1,
    channelCountMode: 'explicit',
  })
  const source = context.createMediaStreamSource(stream)

  let ogg: OggOpusWriter | null = null
  let failure: unknown = null
  let settle: { resolve: (blob: Blob) => void; reject: (err: unknown) => void } | null = null
  const recording = new Promise<Blob>((resolve, reject) => {
    settle = { resolve, reject }
  })

  let ended = false
  const stop = () => {
    if (ended) return
    ended = true
    capture.port.close()
    source.disconnect()
    releaseMicrophone(stream)
    closeAudioContext(context)
    void drain(encoder).then(() => {
      if (ogg) settle?.resolve(ogg.finish())
      else settle?.reject(failure ?? new Error('the recording ended before any audio was encoded'))
    })
  }
  const fail = (err: unknown) => {
    logger.error('voice-recorder', 'the Opus encoder failed', undefined, err)
    failure = err
    stop()
  }

  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      if (!ogg) {
        const opusHead = metadata?.decoderConfig?.description
        if (!opusHead) return fail(new Error('the Opus encoder gave no OpusHead'))
        ogg = new OggOpusWriter(copyBytes(opusHead))
      }
      const packet = new Uint8Array(chunk.byteLength)
      chunk.copyTo(packet)
      ogg.addPacket(packet)
      onBytes(ogg.byteLength)
    },
    error: fail,
  })
  encoder.configure(config)

  let frames = 0
  capture.port.addEventListener('message', (event: MessageEvent<Float32Array<ArrayBuffer>>) => {
    const samples = event.data
    const audio = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfChannels: 1,
      numberOfFrames: samples.length,
      timestamp: Math.round((frames * 1_000_000) / sampleRate),
      data: samples,
    })
    frames += samples.length
    encoder.encode(audio)
    audio.close()
  })
  capture.port.start()
  source.connect(capture)
  stream.getAudioTracks()[0]?.addEventListener('ended', stop)
  return { recording, stop }
}

/** Encodes what is queued, unless the encoder already closed on an error. */
async function drain(encoder: AudioEncoder): Promise<void> {
  if (encoder.state !== 'configured') return
  try {
    await encoder.flush()
  } catch (err) {
    logger.warn('voice-recorder', 'flushing the Opus encoder failed', undefined, err)
  }
  if (encoder.state === 'configured') encoder.close()
}
