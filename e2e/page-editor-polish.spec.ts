/**
 * E2E — the page editor's four inconsistencies (#7040 P4), in blocks and in
 * page mode. The Properties header reads like every other section header: its
 * label, then its count in the muted count tone.
 * A callout is a tinted card with its style's icon, and a quote keeps its plain
 * left bar.
 * A table takes the code block's corners, with lighter inner rules than its
 * frame.
 * The linked references' controls (link kind, source page, Add filter, sort
 * field and direction) are one height, and each is a 44 px target on a phone.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import { SEED_IDS } from '@/lib/tauri-mock/seed'

import { expect, expect44, ipc, openPageMobile, settleBackend, test, waitForBoot } from './helpers'

const TITLE = 'Polish showcase'
const SCOPE = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }
const DESKTOP = { viewport: { width: 1440, height: 900 } }

/** A page with a property, a note callout, a quote, a table and code, linked from Quick Notes. */
async function seed(page: Page): Promise<void> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: TITLE,
    spaceId: SEED_IDS.SPACE_PERSONAL,
  })
  await ipc(page, 'set_property', {
    blockId: pageId,
    key: 'status',
    value: { value_text: 'active' },
  })
  const block = (parentId: string, content: string) =>
    ipc(page, 'create_block', {
      blockType: 'content',
      content,
      parentId,
      index: null,
      scope: SCOPE,
      blockId: null,
    })
  for (const content of [
    '> [!NOTE] Decision\n> Sheets on phones.',
    '> A plain quote.',
    '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |',
    '```ts\nconst x = 1\n```',
  ]) {
    await block(pageId, content)
  }
  await block(SEED_IDS.PAGE_QUICK_NOTES, `See [[${pageId}]]`)
  await settleBackend(page)
}

async function openShowcase(page: Page): Promise<void> {
  await waitForBoot(page)
  await seed(page)
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(TITLE)
  await page.locator('[cmdk-item]').filter({ hasText: TITLE }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(TITLE)
}

async function toPageMode(page: Page): Promise<void> {
  await page
    .getByRole('radiogroup', { name: 'Editing mode' })
    .getByRole('radio', { name: 'Page' })
    .click()
  await expect(page.getByTestId('page-mode-editor')).toBeVisible()
}

const css = (el: Locator, prop: string, pseudo?: string): Promise<string> =>
  el.evaluate((node, [p, ps]) => getComputedStyle(node, ps ?? null).getPropertyValue(p ?? ''), [
    prop,
    pseudo,
  ] as const)

/** The header names its count, which takes the count tone: muted and not bold. */
async function expectPropertiesHeader(page: Page): Promise<void> {
  const header = page.getByRole('button', { name: 'Properties 1', exact: true })
  await expect(header).toBeVisible()
  const count = header.locator('[data-slot="badge"][data-variant="metadata"]')
  await expect(count).toHaveText('1')
  expect(await css(count, 'font-weight'), 'count weight').toBe('400')
  expect(await css(count, 'color'), 'count colour').toBe(await css(header, 'color'))
}

/** How far a computed colour is from grey: the spread of its sRGB channels, 0–255. */
function tint(el: Locator, prop: string): Promise<number> {
  return el.evaluate((node, p) => {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) throw new Error('no 2d canvas')
    ctx.fillStyle = getComputedStyle(node).getPropertyValue(p)
    ctx.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data
    return a === 0 ? 0 : Math.max(r, g, b) - Math.min(r, g, b)
  }, prop)
}

/** The callout is a tinted card with a coloured bar; the quote has no fill. */
async function expectTintedCallout(callout: Locator, quote: Locator): Promise<void> {
  await expect(callout).toBeVisible()
  expect(await tint(callout, 'background-color'), 'callout fill is tinted').toBeGreaterThan(3)
  expect(await tint(callout, 'border-left-color'), 'callout bar is tinted').toBeGreaterThan(3)
  expect(await css(quote, 'background-color'), 'quote has no fill').toBe('rgba(0, 0, 0, 0)')
  expect(await css(quote, 'border-left-style'), 'quote keeps its bar').toBe('solid')
}

const staticQuote = (page: Page): Locator =>
  page.locator('.block-static blockquote:not([data-callout-type])')

/** The table's corners are the code block's; its inner rules are lighter than its frame. */
async function expectTableLikeCode(table: Locator, code: Locator): Promise<void> {
  const codeRadius = await css(code, 'border-top-left-radius')
  expect(codeRadius).not.toBe('0px')
  expect(await css(table, 'border-top-left-radius')).toBe(codeRadius)
  const cell = table.locator('tr').nth(2).locator('td').first()
  expect(await css(cell, 'border-top-width'), 'inner rule').toBe('1px')
  expect(await css(cell, 'border-top-color'), 'inner rule vs frame').not.toBe(
    await css(table, 'border-top-color'),
  )
}

interface ReferenceControls {
  kind: Locator
  source: Locator
  addFilter: Locator
  sortField: Locator
  sortDirection: Locator
}

function referenceControls(page: Page): ReferenceControls {
  const refs = page.getByTestId('linked-references')
  return {
    kind: refs.getByRole('radiogroup', { name: 'Filter by link kind' }),
    source: refs.getByRole('button', { name: 'Filter by source page' }),
    addFilter: refs.getByRole('button', { name: 'Add filter' }),
    sortField: refs.getByRole('combobox', { name: 'Sort by' }),
    sortDirection: refs.getByTestId('backlink-sort-direction'),
  }
}

/** Every control's painted height, which the first one's must match. */
async function expectOneHeight(page: Page): Promise<void> {
  const controls = referenceControls(page)
  await controls.kind.scrollIntoViewIfNeeded()
  const heights: Record<string, number> = {}
  for (const [name, el] of Object.entries(controls)) {
    heights[name] = Math.round(((await el.boundingBox())?.height ?? 0) * 10) / 10
  }
  const first = heights['kind'] ?? 0
  expect(heights).toEqual(Object.fromEntries(Object.keys(heights).map((k) => [k, first])))
}

test.describe('the Properties header @pages', () => {
  test.use(DESKTOP)

  test('reads its label, then its count in the count tone, in blocks and in page mode', async ({
    page,
  }) => {
    await openShowcase(page)
    await expectPropertiesHeader(page)
    await toPageMode(page)
    await expectPropertiesHeader(page)
  })
})

test.describe('callouts and quotes @editor @pages', () => {
  test.use(DESKTOP)

  test('a callout is a tinted card with its icon, in blocks and in page mode', async ({ page }) => {
    await openShowcase(page)
    const callout = page.getByTestId('callout-block')
    await expectTintedCallout(callout, staticQuote(page))
    await expect(callout.locator('svg')).toBeVisible()

    await toPageMode(page)
    const editor = page.getByTestId('page-mode-editor')
    const pageCallout = editor.locator('blockquote[data-callout-type]')
    await expectTintedCallout(pageCallout, editor.locator('blockquote:not([data-callout-type])'))
    expect(await css(pageCallout, 'mask-image', '::after'), 'page-mode callout icon').toContain(
      'url(',
    )
  })

  test('a callout stays tinted in the dark theme', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('theme-preference', 'dark'))
    await openShowcase(page)
    await expectTintedCallout(page.getByTestId('callout-block'), staticQuote(page))
  })
})

test.describe('tables @editor @pages', () => {
  test.use(DESKTOP)

  test('a table takes the code block’s corners, with lighter inner rules', async ({ page }) => {
    await openShowcase(page)
    await expectTableLikeCode(
      page.getByTestId('rich-table'),
      page.locator('pre').locator('xpath=ancestor::*[@data-slot="scroll-area"][1]'),
    )
    await toPageMode(page)
    const editor = page.getByTestId('page-mode-editor')
    await expectTableLikeCode(editor.locator('table'), editor.locator('pre'))
  })
})

test.describe('the linked references’ controls @pages', () => {
  test.use(DESKTOP)

  test('are one height', async ({ page }) => {
    await openShowcase(page)
    await expectOneHeight(page)
  })
})

test.describe('the linked references’ controls on a phone @pages @mobile', () => {
  const pixel = devices['Pixel 7']
  test.use({
    viewport: { width: 412, height: 915 },
    userAgent: pixel.userAgent,
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  })

  test('are one height, each a 44 px target', async ({ page }) => {
    await waitForBoot(page)
    await seed(page)
    await openPageMobile(page, TITLE)
    await expectOneHeight(page)
    const { kind, ...rest } = referenceControls(page)
    for (const radio of await kind.getByRole('radio').all()) {
      await expect44(radio, `kind ${await radio.textContent()}`)
    }
    for (const [name, el] of Object.entries(rest)) await expect44(el, name)
  })
})
