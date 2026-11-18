import { createHash } from 'node:crypto'

import type { Locator, Page } from '@playwright/test'
import JSZip from 'jszip'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  attachFile,
  confirmEach,
  expect,
  focusBlockById,
  importFile,
  importFolder,
  ipc,
  navigateToDataSettings,
  navigateToView,
  reopenTitled,
  rowOf,
  switchToSpace,
  test,
  waitForBoot,
} from './helpers'

/**
 * What the real backend's importers and exporters store and write, by format:
 * a folder with its attachments, an Evernote `.enex`, a Joplin `.jex`, an
 * Obsidian vault, a re-import that merges into a page, a bibliography, the
 * space's ZIP export read back by a folder pick, and an image rendered from
 * its stored bytes. The mock's import is a declared approximation (no
 * attachments, links, task keywords, nesting or properties;
 * src/lib/tauri-mock/handlers/pages.ts) and its export writes no names, so
 * these run on the bridge only. Each asserts on what a page or a command shows
 * after leaving the view and coming back.
 */

const PERSONAL = SEED_IDS.SPACE_PERSONAL
const WORK = SEED_IDS.SPACE_WORK

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

/** Import `markdown` as the page `title`, a lone `.md` file. */
function importMarkdownPage(page: Page, title: string, markdown: string) {
  return importFile(page, 'import-file-input', `${title}.md`, markdown, `Imported “${title}”`)
}

/** The pages of `spaceId`. */
function pagesIn(page: Page, spaceId: string) {
  return ipc<{ id: string; content: string | null }[]>(page, 'list_all_pages_in_space', {
    scope: { kind: 'active', space_id: spaceId },
    tagIds: null,
  })
}

/** The id of the one page titled `title` in `spaceId`. */
async function pageIdTitled(
  page: Page,
  title: string,
  spaceId: string = PERSONAL,
): Promise<string> {
  const found = (await pagesIn(page, spaceId)).filter((p) => p.content === title)
  expect(found, `pages titled ${title}`).toHaveLength(1)
  return found[0]?.id ?? ''
}

/** The one image of `row` has decoded from a `blob:` URL; its natural width. */
async function expectImageRendered(row: Locator): Promise<number> {
  const image = row.getByTestId('image-rendered')
  await image.scrollIntoViewIfNeeded()
  await expect(image).toHaveCount(1)
  await expect(image).toHaveAttribute('src', /^blob:/)
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0)))
    .toBeGreaterThan(0)
  return image.evaluate((img: HTMLImageElement) => img.naturalWidth)
}

/** `text`'s row links its attachment `filename` as a file labelled `label`, with no image. */
async function expectFileLinked(page: Page, text: string, label: string, filename: string) {
  const row = rowOf(page, text)
  await expect(row.getByTestId('attachment-link')).toHaveText(label)
  await expect(
    row.getByRole('button', { name: `Open file ${filename}`, exact: true }),
  ).toBeVisible()
  await expect(row.locator('img')).toHaveCount(0)
}

/** The task marker of `text`'s row reads `state`. */
async function expectTaskState(page: Page, text: string, state: string) {
  await expect(rowOf(page, text).getByTestId('task-marker')).toHaveAttribute(
    'aria-label',
    new RegExp(`^Task: ${state}`),
  )
}

/** Press the Data tab's export button `button` and read the ZIP it downloads, path → bytes. */
async function exportZip(page: Page, button: Locator): Promise<Record<string, Buffer>> {
  await navigateToDataSettings(page)
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()])
  const chunks: Buffer[] = []
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer)
  const zip = await JSZip.loadAsync(Buffer.concat(chunks))
  const files: Record<string, Buffer> = {}
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) files[name] = await entry.async('nodebuffer')
  }
  return files
}

function exportSpaceZip(page: Page) {
  return exportZip(page, page.getByRole('button', { name: 'Export this space', exact: true }))
}

/** A page `title` in `spaceId` holding one block `block`; the page's and the block's ids. */
async function createPage(page: Page, spaceId: string, title: string, block: string) {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId,
  })
  const blockId = await addBlock(page, spaceId, pageId, block)
  return { pageId, blockId }
}

async function addBlock(page: Page, spaceId: string, parentId: string, content: string) {
  const block = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'content',
    content,
    parentId,
    index: null,
    scope: { kind: 'active', space_id: spaceId },
    blockId: null,
  })
  return block.id
}

function setValue(page: Page, blockId: string, key: string, value: Record<string, unknown>) {
  return ipc(page, 'set_property', {
    blockId,
    key,
    value: {
      value_text: null,
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
      ...value,
    },
  })
}

interface PropertyRow {
  key: string
  value_text: string | null
  value_num: number | null
  value_date: string | null
  value_ref: string | null
}

function propertiesOf(page: Page, blockId: string) {
  return ipc<PropertyRow[]>(page, 'get_properties', { blockId })
}

/** The items the open page's Properties table shows for the list under `key` (#6741). */
function propertyListItems(page: Page, key: string): Locator {
  return page.locator(`fieldset[aria-label="${key} value"] [data-slot="badge"] .truncate`)
}

/** A USTAR archive of `entries`, holding the header fields `parseJex`'s tar reader reads. */
function tar(entries: Array<[string, string]>): Buffer {
  const parts: Buffer[] = []
  for (const [name, text] of entries) {
    const data = Buffer.from(text, 'latin1')
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

/** A one-note `.enex` of `title` whose body is `enml` and whose note ends with `extra`. */
function enex(title: string, enml: string, extra = ''): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<en-export>',
    `<note><title>${title}</title><content><![CDATA[<en-note>${enml}</en-note>]]></content>${extra}</note>`,
    '</en-export>',
  ].join('\n')
}

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

// #5740 — a folder pick ships the bytes of the files a note references, which
// the backend stores as attachments and rewrites the refs to.
test.describe(
  'Folder imports with attachments @markdown @attachments',
  { tag: '@real-only' },
  () => {
    test('a folder imports with the image its note references, rendered from the stored bytes', async ({
      page,
    }) => {
      await importFolder(
        page,
        'import-folder-input',
        'folder-dir',
        { 'folder-note.md': '- folder-caption ![pic](pic.png)\n', 'pic.png': PNG },
        'Imported “',
      )
      // The picked folder's own name is no part of a title (#6277 decision 8).
      await reopenTitled(page, 'folder-note')
      await expectImageRendered(rowOf(page, 'folder-caption'))
    })

    test('#6032 — the image beside the note is attached, of two sharing a name with a space', async ({
      page,
    }) => {
      // `a/` is picked first, so a basename match would attach its 1 px image.
      await importFolder(
        page,
        'import-folder-input',
        'beside-dir',
        {
          'a/my image.png': PNG,
          'b/my image.png': WIDE_PNG,
          'b/beside-note.md':
            '- beside-angle ![](<my image.png>)\n- beside-escaped ![](my%20image.png)\n',
        },
        'Imported “',
      )
      await reopenTitled(page, 'b/beside-note')
      expect(await expectImageRendered(rowOf(page, 'beside-angle'))).toBe(2)
      expect(await expectImageRendered(rowOf(page, 'beside-escaped'))).toBe(2)
    })

    test('#6032 — a PDF a note links to is attached and shown as a file link, not a broken image', async ({
      page,
    }) => {
      await importFolder(
        page,
        'import-folder-input',
        'linked-dir',
        { 'linked-note.md': '- linked-read [paper](paper.pdf)\n', 'paper.pdf': PDF },
        'Imported “',
      )
      await reopenTitled(page, 'linked-note')
      await expectFileLinked(page, 'linked-read', 'paper', 'paper.pdf')
    })
  },
)

// #5740, #6032 — `.enex` is unpacked in the webview, each note a page titled
// under the file's name; what it stores is the backend's.
test.describe('Evernote imports @markdown', { tag: '@real-only' }, () => {
  test('a one-note .enex is one page holding its body blocks and image', async ({ page }) => {
    // `&nbsp;` is legal ENML that an XML parse rejects, which once emptied the
    // whole body; a file name with a space was once never ingested.
    const hash = createHash('md5').update(PNG).digest('hex')
    const enml =
      '<div>enex-first&nbsp;cell</div><div>enex-second</div><ul><li>enex-item</li></ul>' +
      `<div>enex-caption <en-media hash="${hash}" type="image/png"/></div>`
    const resource =
      `<resource><data encoding="base64">${PNG.toString('base64')}</data><mime>image/png</mime>` +
      '<resource-attributes><file-name>Screen shot.png</file-name></resource-attributes></resource>'
    await importFile(
      page,
      'import-enex-input',
      'export.enex',
      enex('enex-note', enml, resource),
      'Imported “export/enex-note”',
    )
    expect(
      (await pagesIn(page, PERSONAL)).filter((p) => p.content === 'export/enex-note'),
    ).toHaveLength(1)
    await reopenTitled(page, 'export/enex-note')
    for (const text of ['enex-first', 'enex-second', 'enex-item']) {
      await expect(rowOf(page, text)).toBeVisible()
    }
    await expectImageRendered(rowOf(page, 'enex-caption'))
  })

  test('#6032 — an Evernote task is a task block with its due date, in place of its placeholder', async ({
    page,
  }) => {
    // Evernote 10 writes a task as a `<task>` beside the body, and in the body
    // only this placeholder for its task group.
    const placeholder =
      '<div style="--en-task-group:true; --en-id:group-1;color:#868686">' +
      '<div>Content not supported</div><div>This block is a placeholder for Tasks.</div></div>'
    const task =
      '<task><title>enex-todo</title><taskStatus>open</taskStatus><taskFlag>false</taskFlag>' +
      '<sortWeight>A</sortWeight><noteLevelID>task-1</noteLevelID>' +
      '<taskGroupNoteLevelID>group-1</taskGroupNoteLevelID>' +
      // Midday on 1 Oct 2031 in the task's zone.
      '<dueDate>20311001T120000Z</dueDate><timeZone>Europe/Budapest</timeZone></task>'
    await importFile(
      page,
      'import-enex-input',
      'export.enex',
      enex('task-note', `<div>task-before</div>${placeholder}<div>task-after</div>`, task),
      'Imported “export/task-note”',
    )
    await reopenTitled(page, 'export/task-note')
    await expect(rowOf(page, 'task-after')).toBeVisible()
    await expectTaskState(page, 'enex-todo', 'TODO')
    await expect(rowOf(page, 'enex-todo').locator('.due-date-chip')).toHaveAttribute(
      'aria-label',
      /Oct 1, 2031/,
    )
    await expect(rowOf(page, 'Content not supported')).toHaveCount(0)
  })

  test('#6032 — an .enex note is titled under its file name, its tag a page tag and no block of tags', async ({
    page,
  }) => {
    await importFile(
      page,
      'import-enex-input',
      'tagged-Work.enex',
      enex('tagged-Meeting', '<div>tagged-body</div>', '<tag>tagged-tag</tag>'),
      'Imported “tagged-Work/tagged-Meeting”',
    )
    await reopenTitled(page, 'tagged-Work/tagged-Meeting')
    await expect(rowOf(page, 'tagged-body')).toBeVisible()
    // The tag is the page's tag (PageTagSection's chip), not a block's.
    await expect(page.getByLabel('Remove tag tagged-tag', { exact: true })).toBeVisible()
    await expect(
      page.locator('[data-testid="block-static"] [data-testid="tag-ref-chip"]'),
    ).toHaveCount(0)
  })

  test('#6032 — an Evernote code block is one code block, its indentation kept and its #word no tag', async ({
    page,
  }) => {
    // Evernote 10 writes a code block as a styled `<div>` of one `<div>` per
    // line, indenting with `&nbsp;`.
    const code =
      '<div style="--en-codeblock:true;">' +
      '<div>code-fn():</div><div>&nbsp;&nbsp;&nbsp;&nbsp;return 1</div><div>#code-word</div>' +
      '</div>'
    await importFile(
      page,
      'import-enex-input',
      'export.enex',
      enex('code-note', `${code}<div>code-after</div>`),
      'Imported “export/code-note”',
    )
    await reopenTitled(page, 'export/code-note')
    await expect(rowOf(page, 'code-after')).toBeVisible()
    const block = rowOf(page, 'code-fn')
    await expect(block.locator('pre')).toHaveCount(1)
    expect(await block.locator('pre').textContent()).toContain(
      'code-fn():\n    return 1\n#code-word',
    )
    await expect(block.getByTestId('tag-ref-chip')).toHaveCount(0)
  })

  test('#6032 — an Evernote list item’s text has no spaces before it', async ({ page }) => {
    await importFile(
      page,
      'import-enex-input',
      'export.enex',
      enex('list-note', '<ul><li>list-bullet</li></ul><ol><li>list-numbered</li></ol>'),
      'Imported “export/list-note”',
    )
    await reopenTitled(page, 'export/list-note')
    for (const item of ['list-bullet', 'list-numbered']) {
      const text = await rowOf(page, item)
        .getByTestId('block-static')
        .evaluate((el) => {
          const copy = el.cloneNode(true) as Element
          copy.querySelector('[data-testid="list-marker"]')?.remove()
          return copy.textContent ?? ''
        })
      expect(text).toBe(item)
    }
  })

  // #6032 — a `/` in a title is part of the name, kept as the look-alike `∕`,
  // where it once split the note into a namespace.
  test('an .enex note titled with a / is one page, the / a look-alike', async ({ page }) => {
    await importFile(
      page,
      'import-enex-input',
      'export.enex',
      enex('slash-TCP/IP', '<div>slash-body</div>'),
      'Imported “export/slash-TCP∕IP”',
    )
    await navigateToView(page, 'Pages')
    await expect(page.locator('span[data-page-title="export/slash-TCP/IP"]')).toHaveCount(0)
    await reopenTitled(page, 'export/slash-TCP∕IP')
    await expect(rowOf(page, 'slash-body')).toBeVisible()
  })
})

// #5740 — a `.jex` is unpacked in the webview, each note a page titled by its
// notebook path.
test.describe('Joplin imports @markdown', { tag: '@real-only' }, () => {
  test('a .jex makes each note a page titled by its notebook path, a to-do a task, a tag a page tag', async ({
    page,
  }) => {
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
      joplinItem(`jex-${name}\n\njex-${name}-body`, {
        id,
        parent_id: parent,
        ...props,
        type_: '1',
      }),
    ]
    const jex = tar([
      [`${ids.book}.md`, joplinItem('jex-book', { id: ids.book, parent_id: '', type_: '2' })],
      [`${ids.sub}.md`, joplinItem('jex-sub', { id: ids.sub, parent_id: ids.book, type_: '2' })],
      // A to-do due at local noon on 1 Oct 2031, tagged.
      note('top', ids.book, ids.top, {
        is_todo: '1',
        todo_completed: '0',
        todo_due: String(new Date(2031, 9, 1, 12).getTime()),
      }),
      note('deep', ids.sub, ids.deep),
      [`${ids.tag}.md`, joplinItem('jex-tag', { id: ids.tag, type_: '5' })],
      [
        `${ids.noteTag}.md`,
        joplinItem('', { id: ids.noteTag, note_id: ids.top, tag_id: ids.tag, type_: '6' }),
      ],
    ])
    await importFile(page, 'import-jex-input', 'export.jex', jex, 'Imported “2 notes”')
    await reopenTitled(page, 'jex-book/jex-top')
    await expect(rowOf(page, 'jex-top-body')).toBeVisible()
    // The to-do opens with a task block named after the note.
    const task = rowOf(page, 'jex-top').first()
    await expect(task.getByTestId('task-marker')).toHaveAttribute('aria-label', /^Task: TODO/)
    await expect(task.locator('.due-date-chip')).toHaveAttribute('aria-label', /Oct 1, 2031/)
    await expect(page.getByLabel('Remove tag jex-tag', { exact: true })).toBeVisible()
    await reopenTitled(page, 'jex-book/jex-sub/jex-deep')
    await expect(rowOf(page, 'jex-deep-body')).toBeVisible()
  })

  test('#6032 — a PDF a Joplin note links to is attached and shown as a file link', async ({
    page,
  }) => {
    const ids = { note: 'a'.repeat(32), pdf: 'b'.repeat(32) }
    const jex = tar([
      [
        `${ids.note}.md`,
        joplinItem(`jexpdf-files\n\njexpdf-see [the report](:/${ids.pdf})`, {
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
    await importFile(page, 'import-jex-input', 'export.jex', jex, 'Imported “jexpdf-files”')
    await reopenTitled(page, 'jexpdf-files')
    await expectFileLinked(page, 'jexpdf-see', 'the report', 'report.pdf')
  })

  test('a .jex note and notebook titled with a / are one level each, linked by that title', async ({
    page,
  }) => {
    const ids = { book: '7'.repeat(32), target: '8'.repeat(32), linker: '9'.repeat(32) }
    const jex = tar([
      [`${ids.book}.md`, joplinItem('jexs-A/B', { id: ids.book, parent_id: '', type_: '2' })],
      [
        `${ids.target}.md`,
        joplinItem('jexs-TCP/IP\n\njexs-body', { id: ids.target, parent_id: ids.book, type_: '1' }),
      ],
      [
        `${ids.linker}.md`,
        joplinItem(`jexs-linker\n\njexs-link [it](:/${ids.target})`, {
          id: ids.linker,
          parent_id: '',
          type_: '1',
        }),
      ],
    ])
    await importFile(page, 'import-jex-input', 'export.jex', jex, 'Imported “2 notes”')
    const title = 'jexs-A∕B/jexs-TCP∕IP'
    await reopenTitled(page, title)
    await expect(rowOf(page, 'jexs-body')).toBeVisible()
    await reopenTitled(page, 'jexs-linker')
    await expect(rowOf(page, 'jexs-link').getByTestId('block-link-chip')).toHaveAttribute(
      'data-id',
      await pageIdTitled(page, title),
    )
  })
})

// #5740 — a vault is a folder pick: each note a page, its embeds' bytes stored,
// its `[[Name]]` links written with the named notes' titles.
test.describe('Obsidian vault import @markdown', { tag: '@real-only' }, () => {
  test('a vault imports with its wikilink, tag, front matter, embedded image and note embeds', async ({
    page,
  }) => {
    const home = [
      '---',
      'reviewer: obs-alice',
      'authors: ["Smith, John", "Doe, Jane"]',
      '---',
      '- obs-links [[obs-topic]] #obs-tag',
      '- obs-figure ![[pic.png]]',
      '- obs-sized ![[pic.png|300]]',
      '- ![[obs-topic]]',
      '- ![[obs-topic#^step]]',
      '- obs-umlaut [[über]]',
      '',
    ].join('\n')
    // The image is an attachment, so the pick makes three pages.
    await importFolder(
      page,
      'import-obsidian-input',
      'obs-vault',
      {
        'obs-home.md': home,
        'obs-topic.md': '- obs-body\n- obs-step ^step\n',
        'Über.md': '- obs-uber\n',
        'pic.png': PNG,
      },
      'Imported “3 files”',
    )
    await navigateToView(page, 'Pages')
    await expect(page.locator('span[data-page-title="obs-topic"]')).toBeVisible()
    for (const absent of ['obs-vault/obs-topic', 'über', 'pic.png']) {
      await expect(page.locator(`span[data-page-title="${absent}"]`)).toHaveCount(0)
    }
    await expect(page.locator('span[data-page-title="Über"]')).toBeVisible()

    await reopenTitled(page, 'obs-home')
    await expect(rowOf(page, 'obs-links').getByTestId('tag-ref-chip')).toContainText('obs-tag')
    await expectImageRendered(rowOf(page, 'obs-figure'))
    await expectImageRendered(rowOf(page, 'obs-sized'))
    await expect(rowOf(page, 'obs-sized').getByTestId('image-rendered')).toHaveCSS('width', '300px')
    // The embeds in block order: the note, whose two blocks both show, then the
    // one block `^step` named, which shows alone. The `^step` block is in a
    // note imported after the one naming it: only the folder's closing
    // `link_import_anchors` call can link it.
    const embeds = page.getByTestId('embed-container')
    await expect(embeds).toHaveCount(2)
    await expect(embeds.nth(0)).toContainText('obs-body')
    await expect(embeds.nth(0)).toContainText('obs-step')
    await expect(embeds.nth(1)).toContainText('obs-step')
    await expect(embeds.nth(1)).not.toContainText('obs-body')
    await expect(rowOf(page, 'obs-umlaut').getByTestId('block-link-chip')).toHaveAttribute(
      'data-id',
      await pageIdTitled(page, 'Über'),
    )

    await page.locator('.page-property-table-header').click()
    await expect(page.getByLabel('reviewer value', { exact: true })).toHaveValue('obs-alice')
    // A YAML list under an undeclared key is a list, an item holding a comma
    // one item (#6741), and the export writes it back as that YAML list.
    await expect(propertyListItems(page, 'authors')).toHaveText(['Smith, John', 'Doe, Jane'])
    const homeId = await pageIdTitled(page, 'obs-home')
    expect(await ipc<string>(page, 'export_page_markdown', { pageId: homeId })).toContain(
      'authors: ["Smith, John", "Doe, Jane"]\n',
    )

    // The link names the vault's note, and opens it.
    const chip = rowOf(page, 'obs-links').getByTestId('block-link-chip')
    await expect(chip).toHaveAttribute('data-id', await pageIdTitled(page, 'obs-topic'))
    await chip.dispatchEvent('click')
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('obs-topic')
    await expect(rowOf(page, 'obs-body')).toBeVisible()
  })
})

// #6277 G5 — a file whose title names a page with blocks merges into it as an
// Edit as Markdown save of the file does, after a dialog listing the pages it
// updates (`list_import_merges`).
test.describe(
  'Re-import merges into the page of its title @markdown @pages',
  { tag: '@real-only' },
  () => {
    test('a file lists the existing page before it runs and updates it in place', async ({
      page,
    }) => {
      await importMarkdownPage(
        page,
        'reimport-plan',
        'reimport-alpha\n\nreimport-beta\n\nreimport-gamma\n',
      )
      await navigateToDataSettings(page)
      await page.getByTestId('import-file-input').setInputFiles({
        name: 'reimport-plan.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('reimport-alpha\n\nreimport-beta-edited\n'),
      })
      // The dialog lists the one page the import updates (ImportMergeDialog.tsx).
      await expect(page.getByTestId('import-merge-pages').locator('li')).toHaveText([
        'reimport-plan',
      ])
      await confirmEach(page, ['Update and import'])
      await expect(page.getByTestId('import-result')).toContainText('1 existing page updated')

      await pageIdTitled(page, 'reimport-plan')
      await reopenTitled(page, 'reimport-plan')
      await expect(rowOf(page, 'reimport-beta-edited')).toBeVisible()
      await expect(rowOf(page, 'reimport-alpha')).toBeVisible()
      await expect(rowOf(page, 'reimport-gamma')).toHaveCount(0)
    })

    test('the space’s export folder updates each page in place, keeping its blocks, files and template flag', async ({
      page,
    }) => {
      const { pageId, blockId } = await createPage(page, PERSONAL, 'g5-review', 'g5-holder')
      await attachFile(page, blockId, 'g5 report.pdf', 'application/pdf', '%PDF-1')
      await setValue(page, pageId, 'template', { value_text: 'true' })
      const files = await exportSpaceZip(page)

      await importFolder(page, 'import-folder-input', 'g5-export', files, 'existing page', [
        'Update and import',
      ])
      await pageIdTitled(page, 'g5-review')
      await reopenTitled(page, 'g5-review')
      await expect(rowOf(page, 'g5-holder')).toBeVisible()
      const attached = await ipc<{ filename: string }[]>(page, 'list_attachments', { blockId })
      expect(attached.map((file) => file.filename)).toEqual(['g5 report.pdf'])
      expect(
        (await propertiesOf(page, pageId)).find((row) => row.key === 'template')?.value_text,
      ).toBe('true')
    })

    test('an Obsidian ^name anchor leaves its new block, and the link to it is a ref to that block', async ({
      page,
    }) => {
      await importMarkdownPage(page, 'anchor-notes', 'anchor-old\n')
      await importFile(
        page,
        'import-file-input',
        'anchor-notes.md',
        '- anchor-old\n- anchor-fresh ^two\n- anchor-see [[anchor-notes#^two]]\n',
        '1 existing page updated',
        ['Update and import'],
      )
      await reopenTitled(page, 'anchor-notes')
      // The linking row shows the block's text too, as its ref chip.
      await expect(rowOf(page, 'anchor-fresh').filter({ hasNotText: 'anchor-see' })).toBeVisible()
      const { blocks } = await ipc<{ blocks: { id: string; content: string | null }[] }>(
        page,
        'load_page_subtree',
        {
          rootBlockId: await pageIdTitled(page, 'anchor-notes'),
          scope: { kind: 'active', space_id: PERSONAL },
        },
      )
      const fresh = blocks.find((block) => block.content === 'anchor-fresh')
      expect(fresh).toBeTruthy()
      expect(blocks.map((block) => block.content)).toContain(`anchor-see ((${fresh?.id}))`)
    })

    test('a Logseq page lists the page before it runs and updates it in place', async ({
      page,
    }) => {
      const graph = (markdown: string) => ({
        'logseq/config.edn': '{:file/name-format :triple-lowbar}\n',
        'pages/lsm-notes.md': markdown,
      })
      await importFolder(
        page,
        'import-folder-input',
        'lsm-graph',
        graph('- lsm-alpha\n- lsm-beta\n- lsm-gamma\n'),
        'Imported “lsm-notes”',
      )
      await importFolder(
        page,
        'import-folder-input',
        'lsm-graph',
        graph('- lsm-alpha\n- lsm-beta-edited\n- lsm-gamma\n'),
        '1 existing page updated',
        ['Update and import'],
      )
      await pageIdTitled(page, 'lsm-notes')
      await reopenTitled(page, 'lsm-notes')
      await expect(rowOf(page, 'lsm-beta-edited')).toBeVisible()
      await expect(rowOf(page, 'lsm-gamma')).toBeVisible()
      await expect(page.locator('span[data-page-title="lsm-notes (2)"]')).toHaveCount(0)
    })
  },
)

// #4671, #6032, #6741 — the real BibTeX parser skips an entry with no citation
// key and reports it; a good entry is a page "{family} {year}" holding its
// paper title, its journal and each author as one item of a list.
test.describe('Bibliography import @markdown', { tag: '@real-only' }, () => {
  test('the good entry is a page with its title, journal and authors, the malformed one a warning', async ({
    page,
  }) => {
    const bibtex = [
      '@article{bibfamkey,',
      '  author = {Bibfam, Test and Doe, Jane},',
      '  title = {A bibliography round trip},',
      '  journaltitle = {A Journal Title},',
      '  year = {2024}',
      '}',
      '@article{,',
      '  title = {Entry with no citation key},',
      '  year = {2024}',
      '}',
      '',
    ].join('\n')
    await navigateToDataSettings(page)
    await page.getByTestId('import-bib-input').setInputFiles({
      name: 'refs.bib',
      mimeType: '',
      buffer: Buffer.from(bibtex),
    })
    await expect(page.getByTestId('bib-import-summary')).toContainText('Imported 1 reference page')
    await page.getByTestId('bib-import-warnings').locator('summary').click()
    const warnings = page.getByTestId('bib-import-warning-item')
    await expect(warnings).toHaveCount(1)
    await expect(warnings).toContainText('missing or malformed citation key')

    await reopenTitled(page, 'Bibfam 2024')
    await page.locator('.page-property-table-header').click()
    await expect(page.getByLabel('title value', { exact: true })).toHaveValue(
      'A bibliography round trip',
    )
    await expect(page.getByLabel('journal value', { exact: true })).toHaveValue('A Journal Title')
    await expect(propertyListItems(page, 'authors')).toHaveText(['Bibfam, Test', 'Doe, Jane'])
  })
})

// #5740 items 9 and 10, #6277 — what the backend's export writes, its importer
// and paste read back to the same page.
test.describe('Export read back @markdown', { tag: '@real-only' }, () => {
  test('an exported page re-imports with its task, repeat rule, tag, labelled link and nesting', async ({
    page,
  }) => {
    await importMarkdownPage(page, 'rt-target', '- rt-target-body\n')
    // A Markdown file's task is a checkbox item; a bare `TODO` is text (#6277 decision 1).
    const source = [
      '- [ ] rt-task #rt-tag [[rt-target|rt-label]]',
      '  repeat:: weekly',
      '- rt-parent',
      '  - rt-child',
      '',
    ].join('\n')
    await importMarkdownPage(page, 'rt-page', source)
    const sourceId = await pageIdTitled(page, 'rt-page')
    const exported = await ipc<string>(page, 'export_page_markdown', { pageId: sourceId })
    // The Document layout (#6277 E2): the task, then two bulleted blocks.
    expect(exported).toBe(`# rt-page\n\n${source}`)

    // Trash the source so the import is the only live page of that title.
    await ipc(page, 'delete_block', { blockId: sourceId })
    await importMarkdownPage(page, 'rt-page', exported)
    const copyId = await pageIdTitled(page, 'rt-page')
    expect(copyId).not.toBe(sourceId)
    await reopenTitled(page, 'rt-page')
    const task = rowOf(page, 'rt-task')
    await expect(task.getByTestId('task-marker')).toHaveAttribute('aria-label', /^Task: TODO/)
    await expect(task.locator('.repeat-indicator')).toHaveAttribute('aria-label', 'Repeats weekly')
    await expect(task.getByTestId('block-link-chip')).toHaveText('rt-label')
    await expect(task.getByTestId('block-link-chip')).toHaveAttribute(
      'data-id',
      await pageIdTitled(page, 'rt-target'),
    )
    await expect(task).toHaveAttribute('aria-level', '1')
    await expect(rowOf(page, 'rt-parent')).toHaveAttribute('aria-level', '1')
    await expect(rowOf(page, 'rt-child')).toHaveAttribute('aria-level', '2')
    expect(await ipc<string>(page, 'export_page_markdown', { pageId: copyId })).toBe(exported)
  })

  test('the space exports as a ZIP with a folder per namespace and the image under assets/, linked relatively', async ({
    page,
  }) => {
    const { blockId } = await createPage(page, PERSONAL, 'zip-ns/zip-leaf', 'zip-marker')
    const { id } = await attachFile(page, blockId, 'zip-image.png', 'image/png', PNG)
    await ipc(page, 'edit_block', {
      blockId,
      toText: `zip-marker![zip-image.png](attachment:${id})`,
    })
    const files = await exportSpaceZip(page)
    const assets = Object.keys(files).filter((name) => name.startsWith('assets/'))
    expect(assets).toEqual([`assets/${id}/zip-image.png`])
    expect(files[`assets/${id}/zip-image.png`]?.toString('base64')).toBe(PNG.toString('base64'))
    const leaf = files['zip-ns/zip-leaf.md']?.toString('utf8') ?? ''
    // The file opens with the block, a paragraph, its title line dropped (#6277 E2, decision 8).
    expect(leaf.startsWith(`zip-marker![zip-image.png](../assets/${id}/zip-image.png)`)).toBe(true)
    expect(leaf).not.toContain('attachment:')
    // The report lists what an export skipped; a clean export has none.
    expect(Object.keys(files)).not.toContain('.agaric/export-report.txt')
  })

  test('a page copy pastes into another page as its title heading and its blocks (#6277 E4)', async ({
    page,
  }) => {
    await importMarkdownPage(
      page,
      'pc-page',
      [
        '---',
        'aliases: [pc-alias]',
        '---',
        '',
        '- pc-milk',
        '  + pc-litres',
        '',
        'pc-intro',
        '',
      ].join('\n'),
    )
    const copied = await ipc<string>(page, 'export_page_markdown', {
      pageId: await pageIdTitled(page, 'pc-page'),
    })
    expect(copied.startsWith('---\naliases: [pc-alias]\n---\n\n# pc-page\n')).toBe(true)
    await ipc(page, 'plugin:clipboard-manager|write_text', { text: copied })

    // A selected block pastes the clipboard after it.
    const { blockId } = await createPage(page, PERSONAL, 'pc-dest', 'pc-anchor')
    await reopenTitled(page, 'pc-dest')
    await focusBlockById(page, blockId)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('block-editor')).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+v')
    await expect(rowOf(page, 'pc-intro')).toBeVisible()

    // The durable read: the title is one heading block; the front matter is no
    // block, where it was two `---` rules and an `aliases:` paragraph.
    await reopenTitled(page, 'pc-dest')
    await expect(rowOf(page, 'pc-intro')).toBeVisible()
    const rows = await page.locator('li[data-block-id]').evaluateAll((items) =>
      items.map((li) => ({
        // The list marker renders once the block's list style has loaded.
        text: (() => {
          const copy = li.querySelector('[data-testid="block-static"]')?.cloneNode(true) as Element
          copy?.querySelector('[data-testid="list-marker"]')?.remove()
          return copy?.textContent ?? ''
        })(),
        level: li.getAttribute('aria-level'),
        heading: li.querySelector('h1') !== null,
        rule: li.querySelector('hr') !== null,
      })),
    )
    expect(rows).toEqual([
      { text: 'pc-anchor', level: '1', heading: false, rule: false },
      { text: 'pc-page', level: '1', heading: true, rule: false },
      { text: 'pc-milk', level: '1', heading: false, rule: false },
      { text: 'pc-litres', level: '2', heading: false, rule: false },
      { text: 'pc-intro', level: '1', heading: false, rule: false },
    ])
  })

  // #6277 F3 — a ref value is `"[[Title]]"` in the front matter, which Obsidian
  // reads as a link, and an import reads it back as the same page.
  test('a page ref property exports as a link and imports back as the same page', async ({
    page,
  }) => {
    await ipc(page, 'create_property_def', {
      spaceId: PERSONAL,
      key: 'refowner',
      valueType: 'ref',
      options: null,
    })
    const target = await ipc<string>(page, 'create_page_in_space', {
      parentId: null,
      content: 'ref-target',
      spaceId: PERSONAL,
    })
    const { pageId } = await createPage(page, PERSONAL, 'ref-holder', 'ref-held')
    await setValue(page, pageId, 'refowner', { value_ref: target })
    const md = await ipc<string>(page, 'export_page_markdown', { pageId })
    expect(md).toContain('refowner: "[[ref-target]]"\n')

    await importMarkdownPage(page, 'ref-copy', md)
    await reopenTitled(page, 'ref-copy')
    await page.locator('.page-property-table-header').click()
    // The row is a page picker, so the value is a ref.
    await expect(page.getByRole('button', { name: 'refowner value', exact: true })).toBeVisible()
    const copy = await propertiesOf(page, await pageIdTitled(page, 'ref-copy'))
    expect(copy.find((row) => row.key === 'refowner')?.value_ref).toBe(target)
  })
})

// #6277 G1, G2, G6, #6554 — the space's ZIP export, unzipped and folder-picked
// into another space, gives the same pages; a whole-vault export restores each
// space.
test.describe(
  'Restore of an export by folder import @markdown @spaces',
  { tag: '@real-only' },
  () => {
    test('an export restores its titles, namespaced link, journal day and typed property', async ({
      page,
    }) => {
      const day = '2019-03-14'
      const key = 'restorelevel'
      const leaf = await createPage(page, PERSONAL, 'rs-ns/rs-leaf', 'rs-leaf-body')
      await createPage(page, PERSONAL, 'rs-home', `rs-link [[${leaf.pageId}]]`)
      await createPage(page, PERSONAL, day, 'rs-day')
      await ipc(page, 'create_property_def', {
        spaceId: PERSONAL,
        key,
        valueType: 'number',
        options: null,
      })
      const colon = await createPage(page, PERSONAL, 'rs-a:b', 'rs-colon-body')
      await setValue(page, colon.pageId, key, { value_num: 42 })
      const files = await exportSpaceZip(page)
      for (const name of ['rs-ns/rs-leaf.md', 'rs-home.md', `${day}.md`, 'rs-a_b.md']) {
        expect(Object.keys(files)).toContain(name)
      }
      const notes = Object.keys(files).filter((name) => name.endsWith('.md')).length
      // A partial export's skip ledger, which must not come back as a page.
      files['.agaric/export-report.txt'] = Buffer.from('Agaric export report\n')

      await switchToSpace(page, 'Work')
      await importFolder(
        page,
        'import-folder-input',
        'rs-export',
        files,
        `Imported “${notes} files”`,
      )
      await navigateToView(page, 'Pages')
      await expect(page.locator('span[data-page-title="rs-ns/rs-leaf"]')).toBeVisible()
      for (const absent of [
        'rs-export/rs-ns/rs-leaf',
        'rs-a_b',
        'export-report',
        '.agaric/export-report',
      ]) {
        await expect(page.locator(`span[data-page-title="${absent}"]`)).toHaveCount(0)
      }
      await reopenTitled(page, 'rs-home')
      await rowOf(page, 'rs-link').getByTestId('block-link-chip').dispatchEvent('click')
      await expect(page.locator('[aria-label="Page title"]')).toHaveText('rs-ns/rs-leaf')
      await expect(rowOf(page, 'rs-leaf-body')).toBeVisible()

      const journal = await ipc<{ content: string } | null>(page, 'get_journal_page_by_date', {
        date: day,
        scope: { kind: 'active', space_id: WORK },
      })
      expect(journal?.content).toBe(day)
      const defs = await ipc<{ items: { key: string; value_type: string }[] }>(
        page,
        'list_property_defs',
        { spaceId: WORK, cursor: null, limit: null },
      )
      expect(defs.items.find((def) => def.key === key)?.value_type).toBe('number')
      const restored = await pageIdTitled(page, 'rs-a:b', WORK)
      expect((await propertiesOf(page, restored)).find((row) => row.key === key)?.value_num).toBe(
        42,
      )
    })

    test('an export restores the same blocks and depths, typed properties, template, done date and files', async ({
      page,
    }) => {
      const day = '2018-07-09'
      const keys = new Set(['g6effort', 'g6due', 'template', 'completed_at'])
      for (const [key, valueType] of [
        ['g6effort', 'number'],
        ['g6due', 'date'],
      ]) {
        await ipc(page, 'create_property_def', { spaceId: PERSONAL, key, valueType, options: null })
      }
      const tree = await createPage(page, PERSONAL, 'g6-ns/g6-tree', 'g6-parent')
      const child = await addBlock(page, PERSONAL, tree.blockId, 'g6-child')
      await addBlock(page, PERSONAL, child, 'g6-grandchild')
      await addBlock(page, PERSONAL, tree.pageId, 'g6-sibling')
      await setValue(page, tree.pageId, 'g6effort', { value_num: 3 })
      await setValue(page, child, 'g6due', { value_date: '2026-06-01' })
      await attachFile(page, child, 'g6 report.pdf', 'application/pdf', '%PDF-1')
      const task = await addBlock(page, PERSONAL, tree.pageId, 'g6-task')
      await ipc(page, 'set_todo_state', { blockId: task, state: 'DONE' })
      const template = await createPage(page, PERSONAL, 'g6-a:b template', 'g6-template-body')
      await setValue(page, template.pageId, 'template', { value_text: 'true' })
      const journal = await createPage(page, PERSONAL, day, 'g6-day')
      const files = await exportSpaceZip(page)
      const notes = Object.keys(files).filter((name) => name.endsWith('.md')).length

      await switchToSpace(page, 'Work')
      await importFolder(
        page,
        'import-folder-input',
        'g6-export',
        files,
        `Imported “${notes} files”`,
      )
      await reopenTitled(page, 'g6-ns/g6-tree')

      /** Each block's depth, text, task state, files and kept properties, in tree order. */
      const shape = async (pageId: string, spaceId: string): Promise<string[]> => {
        const { blocks } = await ipc<{
          blocks: {
            id: string
            parent_id: string | null
            content: string | null
            todo_state: string | null
          }[]
        }>(page, 'load_page_subtree', {
          rootBlockId: pageId,
          scope: { kind: 'active', space_id: spaceId },
        })
        const describe = async (blockId: string) => {
          const kept = (await propertiesOf(page, blockId))
            .filter((row) => keys.has(row.key))
            .map(
              (row) =>
                `${row.key}=${JSON.stringify([row.value_text, row.value_num, row.value_date])}`,
            )
          const attached = await ipc<{ filename: string }[]>(page, 'list_attachments', { blockId })
          return [...kept.toSorted(), ...attached.map((file) => `file ${file.filename}`)].join(' ')
        }
        const rows = [`page ${await describe(pageId)}`]
        const walk = async (parentId: string, level: number): Promise<void> => {
          for (const block of blocks.filter((b) => b.parent_id === parentId && b.id !== pageId)) {
            const text = (block.content ?? '').replace(
              /attachment:[0-9A-Z]{26}/g,
              'attachment:<id>',
            )
            rows.push(`${level} ${text} ${block.todo_state ?? ''} ${await describe(block.id)}`)
            await walk(block.id, level + 1)
          }
        }
        await walk(pageId, 0)
        return rows
      }
      for (const [title, from] of [
        ['g6-ns/g6-tree', tree.pageId],
        ['g6-a:b template', template.pageId],
      ] as const) {
        expect(await shape(await pageIdTitled(page, title, WORK), WORK)).toEqual(
          await shape(from, PERSONAL),
        )
      }
      const restoredDay = await ipc<{ id: string } | null>(page, 'get_journal_page_by_date', {
        date: day,
        scope: { kind: 'active', space_id: WORK },
      })
      expect(restoredDay).not.toBeNull()
      expect(await shape(restoredDay?.id ?? '', WORK)).toEqual(
        await shape(journal.pageId, PERSONAL),
      )
      const defs = await ipc<{ items: { key: string; value_type: string }[] }>(
        page,
        'list_property_defs',
        { spaceId: WORK, cursor: null, limit: null },
      )
      expect(
        ['g6effort', 'g6due'].map((key) => defs.items.find((def) => def.key === key)?.value_type),
      ).toEqual(['number', 'date'])
    })

    test('a whole-vault export recreates each space with its typed definition and page, and a second pick duplicates none', async ({
      page,
    }) => {
      // The seeded Personal and Work cannot be emptied, so "an empty vault" is
      // spaces that do not exist yet: each space folder, and the name its space
      // file carries, are renamed before the pick.
      const restores = [
        {
          from: 'Personal',
          fromId: PERSONAL,
          to: 'vault-a',
          page: 'vault-pa',
          key: 'vaultpa',
          value: 42,
        },
        { from: 'Work', fromId: WORK, to: 'vault-b', page: 'vault-pb', key: 'vaultpb', value: 7 },
      ]
      for (const { fromId, page: title, key, value } of restores) {
        await ipc(page, 'create_property_def', {
          spaceId: fromId,
          key,
          valueType: 'number',
          options: null,
        })
        const { pageId } = await createPage(page, fromId, title, `${title}-body`)
        await setValue(page, pageId, key, { value_num: value })
      }
      const all = await exportZip(page, page.getByTestId('export-all-spaces-button'))
      const files: Record<string, Buffer> = {}
      for (const { from, to } of restores) {
        for (const [name, bytes] of Object.entries(all)) {
          if (name.startsWith(`${from}/`)) files[`${to}/${name.slice(from.length + 1)}`] = bytes
        }
        const space = JSON.parse(files[`${to}/.agaric/space.json`]?.toString('utf8') ?? '{}') as {
          name?: string
        }
        expect(space.name).toBe(from)
        files[`${to}/.agaric/space.json`] = Buffer.from(JSON.stringify({ ...space, name: to }))
      }
      const notes = Object.keys(files).filter((name) => name.endsWith('.md')).length

      await importFolder(
        page,
        'import-folder-input',
        'vault-export',
        files,
        `Imported “${notes} files”`,
        ['Restore spaces'],
      )
      const spaces = await ipc<{ id: string; name: string }[]>(page, 'list_spaces', undefined)
      expect(spaces.map(({ name }) => name).toSorted()).toEqual([
        'Personal',
        'Work',
        'vault-a',
        'vault-b',
      ])
      for (const { to, page: title, key, value } of restores) {
        const spaceId = spaces.find(({ name }) => name === to)?.id ?? ''
        const defs = await ipc<{ items: { key: string; value_type: string }[] }>(
          page,
          'list_property_defs',
          { spaceId, cursor: null, limit: null },
        )
        expect(defs.items.find((def) => def.key === key)?.value_type).toBe('number')
        const restored = await pageIdTitled(page, title, spaceId)
        expect((await propertiesOf(page, restored)).find((row) => row.key === key)?.value_num).toBe(
          value,
        )
      }
      // The active space holds its own page once, and none filed under a folder's name.
      const active = (await pagesIn(page, PERSONAL)).map((row) => row.content ?? '')
      expect(active.filter((title) => title === 'vault-pa')).toHaveLength(1)
      expect(active.filter((title) => title === 'vault-pb')).toHaveLength(0)
      expect(active.filter((title) => title.startsWith('vault-') && title.includes('/'))).toEqual(
        [],
      )

      // Their pages exist now, so the second pick also asks, space by space, before updating them.
      await importFolder(
        page,
        'import-folder-input',
        'vault-export',
        files,
        `Imported “${notes} files”`,
        ['Restore spaces', 'Update and import', 'Update and import'],
      )
      expect(await ipc<unknown[]>(page, 'list_spaces', undefined)).toHaveLength(4)
    })
  },
)

// #5365 — a pasted image is an `attachments` row, a file under the app data dir
// and an `attachment:<id>` ref; GatedImage reads the bytes with
// `read_attachment`. An Edit as Markdown save of another line keeps the ref.
test.describe('An image renders from its stored bytes @attachments @markdown', () => {
  test('an attached PNG renders from its bytes, also after a source save of another line', async ({
    page,
  }) => {
    const { pageId, blockId } = await createPage(page, PERSONAL, 'img-page', 'img-holder')
    const { id } = await attachFile(page, blockId, 'image.png', 'image/png', PNG)
    const ref = `img-holder![image.png](attachment:${id})`
    await ipc(page, 'edit_block', { blockId, toText: ref })
    await addBlock(page, PERSONAL, pageId, 'img-below')
    await reopenTitled(page, 'img-page')
    await expectImageRendered(rowOf(page, 'img-holder'))

    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Edit as Markdown', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    await expect(editor).toContainText('img-below')
    await expect(editor).toBeFocused()
    await editor.locator('[data-source-line]', { hasText: 'img-below' }).click({ clickCount: 3 })
    await page.keyboard.type('img-edited')
    await page.getByRole('button', { name: /^Save(?: \(\d+ changes?\))?$/ }).click()
    await expect(page.getByTestId('page-source-editor')).toHaveCount(0)

    await reopenTitled(page, 'img-page')
    await expect(rowOf(page, 'img-edited')).toBeVisible()
    await expect(rowOf(page, 'img-below')).toHaveCount(0)
    await expectImageRendered(rowOf(page, 'img-holder'))
    expect((await ipc<{ content: string }>(page, 'get_block', { blockId })).content).toBe(ref)
  })
})
