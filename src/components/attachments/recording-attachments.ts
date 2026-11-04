/** The file-name suffixes of a recording's transcript and summary (#5364), read in any case. */
const RECORDING_SUFFIXES = { transcript: '.transcript.md', summary: '.summary.md' } as const

interface NamedAttachment {
  filename: string
  mime_type: string
}

/** A block's recording, its transcript and summary, and every other attachment in order. */
export interface RecordingGroup<A extends NamedAttachment> {
  audio?: A
  transcript?: A
  summary?: A
  rest: A[]
}

/** The name before `suffix`, lower-cased, or null when the name does not end in it. */
function stemBefore(filename: string, suffix: string): string | null {
  const name = filename.toLowerCase()
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : null
}

function audioStem(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return (dot > 0 ? filename.slice(0, dot) : filename).toLowerCase()
}

/**
 * Pairs a transcript and a summary with the block's audio. With one audio on
 * the block, the first of each pairs with it whatever its name. With several,
 * the recording is the first audio a transcript or summary names by stem
 * (`rec.ogg` and `rec.transcript.md`), and only files of that stem pair. With
 * no audio, or no stem that matches, nothing pairs.
 */
export function groupRecording<A extends NamedAttachment>(attachments: A[]): RecordingGroup<A> {
  const audios = attachments.filter((att) => att.mime_type.startsWith('audio/'))
  const companion = (audio: A, suffix: string) =>
    attachments.find((att) => {
      const stem = stemBefore(att.filename, suffix)
      return stem !== null && (audios.length === 1 || stem === audioStem(audio.filename))
    })
  for (const audio of audios) {
    const transcript = companion(audio, RECORDING_SUFFIXES.transcript)
    const summary = companion(audio, RECORDING_SUFFIXES.summary)
    if (audios.length > 1 && !transcript && !summary) continue
    return {
      audio,
      ...(transcript && { transcript }),
      ...(summary && { summary }),
      rest: attachments.filter((att) => att !== audio && att !== transcript && att !== summary),
    }
  }
  return { rest: attachments }
}
