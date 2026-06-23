/**
 * Tests for `scanAttachmentRefs` — the frontend half of the #1925 attachment
 * detector (`src/lib/import-attachments.ts`). Mirrors the Rust unit-test
 * fixtures for `detect_attachment_refs` / `is_skippable_attachment_ref` in
 * `src-tauri/src/import.rs` so the FE scanner and BE matcher agree on which
 * in-content refs are attachment candidates.
 */

import { describe, expect, it } from 'vitest'

import { scanAttachmentRefs } from '../import-attachments'

describe('scanAttachmentRefs', () => {
  it('detects an Obsidian embed `![[file.png]]`', () => {
    expect(scanAttachmentRefs('Here: ![[diagram.png]] done')).toEqual(['diagram.png'])
  })

  it('drops the Obsidian `|display` suffix, keeping the inner ref', () => {
    expect(scanAttachmentRefs('![[diagram.png|big diagram]]')).toEqual(['diagram.png'])
  })

  it('detects a standard markdown image `![alt](path)`', () => {
    expect(scanAttachmentRefs('![a cat](images/cat.png)')).toEqual(['images/cat.png'])
  })

  it('detects a Logseq/relative `assets/...` ref via the image form', () => {
    expect(scanAttachmentRefs('![](assets/screenshot_1.png)')).toEqual(['assets/screenshot_1.png'])
  })

  it('detects multiple refs across both forms in source order', () => {
    const md = '![[embed.png]]\n\n![alt](assets/img.jpg)\n\n![[other.gif]]'
    expect(scanAttachmentRefs(md)).toEqual(['embed.png', 'other.gif', 'assets/img.jpg'])
  })

  it('dedups a ref referenced more than once', () => {
    const md = '![](assets/a.png) and again ![alt](assets/a.png)'
    expect(scanAttachmentRefs(md)).toEqual(['assets/a.png'])
  })

  it('leaves a markdown image carrying a title suffix unmatched', () => {
    // `![a](url "title")` — the URL class excludes whitespace AND the regex
    // requires `)` immediately after the path, so a title suffix makes the
    // whole token not match (the ref is left as not-a-vault-file). Mirrors the
    // Rust `[^\)\s\n]` class + trailing `)` requirement.
    expect(scanAttachmentRefs('![a](assets/x.png "a title")')).toEqual([])
  })

  describe('skip rules', () => {
    it('skips http/https URLs', () => {
      expect(scanAttachmentRefs('![](http://e.com/a.png) ![](https://e.com/b.png)')).toEqual([])
    })

    it('skips data: URIs', () => {
      expect(scanAttachmentRefs('![](data:image/png;base64,iVBOR)')).toEqual([])
    })

    it('skips protocol-relative `//host` URLs', () => {
      expect(scanAttachmentRefs('![](//cdn.example.com/a.png)')).toEqual([])
    })

    it('skips already-canonical `attachment:<id>` refs', () => {
      expect(scanAttachmentRefs('![alt](attachment:01ABC) ![[attachment:01XYZ]]')).toEqual([])
    })

    it('skips refs inside a fenced code block (```)', () => {
      const md = [
        'before ![[keep.png]]',
        '```',
        '![[skip.png]]',
        '![](assets/skip.jpg)',
        '```',
      ].join('\n')
      expect(scanAttachmentRefs(md)).toEqual(['keep.png'])
    })

    it('skips refs inside a bulleted fence `- ```lang`', () => {
      const md = ['- ```md', '  ![[skip.png]]', '  ```', '- ![[keep.png]]'].join('\n')
      expect(scanAttachmentRefs(md)).toEqual(['keep.png'])
    })

    it('skips refs inside an inline-code span (`...`)', () => {
      expect(scanAttachmentRefs('use `![[skip.png]]` but ![[keep.png]]')).toEqual(['keep.png'])
    })
  })

  it('returns nothing for empty / ref-free markdown', () => {
    expect(scanAttachmentRefs('')).toEqual([])
    expect(scanAttachmentRefs('# Just a heading\n\n- a bullet')).toEqual([])
  })
})
