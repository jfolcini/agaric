/**
 * Which import units may merge into the page of their title (#6277 decision
 * 7): a Markdown file sent with no vault, named by the path it imports as. A
 * folder's note, a note with attachments and an Org file never merge, so the
 * import dialog never asks about them.
 */

import { describe, expect, it } from 'vitest'

import type { EnexNote } from '@/lib/enex-import'
import type { JexNote } from '@/lib/jex-import'
import {
  enexNotesToUnits,
  indexVaultFiles,
  jexNotesToUnits,
  mdFilesToUnits,
} from '@/lib/vault-import'

function folderFile(text: string, name: string, relativePath: string): File {
  const file = new File([text], name, { type: 'text/markdown' })
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
  return file
}

const attachment = { path: 'a.png', bytes: new Uint8Array([1]), mime: 'image/png' }

function enexNote(title: string, withAttachment: boolean): EnexNote {
  return {
    title,
    markdown: 'body',
    tags: [],
    createdMs: null,
    updatedMs: null,
    sourceUrl: null,
    attachments: withAttachment ? [attachment] : [],
  }
}

function jexNote(title: string, withAttachment: boolean): JexNote {
  return {
    title,
    markdown: 'body',
    createdMs: null,
    updatedMs: null,
    tags: [],
    attachments: withAttachment ? [attachment] : [],
  }
}

describe('ImportUnit.merges', () => {
  it('is the path a picked Markdown file imports as, and none for an Org file', async () => {
    const md = new File(['x'], 'Plan.md')
    const org = new File(['* x'], 'Notes.org')

    const [mdUnit, orgUnit] = mdFilesToUnits([md, org], null, false)

    expect(mdUnit?.merges).toBe('Plan.md')
    expect(mdUnit?.merges).toBe((await mdUnit?.load())?.path)
    expect(orgUnit?.merges).toBeUndefined()
  })

  it('is none for a folder pick, whose notes the import reads against the folder', () => {
    const md = folderFile('x', 'Plan.md', 'Vault/Plan.md')

    const [unit] = mdFilesToUnits([md], indexVaultFiles([md]), false)

    expect(unit?.merges).toBeUndefined()
  })

  it('is an Evernote or Joplin note’s name when it has no attachment', () => {
    const enex = enexNotesToUnits([enexNote('Meeting', false), enexNote('Scan', true)], 'Work.enex')
    const jex = jexNotesToUnits([jexNote('Projects/Plan', false), jexNote('Projects/Scan', true)])

    expect(enex.map((unit) => unit.merges)).toEqual(['Work/Meeting.md', undefined])
    expect(jex.map((unit) => unit.merges)).toEqual(['Projects/Plan.md', undefined])
  })
})
