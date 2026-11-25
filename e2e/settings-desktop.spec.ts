/**
 * E2E — Settings at a desktop width (#7040 D5): the section nav stays in view
 * while the content scrolls, its active item reads apart from a hovered one,
 * card headings share one size, the Keyboard rows give their labels the width,
 * and a Properties row draws its metadata chips one way.
 */

import { expect, navigateToView, openSettingsTab, test, waitForBoot } from './helpers'

const TABS = [
  'General',
  'Appearance',
  'Editor',
  'Keyboard',
  'Tasks & reminders',
  'Spaces',
  'Properties',
  'Agent access',
  'Sync & devices',
  'Data',
  'About',
  'App health',
] as const

test.describe('Settings at a desktop width @settings', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Settings')
  })

  test('the section nav stays in view with the content scrolled to the end', async ({ page }) => {
    await openSettingsTab(page, 'Keyboard')
    const panel = page.getByTestId('settings-panel-keyboard')
    const resetAll = panel.getByRole('button', { name: 'Reset all to defaults', exact: true })
    await expect(resetAll).toBeVisible()

    await page.locator('#main-content').evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await expect(resetAll).toBeInViewport()
    const rail = page.getByTestId('settings-tab-rail')
    await expect(rail.getByRole('tab', { name: 'General', exact: true })).toBeInViewport({
      ratio: 1,
    })
    await expect(rail.getByRole('tab', { name: 'App health', exact: true })).toBeInViewport({
      ratio: 1,
    })
  })

  test('the active section is set apart from a hovered one by weight and fill', async ({
    page,
  }) => {
    await page.addStyleTag({ content: '* { transition: none !important; }' })
    await openSettingsTab(page, 'Appearance')
    const active = page.getByRole('tab', { name: 'Appearance', exact: true })
    const hovered = page.getByRole('tab', { name: 'Editor', exact: true })
    await hovered.hover()
    const style = (el: Element) => {
      const s = getComputedStyle(el)
      return { fill: s.backgroundColor, weight: s.fontWeight }
    }
    const a = await active.evaluate(style)
    const h = await hovered.evaluate(style)
    expect(h.fill).not.toBe(a.fill)
    expect(Number(a.weight), 'active vs hovered weight').toBeGreaterThan(Number(h.weight))
  })

  test('every card heading is one size', async ({ page }) => {
    const sizes = new Map<string, string[]>()
    for (const tab of TABS) {
      await openSettingsTab(page, tab)
      const panel = page.locator('[role="tabpanel"]')
      await expect(panel).toHaveAttribute('aria-labelledby', /settings-tab-/)
      await expect(panel.locator('[aria-busy="true"]')).toHaveCount(0)
      // A card's heading is the heading it opens with, ahead of any control.
      const found = await panel.evaluate((root) =>
        [...root.querySelectorAll('[data-slot="card"]')].flatMap((card) => {
          const first = card.querySelector(
            'h1, h2, h3, h4, [data-slot="card-title"], button, input, [role="switch"], [role="combobox"]',
          )
          if (
            first === null ||
            (!/^H\d$/.test(first.tagName) && !first.matches('[data-slot="card-title"]'))
          )
            return []
          return [`${getComputedStyle(first).fontSize} ${first.textContent?.trim()}`]
        }),
      )
      for (const entry of found) {
        const [size = '', ...name] = entry.split(' ')
        sizes.set(size, [...(sizes.get(size) ?? []), `${tab}: ${name.join(' ')}`])
      }
    }
    expect(sizes.size, JSON.stringify(Object.fromEntries(sizes), null, 1)).toBe(1)
  })

  test('every description is one size', async ({ page }) => {
    const sizes = new Map<string, string[]>()
    for (const tab of ['Keyboard', 'Tasks & reminders', 'Data', 'App health'] as const) {
      await openSettingsTab(page, tab)
      const panel = page.locator('[role="tabpanel"]')
      await expect(panel.locator('[data-slot="card-description"]').first()).toBeVisible()
      const found = await panel.evaluate((root) =>
        [
          ...root.querySelectorAll(
            '[data-slot="card-description"], [data-slot="setting-row"] p[id$="-description"]',
          ),
        ].map((el) => `${getComputedStyle(el).fontSize} ${el.textContent?.trim().slice(0, 40)}`),
      )
      for (const entry of found) {
        const [size = '', ...text] = entry.split(' ')
        sizes.set(size, [...(sizes.get(size) ?? []), `${tab}: ${text.join(' ')}`])
      }
    }
    expect(sizes.size, JSON.stringify(Object.fromEntries(sizes), null, 1)).toBe(1)
  })

  test('a Keyboard row gives its label the width its keys and buttons leave', async ({ page }) => {
    await openSettingsTab(page, 'Keyboard')
    const keys = page.getByTestId('kbd-keys-column')
    await expect(keys.first()).toBeVisible()
    // The keys and the buttons each take their own width, no empty column beside them.
    const slack = await keys.evaluateAll((columns) =>
      columns.flatMap((column) => {
        const label = column.previousElementSibling
        const actions = column.nextElementSibling
        const drawn = column.firstElementChild
        if (!label || !actions || !drawn) return ['a keys column with no row']
        const width = (el: Element) => el.getBoundingClientRect().width
        const name = label.textContent?.trim()
        const buttons = [...actions.children].reduce((sum, b) => sum + width(b), 0)
        const out: string[] = []
        if (width(column) - width(drawn) > 1) out.push(`${name}: empty keys column`)
        if (width(actions) - Math.max(24, buttons + 4 * (actions.children.length - 1)) > 1)
          out.push(`${name}: empty buttons column`)
        return out
      }),
    )
    expect(slack).toEqual([])
  })

  test('a Properties row draws its metadata chips one way', async ({ page }) => {
    await openSettingsTab(page, 'Properties')
    const row = page
      .getByTestId('settings-panel-properties')
      .getByRole('listitem')
      .filter({ has: page.getByTestId('builtin-lock-due_date') })
    await expect(row.getByTestId('property-usage-due_date')).toBeVisible()
    const looks = await row.locator('[data-slot="badge"]').evaluateAll((badges) =>
      badges.map((badge) => {
        const s = getComputedStyle(badge)
        return `${s.backgroundColor} ${s.color} ${s.borderColor}`
      }),
    )
    expect(looks).toHaveLength(3)
    expect(new Set(looks).size, looks.join('\n')).toBe(1)
  })
})
