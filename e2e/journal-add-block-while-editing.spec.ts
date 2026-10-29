import { devices } from '@playwright/test'

import { expect, navigateToView, test, waitForBoot } from './helpers'

/**
 * "Add block" pressed while the roving editor sits on a fresh empty block, by a
 * mouse and by a tap: the press adds a block, which takes the editor, and the
 * blur cleanup drops the abandoned empty one.
 *
 * The mouse case comes from `e2e-tauri/search-bm25-order.e2e.ts`, where Enter
 * creates a sibling and focuses it before the next "Add block" press. The
 * button keeps the editor focused through the press. A tap needs that: its blur
 * is not held until the release the way a mouse press's is (`useEditorBlur`).
 * The mock answers synchronously, so the desktop test injects the backend's IPC
 * latency test-side and drives the click as mousedown / mouseup with a
 * human-sized gap.
 */

const IPC_LATENCY_MS = 120

type LatencyWindow = Window & {
  __TAURI_INTERNALS__?: Record<string, unknown>
}

// Tall enough that the seeded day plus two new rows never scroll: with the page
// at its scroll limit, the shrinking row would pull the document up under the
// pointer and hide the shift this spec is about.
test.use({ viewport: { width: 1280, height: 1024 } })

test('adds a block when the button is clicked while an empty block is being edited @editor @journal @mobile', async ({
  page,
}) => {
  await waitForBoot(page)
  await navigateToView(page, 'Journal')
  await page.evaluate((ms) => {
    const w = window as LatencyWindow
    const internals = w.__TAURI_INTERNALS__
    if (!internals) throw new Error('no __TAURI_INTERNALS__ to inject IPC latency into')
    const original = internals['invoke'] as (cmd: string, args: unknown, opts?: unknown) => unknown
    const slow = new Set(['create_block', 'delete_block', 'edit_block', 'load_page_subtree'])
    internals['invoke'] = async (cmd: string, args: unknown, opts?: unknown) => {
      const result = await original(cmd, args, opts)
      if (slow.has(cmd)) {
        await new Promise((resolve) => setTimeout(resolve, ms))
      }
      return result
    }
  }, IPC_LATENCY_MS)

  const addBlock = page.getByRole('button', { name: /add block/i }).first()
  const editor = page.getByRole('textbox', { name: 'Block editor' })
  const rows = page.locator('[data-testid="sortable-block"]')
  const seeded = await rows.count()

  await addBlock.click()
  await expect(editor).toBeVisible()
  await editor.pressSequentially('zap of ink', { delay: 10 })
  await page.keyboard.press('Enter')
  // The create resolves and focuses the new empty block: the window.
  await expect(
    page.locator('[data-testid="block-static"]', { hasText: 'zap of ink' }),
  ).toBeVisible()
  await expect(editor).toBeVisible()
  const emptyBlockId = await page
    .locator('[data-testid="block-editor"]')
    .getAttribute('data-block-id')

  const box = await addBlock.boundingBox()
  if (!box) throw new Error('Add block button has no box')
  expect(box.y + box.height).toBeLessThan(1024)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  // A real click's press: the blur it causes reshapes the rows before the release.
  await page.waitForTimeout(80)
  await page.mouse.up()

  // The click created a block, which took the editor; the abandoned empty
  // block was dropped by the blur cleanup.
  await expect(editor).toBeVisible()
  await expect
    .poll(() => page.locator('[data-testid="block-editor"]').getAttribute('data-block-id'))
    .not.toBe(emptyBlockId)
  await expect.poll(() => rows.count()).toBe(seeded + 2)

  // Durable: text committed into the block the click created outlives a view
  // round-trip (Enter commits it; Escape would discard it).
  await editor.pressSequentially('bun kit', { delay: 10 })
  await page.keyboard.press('Enter')
  const committed = page.locator('[data-testid="block-static"]', { hasText: 'bun kit' })
  await expect(committed).toBeVisible()
  await navigateToView(page, 'Pages')
  await navigateToView(page, 'Journal')
  await expect(committed).toBeVisible()
})

const iPhone13 = devices['iPhone 13']

test.describe('on touch @editor @journal @mobile', () => {
  test.use({
    viewport: iPhone13.viewport,
    userAgent: iPhone13.userAgent,
    isMobile: true,
    hasTouch: true,
  })

  // A tap's blur runs before its click, not held as a mouse press's is; the
  // button keeps the empty block focused through the tap.
  test('a tap on Add block while an empty block is being edited adds a block, which takes the editor', async ({
    page,
  }) => {
    await waitForBoot(page)
    const addBlock = page.getByRole('button', { name: /add block/i }).first()
    const editor = page.getByRole('textbox', { name: 'Block editor' })
    const editorRow = page.locator('[data-testid="block-editor"]')

    await addBlock.tap()
    await expect(editor).toBeVisible()
    await editor.pressSequentially('zap of ink', { delay: 10 })
    await page.keyboard.press('Enter')
    await expect(
      page.locator('[data-testid="block-static"]', { hasText: 'zap of ink' }),
    ).toBeVisible()
    await expect(editor).toBeVisible()
    const emptyBlockId = await editorRow.getAttribute('data-block-id')
    if (emptyBlockId === null) throw new Error('the empty block has no id')

    await addBlock.tap()

    await expect(editorRow).toHaveCount(1)
    await expect(editorRow).not.toHaveAttribute('data-block-id', emptyBlockId)
    await editor.pressSequentially('bun kit', { delay: 10 })
    await page.keyboard.press('Enter')
    const committed = page.locator('[data-testid="block-static"]', { hasText: 'bun kit' })
    await expect(committed).toBeVisible()
    await navigateToView(page, 'Pages')
    await navigateToView(page, 'Journal')
    await expect(committed).toBeVisible()
  })
})
