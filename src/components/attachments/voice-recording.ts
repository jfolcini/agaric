/**
 * The audio formats `MediaRecorder` may save a voice note in, best first.
 * WebKitGTK's records none of them (#5730); there the recorder encodes Opus
 * itself (`voice-recorder.ts`).
 */
const RECORDING_TYPES = ['audio/webm;codecs=opus', 'audio/mp4']

/** The first of {@link RECORDING_TYPES} this webview's `MediaRecorder` can record, if any. */
export function supportedRecordingType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
}

/**
 * Whether this webview can encode Opus itself and play the Ogg file that makes.
 * Synchronous for the slash menu; whether the encoder takes the microphone's
 * sample rate (`AudioEncoder.isConfigSupported`) is asked when recording starts.
 */
function canEncodeOggOpus(): boolean {
  return (
    typeof AudioEncoder !== 'undefined' &&
    document.createElement('audio').canPlayType('audio/ogg; codecs=opus') !== ''
  )
}

export function canRecordVoiceNote(): boolean {
  return supportedRecordingType() !== undefined || canEncodeOggOpus()
}
