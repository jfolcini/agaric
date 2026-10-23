/**
 * Tests for `scanAttachmentRefs` — the frontend half of the #1925 attachment
 * detector (`src/lib/import-attachments.ts`). The rows of
 * `conformance/attachment-refs.vectors.json` are read here and by
 * `detect_attachment_refs_matches_the_vectors` in
 * `src-tauri/agaric-engine/src/import.rs`, so the FE scanner and BE matcher
 * agree on which in-content refs are attachment candidates. The fenced-code
 * cases stay here: the backend skips a fenced block before its detector runs.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { scanAttachmentRefs } from '@/lib/import-attachments'

interface AttachmentRefCase {
  name: string
  input: string
  refs: string[]
  tsRefs?: string[]
  note?: string
}

const { cases } = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../../../conformance/attachment-refs.vectors.json'),
    'utf8',
  ),
) as { cases: AttachmentRefCase[] }

describe('scanAttachmentRefs', () => {
  it.each(cases.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    expect(scanAttachmentRefs(row.input)).toEqual(row.tsRefs ?? row.refs)
    if (row.tsRefs !== undefined)
      expect(row.note, 'a row where the sides differ says why').toBeDefined()
  })

  it('skips refs inside a fenced code block (```)', () => {
    const md = ['before ![[keep.png]]', '```', '![[skip.png]]', '![](assets/skip.jpg)', '```'].join(
      '\n',
    )
    expect(scanAttachmentRefs(md)).toEqual(['keep.png'])
  })

  it('skips refs inside a bulleted fence `- ```lang`', () => {
    const md = ['- ```md', '  ![[skip.png]]', '  ```', '- ![[keep.png]]'].join('\n')
    expect(scanAttachmentRefs(md)).toEqual(['keep.png'])
  })

  it('returns nothing for empty / ref-free markdown', () => {
    expect(scanAttachmentRefs('')).toEqual([])
    expect(scanAttachmentRefs('# Just a heading\n\n- a bullet')).toEqual([])
  })
})
