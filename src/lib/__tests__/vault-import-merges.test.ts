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
  it('is the path a picked Markdown file imports as, and an Org file’s, read from its `#+TITLE`', async () => {
    const md = new File(['x'], 'Plan.md')
    const org = new File(['#+TITLE: Org Plan\n* x'], 'Notes.org')

    const [mdUnit, orgUnit] = mdFilesToUnits([md, org], null, false)

    expect(mdUnit?.merges).toBe('Plan.md')
    expect(mdUnit?.merges).toBe((await mdUnit?.load())?.path)
    const merges = orgUnit?.merges
    if (typeof merges !== 'function') throw new Error('an Org file reads its title from its text')
    expect(await merges()).toBe('Org Plan.md')
    expect(await merges()).toBe((await orgUnit?.load())?.path)
  })

  it('is the path a folder pick’s note imports as too (#6277 G5)', () => {
    const md = folderFile('x', 'Plan.md', 'Vault/Plan.md')

    const [unit] = mdFilesToUnits([md], indexVaultFiles([md]), false)

    expect(unit?.merges).toBe('Plan.md')
  })

  it('is an Evernote or Joplin note’s name, with or without attachments', () => {
    const enex = enexNotesToUnits([enexNote('Meeting', false), enexNote('Scan', true)], 'Work.enex')
    const jex = jexNotesToUnits([jexNote('Projects/Plan', false), jexNote('Projects/Scan', true)])

    expect(enex.map((unit) => unit.merges)).toEqual(['Work/Meeting.md', 'Work/Scan.md'])
    expect(jex.map((unit) => unit.merges)).toEqual(['Projects/Plan.md', 'Projects/Scan.md'])
  })
})
