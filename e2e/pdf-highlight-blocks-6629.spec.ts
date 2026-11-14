import type { Page } from '@playwright/test'

import {
  activeDialog,
  expect,
  ipc,
  openPage,
  pinPdfComment,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * A highlight or a pinned comment made in the PDF reader becomes a block
 * (#6629). Save writes it into the annotated copy and adds a child of the block
 * that owns the PDF: its text the passage or the comment, its properties the
 * copy's attachment id, the page and the boxes. The block's source chip opens
 * the reader on that page, and a later Save moves the block to the newer copy.
 * Block mode and page mode.
 *
 * Seed data (tauri-mock): BLOCK_GS_1, first child of "Getting Started".
 */

const BLOCK_GS_1 = '0000000000000000000B10CK01'
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }

// Two 200 × 200 pages, Helvetica 24 pt: "Page one", then "Page two".
const TWO_PAGE_PDF_B64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA0IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvQ29udGVudHMgNSAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNyAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvQ29udGVudHMgNiAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNyAwIFIgPj4gPj4gPj4KZW5kb2JqCjUgMCBvYmoKPDwgL0xlbmd0aCAzOSA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDQwIDEwMCBUZCAoUGFnZSBvbmUpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNiAwIG9iago8PCAvTGVuZ3RoIDM5ID4+CnN0cmVhbQpCVCAvRjEgMjQgVGYgNDAgMTAwIFRkIChQYWdlIHR3bykgVGogRVQKZW5kc3RyZWFtCmVuZG9iago3IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDEyMSAwMDAwMCBuIAowMDAwMDAwMjQ3IDAwMDAwIG4gCjAwMDAwMDAzNzMgMDAwMDAgbiAKMDAwMDAwMDQ2MiAwMDAwMCBuIAowMDAwMDAwNTUxIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgOCAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNjIxCiUlRU9G'

interface MockBytesWindow extends Window {
  __addMockAttachmentWithBytes?: (
    blockId: string,
    filename: string,
    mimeType: string,
    bytes: number[],
  ) => Record<string, unknown>
}

interface AttachmentRow {
  id: string
  filename: string
}

interface HighlightBlock {
  id: string
  content: string
  parent_id: string
  page: string | undefined
  boxes: number[][]
}

/** Seed the two-page `report.pdf` on GS_1, with bytes. */
async function seedPdf(page: Page): Promise<void> {
  await page.evaluate((b64) => {
    const bin = atob(b64)
    const bytes = Array.from({ length: bin.length }, (_, i) => bin.charCodeAt(i))
    ;(window as unknown as MockBytesWindow).__addMockAttachmentWithBytes?.(
      '0000000000000000000B10CK01',
      'report.pdf',
      'application/pdf',
      bytes,
    )
  }, TWO_PAGE_PDF_B64)
}

/** Switch the open page to page mode, which does not outlast a navigation. */
async function enterPageMode(page: Page): Promise<void> {
  await page
    .getByRole('radiogroup', { name: 'Editing mode' })
    .getByRole('radio', { name: 'Page' })
    .click()
  await expect(page.locator(`[data-page-block-id="${BLOCK_GS_1}"]`)).toBeVisible()
}

/** Select page `n`'s text in the open reader with Highlight on, as a drag over it does. */
async function highlightTextOfPage(page: Page, n: number, text: string): Promise<void> {
  const reader = activeDialog(page)
  await expect(reader.getByTestId('pdf-tool-highlight')).toHaveAttribute('aria-pressed', 'true')
  const pageBox = reader.locator(`.pdfViewer .page[data-page-number="${n}"]`)
  const span = pageBox.locator('.textLayer').getByText(text, { exact: true })
  await span.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await expect(pageBox.locator('.highlightEditor')).toHaveCount(1)
}

/** Open the reader from GS_1's file chip, highlight page 2's text, and Save; resolves the copy's id. */
async function highlightPageTwoAndSave(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Open file report.pdf' }).click()
  const reader = activeDialog(page)
  await expect(reader.getByTestId('pdf-page-indicator')).toContainText('1 / 2', { timeout: 15000 })
  await reader.getByTestId('pdf-tool-highlight').click()
  await reader.getByRole('button', { name: 'Next page' }).click()
  await expect(reader.getByTestId('pdf-page-indicator')).toContainText('2 / 2')
  await highlightTextOfPage(page, 2, 'Page two')
  await expect(reader.getByTestId('pdf-save')).toBeEnabled()
  await reader.getByTestId('pdf-save').click()
  await expect(reader).toBeHidden()
  const rows = await ipc<AttachmentRow[]>(page, 'list_attachments', { blockId: BLOCK_GS_1 })
  expect(rows.map((r) => r.filename)).toEqual(['report (annotated).pdf'])
  return rows[0]?.id ?? ''
}

/** The live blocks whose `pdf_attachment` is `attachmentId`, as the backend holds them. */
async function highlightBlocksOf(page: Page, attachmentId: string): Promise<HighlightBlock[]> {
  const { items } = await ipc<{ items: Array<{ id: string; content: string; parent_id: string }> }>(
    page,
    'query_by_property',
    {
      request: {
        key: 'pdf_attachment',
        valueText: attachmentId,
        valueDate: null,
        operator: null,
        cursor: null,
        limit: 50,
        excludeParentId: null,
        contentNonEmpty: null,
        blockType: null,
        valueTextIn: null,
        valueDateRange: null,
        excludeTodoStates: null,
      },
      scope: SCOPE,
    },
  )
  if (items.length === 0) return []
  const props = await ipc<Record<string, Array<{ key: string; value_text: string | null }>>>(
    page,
    'get_batch_properties',
    { blockIds: items.map((item) => item.id) },
  )
  const text = (id: string, key: string) =>
    props[id]?.find((p) => p.key === key)?.value_text ?? undefined
  return items.map(({ id, content, parent_id }) => ({
    id,
    content,
    parent_id,
    page: text(id, 'pdf_page'),
    boxes: JSON.parse(text(id, 'pdf_boxes') ?? '[]') as number[][],
  }))
}

/** The blocks are GS_1's children on page 2 holding `texts`, in the order made, one box each. */
function expectPageTwoBlocks(blocks: HighlightBlock[], texts: string[]): void {
  expect(blocks.map((b) => [b.content, b.parent_id, b.page])).toEqual(
    texts.map((text) => [text, BLOCK_GS_1, '2']),
  )
  for (const block of blocks) {
    expect(block.boxes).toHaveLength(1)
    expect(block.boxes[0]).toHaveLength(4)
  }
}

/** The highlight block is GS_1's child holding the passage, page 2 and one box. */
function expectPageTwoHighlight(blocks: HighlightBlock[]): void {
  expectPageTwoBlocks(blocks, ['Page two'])
}

/** Pin a comment saying `words` on page 2 of the open reader, and Save. */
async function commentOnPageTwoAndSave(page: Page, words: string): Promise<void> {
  const reader = activeDialog(page)
  await expect(reader.getByTestId('pdf-page-indicator')).toContainText('2 / 2', { timeout: 15000 })
  await reader.getByTestId('pdf-tool-comment').click()
  await pinPdfComment(page, 2, words)
  await reader.getByTestId('pdf-tool-comment').click()
  await expect(reader.getByTestId('pdf-save')).toBeEnabled()
  await reader.getByTestId('pdf-save').click()
  await expect(reader).toBeHidden()
}

/** Reopen the reader from the source chip: it lands on page 2. Comment, Save; resolves the newer copy's id. */
async function reopenFromChipAndSave(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Open report (annotated).pdf at page 2' }).click()
  await commentOnPageTwoAndSave(page, 'Note')
  const rows = await ipc<AttachmentRow[]>(page, 'list_attachments', { blockId: BLOCK_GS_1 })
  expect(rows.map((r) => r.filename)).toEqual(['report (annotated) (annotated).pdf'])
  return rows[0]?.id ?? ''
}

/**
 * The second Save moved the highlight block to the newest copy, which the
 * backend still has, and added a block for the comment it wrote.
 */
async function expectOnLiveCopy(page: Page, newest: string, first: string): Promise<void> {
  expectPageTwoBlocks(await highlightBlocksOf(page, newest), ['Page two', 'Note'])
  expect(await highlightBlocksOf(page, first)).toEqual([])
  const meta = await ipc<AttachmentRow>(page, 'read_attachment_meta', { attachmentId: newest })
  expect(meta.filename).toBe('report (annotated) (annotated).pdf')
}

test.describe('A PDF highlight or comment becomes a block that links back to its page (#6629) @attachments', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await seedPdf(page)
  })

  test('block mode: Save adds the block, and its chip reopens the reader there', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    const first = await highlightPageTwoAndSave(page)
    expectPageTwoHighlight(await highlightBlocksOf(page, first))
    const [block] = await highlightBlocksOf(page, first)
    const row = page.getByTestId('block-static').and(page.locator(`[data-block-id="${block?.id}"]`))
    await expect(row).toHaveText('Page two')
    const chip = page.getByRole('button', { name: 'Open report (annotated).pdf at page 2' })
    await expect(chip).toHaveText('report (annotated).pdf · p. 2')

    await reopenPage(page, 'Getting Started')
    await expect(row).toHaveText('Page two')
    await expectOnLiveCopy(page, await reopenFromChipAndSave(page), first)
  })

  test('a pinned comment becomes a block too, and its chip reopens the reader there', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    await page.getByRole('button', { name: 'Open file report.pdf' }).click()
    const reader = activeDialog(page)
    await expect(reader.getByTestId('pdf-page-indicator')).toContainText('1 / 2', {
      timeout: 15000,
    })
    await reader.getByRole('button', { name: 'Next page' }).click()
    await commentOnPageTwoAndSave(page, 'Check this')
    const [copy] = await ipc<AttachmentRow[]>(page, 'list_attachments', { blockId: BLOCK_GS_1 })
    expect(copy?.filename).toBe('report (annotated).pdf')
    const blocks = await highlightBlocksOf(page, copy?.id ?? '')
    expectPageTwoBlocks(blocks, ['Check this'])
    const row = page
      .getByTestId('block-static')
      .and(page.locator(`[data-block-id="${blocks[0]?.id}"]`))
    await expect(row).toHaveText('Check this')

    await reopenPage(page, 'Getting Started')
    await expect(row).toHaveText('Check this')
    await page.getByRole('button', { name: 'Open report (annotated).pdf at page 2' }).click()
    await expect(activeDialog(page).getByTestId('pdf-page-indicator')).toContainText('2 / 2', {
      timeout: 15000,
    })
  })

  test('a block moved to another space still follows its file to the newer copy', async ({
    page,
  }) => {
    // The mock's second space, "Work"; a reload re-seeds the mock, so the PDF too.
    await page.addInitScript(() => window.localStorage.setItem('__mockWorkSpace', 'true'))
    await page.reload()
    await waitForBoot(page)
    await seedPdf(page)

    await openPage(page, 'Getting Started')
    const first = await highlightPageTwoAndSave(page)
    const [block] = await highlightBlocksOf(page, first)
    // The highlight block goes to a page of its own, and that page to Work.
    const notesId = await ipc<string>(page, 'create_page_in_space', {
      parentId: null,
      content: 'Reading notes',
      spaceId: 'SPACE_PERSONAL',
    })
    await ipc(page, 'move_block', { blockId: block?.id, newParentId: notesId, newIndex: 0 })
    await ipc(page, 'move_blocks_to_space', {
      blockIds: [notesId],
      spaceId: 'SPACE_WORK',
      acknowledgedLoss: null,
    })
    expect(await highlightBlocksOf(page, first)).toEqual([])

    await reopenPage(page, 'Getting Started')
    await page.getByRole('button', { name: 'Open file report (annotated).pdf' }).click()
    await activeDialog(page).getByRole('button', { name: 'Next page' }).click()
    await commentOnPageTwoAndSave(page, 'Note')
    const [newest] = await ipc<AttachmentRow[]>(page, 'list_attachments', { blockId: BLOCK_GS_1 })
    expect(newest?.filename).toBe('report (annotated) (annotated).pdf')
    const props = await ipc<Record<string, Array<{ key: string; value_text: string | null }>>>(
      page,
      'get_batch_properties',
      { blockIds: [block?.id] },
    )
    expect(props[block?.id ?? '']?.find((p) => p.key === 'pdf_attachment')?.value_text).toBe(
      newest?.id,
    )
  })

  test('undo takes the block back and leaves the PDF', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const first = await highlightPageTwoAndSave(page)
    expectPageTwoHighlight(await highlightBlocksOf(page, first))

    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await highlightBlocksOf(page, first)).length).toBe(0)
    const meta = await ipc<AttachmentRow>(page, 'read_attachment_meta', { attachmentId: first })
    expect(meta.filename).toBe('report (annotated).pdf')
  })

  test('page mode: Save adds the block, and its chip reopens the reader there', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    await enterPageMode(page)
    const first = await highlightPageTwoAndSave(page)
    expectPageTwoHighlight(await highlightBlocksOf(page, first))
    const [block] = await highlightBlocksOf(page, first)
    // Page mode's document takes the new block, its chip under it.
    const row = page.locator(`[data-page-block-id="${block?.id}"]`)
    await expect(row).toContainText('Page two')
    await expect(
      row.getByRole('button', { name: 'Open report (annotated).pdf at page 2' }),
    ).toBeVisible()

    await reopenPage(page, 'Getting Started')
    await enterPageMode(page)
    await expect(row).toContainText('Page two')
    await expectOnLiveCopy(page, await reopenFromChipAndSave(page), first)
  })
})
