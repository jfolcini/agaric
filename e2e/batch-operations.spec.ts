import { devices, type Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  expect,
  ipc,
  openPage,
  openPageMobile,
  selectedCheckboxes,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E tests for batch block operations.
 *
 * Tests multi-select via Ctrl+Click, batch toolbar visibility,
 * bulk TODO state changes, and Ctrl+A select-all functionality.
 *
 * Seed data (`src/lib/tauri-mock/seed.ts`):
 *   PAGE_GETTING_STARTED ("Getting Started") -- 5 child blocks:
 *     GS_1: "Welcome to Agaric! This is your personal knowledge base."
 *     GS_2: contains [[PAGE_QUICK_NOTES]] link
 *     GS_3: "Create new blocks by pressing Enter at the end of any block."
 *     GS_4: contains #[TAG_WORK] and #[TAG_PERSONAL] tag refs
 *     GS_5: contains **bold** text
 *
 * Selection mechanics:
 *   - Ctrl+Click on a static block toggles it in/out of selection
 *   - A selected block shows its checked selection checkbox
 *   - Batch toolbar (`.batch-toolbar`) appears from two selected blocks (#6547)
 *   - Ctrl+A selects all blocks (only when no block is focused/editing)
 */

test.describe('Batch block operations @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    // Verify seed blocks are loaded
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  // =========================================================================
  // 1. Multi-select blocks via Ctrl+Click
  // =========================================================================

  test('multi-select blocks via Ctrl+Click shows selection indicator on both blocks', async ({
    page,
  }) => {
    const blocks = page.locator('[data-testid="sortable-block"]')
    const firstStatic = blocks.nth(0).locator('[data-testid="block-static"]')
    const firstSelected = selectedCheckboxes(blocks.nth(0))
    const secondStatic = blocks.nth(1).locator('[data-testid="block-static"]')
    const secondSelected = selectedCheckboxes(blocks.nth(1))

    // Initially, no block is selected
    await expect(firstSelected).toHaveCount(0)
    await expect(secondSelected).toHaveCount(0)

    // Ctrl+Click first block to toggle it into selection. Click a stable
    // non-interactive corner (the block's padding) rather than the element
    // center — seed blocks render inline links/tag chips whose horizontal
    // position shifts with font metrics, so a center click can land on an
    // inner `<a>`/chip (which swallows the selection toggle) on some platforms.
    await firstStatic.click({ modifiers: ['Control'], position: { x: 6, y: 6 } })
    await expect(firstSelected).toHaveCount(1)

    // Ctrl+Click second block to add it to selection
    await secondStatic.click({ modifiers: ['Control'], position: { x: 6, y: 6 } })
    await expect(firstSelected).toHaveCount(1)
    await expect(secondSelected).toHaveCount(1)
  })

  // =========================================================================
  // 2. Batch toolbar appears with selection count
  // =========================================================================

  test('batch toolbar appears with correct selection count after multi-select', async ({
    page,
  }) => {
    const blocks = page.locator('[data-testid="sortable-block"]')
    const batchToolbar = page.getByTestId('batch-toolbar')

    // No batch toolbar initially
    await expect(batchToolbar).not.toBeVisible()

    // Ctrl+Click first block
    await blocks
      .nth(0)
      .locator('[data-testid="block-static"]')
      .click({ modifiers: ['Control'], position: { x: 6, y: 6 } })

    // One selected block brings no toolbar (#6547)
    await expect(selectedCheckboxes(blocks.nth(0))).toHaveCount(1)
    await expect(batchToolbar).toHaveCount(0)

    // Ctrl+Click second block — the toolbar appears with count 2
    await blocks
      .nth(1)
      .locator('[data-testid="block-static"]')
      .click({ modifiers: ['Control'], position: { x: 6, y: 6 } })
    await expect(batchToolbar).toContainText('2')
    await expect(batchToolbar).toContainText('selected')
  })

  // =========================================================================
  // 3. Bulk TODO state change via batch toolbar
  // =========================================================================

  test('bulk TODO state change sets TODO on all selected blocks', async ({ page }) => {
    const blocks = page.locator('[data-testid="sortable-block"]')
    const batchToolbar = page.getByTestId('batch-toolbar')

    // Select two blocks via Ctrl+Click
    await blocks
      .nth(0)
      .locator('[data-testid="block-static"]')
      .click({ modifiers: ['Control'], position: { x: 6, y: 6 } })
    await blocks
      .nth(1)
      .locator('[data-testid="block-static"]')
      .click({ modifiers: ['Control'], position: { x: 6, y: 6 } })
    await expect(batchToolbar).toBeVisible()

    // Click TODO button in the batch toolbar
    await batchToolbar.getByRole('button', { name: 'TODO' }).click()

    // Both blocks should now show the TODO checkbox indicator
    await expect(blocks.nth(0).locator('[data-testid="task-checkbox-todo"]')).toBeVisible()
    await expect(blocks.nth(1).locator('[data-testid="task-checkbox-todo"]')).toBeVisible()

    // Selection should be cleared after batch operation (toolbar disappears)
    await expect(batchToolbar).not.toBeVisible()
  })

  // =========================================================================
  // 4. Ctrl+A selects all blocks
  // =========================================================================

  test('Ctrl+A selects all blocks when no block is focused', async ({ page }) => {
    const blocks = page.locator('[data-testid="sortable-block"]')
    const blockCount = await blocks.count()
    expect(blockCount).toBe(5)

    const batchToolbar = page.getByTestId('batch-toolbar')

    // No toolbar initially
    await expect(batchToolbar).not.toBeVisible()

    // Press Ctrl+A — should select all blocks (no block is in edit mode)
    await page.keyboard.press('Control+a')

    // Batch toolbar appears with total count
    await expect(batchToolbar).toBeVisible()
    await expect(batchToolbar).toContainText(`${blockCount}`)
    await expect(batchToolbar).toContainText('selected')

    // Every block shows its checked selection checkbox
    for (let i = 0; i < blockCount; i++) {
      await expect(selectedCheckboxes(blocks.nth(i))).toHaveCount(1)
    }
  })

  // =========================================================================
  // 5. How a selection looks (#7040 O4)
  // =========================================================================

  async function selectSecondAndThird(page: Page): Promise<void> {
    const blocks = page.locator('[data-testid="sortable-block"]')
    for (const n of [1, 2]) {
      await blocks
        .nth(n)
        .locator('[data-testid="block-static"]')
        .click({ modifiers: ['Control'], position: { x: 6, y: 6 } })
    }
    await expect(page.getByTestId('batch-toolbar')).toBeVisible()
  }

  test('selection checkboxes are the app Checkbox', async ({ page }) => {
    await selectSecondAndThird(page)
    // A selection gives every row its checkbox.
    const boxes = page.getByTestId('block-select-checkbox')
    await expect(boxes).toHaveCount(5)
    for (const box of await boxes.all()) await expect(box).toHaveAttribute('data-slot', 'checkbox')
  })

  test('a selected row puts its grip left of its checkbox and moves no text', async ({ page }) => {
    const row = page.locator('[data-testid="sortable-block"]').nth(1)
    const rect = (testId: string) =>
      row.getByTestId(testId).evaluate((el) => el.getBoundingClientRect())
    const restingHandle = await rect('drag-handle')
    const restingText = await rect('block-static')

    await selectSecondAndThird(page)
    const handle = await rect('drag-handle')
    const checkbox = await rect('block-select-checkbox')
    const text = await rect('block-static')

    expect(text.left).toBe(restingText.left)
    expect(handle.right).toBeLessThanOrEqual(checkbox.left)
    expect(checkbox.right).toBeLessThanOrEqual(text.left)
    // At rest the grip sits beside the text, in the slot the checkbox takes.
    expect(restingHandle.right).toBeCloseTo(checkbox.right, 0)
  })

  test("the cursor's focus ring wraps the block's row, not the gutter", async ({ page }) => {
    await selectSecondAndThird(page)
    // The last Ctrl+Click leaves the cursor on its row.
    const cursor = page.locator('li[data-block-id]:focus')
    await expect(cursor).toHaveCount(1)
    const { ringLefts, handleRight } = await cursor.evaluate((li) => {
      const ringed = [li, ...li.querySelectorAll('*')].filter((el) =>
        /0px 0px 0px 3px/.test(getComputedStyle(el).boxShadow),
      )
      const handle = li.querySelector('[data-testid="drag-handle"]') as HTMLElement
      return {
        ringLefts: ringed.map((el) => el.getBoundingClientRect().left),
        handleRight: handle.getBoundingClientRect().right,
      }
    })
    expect(ringLefts).toHaveLength(1)
    expect(ringLefts[0]).toBeGreaterThanOrEqual(handleRight)
  })
})

// =========================================================================
// 6. A selected block is marked by its checkbox alone (#7165 U7)
// =========================================================================

const SHAPES_TITLE = 'Selection shapes'
const SHAPES = ['# A heading', 'A paragraph', 'A task with chips', 'The cursor row'] as const

/** A page of a heading, a paragraph and a task with priority and date chips, then a plain row. */
async function openShapesPage(page: Page, phone: boolean): Promise<void> {
  const scope = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: SHAPES_TITLE,
    spaceId: SEED_IDS.SPACE_PERSONAL,
  })
  for (const content of SHAPES) {
    const row = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: pageId,
      index: null,
      scope,
    })
    if (content === 'A task with chips') {
      await ipc(page, 'set_todo_state', { blockId: row.id, state: 'TODO' })
      await ipc(page, 'set_priority', { blockId: row.id, level: '1' })
      await ipc(page, 'set_due_date', { blockId: row.id, date: '2026-12-01' })
    }
  }
  if (phone) await openPageMobile(page, SHAPES_TITLE)
  else await openPage(page, SHAPES_TITLE)
  await expect(page.getByTestId('sortable-block')).toHaveCount(SHAPES.length)
}

/**
 * Select every shape; the last Ctrl+Click leaves the keyboard cursor's ring on
 * the plain row, so the shapes above it show the selection alone. Each draws no
 * ring, shadow or tint, and its checked checkbox centres on its first line.
 */
async function expectCheckboxOnlySelection(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const rows = page.getByTestId('sortable-block')
  for (const row of await rows.all()) {
    const text = row.getByTestId('block-static')
    const box = await text.boundingBox()
    expect(box).not.toBeNull()
    // The row's right end: the left edge holds a nested row's chevron and the text links.
    await text.click({ modifiers: ['Control'], position: { x: (box?.width ?? 0) - 4, y: 4 } })
  }
  await expect(selectedCheckboxes(page)).toHaveCount(SHAPES.length)

  for (const index of [0, 1, 2]) {
    const row = rows.nth(index)
    await expect(row.getByTestId('block-select-checkbox')).toBeChecked()
    const look = await row.evaluate((li) => {
      const frame = li.querySelector('[data-testid="block-frame"]') as HTMLElement
      const painted = [li, li.querySelector('[data-testid="swipe-content"]'), frame].map((el) => {
        const style = getComputedStyle(el as Element)
        return {
          background: style.backgroundColor,
          // Tailwind's unused ring and shadow slots compute as transparent zero layers.
          shadow: style.boxShadow.replaceAll(/rgba\(0, 0, 0, 0\) 0px 0px 0px 0px(, )?/g, ''),
        }
      })
      const checkbox = li.querySelector('[data-testid="block-select-checkbox"]') as HTMLElement
      const walker = document.createTreeWalker(
        li.querySelector('[data-testid="block-static"]') as HTMLElement,
        NodeFilter.SHOW_TEXT,
      )
      let first = walker.nextNode()
      while (first && !first.textContent?.trim()) first = walker.nextNode()
      const glyph = document.createRange()
      glyph.setStart(first as Node, 0)
      glyph.setEnd(first as Node, 1)
      const line = glyph.getBoundingClientRect()
      const mark = checkbox.getBoundingClientRect()
      return {
        painted,
        checkboxMiddle: mark.top + mark.height / 2,
        lineMiddle: line.top + line.height / 2,
      }
    })
    for (const layer of look.painted) {
      expect(layer.background, SHAPES[index]).toBe('rgba(0, 0, 0, 0)')
      expect(['', 'none'], SHAPES[index]).toContain(layer.shadow)
    }
    expect(Math.abs(look.checkboxMiddle - look.lineMiddle), SHAPES[index]).toBeLessThanOrEqual(2)
  }
}

test.describe('A selected block shows its checkbox alone @editor', () => {
  test('desktop: no wrap, the checkbox on the first line', async ({ page }) => {
    await waitForBoot(page)
    await openShapesPage(page, false)
    await expectCheckboxOnlySelection(page)
  })
})

const pixel = devices['Pixel 7']

test.describe('A selected block shows its checkbox alone on a phone @editor @mobile', () => {
  test.use({
    viewport: pixel.viewport,
    hasTouch: pixel.hasTouch,
    isMobile: pixel.isMobile,
    deviceScaleFactor: pixel.deviceScaleFactor,
    userAgent: pixel.userAgent,
  })

  test('phone: no wrap, the checkbox on the first line', async ({ page }) => {
    await waitForBoot(page)
    await openShapesPage(page, true)
    await expectCheckboxOnlySelection(page)
  })
})
