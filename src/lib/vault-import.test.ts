/**
 * Unit tests for the pure import logic extracted from `DataTab.tsx`
 * (`@/lib/vault-import`): path/name/format helpers, the vault index +
 * attachment resolver/collector, and the per-format `*ToUnits` producers.
 */

import { describe, expect, it } from 'vitest'

import { enexNoteToMarkdown, type EnexNote } from '@/lib/enex-import'
import { jexNoteToMarkdown, type JexNote } from '@/lib/jex-import'
import {
  basename,
  collectVaultFiles,
  enexNotesToUnits,
  importErrorReason,
  indexVaultFiles,
  inferBibliographyFormat,
  jexNotesToUnits,
  mdFilesToUnits,
  resolveVaultRef,
  sanitizeSpaceNameForFilename,
  vaultRelativePath,
} from '@/lib/vault-import'

/** Build a `File` carrying a `webkitRelativePath` (the folder-pick shape). */
function folderFile(
  bytes: BlobPart[],
  name: string,
  relativePath: string,
  type = 'text/markdown',
): File {
  const f = new File(bytes, name, { type })
  Object.defineProperty(f, 'webkitRelativePath', { value: relativePath })
  return f
}

describe('vaultRelativePath', () => {
  it('strips the top folder segment (browser prefixes the picked folder name)', () => {
    expect(vaultRelativePath('MyVault/assets/a.png')).toBe('assets/a.png')
    expect(vaultRelativePath('MyVault/note.md')).toBe('note.md')
  })

  it('normalizes backslashes and strips a leading ./ before the top-folder strip', () => {
    expect(vaultRelativePath('MyVault\\assets\\a.png')).toBe('assets/a.png')
    // Leading `./` removed first, then the top folder (`MyVault`) is stripped.
    expect(vaultRelativePath('./MyVault/a.png')).toBe('a.png')
  })

  it('keeps a top-level (no-slash) path as-is and treats empty/undefined as empty', () => {
    expect(vaultRelativePath('note.md')).toBe('note.md')
    expect(vaultRelativePath('')).toBe('')
    expect(vaultRelativePath(undefined)).toBe('')
  })
})

describe('basename', () => {
  it('returns the final segment of a /-separated path', () => {
    expect(basename('a/b/c.png')).toBe('c.png')
    expect(basename('c.png')).toBe('c.png')
    expect(basename('a/b/')).toBe('')
  })
})

describe('sanitizeSpaceNameForFilename', () => {
  it('lowercases, collapses non-alphanumeric runs, and trims dashes', () => {
    expect(sanitizeSpaceNameForFilename('Personal')).toBe('personal')
    expect(sanitizeSpaceNameForFilename('My Project')).toBe('my-project')
    expect(sanitizeSpaceNameForFilename('🌟 Star Space')).toBe('star-space')
    expect(sanitizeSpaceNameForFilename('Work / Home!!!')).toBe('work-home')
  })

  it('returns empty string for an all-non-alphanumeric name', () => {
    expect(sanitizeSpaceNameForFilename('🌟🌟🌟')).toBe('')
    expect(sanitizeSpaceNameForFilename('')).toBe('')
  })
})

describe('inferBibliographyFormat', () => {
  it('maps .bib → bibtex and .json → csl-json (case-insensitive)', () => {
    expect(inferBibliographyFormat('refs.bib')).toBe('bibtex')
    expect(inferBibliographyFormat('REFS.BIB')).toBe('bibtex')
    expect(inferBibliographyFormat('refs.json')).toBe('csl-json')
    expect(inferBibliographyFormat('refs.JSON')).toBe('csl-json')
  })

  it('returns null for any other extension', () => {
    expect(inferBibliographyFormat('notes.md')).toBeNull()
    expect(inferBibliographyFormat('archive.enex')).toBeNull()
    expect(inferBibliographyFormat('noext')).toBeNull()
  })
})

describe('importErrorReason', () => {
  it('prefers the AppError wire-shape message (Validation carries real text)', () => {
    expect(
      importErrorReason({ kind: 'validation', message: 'space_id does not refer to a live space' }),
    ).toBe('space_id does not refer to a live space')
  })

  it('falls back to Error.message, then String() for non-IPC throws', () => {
    expect(importErrorReason(new Error('boom'))).toBe('boom')
    expect(importErrorReason('plain string')).toBe('plain string')
    expect(importErrorReason(42)).toBe('42')
  })
})

describe('indexVaultFiles / resolveVaultRef', () => {
  it('resolves an exact vault-relative path first, then falls back to basename', () => {
    const md = folderFile(['# note'], 'note.md', 'MyVault/note.md')
    const png = folderFile([new Uint8Array([1])], 'diagram.png', 'MyVault/assets/diagram.png')
    const index = indexVaultFiles([md, png])

    // Exact vault-relative path.
    expect(resolveVaultRef('assets/diagram.png', index)).toBe(png)
    // Basename fallback (Obsidian ![[diagram.png]] style).
    expect(resolveVaultRef('diagram.png', index)).toBe(png)
    // Backslash + ./ normalization on the reference.
    expect(resolveVaultRef('.\\assets\\diagram.png', index)).toBe(png)
    // Unknown ref resolves to nothing.
    expect(resolveVaultRef('missing.png', index)).toBeUndefined()
  })

  it('keeps the FIRST file on a basename collision (deterministic)', () => {
    const a = folderFile([new Uint8Array([1])], 'img.png', 'MyVault/a/img.png')
    const b = folderFile([new Uint8Array([2])], 'img.png', 'MyVault/b/img.png')
    const index = indexVaultFiles([a, b])

    // Distinct exact paths both resolve precisely.
    expect(resolveVaultRef('a/img.png', index)).toBe(a)
    expect(resolveVaultRef('b/img.png', index)).toBe(b)
    // Basename collision → the first indexed file wins.
    expect(resolveVaultRef('img.png', index)).toBe(a)
  })
})

describe('collectVaultFiles', () => {
  it('reads the bytes of a referenced sibling and ships a vault-root-relative path', async () => {
    const md = folderFile(['![](assets/diagram.png)'], 'note.md', 'MyVault/note.md')
    const png = folderFile(
      [new Uint8Array([1, 2, 3, 4])],
      'diagram.png',
      'MyVault/assets/diagram.png',
      'image/png',
    )
    const index = indexVaultFiles([md, png])

    const collected = await collectVaultFiles('![](assets/diagram.png)', index)
    expect(collected).toHaveLength(1)
    expect(collected?.[0]?.path).toBe('assets/diagram.png')
    expect(collected?.[0]?.bytes).toEqual([1, 2, 3, 4])
  })

  it('returns null when there are no refs or none resolve', async () => {
    const md = folderFile(['no refs here'], 'note.md', 'MyVault/note.md')
    const index = indexVaultFiles([md])
    // No refs at all.
    expect(await collectVaultFiles('no refs here', index)).toBeNull()
    // A ref that matches no file.
    expect(await collectVaultFiles('![](assets/missing.png)', index)).toBeNull()
  })
})

describe('mdFilesToUnits', () => {
  it('uses the basename as name and file.size as bytes; load reads content + basename path', async () => {
    const file = new File(['# Hello'], 'test.md', { type: 'text/markdown' })
    const [unit] = mdFilesToUnits([file], null)
    expect(unit?.name).toBe('test.md')
    expect(unit?.bytes).toBe(file.size)

    const loaded = await unit?.load()
    expect(loaded?.content).toBe('# Hello')
    // Plain pick (empty webkitRelativePath) ⇒ path falls back to basename.
    expect(loaded?.path).toBe('test.md')
    // No vault index ⇒ no siblings.
    expect(loaded?.vaultFiles).toBeNull()
  })

  it('passes the folder-relative path (namespace mapping) and matched vault siblings', async () => {
    const md = folderFile(['![](assets/diagram.png)'], 'note.md', 'MyVault/note.md')
    const png = folderFile(
      [new Uint8Array([9, 9])],
      'diagram.png',
      'MyVault/assets/diagram.png',
      'image/png',
    )
    const index = indexVaultFiles([md, png])
    const [unit] = mdFilesToUnits([md], index)

    const loaded = await unit?.load()
    // #1446 — the folder-relative path drives the namespace mapping.
    expect(loaded?.path).toBe('MyVault/note.md')
    expect(loaded?.vaultFiles).toHaveLength(1)
    expect(loaded?.vaultFiles?.[0]?.path).toBe('assets/diagram.png')
    expect(loaded?.vaultFiles?.[0]?.bytes).toEqual([9, 9])
  })
})

describe('enexNotesToUnits', () => {
  const note = (title: string, attachments: EnexNote['attachments'] = []): EnexNote => ({
    title,
    markdown: `body of ${title}`,
    tags: [],
    createdMs: null,
    updatedMs: null,
    attachments,
  })

  it('produces one unit per note, filename from the sanitized title, content from enexNoteToMarkdown', async () => {
    const alpha = note('Alpha')
    const notes = [alpha, note('Beta')]
    const units = enexNotesToUnits(notes)
    expect(units).toHaveLength(2)

    expect(units[0]?.name).toBe('Alpha.md')
    const content0 = enexNoteToMarkdown(alpha)
    expect(units[0]?.bytes).toBe(content0.length)
    const loaded0 = await units[0]?.load()
    expect(loaded0?.content).toBe(content0)
    // Note-based units use the name as the IPC path.
    expect(loaded0?.path).toBe('Alpha.md')
    // No attachments ⇒ null vaultFiles (consistent with the single-file path).
    expect(loaded0?.vaultFiles).toBeNull()
  })

  it('ships decoded en-media attachment bytes as vaultFiles', async () => {
    const withMedia = note('Pic', [
      { path: 'pic.png', bytes: new Uint8Array([104, 101, 108, 108, 111]), mime: 'image/png' },
    ])
    const [unit] = enexNotesToUnits([withMedia])
    const loaded = await unit?.load()
    expect(loaded?.vaultFiles).toHaveLength(1)
    expect(loaded?.vaultFiles?.[0]?.path).toBe('pic.png')
    expect(loaded?.vaultFiles?.[0]?.bytes).toEqual([104, 101, 108, 108, 111])
  })

  it('returns an empty list for no notes', () => {
    expect(enexNotesToUnits([])).toEqual([])
  })
})

describe('jexNotesToUnits', () => {
  const note = (title: string, attachments: JexNote['attachments'] = []): JexNote => ({
    title,
    markdown: `body of ${title}`,
    createdMs: null,
    updatedMs: null,
    attachments,
  })

  it('produces one unit per note, filename from the (Evernote) title sanitizer, content from jexNoteToMarkdown', async () => {
    const pic = note('Picture Note')
    const [unit] = jexNotesToUnits([pic])
    expect(unit?.name).toBe('Picture Note.md')
    const content = jexNoteToMarkdown(pic)
    expect(unit?.bytes).toBe(content.length)
    const loaded = await unit?.load()
    expect(loaded?.content).toBe(content)
    expect(loaded?.path).toBe('Picture Note.md')
    expect(loaded?.vaultFiles).toBeNull()
  })

  it('ships decoded resource bytes as vaultFiles', async () => {
    const withRes = note('Res', [
      { path: 'pic.png', bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' },
    ])
    const [unit] = jexNotesToUnits([withRes])
    const loaded = await unit?.load()
    expect(loaded?.vaultFiles).toHaveLength(1)
    expect(loaded?.vaultFiles?.[0]?.path).toBe('pic.png')
    expect(loaded?.vaultFiles?.[0]?.bytes).toEqual([1, 2, 3])
  })
})
