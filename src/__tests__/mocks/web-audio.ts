// Fakes for the `/voice` recorder's Web Audio + WebCodecs route (#5730):
// happy-dom has no `AudioContext`, `AudioWorkletNode`, `AudioEncoder` or
// `AudioData`. A test drives them by hand: `FakeAudioWorkletNode.feed` is the
// microphone, `FakeAudioEncoder.emit` and `fail` are the encoder's callbacks.
//
//   installWebAudioFakes()
//   const { stream, track } = fakeMicrophone()

import { vi } from 'vitest'

/** A 19-byte OpusHead as both engines hand it over: mono, pre-skip 312, 44.1 kHz input. */
export const OPUS_HEAD = new Uint8Array([
  ...new TextEncoder().encode('OpusHead'),
  1,
  1,
  0x38,
  0x01,
  0x44,
  0xac,
  0,
  0,
  0,
  0,
  0,
])

/** The packet the encoder still holds when it is flushed: one 20 ms CELT frame. */
export const FLUSHED_PACKET = new Uint8Array([19 << 3, 7, 7, 7])

export class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  /** What `audioWorklet.addModule` rejects with, as the CSP refusing the module would. */
  static moduleFailure: DOMException | null = null
  readonly sampleRate = 44_100
  state: AudioContextState = 'running'
  readonly audioWorklet = {
    addModule: vi.fn(async (_url: string) => {
      if (FakeAudioContext.moduleFailure !== null) throw FakeAudioContext.moduleFailure
    }),
  }
  readonly source = { connect: vi.fn(), disconnect: vi.fn() }
  readonly close = vi.fn(async () => {
    this.state = 'closed'
  })

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  createMediaStreamSource(_stream: MediaStream) {
    return this.source
  }
}

export class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = []
  private readonly listeners: Array<(event: { data: Float32Array }) => void> = []
  started = false
  closed = false
  readonly port = {
    addEventListener: (_type: 'message', listener: (event: { data: Float32Array }) => void) => {
      this.listeners.push(listener)
    },
    start: () => {
      this.started = true
    },
    close: () => {
      this.closed = true
    },
  }

  readonly name: string
  readonly options: AudioWorkletNodeOptions | undefined

  constructor(_context: FakeAudioContext, name: string, options?: AudioWorkletNodeOptions) {
    this.name = name
    this.options = options
    FakeAudioWorkletNode.instances.push(this)
  }

  /** One batch of microphone samples from the worklet. */
  feed(samples: Float32Array): void {
    if (!this.started || this.closed) return
    for (const listener of this.listeners) listener({ data: samples })
  }
}

export class FakeAudioData {
  readonly close = vi.fn()
  readonly init: AudioDataInit

  constructor(init: AudioDataInit) {
    this.init = init
  }
}

export class FakeAudioEncoder {
  static instances: FakeAudioEncoder[] = []
  static supported = true
  static readonly isConfigSupported = vi.fn(async (config: AudioEncoderConfig) => ({
    supported: FakeAudioEncoder.supported,
    config,
  }))

  state: CodecState = 'unconfigured'
  config: AudioEncoderConfig | null = null
  readonly encoded: AudioDataInit[] = []
  /** Hands over the held packet asynchronously and then resolves, as a real flush does. */
  readonly flush = vi.fn(async () => {
    await Promise.resolve()
    this.emit(FLUSHED_PACKET)
  })
  private emitted = 0
  private readonly init: AudioEncoderInit

  constructor(init: AudioEncoderInit) {
    this.init = init
    FakeAudioEncoder.instances.push(this)
  }

  configure(config: AudioEncoderConfig): void {
    this.config = config
    this.state = 'configured'
  }

  encode(data: FakeAudioData): void {
    if (this.state !== 'configured') throw new DOMException('not configured', 'InvalidStateError')
    this.encoded.push(data.init)
  }

  close(): void {
    this.state = 'closed'
  }

  /** One encoded packet; the first carries the OpusHead, as on both engines. */
  emit(packet: Uint8Array, opusHead: Uint8Array | null = OPUS_HEAD): void {
    const chunk = { byteLength: packet.length, copyTo: (to: Uint8Array) => to.set(packet) }
    const metadata =
      this.emitted++ === 0 && opusHead
        ? {
            decoderConfig: {
              codec: 'opus',
              sampleRate: 44_100,
              numberOfChannels: 1,
              description: opusHead,
            },
          }
        : {}
    this.init.output(chunk as unknown as EncodedAudioChunk, metadata)
  }

  /** The encoder failing, which closes it. */
  fail(error: DOMException): void {
    this.state = 'closed'
    this.init.error(error)
  }
}

export function installWebAudioFakes(): void {
  FakeAudioContext.instances = []
  FakeAudioContext.moduleFailure = null
  FakeAudioWorkletNode.instances = []
  FakeAudioEncoder.instances = []
  FakeAudioEncoder.supported = true
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
  vi.stubGlobal('AudioEncoder', FakeAudioEncoder)
  vi.stubGlobal('AudioData', FakeAudioData)
}

/** A one-track microphone stream; `endOnItsOwn` is the device going away. */
export function fakeMicrophone() {
  const ended: Array<() => void> = []
  const track = {
    stop: vi.fn(),
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'ended') ended.push(listener)
    },
  }
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream
  return {
    stream,
    track,
    endOnItsOwn: () => {
      for (const listener of ended) listener()
    },
  }
}

export function lastOf<T>(instances: T[]): T {
  const instance = instances.at(-1)
  if (instance === undefined) throw new Error('nothing was constructed')
  return instance
}
