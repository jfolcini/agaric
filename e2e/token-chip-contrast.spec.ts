/**
 * #6528 — the token-coloured chips on a page (priority, highlight, links and refs)
 * measured by axe in every shipped theme. The vitest contrast test reads the token
 * values; this reads what the browser paints. History's op badges are not here: axe
 * cannot measure text on a `.list-row`, whose tint is a pseudo element, and files it
 * as incomplete.
 */

import { expect, navigateToView, runAxe, seedSearchBlocks, test, waitForBoot } from './helpers'

const THEMES = [
  'light',
  'dark',
  'solarized-light',
  'solarized-dark',
  'dracula',
  'one-dark-pro',
] as const

const PAGE_QUICK_NOTES = '00000000000000000000PAGE02'
const TAG_WORK = '000000000000000000000TAG01'
const BLOCK_GS_1 = '0000000000000000000B10CK01'

const SEEDS = [
  { content: 'an urgent task', todo: 'TODO', priority: '1' },
  { content: 'a high task', todo: 'DOING', priority: '2' },
  { content: 'a normal task', todo: 'DONE', priority: '3' },
  { content: 'a dropped task', todo: 'CANCELLED' },
  { content: 'some ==marked words== here' },
  { content: `see [[${PAGE_QUICK_NOTES}]] and #[${TAG_WORK}] and ((${BLOCK_GS_1}))` },
  { content: 'an [external link](https://example.com) here' },
]

// Each kind of chip, by a piece of the markup axe reports for its text.
const CHIPS = [
  'priority-urgent',
  'priority-high',
  'priority-normal',
  '<mark',
  'block-link-chip',
  'tag-ref-chip',
  'block-ref-chip',
  'external-link',
]

for (const theme of THEMES) {
  test(`every chip's text clears its contrast minimum in the ${theme} theme @editor @pages`, async ({
    page,
  }) => {
    // axe reads colours, which a fade in progress makes wrong.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 1280, height: 1600 })
    await page.addInitScript((t) => localStorage.setItem('theme-preference', t), theme)
    await waitForBoot(page)
    await seedSearchBlocks(page, SEEDS)
    await navigateToView(page, 'Pages')
    await page.getByText('Projects', { exact: true }).click()
    await expect(page.getByRole('link', { name: 'external link (opens in new tab)' })).toBeVisible()

    const onPage = await runAxe(page, '.page-editor', { runOnly: ['color-contrast'] })
    expect(onPage.violations.flatMap((v) => v.nodes.map((n) => n.html))).toEqual([])
    expect(onPage.incomplete.flatMap((r) => r.nodes.map((n) => n.html))).toEqual([])
    // A measured pass for each chip, not a skipped node.
    const measured = onPage.passes.flatMap((r) => r.nodes.map((n) => n.html))
    for (const chip of CHIPS) {
      expect(
        measured.some((html) => html.includes(chip)),
        chip,
      ).toBe(true)
    }
  })
}
