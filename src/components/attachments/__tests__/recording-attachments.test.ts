import { describe, expect, it } from 'vitest'

import { groupRecording } from '@/components/attachments/recording-attachments'

const file = (filename: string, mime_type: string) => ({ filename, mime_type })
const audio = (filename: string) => file(filename, 'audio/ogg')
const markdown = (filename: string) => file(filename, 'text/markdown')

const rec = audio('rec.ogg')
const transcript = markdown('notes.transcript.md')
const summary = markdown('notes.summary.md')
const image = file('photo.png', 'image/png')
const pdf = file('slides.pdf', 'application/pdf')

describe('groupRecording', () => {
  it.each([
    { name: 'audio alone', input: [rec], expected: { audio: rec, rest: [] } },
    {
      name: 'audio and transcript',
      input: [transcript, rec],
      expected: { audio: rec, transcript, rest: [] },
    },
    {
      name: 'audio and summary',
      input: [summary, rec],
      expected: { audio: rec, summary, rest: [] },
    },
    {
      name: 'audio and others',
      input: [image, rec, pdf],
      expected: { audio: rec, rest: [image, pdf] },
    },
    {
      name: 'audio, transcript and summary',
      input: [transcript, summary, rec],
      expected: { audio: rec, transcript, summary, rest: [] },
    },
    {
      name: 'audio, transcript and others',
      input: [image, transcript, rec, pdf],
      expected: { audio: rec, transcript, rest: [image, pdf] },
    },
    {
      name: 'audio, summary and others',
      input: [pdf, summary, image, rec],
      expected: { audio: rec, summary, rest: [pdf, image] },
    },
    {
      name: 'everything',
      input: [image, transcript, pdf, summary, rec],
      expected: { audio: rec, transcript, summary, rest: [image, pdf] },
    },
  ])('pairs the one audio with any transcript and summary: $name', ({ input, expected }) => {
    expect(groupRecording(input)).toEqual(expected)
  })

  it('leaves a transcript and a summary as plain files on a block with no audio', () => {
    expect(groupRecording([transcript, summary, image])).toEqual({
      rest: [transcript, summary, image],
    })
  })

  it('reads the suffixes in any case and nothing else as a transcript or summary', () => {
    const shouting = markdown('REC.Transcript.MD')
    const plain = [markdown('notes.md'), markdown('transcript.md'), markdown('rec.transcript.txt')]
    expect(groupRecording([rec, ...plain, shouting])).toEqual({
      audio: rec,
      transcript: shouting,
      rest: plain,
    })
  })

  it('pairs the first transcript and summary with one audio and leaves the others', () => {
    const second = markdown('later.transcript.md')
    expect(groupRecording([rec, transcript, second])).toEqual({
      audio: rec,
      transcript,
      rest: [second],
    })
  })

  it('pairs by file-name stem among several audios: the first audio a transcript or summary names', () => {
    const a = audio('a.ogg')
    const b = audio('b.final.webm')
    const bTranscript = markdown('B.final.transcript.md')
    const aSummary = markdown('a.summary.md')
    expect(groupRecording([a, b, bTranscript])).toEqual({
      audio: b,
      transcript: bTranscript,
      rest: [a],
    })
    expect(groupRecording([a, b, bTranscript, aSummary])).toEqual({
      audio: a,
      summary: aSummary,
      rest: [b, bTranscript],
    })
  })

  it('pairs nothing among several audios when no stem matches', () => {
    const input = [audio('a.ogg'), audio('b.ogg'), transcript, summary]
    expect(groupRecording(input)).toEqual({ rest: input })
  })

  it('takes a whole extensionless audio name as its stem', () => {
    const bare = audio('standup')
    const bareTranscript = markdown('standup.transcript.md')
    expect(groupRecording([audio('a.ogg'), bare, bareTranscript])).toEqual({
      audio: bare,
      transcript: bareTranscript,
      rest: [audio('a.ogg')],
    })
  })
})

describe('groupRecording — an audio named only by its extension', () => {
  it('takes the whole name as its stem, so of several audios it pairs with the transcript that names it', () => {
    const dotted = audio('.ogg')
    const other = audio('other.ogg')
    const dottedTranscript = markdown('.ogg.transcript.md')
    expect(groupRecording([other, dotted, dottedTranscript])).toEqual({
      audio: dotted,
      transcript: dottedTranscript,
      rest: [other],
    })
  })
})
