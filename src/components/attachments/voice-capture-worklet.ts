/**
 * The `/voice` recorder's audio-thread end (#5730): hands the microphone's
 * samples to the main thread, which encodes them. Loaded with
 * `audioWorklet.addModule` from a same-origin file, since the CSP refuses a
 * `blob:` module; never import it, it runs only in an `AudioWorkletGlobalScope`.
 */

// `lib.dom` has no types for the worklet scope.
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor & { process(inputs: Float32Array[][]): boolean },
): void

/**
 * Samples per message. Each message is one `AudioEncoder.encode` call, whose
 * overhead on WebKitGTK made 128-sample blocks cost several times as much CPU.
 * The part-filled batch at stop, under 50 ms, is dropped.
 */
const BATCH_FRAMES = 2048

registerProcessor(
  'voice-capture',
  class extends AudioWorkletProcessor {
    batch = new Float32Array(BATCH_FRAMES)
    filled = 0

    process(inputs: Float32Array[][]): boolean {
      const samples = inputs[0]?.[0]
      if (!samples) return true
      for (let offset = 0; offset < samples.length;) {
        const taken = Math.min(samples.length - offset, BATCH_FRAMES - this.filled)
        this.batch.set(samples.subarray(offset, offset + taken), this.filled)
        this.filled += taken
        offset += taken
        if (this.filled === BATCH_FRAMES) {
          this.port.postMessage(this.batch, [this.batch.buffer])
          this.batch = new Float32Array(BATCH_FRAMES)
          this.filled = 0
        }
      }
      return true
    }
  },
)
