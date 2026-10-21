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
  expectImageRendered,
  navigateTo,
  runScopedMarker,
  waitForAppReady,
} from './helpers'

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

async function openDataTab(): Promise<void> {
  await navigateTo('Settings')
  const dataTab = $('#settings-tab-data')
  await dataTab.waitForClickable({ timeout: NAV_TIMEOUT })
  await dataTab.click()
  await $('[data-testid="settings-panel-data"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** Wait until the Data tab's result region (ImportSection.tsx) reads `summary`. */
async function waitForImportResult(summary: string): Promise<void> {
  const result = $('[data-testid="import-result"]')
  await result.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  let text = ''
  await browser
    .waitUntil(
      async () => {
        text = await result.getText()
        return text.includes(summary)
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(
        `the import result reads ${JSON.stringify(text)}, not ${JSON.stringify(summary)}`,
      )
    })
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

/**
 * Pick `folder` in the Data tab's folder input: its FileList holds each file
 * with `webkitRelativePath` `<folder>/<name>`, as the browser's folder picker
 * fills it. WebKitWebDriver cannot pick a folder: Send Keys with a directory
 * path hands the input the directory itself as one File, which fails to read.
 */
async function importFolder(folder: string, files: Record<string, Buffer>): Promise<void> {
  await openDataTab()
  await $('[data-testid="import-folder-input"]').waitForExist({ timeout: ACTION_TIMEOUT })
  const entries = Object.entries(files).map(([name, bytes]) => ({
    name,
    rel: `${folder}/${name}`,
    b64: bytes.toString('base64'),
  }))
  await browser.execute((list: Array<{ name: string; rel: string; b64: string }>) => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="import-folder-input"]')
    if (input === null) throw new Error('no folder input')
    const picked = new DataTransfer()
    for (const { name, rel, b64 } of list) {
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const file = new File([bytes], name)
      Object.defineProperty(file, 'webkitRelativePath', { value: rel })
      picked.items.add(file)
    }
    input.files = picked.files
    if (input.files?.[0]?.webkitRelativePath !== list[0]?.rel) {
      throw new Error('the folder input lost the files or their relative paths')
    }
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, entries)
  // The success line; a run where every file failed reads "All N files failed".
  await waitForImportResult('Imported “')
}

/**
 * Open a page from the Pages list by its full title. A namespaced title
 * (`a/b`) is a leaf of the namespace tree (PageTreeItem.tsx), a flat one a
 * PageRow; both carry the full title in their label span's `title`.
 */
async function openPageByFullTitle(title: string): Promise<void> {
  await navigateTo('Pages')
  const label = $(`span[title="${title}"]`)
  await label.waitForClickable({ timeout: NAV_TIMEOUT })
  await label.click()
  await browser.waitUntil(async () => (await $('[aria-label="Page title"]').getText()) === title, {
    timeout: NAV_TIMEOUT,
    timeoutMsg: `the page ${title} never opened`,
  })
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
    await importFolder(folder, {
      'note.md': Buffer.from(`- ${marker}-caption ![pic](pic.png)\n`),
      'pic.png': PNG,
    })

    await navigateTo('Journal')
    await openPageByFullTitle(`${folder}/note`)
    const block = blockStaticByMarker(`${marker}-caption`)
    await block.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const id = await block.getAttribute('data-block-id')
    if (id === null) throw new Error('the caption block has no data-block-id')
    await expectImageRendered(id, 'after the round trip')
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
    await openPageByFullTitle(title)
    for (const block of ['first', 'second', 'item']) {
      await blockStaticByMarker(`${marker}-${block}`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    }
    const caption = blockStaticByMarker(`${marker}-caption`)
    await caption.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const id = await caption.getAttribute('data-block-id')
    if (id === null) throw new Error('the caption block has no data-block-id')
    await expectImageRendered(id, 'after the round trip')
  })

  it('imports a .jex with each note a page titled by its notebook path', async () => {
    await waitForAppReady()
    const marker = runScopedMarker('wdio-jex')
    const book = `${marker}-book`
    const sub = `${marker}-sub`
    const ids = {
      book: '1'.repeat(32),
      sub: '2'.repeat(32),
      top: '3'.repeat(32),
      deep: '4'.repeat(32),
    }
    const note = (name: string, parent: string, id: string): [string, string] => [
      `${id}.md`,
      joplinItem(`${marker}-${name}\n\n${marker}-${name}-body`, {
        id,
        parent_id: parent,
        type_: '1',
      }),
    ]
    const jex = tar([
      [`${ids.book}.md`, joplinItem(book, { id: ids.book, parent_id: '', type_: '2' })],
      [`${ids.sub}.md`, joplinItem(sub, { id: ids.sub, parent_id: ids.book, type_: '2' })],
      note('top', ids.book, ids.top),
      note('deep', ids.sub, ids.deep),
    ])
    await importFile('import-jex-input', 'export.jex', jex, 'Imported “2 notes”')

    await navigateTo('Journal')
    await openPageByFullTitle(`${book}/${marker}-top`)
    await blockStaticByMarker(`${marker}-top-body`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await navigateTo('Journal')
    await openPageByFullTitle(`${book}/${sub}/${marker}-deep`)
    await blockStaticByMarker(`${marker}-deep-body`).waitForDisplayed({ timeout: NAV_TIMEOUT })
  })
})
