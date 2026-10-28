/**
 * #6160 — a code block's syntax colours sit on `bg-muted`. Happy-dom computes no colours, so
 * axe in a real browser is where every shipped theme is measured, light ones included.
 */

import { createRequire } from 'node:module'

import { expect, navigateToView, seedSearchBlocks, test, waitForBoot } from './helpers'

const axePath = createRequire(import.meta.url).resolve('axe-core')

interface AxeResult {
  violations: Array<{ id: string; nodes: Array<{ html: string }> }>
  passes: Array<{ id: string; nodes: Array<{ html: string }> }>
  incomplete: Array<{ id: string; nodes: Array<{ html: string }> }>
}

const THEMES = [
  'light',
  'dark',
  'solarized-light',
  'solarized-dark',
  'dracula',
  'one-dark-pro',
] as const

// Between them these reach every token class `src/index.css` colours.
const BLOCKS = [
  '```js\n// a muted comment\nconst re = /ab+c/g\nfunction greet(n) { console.log("hi", 42, true, this) }\nclass A extends B {}\n```',
  '```python\n# a comment\n@dec\ndef f(self): return None\n```',
  '```css\na.b#c > p::after { color: red; }\n@media print {}\n```',
  '```html\n<div class="x" id="y">hi</div>\n```',
  '```markdown\n## Section\n> a quote\n- a bullet\n**bold** *emphasis*\n```',
  '```json\n{ "key": [1, true, null] }\n```',
  '```sql\nSELECT name FROM t WHERE id = 1 -- note\n```',
  '```diff\n+ added\n- removed\n```',
]

// One token per block above that proves the block is highlighted (comments are counted apart).
const HIGHLIGHTED = [
  '.hljs-regexp',
  '.hljs-title.function_',
  '.hljs-selector-pseudo',
  '.hljs-name',
  '.hljs-section',
  '.hljs-literal',
  '.hljs-addition',
  '.hljs-deletion',
]

for (const theme of THEMES) {
  test(`every syntax colour in a code block clears 4.5:1 in the ${theme} theme @editor`, async ({
    page,
  }) => {
    // axe reads colours, which a fade in progress makes wrong.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    // Tall, so every block is in view and rendered.
    await page.setViewportSize({ width: 1280, height: 3200 })
    await page.addInitScript((t) => localStorage.setItem('theme-preference', t), theme)
    await waitForBoot(page)
    await seedSearchBlocks(
      page,
      BLOCKS.map((content) => ({ content })),
    )
    await navigateToView(page, 'Pages')
    await page.getByText('Projects', { exact: true }).click()
    // Blocks highlight one after another; axe on a block still plain would pass vacuously.
    await expect(page.locator('.hljs-comment')).toHaveCount(3)
    for (const token of HIGHLIGHTED) await expect(page.locator(token).first()).toBeVisible()

    await page.addScriptTag({ path: axePath })
    const result = await page.evaluate(() =>
      (
        window as unknown as {
          axe: {
            run: (el: Element, opts: { runOnly: string[] }) => Promise<AxeResult>
          }
        }
      ).axe.run(document.body, { runOnly: ['color-contrast'] }),
    )

    // Only the code blocks are under test here.
    const inCode = (n: { html: string }) => n.html.includes('hljs')
    expect(result.violations.flatMap((v) => v.nodes.filter(inCode).map((n) => n.html))).toEqual([])
    expect(result.incomplete.flatMap((r) => r.nodes.filter(inCode).map((n) => n.html))).toEqual([])
    // A measured pass on the comment itself, not a skipped node.
    expect(result.passes.flatMap((r) => r.nodes).some((n) => n.html.includes('hljs-comment'))).toBe(
      true,
    )
  })
}

for (const theme of ['dark', 'solarized-dark', 'dracula', 'one-dark-pro']) {
  test(`this is painted as a keyword in the ${theme} theme @editor`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1200 })
    await page.addInitScript((t) => localStorage.setItem('theme-preference', t), theme)
    await waitForBoot(page)
    await seedSearchBlocks(page, [{ content: '```js\nconst a = this\n```' }])
    await navigateToView(page, 'Pages')
    await page.getByText('Projects', { exact: true }).click()
    const colorOf = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).color)
    await expect(page.locator('.hljs-keyword').first()).toBeVisible()
    expect(await colorOf('.hljs-variable.language_')).toBe(await colorOf('.hljs-keyword'))
  })
}
