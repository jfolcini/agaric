/**
 * E2E — a tap in the journal week view on a phone, while another day's editor
 * is in a code block (#6053). Each day mounts its own tree, and a code block is
 * shorter in the editor than rendered static: a tap whose compat mousedown blurs
 * that editor before the click moves the rows below it, and the tap lands on
 * another row. The same-day case is `mobile-editor.spec.ts`'s.
 */

import { devices } from '@playwright/test'

import { blurEditors, expect, ipc, test, waitForBoot } from './helpers'

const iPhone13 = devices['iPhone 13']
// Seed: today's journal page.
const TODAY_PAGE = '00000000000000000000PAGE03'
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }

test.describe('Week view on a phone @journal @editor @mobile', () => {
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test('a tap on the next day’s block while a code block is edited moves the editor there', async ({
    page,
  }) => {
    // A Wednesday, so the next day is in the same week whichever day it starts on.
    await page.clock.setFixedTime(new Date('2026-10-21T10:00:00'))
    // Mount every day's tree at once instead of on scroll (DaySection).
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
    const code = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content: '```js\nconst a = 1\nconst b = 2\nconst c = 3\nconst d = 4\n```',
      parentId: TODAY_PAGE,
      index: null,
      scope: SCOPE,
    })
    await page.getByRole('button', { name: /^Journal view mode/ }).tap()
    await page.locator('[data-slot="popover-content"]').getByRole('button', { name: /^Week/ }).tap()

    const nextDay = page.locator('section[id="journal-2026-10-22"]')
    await nextDay.scrollIntoViewIfNeeded()
    await nextDay.getByRole('button', { name: 'Add block' }).tap()
    const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
    await expect(editor).toBeFocused()
    await page.keyboard.type('Next one')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Next two')
    await blurEditors(page)
    const nextRows = nextDay.locator('[data-testid="block-static"]')
    await expect(nextRows).toHaveCount(2)
    const targetId = (await nextRows.nth(1).getAttribute('data-block-id')) as string
    const staticOf = (id: string) =>
      page.locator(`[data-testid="block-static"][data-block-id="${id}"]`)

    const codeSlot = page.locator(`li[data-block-id="${code.id}"]`)
    await codeSlot.scrollIntoViewIfNeeded()
    await staticOf(code.id).tap({ position: { x: 4, y: 4 } })
    await expect(page.locator('[data-testid="block-editor"] pre')).toBeVisible()
    await expect(editor).toBeFocused()
    await page.keyboard.type('edited ')
    // The code block on screen above the target, so its height change moves it.
    await codeSlot.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await expect(staticOf(targetId)).toBeInViewport()
    await staticOf(targetId).tap({ position: { x: 4, y: 4 } })

    await expect
      .poll(() =>
        page.locator('[data-testid="block-editor"]').first().getAttribute('data-block-id'),
      )
      .toBe(targetId)
    // The code block's edit was saved as the editor left it.
    await expect
      .poll(
        async () =>
          (await ipc<{ content: string }>(page, 'get_block', { blockId: code.id })).content,
      )
      .toContain('edited ')
  })
})
