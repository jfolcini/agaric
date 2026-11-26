/**
 * The UI review tour: every view, overlay and state the app has, shot on each
 * profile in each theme, for a person to judge (#7040). It asserts nothing; run
 * it through `just ui-review`, which also compares two builds.
 *
 * Extending it:
 * - a screen: add a `shot(name, open)` line to the scene it belongs to. `open`
 *   puts the app in the state to shoot; the shot is taken once it settles.
 * - a scene: add an entry to `SCENES`. Each scene starts on a fresh boot and
 *   runs once per profile and theme.
 * - a device or window size: add an entry to `PROFILES`.
 *
 * A shot whose `open` throws leaves `<name>.failed.txt` (and what the screen
 * showed, `<name>.failed.png`) instead of its PNG, and the scene goes on: on an
 * older build a newer screen is missing, not fatal. The clock is fixed, so the
 * same build shoots the same pixels; a build's own timing (toasts, the graph's
 * settling) can still differ between two runs.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { devices, expect, type Page, test } from '@playwright/test'

import {
  activeMenu,
  emitMockEvent,
  focusBlock,
  navigateToView,
  openAddFilter,
  openMobileSidebar,
  openPage,
  openPageMobile,
  openSettingsTab,
  touchLongPress,
  waitForBoot,
} from '../helpers'
import { seedShowcase } from './seed'

const OUT = resolve(process.env['UI_REVIEW_OUT'] ?? 'ui-review-out/shots/current')

/** A Wednesday morning, so Week and Month show days on both sides of today. */
const NOW = new Date('2026-11-25T09:30:00Z')

const pixel = devices['Pixel 7']
const PROFILES = {
  phone: {
    viewport: pixel.viewport,
    userAgent: pixel.userAgent,
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
} as const
type Profile = keyof typeof PROFILES
const THEMES = ['light', 'dark'] as const

interface Scene {
  page: Page
  profile: Profile
  shot: (name: string, open?: () => Promise<unknown>) => Promise<void>
}

// ── Getting around ─────────────────────────────────────────────────────

const JOURNAL_TABS = {
  Day: 'Daily view',
  Week: 'Weekly view',
  Month: 'Monthly view',
  Stream: 'Continuous stream view',
  Agenda: 'Agenda view',
} as const
type JournalMode = keyof typeof JOURNAL_TABS

async function journalMode(page: Page, profile: Profile, mode: JournalMode): Promise<void> {
  await navigateToView(page, 'Journal')
  if (profile === 'phone') {
    await page.getByRole('button', { name: /^Journal view mode/ }).click()
    await page.getByRole('button', { name: mode, exact: true }).click()
    return
  }
  await page
    .getByRole('tablist', { name: 'Journal view mode' })
    .getByRole('tab', { name: JOURNAL_TABS[mode] })
    .click()
}

function goToPage(page: Page, profile: Profile, title: string): Promise<void> {
  return profile === 'phone' ? openPageMobile(page, title) : openPage(page, title)
}

async function switchSpace(page: Page, profile: Profile, name: string): Promise<void> {
  if (profile === 'phone') await openMobileSidebar(page)
  // A Select on desktop, a bottom-sheet menu on a phone.
  await page.getByLabel('Switch space', { exact: true }).click()
  await page.getByRole(profile === 'phone' ? 'button' : 'option', { name, exact: true }).click()
  if (profile === 'phone') await closeDrawer(page)
}

async function closeDrawer(page: Page): Promise<void> {
  const drawer = page.locator('[data-mobile="true"]')
  if (await drawer.isVisible()) {
    await drawer.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  }
  await expect(drawer).toHaveCount(0)
}

async function dismiss(page: Page, presses = 2): Promise<void> {
  for (let i = 0; i < presses; i++) await page.keyboard.press('Escape')
}

/** Scroll the tallest scrolling box (the view's own) by `dy`. */
async function scrollView(page: Page, dy: number): Promise<void> {
  await page.evaluate((by) => {
    let tallest: HTMLElement | null = null
    for (const el of document.querySelectorAll<HTMLElement>(
      'main, [data-slot="scroll-area-viewport"]',
    )) {
      if (el.scrollHeight <= el.clientHeight + 10) continue
      if (!tallest || el.clientHeight > tallest.clientHeight) tallest = el
    }
    ;(tallest ?? document.scrollingElement)?.scrollBy(0, by)
  }, dy)
}

async function blockMenu(page: Page, profile: Profile, index: number): Promise<void> {
  const row = page.locator('[data-testid="sortable-block"]').nth(index)
  const id = await row.getAttribute('data-block-id')
  const text = `[data-testid="block-static"][data-block-id="${id}"]`
  if (profile === 'phone') await touchLongPress(page, text)
  else await page.locator(text).click({ button: 'right', position: { x: 8, y: 8 } })
  await expect(activeMenu(page)).toBeVisible()
}

/** A new block under the second one, holding `text` as typed. */
async function typeInNewBlock(page: Page, text: string): Promise<void> {
  await focusBlock(page, 1)
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(text, { delay: 30 })
}

/** Switch the open page or journal day between block mode and page mode. */
async function editAs(page: Page, profile: Profile, mode: 'Blocks' | 'Page'): Promise<void> {
  if (profile === 'phone') {
    await page.getByRole('button', { name: 'Page actions' }).click()
    await page
      .getByRole('menuitem', { name: mode === 'Page' ? 'Edit as page' : 'Edit as blocks' })
      .click()
    return
  }
  await page
    .getByRole('radiogroup', { name: 'Editing mode' })
    .getByRole('radio', { name: mode })
    .click()
}

/** Put page mode's caret in the paragraph that starts with `text`. */
async function caretIn(page: Page, text: string): Promise<void> {
  await page.locator('[data-testid="page-mode-editor"]').getByText(text).first().click()
}

type Hooks = Window & {
  __setMockLatency: (ms: number) => void
  __injectMockError: (cmd: string, error: string) => void
}

// ── Scenes ─────────────────────────────────────────────────────────────

const SETTINGS_TABS = [
  ['general', 'General', true],
  ['appearance', 'Appearance', true],
  ['editor', 'Editor', true],
  ['keyboard', 'Keyboard', false],
  ['tasks-reminders', 'Tasks & reminders', false],
  ['spaces', 'Spaces', false],
  ['properties', 'Properties', true],
  ['agent-access', 'Agent access', false],
  ['sync-devices', 'Sync & devices', true],
  ['data', 'Data', true],
  ['about', 'About', false],
  ['app-health', 'App health', false],
] as const

async function views({ page, profile, shot }: Scene): Promise<void> {
  await seedShowcase(page)
  for (const mode of Object.keys(JOURNAL_TABS) as JournalMode[]) {
    await shot(`journal-${mode.toLowerCase()}`, () => journalMode(page, profile, mode))
  }
  await shot('journal-day-scrolled', async () => {
    await journalMode(page, profile, 'Day')
    await scrollView(page, 700)
  })
  await shot('pages', () => navigateToView(page, 'Pages'))
  await shot('pages-scrolled', () => scrollView(page, 600))
  await shot('page-roadmap', () => goToPage(page, profile, 'Product Roadmap Q1'))
  for (const n of [2, 3, 4]) await shot(`page-roadmap-${n}`, () => scrollView(page, 700))
  await shot('page-getting-started', () => goToPage(page, profile, 'Getting Started'))
  await shot('page-projects', () => goToPage(page, profile, 'Projects'))
  const search = page.getByRole('combobox', { name: 'Search blocks' })
  await shot('search-empty', () => navigateToView(page, 'Search'))
  await shot('search-results', async () => {
    await search.fill('screen')
    await search.press('Enter')
  })
  await shot('search-no-results', async () => {
    await search.fill('zzqqxx')
    await search.press('Enter')
  })
  await shot('tags', () => navigateToView(page, 'Tags'))
  await shot('tag-page-work', () => page.getByTestId('tag-item-work').click())
  await shot('templates', () => navigateToView(page, 'Templates'))
  await shot('graph', async () => {
    await navigateToView(page, 'Graph')
    await expect(page.getByTestId('graph-svg')).toBeVisible()
  })
  await shot('query', () => navigateToView(page, 'Advanced query'))
  await shot('history', () => navigateToView(page, 'History'))
  await shot('trash', () => navigateToView(page, 'Trash'))
  await navigateToView(page, 'Settings')
  if (profile === 'phone') await shot('settings')
  for (const [slug, tab, scrolls] of SETTINGS_TABS) {
    await shot(`settings-${slug}`, () => openSettingsTab(page, tab))
    if (scrolls) await shot(`settings-${slug}-scrolled`, () => scrollView(page, 700))
  }
}

async function shell({ page, profile, shot }: Scene): Promise<void> {
  await seedShowcase(page)
  const capture = page.getByTestId('quick-capture-dialog')
  if (profile === 'phone') {
    await shot('drawer', async () => {
      await openMobileSidebar(page)
    })
    await shot('drawer-space-switcher', () =>
      page.getByLabel('Switch space', { exact: true }).click(),
    )
    await dismiss(page, 1)
    await closeDrawer(page)
    await shot('search-sheet', () => page.getByTestId('search-sheet-trigger').click())
    await shot('search-sheet-all-pages', async () => {
      await page.getByTestId('search-sheet-segment-all-pages').click()
      await page.getByTestId('command-palette-input').fill('ro')
    })
    await dismiss(page)
    await shot('quick-capture', () => page.getByTestId('quick-capture-fab').click())
    await shot('quick-capture-typed', () => page.keyboard.type('Call the dentist tomorrow'))
  } else {
    await shot('space-switcher', () =>
      page.getByRole('combobox', { name: 'Switch space', exact: true }).click(),
    )
    await dismiss(page)
    await shot('command-palette', () => page.getByTestId('header-search-button').click())
    await shot('command-palette-typed', () => page.getByTestId('command-palette-input').fill('ro'))
    await shot('command-palette-commands', () =>
      page.getByTestId('command-palette-input').fill('>'),
    )
    await dismiss(page)
    await shot('quick-capture', () =>
      emitMockEvent(page, 'deeplink:capture', {
        kind: 'prefill',
        text: 'Call the dentist tomorrow',
      }),
    )
  }
  await shot('toast', () => capture.getByRole('button', { name: 'Capture', exact: true }).click())
  if (profile === 'desktop') {
    await shot('sidebar-collapsed', () =>
      page.getByRole('button', { name: 'Collapse sidebar' }).click(),
    )
    await page.getByRole('button', { name: 'Expand sidebar' }).click()
    await shot('tabs', async () => {
      await openPage(page, 'Getting Started')
      await page.keyboard.press('Control+t')
      await openPage(page, 'Product Roadmap Q1')
      await page.keyboard.press('Control+t')
      await openPage(page, 'Projects')
    })
    await shot('tab-switcher', () =>
      page.getByRole('button', { name: 'Switch tab', exact: true }).click(),
    )
    await dismiss(page)
    await shot('tooltip', async () => {
      await page.getByTestId('header-search-button').hover()
      await expect(page.getByRole('tooltip')).toBeVisible()
    })
  }
  await shot('shortcuts', async () => {
    await dismiss(page)
    await navigateToView(page, 'Pages')
    await page.locator('body').click({ position: { x: 1, y: 1 } })
    await page.keyboard.press('Escape')
    await page.keyboard.type('?')
  })
  await dismiss(page)
  await shot('bug-report', () =>
    page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('agaric:report-bug', { detail: { message: 'Something broke' } }),
      ),
    ),
  )
}

async function editor({ page, profile, shot }: Scene): Promise<void> {
  await seedShowcase(page)
  await goToPage(page, profile, 'Product Roadmap Q1')
  await shot('block-focused', () => focusBlock(page, 1))
  await shot('task-focused', () => focusBlock(page, 2))
  const toolbar = page.getByTestId('formatting-toolbar')
  const overflow = page.getByTestId('toolbar-overflow-menu')
  if (profile === 'phone') {
    await shot('toolbar-more', () => toolbar.getByRole('button', { name: 'More' }).click())
    await shot('date-picker', () => overflow.getByRole('button', { name: 'Set due date' }).click())
  } else {
    await shot('selection-bubble', async () => {
      await focusBlock(page, 1)
      await page.keyboard.press('Control+Home')
      await page.keyboard.press('Shift+End')
    })
    await shot('toolbar-more', async () => {
      await focusBlock(page, 2)
      await toolbar.getByRole('button', { name: 'More', exact: true }).click()
    })
    await dismiss(page)
    await shot('toolbar-date-menu', async () => {
      await focusBlock(page, 2)
      await toolbar.getByRole('button', { name: 'Date', exact: true }).click()
    })
    await shot('date-picker', () =>
      page.getByTestId('toolbar-date-menu').getByRole('button', { name: 'Set due date' }).click(),
    )
  }
  await dismiss(page)
  await shot('slash-menu', () => typeInNewBlock(page, '/'))
  await dismiss(page)
  await shot('tag-picker', () => typeInNewBlock(page, '@de'))
  await dismiss(page)
  await shot('link-picker', () => typeInNewBlock(page, '[[pro'))
  await dismiss(page, 3)
  await shot('block-menu', () => blockMenu(page, profile, 7))
  await shot('block-properties', () =>
    activeMenu(page)
      .getByRole('menuitem', { name: /Properties/ })
      .click(),
  )
  await dismiss(page)
  await shot('block-history', async () => {
    await blockMenu(page, profile, 2)
    await activeMenu(page)
      .getByRole('menuitem', { name: /History/ })
      .click()
  })
  await dismiss(page)
  const pageActions = page.getByRole('button', { name: 'Page actions' })
  await shot('page-menu', () => pageActions.click())
  await shot('outline', () => page.getByRole('menuitem', { name: 'Open outline' }).click())
  await dismiss(page)
  await shot('delete-page-confirm', async () => {
    await pageActions.click()
    await page.getByRole('menuitem', { name: /Delete page/ }).click()
  })
  await dismiss(page)
  if (profile === 'desktop') {
    await shot('multi-select', async () => {
      const rows = page.locator('[data-testid="sortable-block"] [data-testid="block-static"]')
      for (const n of [2, 3, 4]) {
        await rows.nth(n).click({ modifiers: ['Control'], position: { x: 6, y: 6 } })
      }
    })
    await dismiss(page)
    await shot('in-page-find', async () => {
      await page.keyboard.press('Control+f')
      await page.keyboard.type('screen')
    })
    await dismiss(page)
  }
  await shot('page-bottom-backlinks', async () => {
    await goToPage(page, profile, 'Projects')
    await scrollView(page, 5000)
  })
}

/**
 * The frame around what is being edited, and how the row around it holds up:
 * block mode's one editing block and page mode's whole page, on a page and on
 * the journal's day.
 */
async function editing({ page, profile, shot }: Scene): Promise<void> {
  await seedShowcase(page)
  await goToPage(page, profile, 'Product Roadmap Q1')
  await shot('heading-focused', () => focusBlock(page, 0))
  await shot('task-chips-focused', () => focusBlock(page, 7))
  await shot('properties-focused', () => focusBlock(page, 8))
  await shot('nested-focused', () => focusBlock(page, 12))
  await dismiss(page)
  await shot('page-mode', () => editAs(page, profile, 'Page'))
  await shot('page-mode-paragraph', () => caretIn(page, 'Ship a'))
  await shot('page-mode-task', () => caretIn(page, 'Audit every screen'))
  await shot('page-mode-nested', () => caretIn(page, 'Most participants'))
  await dismiss(page)
  await editAs(page, profile, 'Blocks')
  await navigateToView(page, 'Journal')
  await shot('day-paragraph-focused', () => focusBlock(page, 0))
  await shot('day-task-focused', () => focusBlock(page, 2))
  await dismiss(page)
  if (profile === 'phone') {
    await shot('day-menu', () => page.getByRole('button', { name: 'Page actions' }).click())
    await dismiss(page)
  }
  await shot('day-page-mode', () => editAs(page, profile, 'Page'))
  await shot('day-page-mode-task', () => caretIn(page, 'Buy groceries'))
}

async function states({ page, profile, shot }: Scene): Promise<void> {
  await shot('empty-space-journal', () => switchSpace(page, profile, 'Work'))
  await shot('empty-pages', () => navigateToView(page, 'Pages'))
  await shot('empty-tags', () => navigateToView(page, 'Tags'))
  await shot('empty-trash', () => navigateToView(page, 'Trash'))
  await shot('empty-templates', () => navigateToView(page, 'Templates'))
  await shot('empty-query', () => navigateToView(page, 'Advanced query'))
  await shot('empty-graph', () => navigateToView(page, 'Graph'))
  await shot('empty-agenda', () => journalMode(page, profile, 'Agenda'))
  const newPage = page
    .locator('.page-browser-header')
    .getByRole('button', { name: 'New page', exact: true })
  await shot('new-page-dialog', async () => {
    await navigateToView(page, 'Pages')
    await newPage.click()
    await page.keyboard.type('Weekly review')
  })
  await dismiss(page)
  await shot('new-empty-page', async () => {
    await newPage.click()
    await page.keyboard.type('Blank page')
    await page.keyboard.press('Enter')
  })
  await dismiss(page)
  await switchSpace(page, profile, 'Personal')
  await navigateToView(page, 'Journal')
  await page.evaluate(() => (window as unknown as Hooks).__setMockLatency(5000))
  await shot('loading-pages', () => navigateToView(page, 'Pages'))
  await page.evaluate(() => (window as unknown as Hooks).__setMockLatency(0))
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 })
  await shot('pages-filter', async () => {
    await openAddFilter(page)
  })
  await dismiss(page)
  if (profile === 'phone') {
    await shot('pages-more-menu', () => page.getByTestId('page-browser-more').click())
    await dismiss(page)
  }
  await shot('settings-theme-select', async () => {
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Appearance')
    await page.locator('#theme-select').click()
  })
  await dismiss(page)
  await shot('settings-property-sheet', async () => {
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Properties')
    await page.getByRole('button', { name: 'Edit property project', exact: true }).click()
  })
  await dismiss(page)
  await shot('error-tags', async () => {
    await page.evaluate(() =>
      (window as unknown as Hooks).__injectMockError(
        'list_all_tags_in_space',
        'database is locked',
      ),
    )
    await navigateToView(page, 'Tags')
    await expect(page.getByText('Failed to load tags').first()).toBeVisible()
  })
  // Last: its dialog keeps the focus Escape would need.
  await shot('pair-device', async () => {
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Sync & devices')
    await page.getByRole('button', { name: /pair new device/i }).click()
  })
}

async function firstRun({ page, shot }: Scene): Promise<void> {
  await shot('welcome', () =>
    expect(page.getByRole('button', { name: 'Get started' })).toBeVisible(),
  )
  await shot('after-welcome', () => page.getByRole('button', { name: 'Get started' }).click())
}

const SCENES: Record<string, { run: (scene: Scene) => Promise<void>; firstRun?: true }> = {
  views: { run: views },
  shell: { run: shell },
  editor: { run: editor },
  editing: { run: editing },
  states: { run: states },
  'first-run': { run: firstRun, firstRun: true },
}

// ── The runner ─────────────────────────────────────────────────────────

/** Let the screen settle: no loading skeleton, fonts in, two frames painted. */
async function settle(page: Page): Promise<void> {
  await expect(page.locator('[aria-busy="true"]'))
    .toHaveCount(0, { timeout: 4_000 })
    .catch(() => undefined)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
  // Debounced work (search, pickers) lands within 300 ms of the last input.
  await page.waitForTimeout(350)
}

function shooter(page: Page, dir: string): Scene['shot'] {
  mkdirSync(dir, { recursive: true })
  return async (name, open) => {
    try {
      if (open) await open()
      await settle(page)
      await page.screenshot({
        path: join(dir, `${name}.png`),
        animations: 'disabled',
        caret: 'hide',
      })
    } catch (err) {
      writeFileSync(join(dir, `${name}.failed.txt`), `${String(err)}\n`)
      await page
        .screenshot({ path: join(dir, `${name}.failed.png`) })
        .catch((shotErr: unknown) => console.warn(`ui-review: ${name}: ${String(shotErr)}`))
      await dismiss(page).catch((keyErr: unknown) => console.warn(String(keyErr)))
    }
  }
}

for (const profile of Object.keys(PROFILES) as Profile[]) {
  for (const theme of THEMES) {
    test.describe(`${profile} ${theme}`, () => {
      test.use({ ...PROFILES[profile], colorScheme: theme })

      for (const [name, scene] of Object.entries(SCENES)) {
        test(name, async ({ page }) => {
          await page.clock.setFixedTime(NOW)
          // The emulated phone runs on desktop Chromium, whose Keyboard Map API
          // reports the host's keyboard; Android's WebView has none, so keyboard
          // hints stay hidden until the scene's first key press
          // (`useHasHardwareKeyboard`).
          if (profile === 'phone') {
            await page.addInitScript(() => {
              Reflect.deleteProperty(Navigator.prototype, 'keyboard')
            })
          }
          if (!scene.firstRun) {
            await page.addInitScript(() => {
              localStorage.setItem('agaric-onboarding-done', 'true')
              localStorage.setItem('agaric-gesture-coachmark-seen', 'true')
            })
          }
          await page.emulateMedia({ reducedMotion: 'reduce' })
          await waitForBoot(page)
          const dir = join(OUT, `${profile}-${theme}`, name)
          const shot = shooter(page, dir)
          // A step between shots that throws ends the scene; the report lists
          // it, and the shots after it as missing, rather than the run dying.
          await scene.run({ page, profile, shot }).catch((err: unknown) => {
            writeFileSync(join(dir, '_scene.failed.txt'), `${String(err)}\n`)
          })
        })
      }
    })
  }
}
