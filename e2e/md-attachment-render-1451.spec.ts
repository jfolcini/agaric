import { attachFile, expect, openPage, test, waitForBoot } from './helpers'

/**
 * E2E for #1451 — `.md` / text attachments render as an inline rich-text
 * preview (reusing `renderRichContent`) instead of a download-only file chip.
 *
 * The attachment is added with its markdown source as bytes (`attachFile`), so
 * `read_attachment` returns it; the inline preview then parses + renders it.
 *
 * Seed block: BLOCK_GS_1 — first child of "Getting Started".
 */

const BLOCK_GS_1 = '0000000000000000000B10CK01'

const MD_SOURCE = [
  '# Release notes',
  '',
  'Some **bold** detail.',
  '',
  '- alpha',
  '- beta',
  '',
].join('\n')

test.describe('Markdown attachment inline preview (#1451) @markdown @attachments', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('renders a .md attachment as formatted rich text inline', async ({ page }) => {
    await attachFile(page, BLOCK_GS_1, 'release.md', 'text/markdown', MD_SOURCE)

    await openPage(page, 'Getting Started')

    // The inline preview surface appears in the block body (no list toggle needed).
    const preview = page.getByTestId('markdown-attachment').first()
    await expect(preview).toBeVisible()

    const body = page.getByTestId('markdown-attachment-body').first()
    await expect(body).toBeVisible()

    // Markdown is rendered rich, not as raw source:
    //  - heading becomes a real heading element
    await expect(body.getByRole('heading', { name: 'Release notes' })).toBeVisible()
    //  - bold + list items render as formatted text
    await expect(body.getByText('bold')).toBeVisible()
    await expect(body.getByText('alpha')).toBeVisible()
    await expect(body.getByText('beta')).toBeVisible()
    //  - the raw "# Release notes" markdown line is not shown verbatim
    await expect(body).not.toContainText('# Release notes')
  })

  test('collapse/expand toggle hides and re-shows the preview body', async ({ page }) => {
    await attachFile(page, BLOCK_GS_1, 'notes.md', 'text/markdown', MD_SOURCE)

    await openPage(page, 'Getting Started')

    const body = page.getByTestId('markdown-attachment-body').first()
    await expect(body).toBeVisible()

    const collapse = page.getByRole('button', { name: /Collapse preview of notes\.md/ }).first()
    await collapse.click()
    await expect(page.getByTestId('markdown-attachment-body')).toHaveCount(0)

    const expand = page.getByRole('button', { name: /Expand preview of notes\.md/ }).first()
    await expand.click()
    await expect(page.getByTestId('markdown-attachment-body').first()).toBeVisible()
  })

  test('non-markdown attachments still render the file chip (no regression)', async ({ page }) => {
    await attachFile(page, BLOCK_GS_1, 'document.pdf', 'application/pdf', new Uint8Array(24576))

    await openPage(page, 'Getting Started')

    // Generic chip exposes the open-file affordance; no markdown preview surface.
    await expect(page.getByRole('button', { name: 'Open file document.pdf' }).first()).toBeVisible()
    await expect(page.getByTestId('markdown-attachment')).toHaveCount(0)
  })
})
