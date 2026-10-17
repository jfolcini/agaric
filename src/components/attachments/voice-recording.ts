/**
 * The audio formats the `/voice` recorder can save, best first. A webview whose
 * `MediaRecorder` supports none of them (WebKitGTK, #5730) cannot record a
 * voice note, whatever the microphone permission says.
 */
const RECORDING_TYPES = ['audio/webm;codecs=opus', 'audio/mp4']

/** The first of {@link RECORDING_TYPES} this webview can record, if any. */
export function supportedRecordingType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
}

export function canRecordVoiceNote(): boolean {
  return supportedRecordingType() !== undefined
}
