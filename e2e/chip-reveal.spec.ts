/**
 * #5974 — "Show Markdown syntax around the cursor" beside chips: with the
 * caret at (or a selection on) a page link, tag or block-ref chip, the chip's
 * syntax (`[[` `]]`, `#`, `((` `))`) is drawn beside it, in blocks and in page
 * mode. It is read-only: the chip stays one atom, Backspace takes it whole,
 * and the saved block never holds the syntax.
 */

import { createRequire } from 'node:module'

import { devices, type Page } from '@playwright/test'

import {
  expect,
  ipc,
  navigateToView,
  openPageMobile,
  openSettingsTab,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

const axePath = createRequire(import.meta.url).resolve('axe-core')
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const TITLE = 'Chip reveal'
const BLOCK_EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const PAGE_EDITOR = '[data-testid="page-mode-editor"]'
const SHOTS = process.env['CHIP_REVEAL_SHOTS']

interface Ids {
  target: string
  tag: string
  ref: string
}

async function setReveal(page: Page, on: boolean): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Editor')
  const toggle = page.getByRole('switch', { name: 'Show Markdown syntax around the cursor' })
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(on))
}

/** A page whose one block holds a page link, a tag and a block ref; resolves their targets' ids. */
async function seed(page: Page): Promise<Ids> {
  const target = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: 'Target page',
    spaceId: SCOPE.space_id,
  })
  const tag = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'tag',
    content: 'errand',
    parentId: null,
    index: null,
    scope: SCOPE,
    blockId: null,
  })
  const { blocks } = await ipc<{ blocks: Array<{ id: string }> }>(page, 'create_blocks_batch', {
    specs: [
      { blockType: 'content', content: 'Referenced block', parentId: target, position: null },
    ],
  })
  const ref = blocks[0]?.id ?? ''
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: TITLE,
    spaceId: SCOPE.space_id,
  })
  await ipc(page, 'create_blocks_batch', {
    specs: [
      {
        blockType: 'content',
        content: `see [[${target}]] and #[${tag.id}] and ((${ref})) end`,
        parentId: pageId,
        position: null,
      },
    ],
  })
  return { target, tag: tag.id, ref }
}

async function openBlockMode(page: Page, isMobile: boolean): Promise<void> {
  if (isMobile) await openPageMobile(page, TITLE)
  else {
    await page.keyboard.press('Control+k')
    await page.locator('[cmdk-input]').first().fill(TITLE)
    await page.locator('[cmdk-item]').filter({ hasText: TITLE }).first().waitFor()
    await page.keyboard.press('Enter')
  }
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(TITLE)
  const block = page.getByTestId('block-static').first()
  await expect(block.getByTestId('block-ref-chip')).toBeVisible()
  await block.click({ position: { x: 4, y: 8 } })
  await expect(page.locator(BLOCK_EDITOR).getByTestId('block-ref-chip')).toBeVisible()
}

async function openPageMode(page: Page): Promise<void> {
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(TITLE)
  await page.locator('[cmdk-item]').filter({ hasText: TITLE }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(TITLE)
  await page
    .getByRole('radiogroup', { name: 'Editing mode' })
    .getByRole('radio', { name: 'Page' })
    .click()
  await expect(page.locator(`${PAGE_EDITOR} [data-page-block]`)).toHaveCount(1)
}

/** Put the caret (or a selection of the chip) at the `n`-th chip of `type`, `where` it: before, after or on it. */
async function at(
  page: Page,
  editor: string,
  type: string,
  where: 'before' | 'after' | 'on',
): Promise<void> {
  await page.locator(editor).evaluate(
    (el, [t, w]) => {
      interface Ed {
        state: {
          doc: {
            descendants: (
              f: (n: { type: { name: string }; nodeSize: number }, p: number) => boolean,
            ) => void
          }
        }
        commands: {
          setTextSelection: (p: number) => boolean
          setNodeSelection: (p: number) => boolean
        }
        view: { focus: () => void }
      }
      const ed = (el as HTMLElement & { editor: Ed }).editor
      let found: { pos: number; size: number } | null = null
      ed.state.doc.descendants((n, p) => {
        if (!found && n.type.name === t) found = { pos: p, size: n.nodeSize }
        return !found
      })
      const hit = found as { pos: number; size: number } | null
      if (!hit) throw new Error(`no ${t}`)
      ed.view.focus()
      if (w === 'on') ed.commands.setNodeSelection(hit.pos)
      else ed.commands.setTextSelection(w === 'before' ? hit.pos : hit.pos + hit.size)
      return new Promise((resolve) => setTimeout(resolve, 20))
    },
    [type, where] as const,
  )
}

function syntax(page: Page): Promise<string[]> {
  return page
    .getByTestId('md-reveal-chip-marker')
    .evaluateAll((els) => els.map((el) => el.textContent ?? ''))
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

const CHIPS = [
  { type: 'block_link', chip: 'block-link-chip', expected: ['[[', ']]'] },
  { type: 'tag_ref', chip: 'tag-ref-chip', expected: ['#'] },
  { type: 'block_ref', chip: 'block-ref-chip', expected: ['((', '))'] },
] as const

async function axeViolations(page: Page, scope: string): Promise<string[]> {
  await page.addScriptTag({ path: axePath })
  return page.evaluate(async (s) => {
    // @ts-expect-error injected global
    const results = await window.axe.run(document.querySelector(s))
    return results.violations.map((v: { id: string }) => v.id)
  }, scope)
}

test.describe('Markdown syntax around chips in blocks (#5974) @editor @markdown @mobile', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test.beforeEach(async ({ page, isMobile }) => {
    await waitForBoot(page)
    await setReveal(page, true)
    await seed(page)
    await openBlockMode(page, isMobile)
  })

  test('draws a chip’s syntax when the caret is beside it or it is selected, and none elsewhere', async ({
    page,
  }) => {
    const editor = page.locator(BLOCK_EDITOR)
    expect(await syntax(page)).toEqual([])
    for (const { type, chip, expected } of CHIPS) {
      for (const where of ['before', 'after', 'on'] as const) {
        await at(page, BLOCK_EDITOR, type, where)
        expect(await syntax(page)).toEqual(expected)
        await expect(editor.getByTestId(chip)).toHaveCount(1)
      }
      await shot(page, `block-${type}`)
    }
    await at(page, BLOCK_EDITOR, 'block_link', 'before')
    await page.keyboard.press('Home')
    await expect.poll(() => syntax(page)).toEqual([])
    expect(await axeViolations(page, '[data-testid="block-editor"]')).toEqual([])
  })

  test('draws the syntax beside the chip, aria-hidden, without moving the chip off its line', async ({
    page,
  }) => {
    const chip = page.locator(BLOCK_EDITOR).getByTestId('block-link-chip')
    await at(page, BLOCK_EDITOR, 'tag_ref', 'before')
    const before = await chip.boundingBox()
    await at(page, BLOCK_EDITOR, 'block_link', 'before')
    const marks = page.getByTestId('md-reveal-chip-marker')
    await expect(marks).toHaveText(['[[', ']]'])
    await expect(marks.first()).toHaveAttribute('aria-hidden', 'true')
    const open = await marks.first().boundingBox()
    const close = await marks.last().boundingBox()
    const after = await chip.boundingBox()
    // `[[` sits left of the label and `]]` right of it, on the label's line.
    expect(open && after && open.x + open.width <= after.x + 1).toBe(true)
    expect(close && after && close.x >= after.x + after.width - 1).toBe(true)
    expect(Math.abs((open?.y ?? 0) - (after?.y ?? 0))).toBeLessThan(8)
    expect(before && after && Math.abs(before.y - after.y)).toBeLessThan(2)
  })

  test('Backspace after a chip takes it whole, the syntax is never saved, and it comes back as the chip’s own', async ({
    page,
  }) => {
    const editor = page.locator(BLOCK_EDITOR)
    await at(page, BLOCK_EDITOR, 'block_link', 'after')
    expect(await syntax(page)).toEqual(['[[', ']]'])
    await page.keyboard.press('Backspace')
    await expect(editor.getByTestId('block-link-chip')).toHaveCount(0)
    await expect(editor.getByTestId('tag-ref-chip')).toHaveCount(1)
    expect(await syntax(page)).toEqual([])
    await page.keyboard.press('Escape')
    const stored = page.getByTestId('block-static').first()
    await expect(stored.getByTestId('block-link-chip')).toHaveCount(0)
    await reopenPage(page, TITLE)
    await expect(page.getByTestId('block-static').first()).not.toContainText('[[')
    await expect(page.getByTestId('block-static').first().getByTestId('tag-ref-chip')).toHaveCount(
      1,
    )
  })

  test('with the setting off, no chip syntax is drawn', async ({ page, isMobile }) => {
    await setReveal(page, false)
    await openBlockMode(page, isMobile)
    await at(page, BLOCK_EDITOR, 'block_link', 'on')
    expect(await syntax(page)).toEqual([])
  })
})

test.describe('Markdown syntax around chips on a phone (#5974) @editor @markdown @mobile', () => {
  const phone = devices['Pixel 7']
  test.use({
    viewport: { width: 360, height: 780 },
    userAgent: phone.userAgent,
    isMobile: phone.isMobile,
    hasTouch: phone.hasTouch,
    deviceScaleFactor: phone.deviceScaleFactor,
  })

  test('draws the syntax of each chip without overflowing the line', async ({ page }) => {
    await waitForBoot(page)
    await setReveal(page, true)
    await seed(page)
    await openBlockMode(page, true)
    for (const { type, expected } of CHIPS) {
      await at(page, BLOCK_EDITOR, type, 'on')
      expect(await syntax(page)).toEqual(expected)
      await shot(page, `phone-${type}`)
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })
})

test.describe('Markdown syntax around chips in page mode (#5974) @editor @markdown @pages', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await setReveal(page, true)
    await seed(page)
    await openPageMode(page)
  })

  test('draws a chip’s syntax around the caret and a selected chip, and none elsewhere', async ({
    page,
  }) => {
    expect(await syntax(page)).toEqual([])
    for (const { type, expected } of CHIPS) {
      for (const where of ['before', 'after', 'on'] as const) {
        await at(page, PAGE_EDITOR, type, where)
        expect(await syntax(page)).toEqual(expected)
      }
      await shot(page, `page-${type}`)
    }
    expect(await axeViolations(page, '.page-editor')).toEqual([])
  })

  test('Backspace after a chip takes it whole, and what is saved never holds the syntax', async ({
    page,
  }) => {
    await at(page, PAGE_EDITOR, 'tag_ref', 'after')
    expect(await syntax(page)).toEqual(['#'])
    await page.keyboard.press('Backspace')
    await expect(page.locator(PAGE_EDITOR).getByTestId('tag-ref-chip')).toHaveCount(0)
    await expect(page.locator(PAGE_EDITOR).getByTestId('block-link-chip')).toHaveCount(1)
    expect(await syntax(page)).toEqual([])
    await reopenPage(page, TITLE)
    await expect(page.getByTestId('block-static').first()).not.toContainText('#')
    await expect(
      page.getByTestId('block-static').first().getByTestId('block-link-chip'),
    ).toHaveCount(1)
  })
})
