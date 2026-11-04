import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { currentSegmentIndex, parseTranscript } from '@/components/attachments/transcript'

const pad = (n: number) => String(n).padStart(2, '0')

/** A timestamp as a transcript writes it, with the seconds it stands for. */
const arbTimestamp = fc
  .record({
    hours: fc.option(fc.integer({ min: 0, max: 999 }), { nil: undefined }),
    minutes: fc.integer({ min: 0, max: 59 }),
    seconds: fc.integer({ min: 0, max: 59 }),
  })
  .map(({ hours, minutes, seconds }) => ({
    label: `${hours === undefined ? '' : `${hours}:`}${pad(minutes)}:${pad(seconds)}`,
    start: (hours ?? 0) * 3600 + minutes * 60 + seconds,
  }))

/** One line of speech: never empty, never starting with a bracket, no blank line inside. */
const arbSpeech = fc.stringMatching(/^[A-Za-z][A-Za-z ,.*:!?]{0,40}$/)

describe('parseTranscript', () => {
  it('reads back every [h:mm:ss] and [mm:ss] at the start of a paragraph', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ stamp: arbTimestamp, speech: arbSpeech }), {
          minLength: 1,
          maxLength: 8,
        }),
        (rows) => {
          const text = rows.map((r) => `[${r.stamp.label}] ${r.speech}`).join('\n\n')
          expect(parseTranscript(text)).toEqual(
            rows.map((r) => ({
              start: r.stamp.start,
              label: r.stamp.label,
              markdown: r.speech.trim(),
            })),
          )
        },
      ),
    )
  })

  it('leaves a bracket that is not a timestamp as text', () => {
    const notTimestamps = fc.oneof(
      fc.integer({ min: 60, max: 99 }).map((m) => `${m}:00`),
      fc.integer({ min: 60, max: 99 }).map((s) => `00:${s}`),
      fc.integer({ min: 0, max: 9 }).map((m) => `${m}:00`),
      fc.integer({ min: 100, max: 999 }).map((m) => `${m}:00`),
      fc.integer({ min: 0, max: 9 }).map((s) => `1:00:${s}`),
      fc.constantFrom('', 'x', '00:00:00:00', 'aa:bb', '00:0a', ' 00:05', '00:05 ', '1:60:00'),
    )
    fc.assert(
      fc.property(notTimestamps, arbSpeech, (inner, speech) => {
        expect(parseTranscript(`[${inner}] ${speech}`)).toBeNull()
      }),
    )
  })

  it('reads a timestamp only at the very start of a paragraph, followed by a space or the end', () => {
    expect(parseTranscript('Alice said [00:05] hello')).toBeNull()
    expect(parseTranscript('[00:05](https://example.com) a link')).toBeNull()
    expect(parseTranscript('[00:05]hello')).toBeNull()
    expect(parseTranscript('[00:05]')).toEqual([{ start: 5, label: '00:05', markdown: '' }])
  })

  it('keeps the speaker in the Markdown and the paragraphs that carry no timestamp', () => {
    const text =
      '# Standup\r\n\r\n[00:00] **Alice:** hi\r\nsecond line\r\n\r\n\r\nNotes\n\n[1:02:03] **Bob:** bye'
    expect(parseTranscript(text)).toEqual([
      { start: null, label: '', markdown: '# Standup' },
      { start: 0, label: '00:00', markdown: '**Alice:** hi\nsecond line' },
      { start: null, label: '', markdown: 'Notes' },
      { start: 3723, label: '1:02:03', markdown: '**Bob:** bye' },
    ])
  })

  it('is null for text with no timestamped paragraph', () => {
    expect(parseTranscript('')).toBeNull()
    expect(parseTranscript('# Notes\n\nNo times here.')).toBeNull()
  })
})

describe('currentSegmentIndex', () => {
  it('is the last start at or before the time, or -1 before the first', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10_000 }), { maxLength: 50 }),
        fc.double({ min: -10, max: 10_100, noNaN: true }),
        (unsorted, time) => {
          const starts = unsorted.toSorted((a, b) => a - b)
          expect(currentSegmentIndex(starts, time)).toBe(starts.findLastIndex((s) => s <= time))
        },
      ),
    )
  })

  it('lands on a start exactly and on the last of equal starts', () => {
    expect(currentSegmentIndex([0, 5, 5, 9], 5)).toBe(2)
    expect(currentSegmentIndex([0, 5, 9], 4.999)).toBe(0)
    expect(currentSegmentIndex([3], 2)).toBe(-1)
    expect(currentSegmentIndex([], 2)).toBe(-1)
  })
})
