/**
 * Unit tests for the pure import logic extracted from `DataTab.tsx`
 * (`@/lib/vault-import`): path/name/format helpers, the vault index +
 * attachment resolver/collector, and the per-format `*ToUnits` producers.
 */

import { describe, expect, it } from 'vitest'

import { enexNoteToMarkdown, type EnexNote } from '@/lib/enex-import'
import { t } from '@/lib/i18n'
import { jexNoteToMarkdown, type JexNote } from '@/lib/jex-import'
import {
  basename,
  collectVaultFiles,
  enexNotesToUnits,
  importErrorReason,
  indexVaultFiles,
  inferBibliographyFormat,
  isNotionPick,
  jexNotesToUnits,
  mdFilesToUnits,
  pathTitle,
  resolveVaultRef,
  restoreSpaceFile,
  sanitizeSpaceNameForFilename,
  skippedFiles,
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

  it('only strips a leading "./" — a stray "./" elsewhere in the path is left for the ordinary top-folder strip', () => {
    // No leading './', so the top-folder strip treats 'a.' as the folder name.
    expect(vaultRelativePath('a./b.png')).toBe('b.png')
  })

  it('removes a leading "./" outright (not by substitution) even with no other slash present', () => {
    expect(vaultRelativePath('./note.md')).toBe('note.md')
  })

  it('strips the top segment even when it is a single character (first slash at index 1)', () => {
    expect(vaultRelativePath('a/b.png')).toBe('b.png')
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
    expect(resolveVaultRef('assets/diagram.png', '', index)).toEqual([png])
    // Basename fallback (Obsidian ![[diagram.png]] style).
    expect(resolveVaultRef('diagram.png', '', index)).toEqual([png])
    // Backslash + ./ normalization on the reference.
    expect(resolveVaultRef('.\\assets\\diagram.png', '', index)).toEqual([png])
    // Unknown ref resolves to nothing.
    expect(resolveVaultRef('missing.png', '', index)).toEqual([])
  })

  it('#6032 — ships every file of a basename collision, in pick order', () => {
    const a = folderFile([new Uint8Array([1])], 'img.png', 'MyVault/a/img.png')
    const b = folderFile([new Uint8Array([2])], 'img.png', 'MyVault/b/img.png')
    const index = indexVaultFiles([a, b])

    // Distinct exact paths both resolve precisely.
    expect(resolveVaultRef('a/img.png', '', index)).toEqual([a])
    expect(resolveVaultRef('b/img.png', '', index)).toEqual([b])
    // Basename collision → both ship; the backend takes the first and warns.
    expect(resolveVaultRef('img.png', '', index)).toEqual([a, b])
  })

  it('#6032 — ships only the first two files of a basename tie', () => {
    const files = ['a', 'b', 'c'].map((dir, i) =>
      folderFile([new Uint8Array([i])], 'img.png', `MyVault/${dir}/img.png`),
    )
    expect(resolveVaultRef('img.png', '', indexVaultFiles(files))).toEqual(files.slice(0, 2))
  })

  it('keeps the FIRST file on an exact vault-relative-path collision too (byPath dedup, not just byBase)', () => {
    // Two different top-level vault picks that normalize to the same vault-relative path.
    const first = folderFile(['# a'], 'x.png', 'Vault1/notes/x.png')
    const second = folderFile(['# b'], 'x.png', 'Vault2/notes/x.png')
    const index = indexVaultFiles([first, second])

    expect(resolveVaultRef('notes/x.png', '', index)).toEqual([first])
  })

  it('only strips a leading "./" on the reference — a stray "./" elsewhere falls through to the basename fallback', () => {
    const target = folderFile(['b'], 'b.png', 'MyVault/x/b.png')
    const index = indexVaultFiles([target])

    // want stays 'a./b.png' (no leading './'); no exact-path match, so it
    // falls back to the basename ('b.png'), which does resolve.
    expect(resolveVaultRef('a./b.png', '', index)).toEqual([target])
  })

  it('removes a leading "./" on the reference outright (not by substitution)', () => {
    const target = folderFile(['n'], 'note.md', 'MyVault/note.md')
    const index = indexVaultFiles([target])

    expect(resolveVaultRef('./note.md', '', index)).toEqual([target])
  })

  it("#6032 — resolves from the note's folder, then the vault root, then by basename", () => {
    const png = (path: string) => folderFile([new Uint8Array([1])], basename(path), `V/${path}`)
    const root = png('img.png')
    const inNotes = png('notes/img.png')
    const inSub = png('notes/sub/img.png')
    const pic = png('other/pic.png')
    const index = indexVaultFiles([root, inNotes, inSub, pic])

    expect(resolveVaultRef('img.png', 'notes', index)).toEqual([inNotes])
    expect(resolveVaultRef('sub/img.png', 'notes', index)).toEqual([inSub])
    expect(resolveVaultRef('img.png', '', index)).toEqual([root])
    expect(resolveVaultRef('notes/img.png', 'journal', index)).toEqual([inNotes])
    expect(resolveVaultRef('../img.png', 'notes/sub', index)).toEqual([inNotes])
    expect(resolveVaultRef('./../other/pic.png', 'notes', index)).toEqual([pic])
    // Climbing above the root fails both path steps rather than stopping at
    // the root, so the basename's tie ships.
    expect(resolveVaultRef('../../img.png', 'notes', index)).toEqual([root, inNotes])
  })

  it('drops a "." segment inside the reference, so the exact path wins over a basename tie', () => {
    const a = folderFile([new Uint8Array([1])], 'img.png', 'MyVault/a/img.png')
    const b = folderFile([new Uint8Array([2])], 'img.png', 'MyVault/b/img.png')
    const index = indexVaultFiles([a, b])

    // Were the "." kept, 'a/./img.png' would miss byPath and ship the tie [a, b].
    expect(resolveVaultRef('a/./img.png', '', index)).toEqual([a])
    expect(resolveVaultRef('./img.png', 'b', index)).toEqual([b])
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

    const collected = await collectVaultFiles('![](assets/diagram.png)', '', index)
    expect(collected).toHaveLength(1)
    expect(collected?.[0]?.path).toBe('assets/diagram.png')
    expect(collected?.[0]?.bytes).toEqual([1, 2, 3, 4])
  })

  it('returns null when there are no refs or none resolve', async () => {
    const md = folderFile(['no refs here'], 'note.md', 'MyVault/note.md')
    const index = indexVaultFiles([md])
    // No refs at all.
    expect(await collectVaultFiles('no refs here', '', index)).toBeNull()
    // A ref that matches no file.
    expect(await collectVaultFiles('![](assets/missing.png)', '', index)).toBeNull()
  })

  it("#6032 — ships every file of a basename tie, and only the note's own for a note-relative ref", async () => {
    const a = folderFile([new Uint8Array([0xa])], 'image.png', 'V/a/image.png', 'image/png')
    const b = folderFile([new Uint8Array([0xb])], 'image.png', 'V/b/image.png', 'image/png')
    const index = indexVaultFiles([a, b])

    const tie = await collectVaultFiles('![](image.png)', 'c', index)
    expect(tie?.map((f) => [f.path, f.bytes])).toEqual([
      ['a/image.png', [0xa]],
      ['b/image.png', [0xb]],
    ])
    const beside = await collectVaultFiles('![](image.png)', 'b', index)
    expect(beside?.map((f) => [f.path, f.bytes])).toEqual([['b/image.png', [0xb]]])
  })

  it('#6032 — resolves a `<…>` or `%20` name holding a space', async () => {
    const png = folderFile([new Uint8Array([7])], 'my image.png', 'V/my image.png', 'image/png')
    const index = indexVaultFiles([png])

    for (const content of ['![](<my image.png>)', '![](my%20image.png "title")']) {
      const collected = await collectVaultFiles(content, '', index)
      expect(
        collected?.map((f) => f.path),
        content,
      ).toEqual(['my image.png'])
    }
  })

  it('#6032 — ships a file a note links to, and nothing for a link to a note', async () => {
    const pdf = folderFile(
      [new Uint8Array([5])],
      'paper.pdf',
      'V/docs/paper.pdf',
      'application/pdf',
    )
    const other = folderFile(['- o'], 'other.md', 'V/docs/other.md')
    const index = indexVaultFiles([pdf, other])

    const collected = await collectVaultFiles('[paper](paper.pdf) [o](other.md)', 'docs', index)
    expect(collected?.map((f) => [f.path, f.bytes])).toEqual([['docs/paper.pdf', [5]]])
  })
})

describe('mdFilesToUnits', () => {
  it('uses the basename as name and file.size as bytes; load reads content + basename path', async () => {
    const file = new File(['# Hello'], 'test.md', { type: 'text/markdown' })
    const [unit] = mdFilesToUnits([file], null, false)
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
    const [unit] = mdFilesToUnits([md], index, false)

    const loaded = await unit?.load()
    // #1446 — the path below the picked folder drives the namespace mapping;
    // the folder's own name is no part of the title (#6277 decision 8).
    expect(loaded?.path).toBe('note.md')
    expect(loaded?.vaultFiles).toHaveLength(1)
    expect(loaded?.vaultFiles?.[0]?.path).toBe('assets/diagram.png')
    expect(loaded?.vaultFiles?.[0]?.bytes).toEqual([9, 9])
  })

  it("#6032 — resolves a note's refs from the note's own folder", async () => {
    const md = folderFile(['![](image.png)'], 'note.md', 'V/b/note.md')
    const a = folderFile([new Uint8Array([0xa])], 'image.png', 'V/a/image.png', 'image/png')
    const b = folderFile([new Uint8Array([0xb])], 'image.png', 'V/b/image.png', 'image/png')
    const [unit] = mdFilesToUnits([md, a, b], indexVaultFiles([md, a, b]), false)

    const loaded = await unit?.load()
    expect(loaded?.vaultFiles?.map((f) => f.path)).toEqual(['b/image.png'])
  })

  it('short-circuits to vaultFiles: null on a null vault index without ever calling collectVaultFiles, even when the content has attachment refs', async () => {
    // A plain (non-folder) pick has no vault index. If load() tried to
    // collect vault files anyway it would read a null index and throw.
    const file = new File(['![](assets/diagram.png)'], 'note.md', { type: 'text/markdown' })
    const [unit] = mdFilesToUnits([file], null, false)

    const loaded = await unit?.load()
    expect(loaded?.vaultFiles).toBeNull()
  })

  // #5740 — every non-Markdown file of a folder pick used to become a page
  // holding its bytes as text; it is an attachment only.
  it('makes a page of each Markdown file only, any case of `.md`, while an image still ships', async () => {
    const note = folderFile(['- ![[pic.png]]'], 'note.md', 'Vault/note.md')
    const pic = folderFile([new Uint8Array([7])], 'pic.png', 'Vault/pic.png', 'image/png')
    const loud = folderFile(['- loud'], 'LOUD.MD', 'Vault/LOUD.MD')
    const files = [note, pic, loud]

    const units = mdFilesToUnits(files, indexVaultFiles(files), false)

    expect(units.map((u) => u.name)).toEqual(['note.md', 'LOUD.MD'])
    const loaded = await units[0]?.load()
    expect(loaded?.vaultFiles).toEqual([{ path: 'pic.png', bytes: [7] }])
  })

  // #5740 — the backend writes a `[[Name]]` naming a note of the pick with
  // that note's title, so each file ships the paths of the notes its links
  // and embeds may name, every note of a shared name included, and none when
  // there are none: a folder's note always ships them, which tells the
  // backend it is one.
  it("ships the paths of the folder's notes a `[[Name]]` names, or none", async () => {
    const home = folderFile(['- [[Topic]] ![[twin#h|x]] [[none]]'], 'home.md', 'Vault/home.md')
    const topic = folderFile(['- body'], 'topic.md', 'Vault/sub/topic.md')
    const twin = folderFile(['- twin'], 'twin.md', 'Vault/twin.md')
    const deepTwin = folderFile(['- deep twin'], 'twin.md', 'Vault/a/twin.md')
    const files = [home, topic, twin, deepTwin]

    const [homeUnit, topicUnit] = mdFilesToUnits(files, indexVaultFiles(files), false)

    expect((await homeUnit?.load())?.vaultNotes).toEqual(['sub/topic.md', 'twin.md', 'a/twin.md'])
    expect((await topicUnit?.load())?.vaultNotes).toEqual([])
  })

  it('matches a `[[Name]]` to its note in any case and with padding spaces', async () => {
    const plain = folderFile(['- [[note]]'], 'plain.md', 'Vault/plain.md')
    const padded = folderFile(['- [[ Note ]]'], 'padded.md', 'Vault/padded.md')
    const note = folderFile(['- body'], 'Note.md', 'Vault/Note.md')
    const files = [plain, padded, note]

    const [plainUnit, paddedUnit] = mdFilesToUnits(files, indexVaultFiles(files), false)

    expect((await plainUnit?.load())?.vaultNotes).toEqual(['Note.md'])
    expect((await paddedUnit?.load())?.vaultNotes).toEqual(['Note.md'])
  })

  it('ships no note paths on a plain pick, whose links already name its titles', async () => {
    const home = new File(['- [[topic]]'], 'home.md', { type: 'text/markdown' })
    const topic = new File(['- body'], 'topic.md', { type: 'text/markdown' })

    const [homeUnit] = mdFilesToUnits([home, topic], null, false)

    expect((await homeUnit?.load())?.vaultNotes).toBeNull()
  })
})

/** The content and path each unit of a pick loads, in pick order. */
async function loadAll(files: File[]): Promise<Array<{ path: string; content: string }>> {
  const units = mdFilesToUnits(files, indexVaultFiles(files), isNotionPick(files))
  return Promise.all(
    units.map(async (unit) => {
      const { path, content } = await unit.load()
      return { path, content }
    }),
  )
}

// #6032 — a folder pick dropped every note that was not `.md`, saying nothing.
// #6277 decision 8 — an unzipped export folder-picked back in.
describe('restoring an export', () => {
  it('titles a note its space file lists by the recorded title, which its links then name', async () => {
    const files = [
      folderFile(['- body'], 'a_b.md', 'Export/a_b.md'),
      folderFile(['- see [[a:b]]'], 'home.md', 'Export/home.md'),
    ]
    const units = mdFilesToUnits(files, indexVaultFiles(files), false, new Map([['a_b.md', 'a:b']]))

    const loaded = await Promise.all(units.map((unit) => unit.load()))
    expect(loaded.map((unit) => unit.path)).toEqual(['a:b.md', 'home.md'])
    expect(loaded[1]?.vaultNotes).toEqual(['a:b.md'])
  })

  it('imports no note under `.agaric/`, and every page the export filed under a leading dot', () => {
    const files = [
      folderFile(['report'], 'export-report.txt', 'Export/.agaric/export-report.txt', 'text/plain'),
      folderFile(['x'], '.NET.md', 'Export/.NET.md'),
      folderFile(['x'], 'Core.md', 'Export/.NET/Core.md'),
    ]
    expect(mdFilesToUnits(files, indexVaultFiles(files), false).map((unit) => unit.name)).toEqual([
      '.NET.md',
      'Core.md',
    ])
  })

  it.each([
    ['no definitions', '{"titles": {}}', 'not a space file'],
    ['null titles', '{"propertyDefinitions": [], "titles": null}', 'not a space file'],
    [
      'a title that is no string',
      '{"propertyDefinitions": [], "titles": {"a.md": 1}}',
      'not a space file',
    ],
    [
      'a definition without a type',
      '{"propertyDefinitions": [{"key": "k", "options": null}], "titles": {}}',
      'not a property definition',
    ],
    ['a list for a file', '[]', 'not a space file'],
    ['a list for titles', '{"propertyDefinitions": [], "titles": []}', 'not a space file'],
    [
      'a list for a definition',
      '{"propertyDefinitions": [[]], "titles": {}}',
      'not a property definition',
    ],
    [
      'a definition whose key is no string',
      '{"propertyDefinitions": [{"key": 1, "value_type": "text", "options": null}], "titles": {}}',
      'not a property definition',
    ],
    [
      'a definition whose options are no string',
      '{"propertyDefinitions": [{"key": "k", "value_type": "select", "options": 1}], "titles": {}}',
      'not a property definition',
    ],
  ])('says a space file with %s, and restores nothing from it', async (_, text, reason) => {
    const files = [folderFile([text], 'space.json', 'Export/.agaric/space.json', '')]
    const restored = await restoreSpaceFile(files, 'SPACE')
    expect(restored.titles.size).toBe(0)
    expect(restored.warnings).toEqual([t('data.importSpaceFileFailed', { reason })])
  })

  it('reads no space file from a plain pick, which has no folder', async () => {
    const file = new File(['{"propertyDefinitions": [], "titles": {"a.md": "b"}}'], 'space.json')
    expect(await restoreSpaceFile([file], 'SPACE')).toEqual({ titles: new Map(), warnings: [] })
  })

  it('reads a path back as the importer titles it: no `.md`, segments trimmed, empty ones dropped', () => {
    expect(pathTitle(' a / /b .md')).toBe('a/b')
    expect(pathTitle('a_b.md')).toBe('a_b')
    expect(pathTitle('Notes.MD')).toBe('Notes.MD')
  })
})

describe('folder picks of other note formats (#6032)', () => {
  it('imports `.markdown`, `.mdx` and `.txt` as Markdown, each titled without its extension', async () => {
    const files = [
      folderFile(['- one'], 'one.markdown', 'Vault/one.markdown'),
      folderFile(['- two'], 'two.mdx', 'Vault/two.mdx'),
      folderFile(['- three'], 'three.txt', 'Vault/sub/three.txt', 'text/plain'),
      folderFile([new Uint8Array([1])], 'pic.png', 'Vault/pic.png', 'image/png'),
    ]

    expect(await loadAll(files)).toEqual([
      { path: 'one.md', content: '- one' },
      { path: 'two.md', content: '- two' },
      { path: 'sub/three.md', content: '- three' },
    ])
  })

  it('counts the files a pick skips: not a note, an image or a PDF, and not hidden', () => {
    const files = [
      folderFile(['- n'], 'note.md', 'Vault/note.md'),
      folderFile(['x'], 'pic.PNG', 'Vault/pic.PNG', 'image/png'),
      folderFile(['x'], 'paper.pdf', 'Vault/paper.pdf', 'application/pdf'),
      folderFile(['x'], 'data.bin', 'Vault/data.bin', ''),
      folderFile(['x'], 'sheet.csv', 'Vault/sheet.csv', 'text/csv'),
      folderFile(['{}'], 'app.json', 'Vault/.obsidian/app.json', 'application/json'),
      folderFile(['x'], '.DS_Store', 'Vault/.DS_Store', ''),
    ]

    expect(skippedFiles(files, false, new Set())).toEqual({ other: 2, databases: 0 })
  })

  it('does not count as skipped a file a note embedded, whatever its type', () => {
    const files = [
      folderFile(['![[data.csv]]'], 'note.md', 'Vault/note.md'),
      folderFile(['a,b'], 'data.csv', 'Vault/data.csv', 'text/csv'),
      folderFile(['{}'], 'raw.json', 'Vault/sub/raw.json', 'application/json'),
    ]

    expect(skippedFiles(files, false, new Set(['data.csv']))).toEqual({ other: 1, databases: 0 })
  })

  it('takes a `.jpg` as an image, and counts a file whose image extension is not its last', () => {
    const jpg = folderFile(['x'], 'photo.jpg', 'Vault/photo.jpg', 'image/jpeg')
    const bak = folderFile(['x'], 'pic.png.bak', 'Vault/pic.png.bak', '')

    expect(skippedFiles([jpg], false, new Set())).toEqual({ other: 0, databases: 0 })
    expect(skippedFiles([bak], false, new Set())).toEqual({ other: 1, databases: 0 })
  })

  it('does not count a hidden file of a plain pick, which has no folder path', () => {
    const hidden = new File(['x'], '.DS_Store')
    const shown = new File(['x'], 'data.bin')

    expect(skippedFiles([hidden], false, new Set())).toEqual({ other: 0, databases: 0 })
    expect(skippedFiles([shown], false, new Set())).toEqual({ other: 1, databases: 0 })
  })
})

describe('Notion export (#6032)', () => {
  const PLAN = '0123456789abcdef0123456789abcdef'
  const OTHER = 'fedcba9876543210fedcba9876543210'
  const SUB = 'aaaabbbbccccddddeeeeffff00001111'

  const planMd = [
    '# Plan',
    '',
    'Status: In progress',
    'Due date: 2026-11-01',
    'Categoría: diseño',
    '',
    `See [Other](Other%20${OTHER}.md), [Sub](Plan%20${PLAN}/Sub%20${SUB}.md) and ![pic](Plan%20${PLAN}/pic.png).`,
    '',
    '<aside>',
    '💡 Mind the deadline.',
    '',
    'Second line.',
    '</aside>',
    '',
    '<details>',
    '<summary>More</summary>',
    '',
    'Hidden text',
    '',
    '</details>',
  ].join('\n')

  const notionFiles = (): File[] => [
    folderFile([planMd], `Plan ${PLAN}.md`, `Export/Plan ${PLAN}.md`),
    folderFile(['# Other\n\nBody'], `Other ${OTHER}.md`, `Export/Other ${OTHER}.md`),
    folderFile(['# Sub\n\nChild'], `Sub ${SUB}.md`, `Export/Plan ${PLAN}/Sub ${SUB}.md`),
    folderFile(['Name,Status'], `Tasks ${OTHER}.csv`, `Export/Tasks ${OTHER}.csv`, 'text/csv'),
    folderFile(
      ['Name,Status'],
      `Tasks ${OTHER}_all.csv`,
      `Export/Tasks ${OTHER}_all.csv`,
      'text/csv',
    ),
  ]

  it('titles each page without its id, and its links, `%20`-encoded or in a folder, name those titles', async () => {
    const [plan, other, sub] = await loadAll(notionFiles())

    expect([plan?.path, other?.path, sub?.path]).toEqual(['Plan.md', 'Other.md', 'Plan/Sub.md'])
    // The backend resolves `Other.md` and `Plan/Sub.md` against the folder of
    // `Plan` to the pages `Other` and `Plan/Sub`.
    expect(plan?.content).toContain(
      `See [Other](Other.md), [Sub](Plan/Sub.md) and ![pic](Plan%20${PLAN}/pic.png).`,
    )
  })

  it('makes the property lines page properties, and a callout of each aside and toggle', async () => {
    const [plan, other] = await loadAll(notionFiles())

    expect(plan?.content).toBe(
      [
        'status:: In progress',
        'due-date:: 2026-11-01',
        'categoria:: diseño',
        '',
        `See [Other](Other.md), [Sub](Plan/Sub.md) and ![pic](Plan%20${PLAN}/pic.png).`,
        '',
        '> [!note] 💡 Mind the deadline.',
        '>',
        '> Second line.',
        '',
        '> [!note] More',
        '> Hidden text',
      ].join('\n'),
    )
    // The `# Other` title heading goes; the body has no property lines.
    expect(other?.content).toBe('Body')
  })

  it('keeps a heading that is not the title, after the properties, and prose that is not all properties', async () => {
    const page = folderFile(
      ['# Plan: Q3\n\nOwner: Ann\n\nNote: this line\nis prose\n'],
      `Plan ${PLAN}.md`,
      `Export/Plan ${PLAN}.md`,
    )

    const [loaded] = await loadAll([page])

    expect(loaded?.content).toBe('owner:: Ann\n\n# Plan: Q3\n\nNote: this line\nis prose\n')
  })

  it('leaves a code block as written: no callout and no link made of what it shows', async () => {
    const code = [
      '```html',
      '<details>',
      '<summary>More</summary>',
      `<a href="Other%20${OTHER}.md">[Other](Other%20${OTHER}.md)</a>`,
      '</details>',
      '```',
    ].join('\n')
    const page = folderFile([`# Plan\n\n${code}`], `Plan ${PLAN}.md`, `Export/Plan ${PLAN}.md`)

    const [loaded] = await loadAll([page])

    expect(loaded?.content).toBe(code)
  })

  it('keeps as prose the property lines of a page with a key the app reserves', async () => {
    const page = folderFile(
      ['# Plan\n\nSpace: Room 4\nOwner: Ann\n\nBody'],
      `Plan ${PLAN}.md`,
      `Export/Plan ${PLAN}.md`,
    )

    const [loaded] = await loadAll([page])

    expect(loaded?.content).toBe('Space: Room 4\nOwner: Ann\n\nBody')
  })

  it('reports the database tables apart from other skipped files, each once though Notion writes it twice', () => {
    const files = notionFiles()

    expect(isNotionPick(files)).toBe(true)
    expect(skippedFiles(files, true, new Set())).toEqual({ other: 0, databases: 1 })
  })

  it('counts a file of the export that is neither a page nor a table as other', () => {
    const files = [...notionFiles(), folderFile(['x'], 'data.bin', 'Export/data.bin', '')]

    expect(skippedFiles(files, true, new Set())).toEqual({ other: 1, databases: 1 })
  })

  it('takes `_all` off only the end of a table name, so a table named like a file stays one', () => {
    const files = [
      folderFile(['a'], `log_all.csv ${OTHER}.csv`, `Export/log_all.csv ${OTHER}.csv`, 'text/csv'),
      folderFile(
        ['a'],
        `log_all.csv ${OTHER}_all.csv`,
        `Export/log_all.csv ${OTHER}_all.csv`,
        'text/csv',
      ),
    ]

    expect(skippedFiles(files, true, new Set())).toEqual({ other: 0, databases: 1 })
  })

  it('reads a pick as Notion by its Markdown names alone, however many images its pages hold', async () => {
    const files = [
      ...notionFiles(),
      ...['a', 'b', 'c', 'd'].map((n) =>
        folderFile(['x'], `${n}.png`, `Export/Plan ${PLAN}/${n}.png`, 'image/png'),
      ),
    ]

    const loaded = await loadAll(files)

    expect(loaded.map((l) => l.path)).toEqual(['Plan.md', 'Other.md', 'Plan/Sub.md'])
  })

  it('keeps a text note of the export as written, reading only its Markdown pages as Notion', async () => {
    const files = [
      ...notionFiles(),
      folderFile(['# readme\n\nStatus: draft'], 'readme.txt', 'Export/readme.txt', 'text/plain'),
    ]

    const loaded = await loadAll(files)

    expect(loaded[3]).toEqual({ path: 'readme.md', content: '# readme\n\nStatus: draft' })
  })

  it('leaves a plain folder alone when only some names end in an id', async () => {
    const aside = '# a\n\nStatus: draft\n\n<aside>\nx\n</aside>\n'
    const files = [
      folderFile([aside], 'a.md', 'Vault/a.md'),
      folderFile(['- b'], 'b.md', 'Vault/b.md'),
      folderFile(['- odd'], `Odd ${PLAN}.md`, `Vault/Odd ${PLAN}.md`),
      folderFile(['x,y'], 'table.csv', 'Vault/table.csv', 'text/csv'),
    ]

    const loaded = await loadAll(files)

    expect(loaded.map((l) => l.path)).toEqual(['a.md', 'b.md', `Odd ${PLAN}.md`])
    expect(loaded[0]?.content).toBe(aside)
    expect(skippedFiles(files, isNotionPick(files), new Set())).toEqual({ other: 1, databases: 0 })
  })
})

describe('Org files (#6032)', () => {
  const org = [
    '#+TITLE: Org Tasks',
    '#+STARTUP: overview',
    ':PROPERTIES:',
    ':category: work',
    ':END:',
    '',
    'Intro with [[https://orgmode.org][Org]], [[file:notes/my other.org][Other]] and [[file:pic.png]].',
    '# a comment',
    '',
    '* TODO [#A] Write report',
    '  SCHEDULED: <2026-11-02 Mon> DEADLINE: <2026-11-05 Thu>',
    '  :PROPERTIES:',
    '  :Owner: Alice',
    '  :END:',
    '  Body line.',
    '  - nested item',
    '    - deeper',
    '** DONE Gather data',
    '   CLOSED: [2026-10-30 Fri 10:00]',
    '   #+BEGIN_SRC python',
    '   def f():',
    '       return 1',
    '   ,* not a headline',
    '   #+END_SRC',
    '| a | b |',
    '|---+---|',
    '* Plain [[Page][label]] and [[Page]]',
  ].join('\n')

  it('makes headlines nested blocks with their task syntax, drawers properties and links Markdown', async () => {
    const [loaded] = await loadAll([folderFile([org], 'tasks.org', 'Vault/tasks.org', '')])

    expect(loaded?.content).toBe(
      [
        'category:: work',
        '#+STARTUP: overview',
        '',
        'Intro with [Org](https://orgmode.org), [Other](notes/my%20other.md) and ![](pic.png).',
        '',
        '- TODO [#A] Write report',
        '  SCHEDULED: <2026-11-02 Mon> DEADLINE: <2026-11-05 Thu>',
        '  Owner:: Alice',
        '  Body line.',
        '  - nested item',
        '    - deeper',
        '  - DONE Gather data',
        '    ```python',
        '    def f():',
        '        return 1',
        '    * not a headline',
        '    ```',
        '    | a | b |',
        '    |---+---|',
        '- Plain [[Page|label]] and [[Page]]',
        '',
      ].join('\n'),
    )
  })

  it('titles the page by `#+TITLE`, else by its file name', async () => {
    const titled = folderFile([org], 'tasks.org', 'Vault/sub/tasks.org', '')
    const untitled = folderFile(['* Only a headline'], 'loose.org', 'Vault/loose.org', '')

    const loaded = await loadAll([titled, untitled])

    expect(loaded.map((l) => l.path)).toEqual(['sub/Org Tasks.md', 'loose.md'])
  })

  it('titles the page by its file name when its `#+TITLE` is empty', async () => {
    const loaded = await loadAll([
      folderFile(['#+TITLE:\n* A\n'], 'bare.org', 'Vault/bare.org', ''),
    ])

    expect(loaded.map((l) => l.path)).toEqual(['bare.md'])
  })

  it('#6032 — keeps a / in a `#+TITLE` as a look-alike, so the page stays in its folder', async () => {
    const titled = folderFile(['#+TITLE: TCP/IP\n* A\n'], 'net.org', 'Vault/net.org', '')

    const loaded = await loadAll([titled])

    expect(loaded.map((l) => l.path)).toEqual(['TCP∕IP.md'])
  })

  const orgContent = async (text: string): Promise<string | undefined> =>
    (await loadAll([folderFile([text], 'a.org', 'Vault/a.org', '')]))[0]?.content

  it('keeps as text a property drawer with no `:END:`, which Org does not read as one', async () => {
    const text = ['* Task', '  :PROPERTIES:', '  :Owner: Alice', '  Body line.', '* Next']

    expect(await orgContent(text.join('\n'))).toBe(
      ['- Task', '  :PROPERTIES:', '  :Owner: Alice', '  Body line.', '- Next', ''].join('\n'),
    )
  })

  it('fences a source block longer than any backtick run in it, so the code stays whole', async () => {
    const text = [
      '* Doc',
      '  #+BEGIN_SRC markdown',
      '  ```sh',
      '  ls',
      '  ```',
      '  #+END_SRC',
      '  After.',
    ]

    expect(await orgContent(text.join('\n'))).toBe(
      ['- Doc', '  ````markdown', '  ```sh', '  ls', '  ```', '  ````', '  After.', ''].join('\n'),
    )
  })

  it('keeps as text a page property the app reserves, which the import would drop unsaid', async () => {
    const text = [':PROPERTIES:', ':Space: Room 4', ':Owner: Ann', ':END:', 'Intro.']

    expect(await orgContent(text.join('\n'))).toBe('Owner:: Ann\n:Space: Room 4\nIntro.\n')
  })

  const TARGET_ID = '5f2c0000-0000-4000-8000-000000000001'
  const FILE_ID = '5f2c0000-0000-4000-8000-000000000002'
  const LOST_ID = '5f2c0000-0000-4000-8000-000000000003'

  it('#6032 N4 — escapes a link to a heading, a custom id or an unknown id, so it names no page', async () => {
    const text = `* See [[*Budget]], [[*Budget][the budget]], [[#custom-id]] and [[id:${LOST_ID}]]`

    expect(await orgContent(text)).toBe(
      `- See \\[[*Budget]], \\[[*Budget][the budget]], \\[[#custom-id]] and \\[[id:${LOST_ID}]]\n`,
    )
  })

  it('#6032 N4 — links an `id:` to the headline or the file of the pick holding that `:ID:`', async () => {
    const roam = [
      ':PROPERTIES:',
      `:ID: ${FILE_ID}`,
      ':END:',
      '#+TITLE: Roam Notes',
      '* Target',
      '  :PROPERTIES:',
      `  :ID: ${TARGET_ID}`,
      '  :END:',
      '* Custom',
      '  :PROPERTIES:',
      '  :ID: custom-1',
      '  :END:',
    ].join('\n')
    const links = [
      `* See [[id:${TARGET_ID}][the target]] and [[id:${TARGET_ID}]]`,
      `* Back to [[id:${FILE_ID}][notes]] and [[id:${FILE_ID}]]`,
      `* Lost [[id:${LOST_ID}]] and [[id:custom-1]]`,
    ].join('\n')

    const [, linked] = await loadAll([
      folderFile([roam], 'roam.org', 'Vault/roam.org', ''),
      folderFile([links], 'links.org', 'Vault/links.org', ''),
    ])

    expect(linked?.content).toBe(
      [
        `- See ((${TARGET_ID})) and ((${TARGET_ID}))`,
        '- Back to [[Roam Notes|notes]] and [[Roam Notes]]',
        `- Lost \\[[id:${LOST_ID}]] and \\[[id:custom-1]]`,
        '',
      ].join('\n'),
    )
  })

  it('#6032 N7 — reads the keywords of `#+TODO` lines as task states, open before the `|`, leaving those the importer reads', async () => {
    const text = [
      '#+TODO: TODO NEXT(n) NOW DOING WAIT(w@/!) | DONE(d) CANCELED(c)',
      '#+SEQ_TODO: IDEA | DROPPED',
      '#+TYP_TODO: Fred Sara',
      '* NEXT Call Bob',
      '* NOW Write',
      '* WAIT [#A] Reply',
      '* DOING Draft',
      '* CANCELED Trip',
      '* DROPPED Old idea',
      '* IDEA New one',
      '* Fred Review',
      '* Sara Report',
      '* NEXTSTEP stays text',
    ]

    expect(await orgContent(text.join('\n'))).toBe(
      [
        '- TODO Call Bob',
        '- NOW Write',
        '- WAIT [#A] Reply',
        '- DOING Draft',
        '- CANCELED Trip',
        '- DONE Old idea',
        '- TODO New one',
        '- TODO Review',
        '- DONE Report',
        '- NEXTSTEP stays text',
        '',
      ].join('\n'),
    )
  })

  it('#6032 N7 — makes `#+FILETAGS` the page tags and headline tags block tags', async () => {
    const text = [
      '#+FILETAGS: :work:@home:',
      '#+FILETAGS: :2024:',
      '* TODO Call Bob   :errand:@phone:',
      '* :solo:',
      '* At 10:30: no tags',
    ]

    expect(await orgContent(text.join('\n'))).toBe(
      [
        'tags:: work, @home, 2024',
        '- TODO Call Bob #[[errand]] #[[@phone]]',
        '- #[[solo]]',
        '- At 10:30: no tags',
        '',
      ].join('\n'),
    )
  })

  it('#6032 N7 — keeps a headline tag whole in NFD, its accent a combining mark', async () => {
    const nfd = 'cafe\u0301'

    expect(await orgContent(`* Visit :${nfd}:`)).toBe(`- Visit #[[${nfd}]]\n`)
  })
})

describe('Logseq graph (#6033)', () => {
  const graph = () => [
    folderFile(
      ['{:journal/page-title-format "MMM do, yyyy"\n :file/name-format :triple-lowbar}'],
      'config.edn',
      'Graph/logseq/config.edn',
      '',
    ),
    folderFile(['- old'], '2026.md', 'Graph/logseq/bak/pages/a___b/2026.md'),
    folderFile(['- see [[Oct 21st, 2026]] [[A/B]]'], 'a___b.md', 'Graph/pages/a___b.md'),
    folderFile(['title:: Real/Title\n\n- q'], 'What%3F.md', 'Graph/pages/What%3F.md'),
    folderFile(['- why [[b]]'], 'Why%3F.md', 'Graph/pages/Why%3F.md'),
    folderFile(['- day'], '2026_10_21.md', 'Graph/journals/2026_10_21.md'),
  ]

  it("titles pages and journals as Logseq does, skipping the graph's own folder", async () => {
    expect(await loadAll(graph())).toEqual([
      { path: 'a/b.md', content: '- see [[2026-10-21]] [[A/B]]' },
      { path: 'Real/Title.md', content: 'title:: Real/Title\n\n- q' },
      { path: 'Why?.md', content: '- why [[b]]' },
      { path: '2026-10-21.md', content: '- day' },
    ])
  })

  it('ships the notes a link names by their whole titles, never a namespaced one', async () => {
    const both = folderFile(['- [[A/B]] and [[b]]'], 'c.md', 'Graph/pages/c.md')
    const files = [...graph(), both]
    const [namespaced, , leaf, , c] = mdFilesToUnits(files, indexVaultFiles(files), false)

    expect((await namespaced?.load())?.vaultNotes).toEqual(['2026-10-21.md'])
    expect((await leaf?.load())?.vaultNotes).toEqual([])
    expect((await c?.load())?.vaultNotes).toEqual([])
  })

  it('reads a pick with `pages/` and `journals/` but no config as a graph of the defaults', async () => {
    expect((await loadAll(graph().slice(2))).map((l) => l.path)).toEqual([
      'a/b.md',
      'Real/Title.md',
      'Why?.md',
      '2026-10-21.md',
    ])
  })
})

describe('enexNotesToUnits', () => {
  const note = (title: string, attachments: EnexNote['attachments'] = []): EnexNote => ({
    title,
    markdown: `body of ${title}`,
    tags: [],
    createdMs: null,
    updatedMs: null,
    sourceUrl: null,
    attachments,
  })

  it('produces one unit per note, filename from the sanitized title, content from enexNoteToMarkdown', async () => {
    const alpha = note('Alpha')
    const notes = [alpha, note('Beta')]
    const units = enexNotesToUnits(notes, 'export.enex')
    expect(units).toHaveLength(2)

    expect(units[0]?.name).toBe('export/Alpha.md')
    const content0 = enexNoteToMarkdown(alpha)
    expect(units[0]?.bytes).toBe(content0.length)
    const loaded0 = await units[0]?.load()
    expect(loaded0?.content).toBe(content0)
    // Note-based units use the name as the IPC path.
    expect(loaded0?.path).toBe('export/Alpha.md')
    // No attachments ⇒ null vaultFiles (consistent with the single-file path).
    expect(loaded0?.vaultFiles).toBeNull()
  })

  it('#6032 — names a note titled with a / as one page, the / a look-alike', async () => {
    const [unit] = enexNotesToUnits([note('TCP/IP')], 'export.enex')
    expect(unit?.name).toBe('export/TCP∕IP.md')
    expect((await unit?.load())?.path).toBe('export/TCP∕IP.md')
  })

  it('ships decoded en-media attachment bytes as vaultFiles', async () => {
    const withMedia = note('Pic', [
      { path: 'pic.png', bytes: new Uint8Array([104, 101, 108, 108, 111]), mime: 'image/png' },
    ])
    const [unit] = enexNotesToUnits([withMedia], 'export.enex')
    const loaded = await unit?.load()
    expect(loaded?.vaultFiles).toHaveLength(1)
    expect(loaded?.vaultFiles?.[0]?.path).toBe('pic.png')
    expect(loaded?.vaultFiles?.[0]?.bytes).toEqual([104, 101, 108, 108, 111])
  })

  it('returns an empty list for no notes', () => {
    expect(enexNotesToUnits([], 'export.enex')).toEqual([])
  })

  it('#2899 — converts attachment bytes lazily inside load(), not up front for every note', async () => {
    // Track WHEN each attachment's `bytes` is actually read (a getter, not a
    // plain field, so the read is observable). The pre-#2899 code did
    // `note.attachments.map((a) => ({ ..., bytes: Array.from(a.bytes) }))`
    // INSIDE the `enexNotesToUnits` `.map()` callback (i.e. at unit-build
    // time, before any `load()` runs) — that would read `a.bytes` for every
    // note immediately, so the `expect(accessed).toEqual([])` assertion
    // right after `enexNotesToUnits(...)` below would fail against the old
    // code (it would already read `['a.png', 'b.png']`).
    const accessed: string[] = []
    const makeAttachment = (path: string, raw: number[]): EnexNote['attachments'][number] => {
      const bytes = new Uint8Array(raw)
      return {
        path,
        mime: 'application/octet-stream',
        get bytes() {
          accessed.push(path)
          return bytes
        },
      }
    }
    const notes = [
      note('Alpha', [makeAttachment('a.png', [1, 2, 3])]),
      note('Beta', [makeAttachment('b.png', [4, 5, 6])]),
    ]

    const units = enexNotesToUnits(notes, 'export.enex')
    // Building the units must not have touched any attachment's bytes yet.
    expect(accessed).toEqual([])

    await units[0]?.load()
    // Only the FIRST note's attachment was materialized so far — the
    // second note's bytes are still untouched (peak memory is O(one note),
    // not O(all notes)).
    expect(accessed).toEqual(['a.png'])

    await units[1]?.load()
    expect(accessed).toEqual(['a.png', 'b.png'])
  })
})

describe('jexNotesToUnits', () => {
  const note = (title: string, attachments: JexNote['attachments'] = []): JexNote => ({
    title,
    markdown: `body of ${title}`,
    createdMs: null,
    updatedMs: null,
    tags: [],
    attachments,
  })

  it('#6032 — keeps the / between a notebook and its note as the namespace', async () => {
    const [unit] = jexNotesToUnits([note('A∕B/TCP∕IP')])
    expect(unit?.name).toBe('A∕B/TCP∕IP.md')
    expect((await unit?.load())?.path).toBe('A∕B/TCP∕IP.md')
  })

  it('produces one unit per note, filename from the title, content from jexNoteToMarkdown', async () => {
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

  it('#5160 D10 — imports the notes whose titles hold a `|` first, so links to them find their pages', () => {
    const units = jexNotesToUnits([
      note('Links'),
      note('Article | Medium'),
      note('Other'),
      note('A|B'),
    ])
    expect(units.map((u) => u.name)).toEqual([
      'Article | Medium.md',
      'A|B.md',
      'Links.md',
      'Other.md',
    ])
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

  it('#2899 — converts resource bytes lazily inside load(), not up front for every note', async () => {
    // Same proof as the `.enex` producer above: the pre-#2899 code read
    // every note's `a.bytes` inside the `jexNotesToUnits` `.map()` callback
    // (unit-build time), so `accessed` would already be non-empty right
    // after `jexNotesToUnits(...)` against that code.
    const accessed: string[] = []
    const makeResource = (path: string, raw: number[]): JexNote['attachments'][number] => {
      const bytes = new Uint8Array(raw)
      return {
        path,
        mime: 'application/octet-stream',
        get bytes() {
          accessed.push(path)
          return bytes
        },
      }
    }
    const notes = [
      note('Alpha', [makeResource('a.png', [1, 2, 3])]),
      note('Beta', [makeResource('b.png', [4, 5, 6])]),
    ]

    const units = jexNotesToUnits(notes)
    expect(accessed).toEqual([])

    await units[0]?.load()
    expect(accessed).toEqual(['a.png'])

    await units[1]?.load()
    expect(accessed).toEqual(['a.png', 'b.png'])
  })
})
