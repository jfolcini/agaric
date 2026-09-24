import { expect, navigateToView, test, waitForBoot } from './helpers'

/**
 * "Add block" clicked while the roving editor sits on a fresh empty block.
 *
 * The real-backend lane hit this in `e2e-tauri/search-bm25-order.e2e.ts`: Enter
 * creates a sibling, Escape arrives before that create resolves (so it acts on
 * the previous block), the new empty block is focused once the round trip
 * lands, and the next "Add block" click blurs its editor. The blur swapped the
 * editor row for the shorter static row, the button moved up under the pointer,
 * mouseup landed off it and `onClick` never ran: no new block, and the empty
 * one was dropped by the blur cleanup. The mock answers synchronously, so the
 * IPC latency that opens that window is injected here, test-side (the Enter's
 * create is held until Escape has landed), and the click is driven as
 * mousedown / mouseup with a human-sized gap.
 */

const IPC_LATENCY_MS = 120

type LatencyWindow = Window & {
  __TAURI_INTERNALS__?: Record<string, unknown>
  /** The next `create_block` answer waits for `__releaseCreate`. */
  __holdCreate?: boolean
  __releaseCreate?: () => void
}

// Tall enough that the seeded day plus two new rows never scroll: with the page
// at its scroll limit, the shrinking row would pull the document up under the
// pointer and hide the shift this spec is about.
test.use({ viewport: { width: 1280, height: 1024 } })

test('adds a block when the button is clicked while an empty block is being edited', async ({
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
      if (cmd === 'create_block' && w.__holdCreate) {
        w.__holdCreate = false
        await new Promise<void>((resolve) => {
          w.__releaseCreate = resolve
        })
      } else if (slow.has(cmd)) {
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
  await page.evaluate(() => {
    ;(window as LatencyWindow).__holdCreate = true
  })
  await page.keyboard.press('Enter')
  // Escape lands while the Enter-created sibling's create is still unanswered.
  await page.waitForFunction(() => (window as LatencyWindow).__releaseCreate !== undefined)
  await page.keyboard.press('Escape')
  await expect(
    page.locator('[data-testid="block-static"]', { hasText: 'zap of ink' }),
  ).toBeVisible()
  // The create resolves and focuses the new empty block: the window.
  await page.evaluate(() => (window as LatencyWindow).__releaseCreate?.())
  await expect(editor).toBeVisible()
  const emptyBlockId = await page
    .locator('[data-testid="block-editor"]')
    .getAttribute('data-block-id')

  const box = await addBlock.boundingBox()
  if (!box) throw new Error('Add block button has no box')
  expect(box.y + box.height).toBeLessThan(1024)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
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
