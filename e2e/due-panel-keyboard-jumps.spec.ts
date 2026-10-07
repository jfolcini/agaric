import type { Page } from '@playwright/test'

import { expect, navigateToView, test, waitForBoot } from './helpers'

/**
 * #5302: the Due panel virtualises its rows, so Home/End/PageUp/PageDown move
 * the cursor to a row that is not mounted yet. Focus has to survive the jump
 * and land on the cursor row, or the ring disappears and the next key goes
 * nowhere. Only a real browser lays the list out, so only here does the
 * virtual window actually exclude the jump target.
 */

const PAGE_PROJECTS = '00000000000000000000PAGE04'
const TASKS = 45
const LAST_TASK = `long task ${TASKS - 1}`

async function seedTasksDueToday(page: Page): Promise<void> {
  await page.evaluate(
    async ({ count, parentId }) => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke
      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
      for (let i = 0; i < count; i++) {
        const block = (await invoke('create_block', {
          blockType: 'content',
          content: `long task ${String(i).padStart(2, '0')}`,
          parentId,
          index: null,
          scope: { kind: 'global' },
          blockId: null,
        })) as { id: string }
        await invoke('set_todo_state', { blockId: block.id, state: 'TODO' })
        await invoke('set_due_date', { blockId: block.id, date: today })
      }
    },
    { count: TASKS, parentId: PAGE_PROJECTS },
  )
  // Leave and re-enter the journal so the Due panel refetches the seeded tasks.
  await navigateToView(page, 'Pages')
  await navigateToView(page, 'Journal')
}

test.describe('Due panel keyboard jumps (#5302)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await seedTasksDueToday(page)
  })

  test('End, Home and PageDown keep DOM focus on the cursor row', async ({ page }) => {
    const rows = page.getByTestId('due-panel-item')
    const focusedRow = page.locator('[data-testid="due-panel-item"]:focus')
    await expect(rows.first()).toBeVisible()
    // The jump target must start outside the mounted window, or nothing is tested.
    await expect(rows.filter({ hasText: LAST_TASK })).toHaveCount(0)

    await rows.first().focus()
    const firstRowText = (await rows.first().textContent()) ?? ''

    await page.keyboard.press('End')
    await expect(focusedRow).toContainText(LAST_TASK)
    await expect(focusedRow).toHaveClass(/list-cursor/)

    await page.keyboard.press('Home')
    await expect(focusedRow).toHaveText(firstRowText)
    await expect(focusedRow).toHaveClass(/list-cursor/)

    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('PageDown')
      await expect(focusedRow).toHaveClass(/list-cursor/)
    }

    // The next key still reaches the list.
    const beforeArrow = (await focusedRow.textContent()) ?? ''
    await page.keyboard.press('ArrowDown')
    await expect(focusedRow).toHaveClass(/list-cursor/)
    await expect(focusedRow).not.toHaveText(beforeArrow)
  })
})
