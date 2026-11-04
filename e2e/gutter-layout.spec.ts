/**
 * A block's gutter on desktop, laid out alike in block mode and page mode
 * against the mock backend: a line's text lands at one x in both modes, at
 * every font size; a plain line reserves no room for a task's checkbox; the
 * grip, the chevron and a task's checkbox sit inside the mode's box, the grip's
 * glyph `SLACK` px clear of its edge; hovering a row moves no text; a child's
 * text starts one indent step past its parent's, a task's included, and moves
 * as its parent becomes a task or stops being one, on a phone too; and
 * `/todo`, Ctrl+Enter and the block menu each still make a plain line a task,
 * read back from the backend.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import {
  activeMenu,
  expect,
  focusBlockById,
  ipc,
  openPageMobile,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'
/** The space between a task's checkbox and its text column (`gap-1`), and the text box's own inset (`px-3`). */
const GAP = 4
const INSET = 12
/** How far the grip's glyph sits inside the box, at least. */
const SLACK = 6

type Row = [depth: number, text: string, todo?: 'TODO']

/** One of each shape: a task, a plain parent, a plain leaf, a task with a child. */
const SHAPES: readonly Row[] = [
  [0, 'a task', 'TODO'],
  [0, 'a plain parent'],
  [1, 'its child'],
  [0, 'a plain leaf'],
  [0, 'a task parent', 'TODO'],
  [1, 'its subtask'],
]
/** Each shape's row in `SHAPES`. */
const SHAPE = { task: 0, parent: 1, leaf: 3, taskParent: 4 } as const
type Shape = keyof typeof SHAPE
const NAMES = Object.keys(SHAPE) as Shape[]
const HAS_CHEVRON: ReadonlySet<Shape> = new Set(['parent', 'taskParent'])
const IS_TASK: ReadonlySet<Shape> = new Set(['task', 'taskParent'])

async function seed(page: Page, title: string, rows: readonly Row[]) {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const ids: string[] = []
  const atDepth: string[] = [pageId]
  for (const [depth, content, todo] of rows) {
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
  return { pageId, ids }
}

async function open(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Control+k')
  const input = page.locator('[cmdk-input]').first()
  await input.fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
  await expect(page.getByTestId('view-transition-wrapper')).toHaveCSS('opacity', '1')
}

async function mode(page: Page, name: 'Blocks' | 'Page'): Promise<void> {
  await page.getByRole('radiogroup', { name: 'Editing mode' }).getByRole('radio', { name }).click()
  if (name === 'Page') await expect(page.locator(EDITOR)).toBeVisible()
  else await expect(page.getByTestId('block-tree')).toBeVisible()
}

const blockRow = (page: Page, id: string | undefined): Locator =>
  page.locator(`[data-testid="sortable-block"][data-block-id="${id}"]`)
const blockText = (page: Page, id: string | undefined): Locator =>
  blockRow(page, id).locator('[data-testid="block-static"]')
const pageBlock = (page: Page, id: string | undefined): Locator =>
  page.locator(`${EDITOR} [data-page-block-id="${id}"]`)
const pageText = (page: Page, id: string | undefined): Locator =>
  pageBlock(page, id).locator(':scope > .page-block-content')

const pageCheckbox = (page: Page, id: string | undefined): Locator =>
  pageBlock(page, id).locator(':scope > .page-block-controls [data-testid="task-marker"]')

/** Put page mode's cursor at the end of block `index`'s text, and focus the document. */
async function caretAtEnd(page: Page, index: number): Promise<void> {
  await page.evaluate(
    ({ selector, index: i }) => {
      const { editor } = document.querySelector(selector) as HTMLElement & {
        editor: {
          state: {
            doc: {
              child: (n: number) => { nodeSize: number; firstChild: { content: { size: number } } }
            }
          }
          commands: { setTextSelection: (pos: number) => boolean }
          view: { focus: () => void }
        }
      }
      let pos = 0
      for (let k = 0; k < i; k += 1) pos += editor.state.doc.child(k).nodeSize
      editor.commands.setTextSelection(pos + 2 + editor.state.doc.child(i).firstChild.content.size)
      editor.view.focus()
    },
    { selector: EDITOR, index },
  )
  await expect(page.locator(EDITOR)).toBeFocused()
}

/** The left edge of the first character of `locator`'s text. */
function textX(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        (n.textContent ?? '').trim() === '' ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT,
    })
    const node = walker.nextNode()
    if (node === null) throw new Error('no text')
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, 1)
    return range.getBoundingClientRect().left
  })
}

async function box(locator: Locator) {
  const at = await locator.boundingBox()
  if (at === null) throw new Error('no box')
  return { x: at.x, right: at.x + at.width }
}

/** `inner` lies across no edge of `outer`. */
function expectInside(
  inner: { x: number; right: number },
  outer: { x: number; right: number },
  what: string,
): void {
  expect(inner.x, `${what}'s left edge`).toBeGreaterThanOrEqual(outer.x)
  expect(inner.right, `${what}'s right edge`).toBeLessThanOrEqual(outer.right)
}

/** Each shape's text x. */
async function textXs(
  text: (id: string | undefined) => Locator,
  ids: string[],
): Promise<Record<Shape, number>> {
  const out = {} as Record<Shape, number>
  for (const name of NAMES) out[name] = await textX(text(ids[SHAPE[name]]))
  return out
}

/** A task with a plain child and grandchild, and a plain block with the same. */
const NESTED: readonly Row[] = [
  [0, 'a task', 'TODO'],
  [1, 'its plain child'],
  [2, 'its grandchild'],
  [0, 'a plain block'],
  [1, 'its own child'],
  [2, 'its own grandchild'],
]
/** Each row's parent in `NESTED`, by index. */
const PARENT: ReadonlyMap<number, number> = new Map([
  [1, 0],
  [2, 1],
  [4, 3],
  [5, 4],
])

/** `--indent-width`, in px. */
function indentStep(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--indent-width'),
    ),
  )
}

/** Each child's text starts one indent step past its parent's. */
async function expectIndented(
  text: (index: number) => Locator,
  step: number,
  what: string,
): Promise<(index: number) => number> {
  const xs: number[] = []
  for (let i = 0; i < NESTED.length; i += 1) xs.push(await textX(text(i)))
  const x = (index: number): number => xs[index] ?? Number.NaN
  for (const [child, parent] of PARENT) {
    expect(
      x(child) - x(parent),
      `${what}: "${NESTED[child]?.[1]}" vs "${NESTED[parent]?.[1]}"`,
    ).toBeCloseTo(step, 0)
  }
  return x
}

for (const size of ['small', 'medium', 'large'] as const) {
  test.describe(`gutter layout, font size ${size} @editor @pages`, () => {
    test.use({ viewport: { width: 1280, height: 800 } })

    test.beforeEach(async ({ page }) => {
      await page.addInitScript((s) => localStorage.setItem('agaric-font-size', s), size)
      await waitForBoot(page)
      await page.emulateMedia({ reducedMotion: 'reduce' })
    })

    test('text lands at one x in both modes, a plain line keeps no checkbox room, the controls stay in the box, and hovering moves no text', async ({
      page,
    }) => {
      const { ids } = await seed(page, `Gutter ${size}`, SHAPES)
      await open(page, `Gutter ${size}`)
      await mode(page, 'Blocks')

      // Block mode's box: the page column (`PageEditor`'s root), which the title starts.
      const column = await box(page.locator('.page-editor'))
      const blockXs = await textXs((id) => blockText(page, id), ids)
      // A plain line's text starts the inset past where a task's checkbox starts, and a
      // task's text the gap and the inset past where its checkbox ends.
      const blockCheckbox = await box(blockRow(page, ids[SHAPE.task]).getByTestId('task-marker'))
      expect(blockXs.parent - blockCheckbox.x, 'plain parent').toBeCloseTo(INSET, 0)
      expect(blockXs.leaf - blockCheckbox.x, 'plain leaf').toBeCloseTo(INSET, 0)
      expect(blockXs.task - blockCheckbox.right, 'task').toBeCloseTo(GAP + INSET, 0)
      for (const name of NAMES) {
        const row = blockRow(page, ids[SHAPE[name]])
        await row.hover()
        const grip = row.getByTestId('drag-handle')
        await expect(grip).toHaveCSS('opacity', '1')
        expect(await textX(blockText(page, ids[SHAPE[name]])), `${name}: x, hovered`).toBe(
          blockXs[name],
        )
        expectInside(await box(grip), column, `${name}: grip`)
        expect(
          (await box(grip.locator('svg'))).x - column.x,
          `${name}: grip glyph inside the column`,
        ).toBeGreaterThanOrEqual(SLACK)
        if (HAS_CHEVRON.has(name)) {
          expectInside(await box(row.getByTestId('collapse-toggle')), column, `${name}: chevron`)
        }
        // No checkbox on a plain line, even hovered.
        if (IS_TASK.has(name)) {
          expectInside(await box(row.getByTestId('task-marker')), column, `${name}: checkbox`)
        } else {
          await expect(row.getByTestId('task-marker')).toHaveCount(0)
        }
      }

      await mode(page, 'Page')
      // Page mode's box: its frame, the bordered box around the toolbar, the text and the footer.
      const frame = await box(page.locator('[data-page-mode-surface]').locator('..'))
      await expect(pageCheckbox(page, ids[SHAPE.task])).toBeVisible()
      const pageXs = await textXs((id) => pageText(page, id), ids)
      for (const name of NAMES) {
        expect(
          Math.abs(pageXs[name] - blockXs[name]),
          `${name}: page x vs block x`,
        ).toBeLessThanOrEqual(1)
      }
      const pageBox = await box(pageCheckbox(page, ids[SHAPE.task]))
      expect(pageXs.parent - pageBox.x, 'page plain parent').toBeCloseTo(INSET, 0)
      expect(pageXs.leaf - pageBox.x, 'page plain leaf').toBeCloseTo(INSET, 0)
      expect(pageXs.task - pageBox.right, 'page task').toBeCloseTo(GAP + INSET, 0)
      for (const name of NAMES) {
        const at = pageBlock(page, ids[SHAPE[name]])
        await at.hover()
        await expect(at).toHaveAttribute('data-page-grip-on', '')
        const grip = page.locator('[data-page-grip]')
        await expect(grip).toBeVisible()
        expect(await textX(pageText(page, ids[SHAPE[name]])), `${name}: page x, hovered`).toBe(
          pageXs[name],
        )
        expectInside(await box(grip), frame, `${name}: page grip`)
        expect(
          (await box(grip.locator('svg'))).x - frame.x,
          `${name}: page grip glyph inside the frame`,
        ).toBeGreaterThanOrEqual(SLACK)
        if (HAS_CHEVRON.has(name)) {
          const chevron = at.locator(
            ':scope > .page-block-gutter > [data-testid="collapse-toggle"]',
          )
          expectInside(await box(chevron), frame, `${name}: page chevron`)
        }
        if (IS_TASK.has(name)) {
          expectInside(
            await box(pageCheckbox(page, ids[SHAPE[name]])),
            frame,
            `${name}: page checkbox`,
          )
        } else {
          await expect(at.getByTestId('task-marker')).toHaveCount(0)
        }
      }
    })

    test("a child's text starts one indent step past its parent's, a task's too, and follows its parent's task state", async ({
      page,
    }) => {
      const { ids } = await seed(page, `Indent ${size}`, NESTED)
      await open(page, `Indent ${size}`)
      await mode(page, 'Blocks')
      const step = await indentStep(page)
      expect(step, '--indent-width').toBe(24)
      // The edited row's text is its editor's.
      const blockAt = (i: number) =>
        blockRow(page, ids[i]).locator('[data-testid="block-static"], .ProseMirror').first()
      const blockXs = await expectIndented(blockAt, step, 'block mode')

      // The plain block becomes a task: its text moves past the checkbox, and its
      // children's with it, measured as they redraw.
      const shift = blockXs(0) - blockXs(3)
      await focusBlockById(page, ids[3] as string)
      await page.keyboard.press('Control+Enter')
      await expect(blockRow(page, ids[3]).getByTestId('task-checkbox-todo')).toBeVisible()
      await expect
        .poll(() => textX(blockAt(4)), 'block mode: child under the new task')
        .toBeCloseTo(blockXs(4) + shift, 0)
      await expectIndented(blockAt, step, 'block mode, both tasks')
      // And back: four more cycles take the task off.
      for (let k = 0; k < 4; k += 1) await page.keyboard.press('Control+Enter')
      await expect(blockRow(page, ids[3]).getByTestId('task-marker')).toHaveCount(0)
      await expect
        .poll(() => textX(blockAt(4)), 'block mode: child, task off')
        .toBeCloseTo(blockXs(4), 0)
      await expectIndented(blockAt, step, 'block mode, task off')

      await mode(page, 'Page')
      await expect(pageCheckbox(page, ids[0])).toBeVisible()
      const pageAt = (i: number) => pageText(page, ids[i])
      const pageXs = await expectIndented(pageAt, step, 'page mode')
      for (let i = 0; i < NESTED.length; i += 1) {
        expect(
          Math.abs(pageXs(i) - blockXs(i)),
          `"${NESTED[i]?.[1]}": page x vs block x`,
        ).toBeLessThanOrEqual(1)
      }
      await caretAtEnd(page, 3)
      await page.keyboard.press('Control+Enter')
      await expect(pageCheckbox(page, ids[3])).toBeVisible()
      await expect
        .poll(() => textX(pageAt(4)), 'page mode: child under the new task')
        .toBeCloseTo(pageXs(4) + shift, 0)
      await expectIndented(pageAt, step, 'page mode, both tasks')
      for (let k = 0; k < 4; k += 1) await page.keyboard.press('Control+Enter')
      await expect(pageBlock(page, ids[3]).getByTestId('task-marker')).toHaveCount(0)
      await expect
        .poll(() => textX(pageAt(4)), 'page mode: child, task off')
        .toBeCloseTo(pageXs(4), 0)
      await expectIndented(pageAt, step, 'page mode, task off')
    })
  })
}

test.describe('gutter layout on a phone @editor @pages @mobile', () => {
  const iPhone13 = devices['iPhone 13']
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test("a child's text starts one indent step past its parent's in both modes; page mode keeps a task's text where a plain block's is", async ({
    page,
  }) => {
    const { ids } = await seed(page, 'Indent phone', NESTED)
    await openPageMobile(page, 'Indent phone')
    const step = await indentStep(page)
    expect(step, '--indent-width').toBe(12)
    await expect(blockText(page, ids[5])).toBeVisible()
    const blockXs = await expectIndented((i) => blockText(page, ids[i]), step, 'phone block mode')
    // Block mode draws the checkbox before a task's text.
    expect(blockXs(0) - blockXs(3), 'phone block mode: task vs plain').toBeGreaterThan(0)

    await page.getByRole('button', { name: 'Page actions', exact: true }).tap()
    await page.getByRole('menuitem', { name: 'Edit as page', exact: true }).tap()
    await expect(pageCheckbox(page, ids[0])).toBeVisible()
    const pageXs = await expectIndented((i) => pageText(page, ids[i]), step, 'phone page mode')
    // Page mode's phone checkbox sits in the lane.
    expect(pageXs(0), 'phone page mode: task vs plain').toBe(pageXs(3))
  })
})

test.describe('gutter layout: setting a task @editor @pages', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  const todo = async (page: Page, id: string | undefined) =>
    (await ipc<{ todo_state: string | null }>(page, 'get_block', { blockId: id })).todo_state

  test('block mode: /todo, Ctrl+Enter and the context menu each make a plain line a task', async ({
    page,
  }) => {
    const { ids } = await seed(page, 'Tasks blocks', [
      [0, 'one'],
      [0, 'two'],
      [0, 'three'],
    ])
    await open(page, 'Tasks blocks')
    await mode(page, 'Blocks')

    await blockText(page, ids[2]).click({ button: 'right' })
    await activeMenu(page).getByRole('menuitem', { name: 'Set as TODO' }).click()
    await expect.poll(() => todo(page, ids[2])).toBe('TODO')
    await expect(blockRow(page, ids[2]).getByTestId('task-checkbox-todo')).toBeVisible()

    await focusBlockById(page, ids[0] as string)
    await typeSlashCommand(page, 'todo')
    await page.keyboard.press('Enter')
    await expect.poll(() => todo(page, ids[0])).toBe('TODO')

    await focusBlockById(page, ids[1] as string)
    await page.keyboard.press('Control+Enter')
    await expect.poll(() => todo(page, ids[1])).toBe('TODO')
  })

  test('page mode: /todo, Ctrl+Enter and the block menu each make a plain line a task', async ({
    page,
  }) => {
    const { ids } = await seed(page, 'Tasks page', [
      [0, 'one'],
      [0, 'two'],
      [0, 'three'],
    ])
    await open(page, 'Tasks page')
    await mode(page, 'Page')

    await caretAtEnd(page, 0)
    await page.keyboard.type(' /todo')
    await expect(page.locator('#suggestion-todo')).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')
    await expect.poll(() => todo(page, ids[0])).toBe('TODO')

    await caretAtEnd(page, 1)
    await page.keyboard.press('Control+Enter')
    await expect.poll(() => todo(page, ids[1])).toBe('TODO')

    await pageText(page, ids[2]).click({ button: 'right' })
    await page
      .getByRole('menu', { name: 'Block actions' })
      .getByRole('menuitem', { name: 'Set as TODO' })
      .click()
    await expect.poll(() => todo(page, ids[2])).toBe('TODO')
    await expect(pageBlock(page, ids[2]).getByTestId('task-checkbox-todo')).toBeVisible()
  })
})
