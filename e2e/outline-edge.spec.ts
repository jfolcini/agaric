/**
 * The outline on one left edge (#7040 S5), on a 1440 px desktop and a phone, in
 * block mode against the mock: the page title, Add block, the references
 * heading and each top-level block's first glyph (its text, or a task's
 * checkbox) start at one x, the grip and the chevron hanging left of it; a
 * child starts one indent step in, wider on a phone than before; a faint guide
 * runs down each nesting level without taking a click; and a parent's chevron
 * sits just left of its first glyph, folding its children.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import { expect, ipc, openPage, openPageMobile, test, waitForBoot } from './helpers'

const SCOPE = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }
const TITLE = 'Outline edge'

type Row = [depth: number, text: string, todo?: 'TODO']
const ROWS: readonly Row[] = [
  [0, 'A plain line'],
  [0, 'A task', 'TODO'],
  [0, 'A parent'],
  [1, 'A child'],
  [2, 'A grandchild'],
  [0, 'A task parent', 'TODO'],
  [1, 'Its subtask'],
]
const PARENT = 2
const CHILD = 3
const GRANDCHILD = 4
const TASK_PARENT = 5

/** The page, its rows, and a page linking to it, so the references heading shows. */
async function seed(page: Page): Promise<string[]> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: TITLE,
    spaceId: SCOPE.space_id,
  })
  const ids: string[] = []
  const atDepth: string[] = [pageId]
  for (const [depth, content, todo] of ROWS) {
    const row = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: atDepth[depth],
      index: null,
      scope: SCOPE,
    })
    if (todo !== undefined) await ipc(page, 'set_todo_state', { blockId: row.id, state: todo })
    atDepth[depth + 1] = row.id
    ids.push(row.id)
  }
  const linker = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: 'Outline linker',
    spaceId: SCOPE.space_id,
  })
  await ipc(page, 'create_block', {
    blockType: 'content',
    content: `See [[${pageId}]]`,
    parentId: linker,
    index: null,
    scope: SCOPE,
  })
  return ids
}

const row = (page: Page, id: string | undefined): Locator =>
  page.locator(`[data-testid="sortable-block"][data-block-id="${id}"]`)

/** The left edge of `el`'s first glyph: a task's checkbox, an icon, or its first character. */
function glyphX(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    if (el.matches('.task-checkbox')) return el.getBoundingClientRect().left
    const first = el.querySelector('.task-checkbox, svg')
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        (n.textContent ?? '').trim() === '' || n.parentElement?.closest('.sr-only')
          ? NodeFilter.FILTER_SKIP
          : NodeFilter.FILTER_ACCEPT,
    })
    const text = walker.nextNode()
    let textLeft = Number.POSITIVE_INFINITY
    if (text !== null) {
      const at = (text.textContent ?? '').search(/\S/)
      const range = document.createRange()
      range.setStart(text, at)
      range.setEnd(text, at + 1)
      textLeft = range.getBoundingClientRect().left
    }
    // Whichever comes first on the line: a checkbox or icon leads its text.
    const iconLeft = first === null ? Number.POSITIVE_INFINITY : first.getBoundingClientRect().left
    return Math.min(iconLeft, textLeft)
  })
}

/** A block's first glyph: its checkbox, or its text's first character. */
function blockGlyphX(page: Page, id: string | undefined): Promise<number> {
  return glyphX(
    row(page, id).locator('.task-checkbox, [data-testid="block-static"], .ProseMirror').first(),
  )
}

async function box(locator: Locator) {
  const at = await locator.boundingBox()
  if (at === null) throw new Error('no box')
  return { x: at.x, right: at.x + at.width, y: at.y, height: at.height }
}

const pixel = devices['Pixel 7']
const PROFILES = {
  desktop: { use: { viewport: { width: 1440, height: 900 } }, indent: 24 },
  phone: {
    use: {
      viewport: { width: 412, height: 915 },
      userAgent: pixel.userAgent,
      hasTouch: true,
      isMobile: true,
    },
    indent: 20,
  },
} as const

for (const [name, profile] of Object.entries(PROFILES)) {
  const phone = name === 'phone'
  test.describe(`the outline on one left edge, ${name} @editor @pages${phone ? ' @mobile' : ''}`, () => {
    test.use({ ...profile.use, colorScheme: 'light' })

    let ids: string[] = []
    test.beforeEach(async ({ page }) => {
      await waitForBoot(page)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      ids = await seed(page)
      await (phone ? openPageMobile(page, TITLE) : openPage(page, TITLE))
      await expect(row(page, ids[GRANDCHILD])).toBeVisible()
      await expect(page.getByTestId('linked-references')).toBeVisible()
    })

    test('the title, Add block, the references heading and each top-level block start at one x', async ({
      page,
    }) => {
      const edge = await glyphX(page.locator('[aria-label="Page title"]'))
      const xs: Record<string, number> = {
        'Add block': await glyphX(page.getByRole('button', { name: 'Add block' })),
        references: await glyphX(page.locator('.linked-references-header')),
      }
      for (const [i, [depth, text]] of ROWS.entries()) {
        if (depth === 0) xs[text] = await blockGlyphX(page, ids[i])
      }
      for (const [what, x] of Object.entries(xs)) {
        expect(Math.abs(x - edge), `${what} at ${x} vs the title at ${edge}`).toBeLessThanOrEqual(1)
      }
    })

    test(`a child starts one ${profile.indent} px step in, and a faint guide per level takes no click`, async ({
      page,
    }) => {
      const parent = await blockGlyphX(page, ids[PARENT])
      const child = await blockGlyphX(page, ids[CHILD])
      const grandchild = await blockGlyphX(page, ids[GRANDCHILD])
      expect(child - parent, 'child vs parent').toBeCloseTo(profile.indent, 0)
      expect(grandchild - child, 'grandchild vs child').toBeCloseTo(profile.indent, 0)

      const guides = row(page, ids[GRANDCHILD]).getByTestId('indent-guide')
      await expect(guides, 'one guide per level above the grandchild').toHaveCount(2)
      await expect(row(page, ids[CHILD]).getByTestId('indent-guide')).toHaveCount(1)
      await expect(row(page, ids[PARENT]).getByTestId('indent-guide')).toHaveCount(0)
      const levels = [parent, child]
      for (let level = 0; level < 2; level += 1) {
        const guide = guides.nth(level)
        const at = await box(guide)
        expect(at.right - at.x, `guide ${level}: a hairline`).toBeLessThanOrEqual(1)
        // Left of the level's children, within a chevron's width of its own first glyph.
        expect(at.x, `guide ${level}: left of the level's children`).toBeLessThan(
          (levels[level] ?? 0) + profile.indent,
        )
        expect(at.x, `guide ${level}: under its block's chevron`).toBeGreaterThanOrEqual(
          (levels[level] ?? 0) - 16,
        )
        // Faint: drawn in the border token, at reduced strength.
        const alpha = await guide.evaluate((el) => {
          const c = getComputedStyle(el).backgroundColor
          const m = /\/\s*([\d.]+)\)|rgba\([^)]*,\s*([\d.]+)\)/.exec(c)
          return m === null ? 1 : Number(m[1] ?? m[2])
        })
        expect(alpha, `guide ${level}: faint`).toBeLessThan(1)
        // A press on the guide lands on its row, not the guide.
        const hit = await guide.evaluate((el) => {
          const r = el.getBoundingClientRect()
          const under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          return {
            guide: under === el,
            row: under?.closest('[data-testid="sortable-block"]')?.getAttribute('data-block-id'),
          }
        })
        expect(hit.guide, `guide ${level}: not the click target`).toBe(false)
        expect(hit.row, `guide ${level}: the press lands on its row`).toBe(ids[GRANDCHILD])
      }
    })

    test("a parent's chevron sits just left of its first glyph and folds its children", async ({
      page,
    }) => {
      for (const i of [PARENT, TASK_PARENT]) {
        const parent = row(page, ids[i])
        const chevron = parent.getByTestId('collapse-toggle')
        const glyph = await blockGlyphX(page, ids[i])
        const at = await box(chevron)
        expect(at.right, `${ROWS[i]?.[1]}: chevron left of its first glyph`).toBeLessThanOrEqual(
          glyph + 0.5,
        )
        expect(at.x, `${ROWS[i]?.[1]}: chevron right beside it`).toBeGreaterThanOrEqual(glyph - 24)
        if (phone) {
          const area = await chevron.evaluate((el) => {
            const s = getComputedStyle(el, '::before')
            return { w: Number.parseFloat(s.width), h: Number.parseFloat(s.height) }
          })
          expect(area.w, `${ROWS[i]?.[1]}: touch target width`).toBeGreaterThanOrEqual(44)
          expect(area.h, `${ROWS[i]?.[1]}: touch target height`).toBeGreaterThanOrEqual(44)
        }
      }

      const chevron = row(page, ids[PARENT]).getByTestId('collapse-toggle')
      if (!phone) await row(page, ids[PARENT]).hover()
      await expect(chevron).toHaveAttribute('aria-label', 'Collapse children')
      await chevron.click()
      await expect(row(page, ids[CHILD])).toHaveCount(0)
      await expect(chevron).toHaveAttribute('aria-expanded', 'false')
      await chevron.click()
      await expect(row(page, ids[CHILD])).toBeVisible()
      await expect(row(page, ids[GRANDCHILD])).toBeVisible()
    })
  })
}
