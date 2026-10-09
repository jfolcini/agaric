import type { Page } from '@playwright/test'

import { expect, getInvokeCalls, installIpcRecorder, openPage, test, waitForBoot } from './helpers'

/**
 * #5443 — the rows in view fetch their properties, attachments and link
 * targets once. The three fetches used to drop an answer that arrived after the
 * visible set had moved on and ask for the same rows again on every scroll
 * step. The mock answers in a microtask, which hides that race; real IPC is
 * async and out of process, so the three commands are answered a task later
 * here, as in `perf.spec.ts`.
 */

const ROWS = 300
const TITLE = 'Scroll IPC page'
const ROW_FETCHES = ['get_batch_properties', 'list_attachments_batch', 'batch_resolve'] as const

/** A 300-row page whose rows each reference a block nothing else has resolved yet. */
async function seedPage(page: Page): Promise<void> {
  await page.evaluate(
    async ({ rows, title }) => {
      const internals = (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] as {
        invoke: (cmd: string, args: unknown) => Promise<unknown>
      }
      const invoke = internals.invoke
      const targetsPage = await invoke('create_page_in_space', {
        parentId: null,
        content: `${title} targets`,
        spaceId: 'SPACE_PERSONAL',
      })
      const targets = (await invoke('create_blocks_batch', {
        specs: Array.from({ length: rows }, (_, i) => ({
          blockType: 'content',
          content: `target ${i}`,
          parentId: targetsPage,
          position: null,
        })),
      })) as { blocks: Array<{ id: string }> }
      const big = await invoke('create_page_in_space', {
        parentId: null,
        content: title,
        spaceId: 'SPACE_PERSONAL',
      })
      await invoke('create_blocks_batch', {
        specs: targets.blocks.map((t, i) => ({
          blockType: 'content',
          content: `row ${i} lorem ipsum dolor sit amet ((${t.id}))`,
          parentId: big,
          position: null,
        })),
      })
    },
    { rows: ROWS, title: TITLE },
  )
}

/** Answer the row fetches a task later, the way an out-of-process backend does. */
async function deferRowFetches(page: Page): Promise<void> {
  await page.evaluate((cmds) => {
    const internals = (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] as
      | Record<string, unknown>
      | undefined
    if (!internals) throw new Error('no __TAURI_INTERNALS__ to defer')
    const original = internals['invoke'] as (cmd: string, args: unknown, opts?: unknown) => unknown
    const deferred = new Set<string>(cmds)
    internals['invoke'] = async (cmd: string, args: unknown, opts?: unknown) => {
      if (deferred.has(cmd)) await new Promise((resolve) => setTimeout(resolve, 0))
      return original(cmd, args, opts)
    }
  }, ROW_FETCHES)
}

async function rowFetchCounts(page: Page): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const cmd of ROW_FETCHES) counts[cmd] = (await getInvokeCalls(page, cmd)).length
  return counts
}

/** Wait until no row fetch has been issued for a while. */
async function settle(page: Page): Promise<Record<string, number>> {
  let last = ''
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await rowFetchCounts(page))
        const stable = now === last
        last = now
        return stable
      },
      { intervals: [300] },
    )
    .toBe(true)
  return rowFetchCounts(page)
}

// Measured: before #5443 opening sent two of each (all 300 rows, then the
// first screen again) and the scroll brought each to 25-27; after, opening
// sends one of each and the scroll none. Headroom over that one.
const SCROLLED_MAX = 3

test('opening and scrolling a 300-row page fetches its rows once (#5443)', async ({ page }) => {
  await waitForBoot(page)
  await seedPage(page)
  await deferRowFetches(page)
  await installIpcRecorder(page)

  await openPage(page, TITLE)
  const blocks = page.locator('[data-testid="block-static"]')
  await blocks.nth(10).waitFor()
  expect(await settle(page)).toEqual(Object.fromEntries(ROW_FETCHES.map((cmd) => [cmd, 1])))

  // The row's left edge holds its text, never the trailing `((ref))` chip,
  // whose hover peek sends a `batch_resolve` of its own.
  await blocks.nth(5).hover({ position: { x: 4, y: 4 } })
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 1200)
    await page.waitForTimeout(50)
  }
  await expect(page.getByText(`row ${ROWS - 1} lorem`)).toBeInViewport()
  const scrolled = await settle(page)
  for (const cmd of ROW_FETCHES) expect(scrolled[cmd], cmd).toBeLessThanOrEqual(SCROLLED_MAX)
})
