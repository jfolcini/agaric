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
 * E2E for PDF annotation via pdf.js's prebuilt viewer (#1452).
 *
 * Flow under test:
 *   1. Seed a real (parseable) PDF attachment on a block, with bytes.
 *   2. Open the page → click the inline "Open file" attachment button.
 *   3. The PdfViewerDialog mounts the PREBUILT viewer (text + annotation
 *      layers) — NOT the old bare <canvas>. The page indicator renders.
 *   4. The annotation toolbar (highlight / comment / save) appears because the
 *      owning block is known; toggling Highlight switches the editor mode.
 *   5. Save is disabled until an annotation exists.
 *
 * The second describe saves a real comment (#6629): the annotated copy
 * replaces the original, and the owning block's `attachment:` link follows it
 * in block mode and in page mode.
 *
 * Seed data (tauri-mock): BLOCK_GS_1 — first child of "Getting Started".
 */

const BLOCK_GS_1 = '0000000000000000000BLOCK01'

// Minimal valid 1-page PDF with selectable text ("Hi 6.0"). Same fixture as
// pdfjs-v6-smoke.spec.ts so we know pdf.js parses + renders it.
const PDF_B64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAzNyA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDUwIDEwMCBUZCAoSGkgNi4wKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMyOCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjM5OAolJUVPRg=='

interface MockBytesWindow extends Window {
  __addMockAttachmentWithBytes?: (
    blockId: string,
    filename: string,
    mimeType: string,
    bytes: number[],
  ) => Record<string, unknown>
}

/** Seed a real PDF attachment (with bytes) into the mock store. */
async function seedPdf(page: import('@playwright/test').Page, blockId: string, filename: string) {
  await page.evaluate(
    ({ blockId: innerBlockId, filename: innerFilename, b64 }) => {
      const bin = atob(b64)
      const bytes = Array.from({ length: bin.length }, (_, i) => bin.charCodeAt(i))
      ;(window as unknown as MockBytesWindow).__addMockAttachmentWithBytes?.(
        innerBlockId,
        innerFilename,
        'application/pdf',
        bytes,
      )
    },
    { blockId, filename, b64: PDF_B64 },
  )
}

test.describe('PDF annotation viewer (#1452) @attachments', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('opens a PDF in the prebuilt viewer with the annotation toolbar', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))

    await seedPdf(page, BLOCK_GS_1, 'report.pdf')
    await openPage(page, 'Getting Started')

    // The inline attachment "Open file" button is rendered under the block.
    const openBtn = page.getByRole('button', { name: 'Open file report.pdf' })
    await expect(openBtn).toBeVisible()
    await openBtn.click()

    // The prebuilt viewer container mounts (NOT a bare <canvas>), and the page
    // indicator renders once the document parses.
    await expect(page.getByTestId('pdf-viewer-container')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('pdf-page-indicator')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('pdf-page-indicator')).toContainText('1 / 1')

    // The annotation toolbar appears because the owning block is known.
    await expect(page.getByTestId('pdf-annotation-toolbar')).toBeVisible()
    await expect(page.getByTestId('pdf-tool-highlight')).toBeVisible()
    await expect(page.getByTestId('pdf-tool-comment')).toBeVisible()

    // Save is disabled until an annotation exists.
    await expect(page.getByTestId('pdf-save')).toBeDisabled()

    // Toggling Highlight activates the editor mode (aria-pressed flips).
    await page.getByTestId('pdf-tool-highlight').click()
    await expect(page.getByTestId('pdf-tool-highlight')).toHaveAttribute('aria-pressed', 'true')

    // No page errors (e.g. the prebuilt viewer's `globalThis.pdfjsLib`
    // destructure, or a worker/API version mismatch).
    expect(pageErrors.join('\n')).not.toMatch(/pdfjsLib|does not match the Worker version/i)
  })

  test('renders the prebuilt text layer for selection', async ({ page }) => {
    await seedPdf(page, BLOCK_GS_1, 'doc.pdf')
    await openPage(page, 'Getting Started')

    await page.getByRole('button', { name: 'Open file doc.pdf' }).click()
    await expect(page.getByTestId('pdf-viewer-container')).toBeVisible({ timeout: 15000 })

    // The prebuilt viewer renders a `.textLayer` per page (the core-only
    // canvas renderer never did). Its presence is the marker that text
    // selection / highlight is wired up.
    await expect(page.locator('.pdfViewer .textLayer').first()).toBeAttached({ timeout: 15000 })
  })
})

interface AttachmentRow {
  id: string
  filename: string
}

/** Seed `report.pdf` on GS_1 with the block's text linking it, as a folder, ENEX or JEX import writes it. */
async function seedLinkedPdf(page: import('@playwright/test').Page): Promise<void> {
  await seedPdf(page, BLOCK_GS_1, 'report.pdf')
  const [row] = await ipc<AttachmentRow[]>(page, 'list_attachments', { blockId: BLOCK_GS_1 })
  if (!row) throw new Error('seedLinkedPdf: the PDF was not attached')
  await ipc(page, 'edit_block', {
    blockId: BLOCK_GS_1,
    toText: `[report.pdf](attachment:${row.id})`,
  })
}

/**
 * Open the reader from the block's chip, place a comment, and Save; resolves
 * the annotated copy's id, once it is the block's only attachment.
 */
async function annotateAndSave(page: import('@playwright/test').Page): Promise<string> {
  await page.getByRole('button', { name: 'Open file report.pdf' }).click()
  const reader = activeDialog(page)
  await expect(reader.getByTestId('pdf-page-indicator')).toContainText('1 / 1', { timeout: 15000 })
  await reader.getByTestId('pdf-tool-comment').click()
  await pinPdfComment(page, 1, 'Note')
  // Leaving the comment commits it, which enables Save.
  await reader.getByTestId('pdf-tool-comment').click()
  await expect(reader.getByTestId('pdf-save')).toBeEnabled()
  await reader.getByTestId('pdf-save').click()
  await expect(reader).toBeHidden()
  const rows = await ipc<AttachmentRow[]>(page, 'list_attachments', { blockId: BLOCK_GS_1 })
  expect(rows.map((r) => r.filename)).toEqual(['report (annotated).pdf'])
  return rows[0]?.id ?? ''
}

/** The filename of the attachment the block's text links, as the backend resolves it now. */
async function linkedFilename(page: import('@playwright/test').Page): Promise<string> {
  const block = await ipc<{ content: string }>(page, 'get_block', { blockId: BLOCK_GS_1 })
  const id = /attachment:([0-9A-Za-z_-]+)/.exec(block.content)?.[1]
  if (id === undefined) throw new Error(`no attachment link in: ${block.content}`)
  return (await ipc<AttachmentRow>(page, 'read_attachment_meta', { attachmentId: id })).filename
}

/** Put page mode's caret at the end of block `blockId`'s text. */
async function caretAtEndOf(page: import('@playwright/test').Page, blockId: string): Promise<void> {
  const editor = page.getByTestId('page-mode-editor')
  await editor.evaluate((dom, id) => {
    interface PMNode {
      attrs: { blockId?: string }
      firstChild: { content: { size: number } }
    }
    const { editor: tiptap } = dom as HTMLElement & {
      editor: {
        state: { doc: { forEach: (fn: (node: PMNode, offset: number) => void) => void } }
        commands: { setTextSelection: (pos: number) => boolean }
        view: { focus: () => void }
      }
    }
    let end = -1
    tiptap.state.doc.forEach((node, offset) => {
      if (node.attrs.blockId === id) end = offset + 2 + node.firstChild.content.size
    })
    if (end < 0) throw new Error(`caretAtEndOf: no block ${id}`)
    tiptap.commands.setTextSelection(end)
    tiptap.view.focus()
    // ProseMirror puts its own selection back 20 ms after a focus; type after that.
    return new Promise((resolve) => setTimeout(resolve, 20))
  }, blockId)
  await expect(editor).toBeFocused()
}

test.describe('Saving PDF annotations keeps the block linking the file (#6629) @attachments', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('block mode: the link names the annotated copy', async ({ page }) => {
    await seedLinkedPdf(page)
    await openPage(page, 'Getting Started')
    const annotated = await annotateAndSave(page)
    const link = page.locator(`[data-block-id="${BLOCK_GS_1}"] [data-testid="attachment-link"]`)
    await expect(link).toHaveAttribute('data-attachment-id', annotated)

    await reopenPage(page, 'Getting Started')
    await expect(link).toHaveAttribute('data-attachment-id', annotated)
    expect(await linkedFilename(page)).toBe('report (annotated).pdf')
  })

  test('page mode: the link names the annotated copy', async ({ page }) => {
    await seedLinkedPdf(page)
    await openPage(page, 'Getting Started')
    await page
      .getByRole('radiogroup', { name: 'Editing mode' })
      .getByRole('radio', { name: 'Page' })
      .click()
    const block = page.locator(`[data-page-block-id="${BLOCK_GS_1}"]`)
    await expect(block).toBeVisible()
    // Page mode saves what is typed through the block commands, not the page store.
    await caretAtEndOf(page, BLOCK_GS_1)
    await page.keyboard.type(' read twice')
    await expect
      .poll(
        async () =>
          (await ipc<{ content: string }>(page, 'get_block', { blockId: BLOCK_GS_1 })).content,
      )
      .toMatch(/ read twice$/)
    const annotated = await annotateAndSave(page)

    // Page mode's document holds the block's text: the edit reaches it, not only the backend.
    await expect(block.getByRole('link', { name: 'report.pdf', exact: true })).toHaveAttribute(
      'href',
      `attachment:${annotated}`,
    )
    await expect(block).toContainText('read twice')
    await reopenPage(page, 'Getting Started')
    expect(
      (await ipc<{ content: string }>(page, 'get_block', { blockId: BLOCK_GS_1 })).content,
    ).toBe(`[report.pdf](attachment:${annotated}) read twice`)
    expect(await linkedFilename(page)).toBe('report (annotated).pdf')
  })
})
