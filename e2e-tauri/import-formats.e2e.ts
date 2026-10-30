// ---------------------------------------------------------------------------
// Real-backend imports of a folder, an Evernote `.enex` and a Joplin `.jex`
// (#5740).
//
// Each format reaches the backend as one `import_markdown` call per file or
// note: a folder pick ships the bytes of the files a note references, which
// the backend stores as attachments and rewrites the refs to
// (`ingest_attachments` in commands/pages/markdown.rs); `.enex` and `.jex` are
// unpacked in the webview (`parseEnex`, `parseJex`), a Joplin note's title
// prefixed with its notebook path. The mock keeps attachment refs as literal
// text and models only a subset of the backend's titles and blocks (its
// `import_markdown` in tauri-mock/handlers/pages.ts), so every case asserts
// what a page shows after a navigation round-trip.
//
// `.enex` and `.jex` are picked as the other import specs pick their files:
// WebDriver's Element Send Keys on the Data tab's hidden `<input type="file">`.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  expectAbsent,
  expectImageRendered,
  importFolder,
  navigateTo,
  openDataTab,
  openPageTitled,
  pageEntryTitled,
  runScopedMarker,
  waitForAppReady,
  waitForImportResult,
} from './helpers'

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

// A 2x1 blue PNG, told apart from `PNG` by its width.
const WIDE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGNgYPj/H4QBDfsD/Yde1YcAAAAASUVORK5CYII=',
  'base64',
)

// A one-page PDF of 3 x 3 points.
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 3 3]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
)

/**
 * Wait until the block holding `marker` links its attachment `filename` as a
 * file, labelled `label`, and shows it as a file chip, with no image.
 */
async function expectFileLinked(marker: string, label: string, filename: string): Promise<void> {
  const block = blockStaticByMarker(marker)
  await block.waitForDisplayed({ timeout: NAV_TIMEOUT })
  const id = await block.getAttribute('data-block-id')
  if (id === null) throw new Error(`the ${marker} block has no data-block-id`)
  const link = $(`[data-block-id="${id}"] [data-testid="attachment-link"]`)
  await link.waitForDisplayed({ timeout: NAV_TIMEOUT })
  expect(await link.getText()).toBe(label)
  await $(`li[data-block-id="${id}"] button[aria-label="Open file ${filename}"]`).waitForDisplayed({
    timeout: NAV_TIMEOUT,
  })
  await expectAbsent(`[data-block-id="${id}"] img`, `an image in the ${marker} block`)
}

/** Write `contents` to a fresh temp file and pick it in the Data tab's `testid` input. */
async function importFile(
  testid: string,
  name: string,
  contents: string | Buffer,
  summary: string,
): Promise<void> {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'wdio-import-')), name)
  writeFileSync(file, contents)
  await openDataTab()
  const input = $(`[data-testid="${testid}"]`)
  await input.waitForExist({ timeout: ACTION_TIMEOUT })
  await browser.execute((id: string) => {
    document.querySelector(`[data-testid="${id}"]`)?.classList.remove('hidden')
  }, testid)
  await input.addValue(file)
  await waitForImportResult(summary)
}

/** A USTAR archive of `entries`, holding the header fields `parseJex`'s tar reader reads. */
function tar(entries: Array<[string, string]>): Buffer {
  const parts: Buffer[] = []
  for (const [name, text] of entries) {
    const data = Buffer.from(text)
    const header = Buffer.alloc(512)
    header.write(name, 0)
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('0', 156)
    parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

/** A Joplin item file: its content, a blank line, then its `key: value` metadata. */
function joplinItem(content: string, props: Record<string, string>): string {
  const meta = Object.entries(props).map(([key, value]) => `${key}: ${value}`)
  return [content, '', ...meta].join('\n')
}

describe('Agaric real-backend imports by format (#5740) @markdown', () => {
  it('imports a folder with the image its note references, rendered from the stored bytes', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-folder')
    const folder = `${marker}-dir`
    await importFolder(
      'import-folder-input',
      folder,
      {
        'note.md': Buffer.from(`- ${marker}-caption ![pic](pic.png)\n`),
        'pic.png': PNG,
      },
      'Imported “',
    )

    await navigateTo('Journal')
    await openPageTitled(`${folder}/note`)
    const block = blockStaticByMarker(`${marker}-caption`)
    await block.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const id = await block.getAttribute('data-block-id')
    if (id === null) throw new Error('the caption block has no data-block-id')
    await expectImageRendered(id, 'after the round trip')
  })

  it('#6032 — attaches the image beside the note, of two sharing a name with a space', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-beside')
    const folder = `${marker}-dir`
    // `a/` is picked first, so a basename match would attach its 1 px image.
    await importFolder(
      'import-folder-input',
      folder,
      {
        'a/my image.png': PNG,
        'b/my image.png': WIDE_PNG,
        'b/note.md': Buffer.from(
          `- ${marker}-angle ![](<my image.png>)\n- ${marker}-escaped ![](my%20image.png)\n`,
        ),
      },
      'Imported “',
    )

    await navigateTo('Journal')
    await openPageTitled(`${folder}/b/note`)
    for (const ref of ['angle', 'escaped']) {
      const block = blockStaticByMarker(`${marker}-${ref}`)
      await block.waitForDisplayed({ timeout: NAV_TIMEOUT })
      const id = await block.getAttribute('data-block-id')
      if (id === null) throw new Error(`the ${ref} block has no data-block-id`)
      const width = await expectImageRendered(id, `the ${ref} ref`)
      expect(width).toBe(2)
    }
  })

  it('#6032 — attaches a PDF a note links to, shown as a file link, not a broken image', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-linked')
    const folder = `${marker}-dir`
    await importFolder(
      'import-folder-input',
      folder,
      { 'note.md': Buffer.from(`- ${marker}-read [paper](paper.pdf)\n`), 'paper.pdf': PDF },
      'Imported “',
    )

    await navigateTo('Journal')
    await openPageTitled(`${folder}/note`)
    await expectFileLinked(`${marker}-read`, 'paper', 'paper.pdf')
  })

  it('imports a one-note .enex as one page holding its body blocks and image', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-enex')
    const title = `${marker}-note`
    // `&nbsp;` is legal ENML that an XML parse rejects, which once emptied the
    // whole body; a file-name with a space was once never ingested.
    const enml =
      `<en-note><div>${marker}-first&nbsp;cell</div><div>${marker}-second</div>` +
      `<ul><li>${marker}-item</li></ul>` +
      `<div>${marker}-caption <en-media hash="${createHash('md5').update(PNG).digest('hex')}" type="image/png"/></div>` +
      '</en-note>'
    const resource =
      `<resource><data encoding="base64">${PNG.toString('base64')}</data><mime>image/png</mime>` +
      '<resource-attributes><file-name>Screen shot.png</file-name></resource-attributes></resource>'
    const enex = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<en-export>',
      `<note><title>${title}</title><content><![CDATA[${enml}]]></content>${resource}</note>`,
      '</en-export>',
    ].join('\n')
    await importFile('import-enex-input', 'export.enex', enex, `Imported “${title}”`)

    await navigateTo('Journal')
    await navigateTo('Pages')
    await $(`span[title="${title}"]`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    expect(await $$(`span[title="${title}"]`).length).toBe(1)
    await openPageTitled(title)
    for (const block of ['first', 'second', 'item']) {
      await blockStaticByMarker(`${marker}-${block}`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    }
    const caption = blockStaticByMarker(`${marker}-caption`)
    await caption.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const id = await caption.getAttribute('data-block-id')
    if (id === null) throw new Error('the caption block has no data-block-id')
    await expectImageRendered(id, 'after the round trip')
  })

  it('imports a .jex with each note a page titled by its notebook path, a to-do a task, a tag a page tag', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-jex')
    const book = `${marker}-book`
    const sub = `${marker}-sub`
    const tag = `${marker}-tag`
    const ids = {
      book: '1'.repeat(32),
      sub: '2'.repeat(32),
      top: '3'.repeat(32),
      deep: '4'.repeat(32),
      tag: '5'.repeat(32),
      noteTag: '6'.repeat(32),
    }
    const note = (
      name: string,
      parent: string,
      id: string,
      props: Record<string, string> = {},
    ): [string, string] => [
      `${id}.md`,
      joplinItem(`${marker}-${name}\n\n${marker}-${name}-body`, {
        id,
        parent_id: parent,
        ...props,
        type_: '1',
      }),
    ]
    const jex = tar([
      [`${ids.book}.md`, joplinItem(book, { id: ids.book, parent_id: '', type_: '2' })],
      [`${ids.sub}.md`, joplinItem(sub, { id: ids.sub, parent_id: ids.book, type_: '2' })],
      // A to-do due at local noon on 1 Oct 2031, tagged.
      note('top', ids.book, ids.top, {
        is_todo: '1',
        todo_completed: '0',
        todo_due: String(new Date(2031, 9, 1, 12).getTime()),
      }),
      note('deep', ids.sub, ids.deep),
      [`${ids.tag}.md`, joplinItem(tag, { id: ids.tag, type_: '5' })],
      [
        `${ids.noteTag}.md`,
        joplinItem('', { id: ids.noteTag, note_id: ids.top, tag_id: ids.tag, type_: '6' }),
      ],
    ])
    await importFile('import-jex-input', 'export.jex', jex, 'Imported “2 notes”')

    await navigateTo('Journal')
    await openPageTitled(`${book}/${marker}-top`)
    await blockStaticByMarker(`${marker}-top-body`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    // The to-do opens with a task block named after the note, the first block
    // whose text holds `<marker>-top` (the body block's comes after it).
    const task = blockStaticByMarker(`${marker}-top`)
    const taskId = await task.getAttribute('data-block-id')
    const row = $(`li[data-block-id="${taskId}"]`)
    const taskMarker = row.$('[data-testid="task-marker"]')
    await taskMarker.waitForExist({ timeout: ACTION_TIMEOUT })
    await browser.waitUntil(
      async () => ((await taskMarker.getAttribute('aria-label')) ?? '').startsWith('Task: TODO'),
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the imported to-do never showed the TODO state' },
    )
    const due = row.$('.due-date-chip')
    await due.waitForExist({ timeout: ACTION_TIMEOUT })
    expect(await due.getAttribute('aria-label')).toContain('Oct 1, 2031')
    // The tag is the page's tag (PageTagSection's chip).
    await $(`[aria-label="Remove tag ${tag}"]`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await navigateTo('Journal')
    await openPageTitled(`${book}/${sub}/${marker}-deep`)
    await blockStaticByMarker(`${marker}-deep-body`).waitForDisplayed({ timeout: NAV_TIMEOUT })
  })

  it('#6032 — attaches a PDF a Joplin note links to, shown as a file link', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-jex-pdf')
    const ids = { note: 'a'.repeat(32), pdf: 'b'.repeat(32) }
    const jex = tar([
      [
        `${ids.note}.md`,
        joplinItem(`${marker}-files\n\n${marker}-see [the report](:/${ids.pdf})`, {
          id: ids.note,
          parent_id: '',
          type_: '1',
        }),
      ],
      [
        `${ids.pdf}.md`,
        joplinItem('report.pdf', {
          id: ids.pdf,
          mime: 'application/pdf',
          file_extension: 'pdf',
          type_: '4',
        }),
      ],
      [`resources/${ids.pdf}.pdf`, PDF.toString('latin1')],
    ])
    await importFile('import-jex-input', 'export.jex', jex, `Imported “${marker}-files”`)

    await navigateTo('Journal')
    await openPageTitled(`${marker}-files`)
    await expectFileLinked(`${marker}-see`, 'the report', 'report.pdf')
  })

  // #6032 — a `/` in a title is part of the name, kept as the look-alike `∕`,
  // where it once split the note into a namespace.
  it('imports an .enex note titled with a / as one page, the / a look-alike', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-enex-slash')
    const title = `${marker}-TCP∕IP`
    const enml = `<en-note><div>${marker}-body</div></en-note>`
    const enex = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<en-export>',
      `<note><title>${marker}-TCP/IP</title><content><![CDATA[${enml}]]></content></note>`,
      '</en-export>',
    ].join('\n')
    await importFile('import-enex-input', 'export.enex', enex, `Imported “${title}”`)

    await navigateTo('Journal')
    await navigateTo('Pages')
    await pageEntryTitled(title).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(`span[title="${marker}-TCP/IP"]`, 'the page IP under the namespace TCP')
    await openPageTitled(title)
    await blockStaticByMarker(`${marker}-body`).waitForDisplayed({ timeout: NAV_TIMEOUT })
  })

  it('imports a .jex note and notebook titled with a / as one level each, linked by that title', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-jex-slash')
    const ids = { book: '7'.repeat(32), target: '8'.repeat(32), linker: '9'.repeat(32) }
    const jex = tar([
      [`${ids.book}.md`, joplinItem(`${marker}-A/B`, { id: ids.book, parent_id: '', type_: '2' })],
      [
        `${ids.target}.md`,
        joplinItem(`${marker}-TCP/IP\n\n${marker}-body`, {
          id: ids.target,
          parent_id: ids.book,
          type_: '1',
        }),
      ],
      [
        `${ids.linker}.md`,
        joplinItem(`${marker}-linker\n\n${marker}-link [it](:/${ids.target})`, {
          id: ids.linker,
          parent_id: '',
          type_: '1',
        }),
      ],
    ])
    await importFile('import-jex-input', 'export.jex', jex, 'Imported “2 notes”')

    const title = `${marker}-A∕B/${marker}-TCP∕IP`
    await navigateTo('Journal')
    await openPageTitled(title)
    await blockStaticByMarker(`${marker}-body`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await navigateTo('Journal')
    await openPageTitled(`${marker}-linker`)
    const link = blockStaticByMarker(`${marker}-link`)
    await link.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const id = await link.getAttribute('data-block-id')
    const chip = $(`li[data-block-id="${id}"] [data-testid="block-link-chip"]`)
    await browser.waitUntil(async () => (await chip.getAttribute('title')) === title, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: `the link to the note never resolved to the page ${title}`,
    })
  })
})
