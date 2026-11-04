/**
 * The transcript format a `.transcript.md` attachment is read in (#5410): a
 * paragraph that starts with `[h:mm:ss]` or `[mm:ss]` (hours one or more
 * digits, minutes and seconds two digits below 60), then a space or the end of
 * the paragraph, is a segment starting at that time. Any other paragraph, or a
 * bracket anywhere else, is plain Markdown. Paragraphs are separated by a blank
 * line.
 */

export interface TranscriptSegment {
  /** Seconds into the recording; `null` for a paragraph with no timestamp. */
  start: number | null
  /** The timestamp as written, without its brackets; `''` when `start` is null. */
  label: string
  /** The paragraph after its timestamp, a speaker such as `**Alice:**` included. */
  markdown: string
}

const TIMESTAMP = /^\[(?:(\d+):)?([0-5]\d):([0-5]\d)\](?:\s+|$)/

/** The text's paragraphs as segments, or `null` when no paragraph has a timestamp. */
export function parseTranscript(text: string): TranscriptSegment[] | null {
  const segments: TranscriptSegment[] = []
  let timed = false
  for (const raw of text.replaceAll('\r\n', '\n').split(/\n[ \t]*\n/)) {
    const paragraph = raw.trim()
    if (paragraph === '') continue
    const match = TIMESTAMP.exec(paragraph)
    if (!match) {
      segments.push({ start: null, label: '', markdown: paragraph })
      continue
    }
    const [stamp, hours, minutes, seconds] = match
    timed = true
    segments.push({
      start: Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds),
      label: stamp.trim().slice(1, -1),
      markdown: paragraph.slice(stamp.length),
    })
  }
  return timed ? segments : null
}

/** The index of the last of the ascending `starts` at or before `time`; -1 before the first. */
export function currentSegmentIndex(starts: readonly number[], time: number): number {
  let low = 0
  let high = starts.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if ((starts[mid] as number) <= time) low = mid + 1
    else high = mid
  }
  return low - 1
}
