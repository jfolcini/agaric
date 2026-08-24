/**
 * E2E — mobile horizontal-overflow sweep (#1966).
 *
 * Opens every reachable top-level view (and a couple of key dialogs) at phone
 * widths and asserts NOTHING overflows the viewport horizontally — the failure
 * mode behind the pairing-dialog report (buttons bleeding off a narrow screen)
 * and the class of bug the user asked to sweep for across the whole UI.
 *
 * RUNS IN CI (#4300). This file was skipped in CI for two successive reasons,
 * both now retired. The first — "low marginal protection" — was already false:
 * the strengthened element-root guard in `helpers.ts` (#3501) immediately
 * caught a real defect (KeyboardShortcuts.tsx clipping ~32px off the Action
 * column at 360px). The second was a SEPARATE pre-existing bug: the pairing
 * tests below queried `activeDialog(page)` (`[data-slot="dialog-content"]`)
 * while `PairingDialog` renders a Sheet on phones, so they failed on the
 * selector before any overflow assertion ran. That was fixed for #3468 — the
 * pairing tests now use `activeSheet(page)` — and the whole file passes at both
 * profiles, so the skip was outliving its own stated condition.
 *
 * Leaving it skipped had a cost, and it was paid: the paired-device row
 * (`PeerListItem`) shipped with its action buttons overflowing the card at both
 * phone widths, and this is the suite that would have caught it. The regression
 * is now pinned by `paired device row` below, which is the only test here that
 * MATERIALIZES a peer — every other sync assertion in this file runs against an
 * empty device list, which is why an overflowing peer row was invisible to it.
 *
 * Run locally:
 *   npx playwright test e2e/mobile-overflow.spec.ts --workers=1
 */

import { devices } from '@playwright/test'

import {
  activeRoleDialog,
  activeSheet,
  expect,
  expectNoHorizontalOverflow,
  focusBlock,
  navigateMobile,
  openMobileSidebar,
  test,
  waitForBoot,
} from './helpers'

// Two narrow profiles: the existing iPhone-13 baseline (390px) and a narrower
// 360px Android width (small Pixel / Galaxy) that exposes overflow the 390px
// case misses. Both are below the 768px `useIsMobile` breakpoint, so the app
// renders its mobile chrome (header hamburger + sheets, no persistent rail).
const iPhone13 = devices['iPhone 13']
const PROFILES = [
  { name: 'iPhone 13 · 390px', use: { ...pick(iPhone13), viewport: { width: 390, height: 844 } } },
  {
    name: 'narrow Android · 360px',
    use: { ...pick(iPhone13), viewport: { width: 360, height: 800 } },
  },
] as const

// Spread only the per-context fields. Including `defaultBrowserType` would force
// a new worker and Playwright rejects it inside a describe (see
// search-view-mobile.spec.ts).
function pick(device: (typeof devices)[string]) {
  return {
    hasTouch: device.hasTouch,
    isMobile: device.isMobile,
    deviceScaleFactor: device.deviceScaleFactor,
    userAgent: device.userAgent,
  }
}

// Top-level views, keyed by the accessible name of their nav button inside
// the sidebar drawer (the i18n `sidebar.*` label). `query`'s label is
// "Advanced Query".
const VIEWS = [
  'Journal',
  'Pages',
  'Search',
  'Tags',
  'Graph',
  'Templates',
  'Advanced Query',
  'Status',
  'History',
  'Trash',
  'Settings',
] as const

for (const profile of PROFILES) {
  test.describe(`mobile overflow sweep — ${profile.name}`, () => {
    test.use(profile.use)

    for (const view of VIEWS) {
      test(`${view} view has no horizontal overflow`, async ({ page }) => {
        await waitForBoot(page)

        // Navigate via the header hamburger + sidebar drawer. The persistent
        // 48px icon rail this file used to drive is gone — mobile has no
        // sidebar in the layout at all, which is the width this sweep is now
        // measuring. `navigateMobile` waits for the drawer to dismiss itself,
        // so the measurement below runs against the view, not the overlay.
        await navigateMobile(page, view)
        // Let the lazy view chunk resolve and layout settle before measuring.
        await page.waitForLoadState('networkidle')
        await page.waitForTimeout(250)

        await expectNoHorizontalOverflow(page, undefined, `${view} view @ ${profile.name}`)
      })
    }

    // Replaces "collapsed sidebar rail clips its content (no text bleed)".
    // That test pinned the rail at 48px and asserted it clipped its own
    // labels. The rail is retired: nothing is pinned to the edge, so instead
    // of measuring the rail we measure what replaced it — content occupying
    // the full viewport width. This is the assertion that fails if the rail
    // (or any other fixed left-edge chrome) comes back.
    test('no persistent sidebar chrome — content owns the full viewport width', async ({
      page,
    }) => {
      await waitForBoot(page)

      await expect(page.locator('[data-mobile-rail="true"]')).toHaveCount(0)
      // The layout spacer is the element that actually cost the width; the
      // rail could be removed while a stray gap kept reserving it.
      await expect(page.locator('[data-slot="sidebar-gap"]')).toHaveCount(0)
      // With the Sheet closed, no part of the sidebar is mounted at all.
      await expect(page.locator('[data-mobile="true"]')).toHaveCount(0)

      const viewportWidth = page.viewportSize()?.width ?? 0
      expect(viewportWidth).toBeGreaterThan(0)

      const inset = page.locator('[data-slot="sidebar-inset"]')
      await expect(inset).toBeVisible()
      const box = await inset.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { left: Math.round(r.left), width: Math.round(r.width) }
      })
      expect(box.left, 'content column must start at the viewport edge').toBe(0)
      expect(box.width, `content column is ${box.width}px of a ${viewportWidth}px viewport`).toBe(
        viewportWidth,
      )
    })

    // The rail was the only mobile nav affordance before the hamburger
    // existed; removing it without a replacement would strand the user. Pin
    // that the replacement is reachable, opens the drawer, and marks the
    // destination the user is on.
    test('the header hamburger opens a navigation drawer', async ({ page }) => {
      await waitForBoot(page)

      const trigger = page.getByTestId('mobile-sidebar-trigger')
      await expect(trigger).toBeVisible()
      // Coarse-pointer sizing: the trigger must meet the 44px WCAG target.
      const size = await trigger.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height) }
      })
      expect(size.w, 'hamburger width').toBeGreaterThanOrEqual(44)
      expect(size.h, 'hamburger height').toBeGreaterThanOrEqual(44)

      const sheet = await openMobileSidebar(page)
      // Every top-level destination is reachable from inside the drawer.
      for (const view of VIEWS) {
        await expect(sheet.getByRole('button', { name: view, exact: true })).toBeVisible()
      }
      // Journal is the boot view and must be marked as current.
      await expect(sheet.getByRole('button', { name: 'Journal', exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      )

      // Tapping a destination navigates AND dismisses the drawer.
      await sheet.getByRole('button', { name: 'Tags', exact: true }).click()
      await expect(sheet).toHaveCount(0)
      const reopened = await openMobileSidebar(page)
      await expect(reopened.getByRole('button', { name: 'Tags', exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      )
    })

    test('Keyboard Shortcuts dialog has no horizontal overflow', async ({ page }) => {
      await waitForBoot(page)
      const sheet = await openMobileSidebar(page)
      const shortcutsBtn = sheet.getByRole('button', { name: 'Shortcuts', exact: true })
      // Best-effort: if the trigger isn't reachable in this build, skip cleanly
      // rather than fail the sweep on an unrelated gap.
      if ((await shortcutsBtn.count()) === 0) {
        test.skip(true, 'Shortcuts trigger not present')
      }
      // The sidebar drawer dismisses itself before the dialog opens, so the
      // two overlays never stack (`AppSidebar`'s `dismissOnMobile`).
      await shortcutsBtn.click()
      await expect(sheet).toHaveCount(0)

      // useDialogOrSheet renders a Sheet on mobile; fall back to a role=dialog
      // if a plain dialog is used instead.
      const shortcutsSheet = activeSheet(page)
      const surface = (await shortcutsSheet.count()) > 0 ? shortcutsSheet : activeRoleDialog(page)
      await expect(surface).toBeVisible()
      await page.waitForTimeout(150)
      await expectNoHorizontalOverflow(page, surface, `Shortcuts dialog @ ${profile.name}`)
    })

    test('Pairing dialog (Settings → Sync) has no horizontal overflow', async ({ page }) => {
      await waitForBoot(page)
      await navigateMobile(page, 'Settings')

      // Open the "Sync & Devices" settings tab, which hosts DeviceManagement
      // (mono device-id row, peers list, "Pair New Device").
      const syncTab = page.getByRole('tab', { name: 'Sync & Devices', exact: true })
      await expect(syncTab).toBeVisible()
      await syncTab.click()
      await expect(page.getByTestId('settings-panel-sync')).toBeVisible()
      // The device id loads async; the pair button is gated on it.
      const pairBtn = page.locator('.device-pair-btn')
      await expect(pairBtn).toBeVisible()
      // The device-management panel itself must not overflow (long mono ids).
      await expectNoHorizontalOverflow(page, undefined, `Settings · Sync panel @ ${profile.name}`)

      // Open the pairing dialog and assert the entry-mode toggle (the row that
      // overflowed before #1966) stays within the dialog at this width.
      await pairBtn.click()
      // #3468 — on phones PairingDialog renders as a bottom Sheet
      // (`useDialogOrSheet('dialog')`, deliberate per #2665), so its content
      // carries `data-slot="sheet-content"`. This test used `activeDialog`
      // (`data-slot="dialog-content"`), which no phone-width run can ever
      // match, and timed out at both profiles while the pairing surface was
      // open and fully functional behind it. Every profile in this file is
      // below the 768px `useIsMobile` breakpoint, so the Sheet is the only
      // primitive in play — asserting it directly also keeps this test
      // honest about the mobile surface rather than accepting either one.
      const dialog = activeSheet(page)
      await expect(dialog).toBeVisible()

      // #3463: the dialog now opens directly on the host path (this
      // device's own code) — no upfront chooser — so the host surface is
      // measured as soon as it renders, without a click.
      await expect(
        dialog.getByRole('button', { name: /have a code from the other device/i }),
      ).toBeVisible()
      await page.waitForTimeout(150)
      await expectNoHorizontalOverflow(page, dialog, `Pairing dialog · host @ ${profile.name}`)

      // Then the joiner surface, which hosts the entry-mode toggle — reached
      // via the "Have a code from the other device?" affordance, which is
      // also what declares the joiner role (replacing the old chooser).
      await dialog.getByRole('button', { name: /have a code from the other device/i }).click()
      await expect(
        dialog.getByRole('button', { name: 'Type Passphrase', exact: true }),
      ).toBeVisible()
      await page.waitForTimeout(150)
      await expectNoHorizontalOverflow(page, dialog, `Pairing dialog · joiner @ ${profile.name}`)
    })

    // The only test in this file that materializes a PEER. Every other sync
    // assertion above runs against an empty device list, so `PeerListItem`'s
    // own layout was never measured — which is exactly how it shipped with
    // three `whitespace-nowrap` buttons needing 264px inside a 196px row.
    //
    // Measured, not eyeballed: the card used to be ~230px wide at a 360px
    // viewport (the 48px mobile rail plus panel and card padding took the
    // rest). The rail is gone, so the card is ~48px wider — the assertions
    // below hold with more headroom, not less, and are deliberately kept as
    // relative checks (fits its own box / name column above a floor) rather
    // than absolute pixel counts that would drift with layout changes.
    // `expectNoHorizontalOverflow(page)` alone is NOT sufficient here — a row
    // can overflow its own card without the document scrolling. The scrollWidth
    // assertion below is the one that fails on a regression.
    test('paired device row fits its card and does not overflow', async ({ page }) => {
      await waitForBoot(page)
      await navigateMobile(page, 'Settings')
      await page.getByRole('tab', { name: 'Sync & Devices', exact: true }).click()
      await expect(page.getByTestId('settings-panel-sync')).toBeVisible()
      const pairBtn = page.locator('.device-pair-btn')
      await expect(pairBtn).toBeVisible()

      // Drive the joiner path; the mock reveals the pinned peer after a couple
      // of `list_peer_refs` polls (PAIRING_PEER_POLL_INTERVAL_MS = 2000).
      await pairBtn.click()
      const sheet = activeSheet(page)
      await sheet.getByRole('button', { name: /have a code from the other device/i }).click()
      await sheet.getByRole('button', { name: 'Type Passphrase', exact: true }).click()
      const words = ['alpha', 'bravo', 'charlie', 'delta']
      const inputs = sheet.locator('input')
      for (const [i, word] of words.entries()) await inputs.nth(i).fill(word)
      await sheet.getByRole('button', { name: /^pair$/i }).click()

      const row = page.locator('[data-testid="settings-panel-sync"] .device-peer-item')
      await expect(row).toHaveCount(1, { timeout: 20000 })

      // The action cluster must not be wider than the space it is given.
      const actions = await page
        .locator('.device-peer-actions')
        .evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
      expect(
        actions.scrollWidth,
        `peer action buttons overflow their row at ${profile.name} ` +
          `(${actions.scrollWidth}px of content in ${actions.clientWidth}px)`,
      ).toBeLessThanOrEqual(actions.clientWidth)

      // The device name is the field the old layout starved to a few characters.
      const name = page.locator('.device-peer-name')
      await expect(name).toBeVisible()
      const nameBox = await name.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }))
      expect(
        nameBox.clientWidth,
        `device name column collapsed to ${nameBox.clientWidth}px at ${profile.name}`,
      ).toBeGreaterThan(80)

      await expectNoHorizontalOverflow(page, undefined, `Sync panel · paired @ ${profile.name}`)
    })

    // #4307 — the EMPTY-BLOCK PLACEHOLDER, the one piece of overflowing text in
    // this sweep that no other test could ever reach: it is a `::before`
    // pseudo-element, so the DOM walk in `expectNoHorizontalOverflow` (which
    // enumerates real ELEMENTS) can never enumerate it. It has to be measured
    // through `getComputedStyle(p, '::before')`, which is what this test does.
    //
    // The regression, MEASURED at 360px rather than assumed: the rule carried
    // TipTap's stock `float: left; height: 0`. A float is shrink-to-fit, so the
    // placeholder box was 204px — exactly the paragraph's content width — and
    // the 88-character hint WRAPPED to three lines inside it. But `height: 0`
    // meant that box contributed no height at all, so the block stayed one line
    // (24px) tall while the other two lines of placeholder painted straight
    // down over whatever followed. The spill is VERTICAL, not horizontal, which
    // is why every existing horizontal-overflow assertion in this file stayed
    // green through the bug.
    //
    // Hence the shape of the assertions: the placeholder's own box must be
    // NON-DEGENERATE (a zero-height box that still paints text IS the bug) and
    // must FIT INSIDE the paragraph in both axes. Measured values with the fix
    // in place: `::before` is 204×24 inside a 204×24 paragraph whose
    // line-height is 24px. Before it: 204×0.
    //
    // Two guards against over-correcting:
    //   - the empty row must not be TALLER than the very same row holding one
    //     line of text (putting the placeholder back in flow to let the box
    //     "grow to fit" would triple every empty block's height on a phone and
    //     make the caret jump a line every time you press Enter), and
    //   - the caret must still sit at the paragraph's content-box start.
    //     ProseMirror marks that position with `<br>`, so its left edge is a
    //     stable, measurable proxy for where the caret renders. `float`+`h-0`
    //     kept the caret at x=0 by never shortening the line box; `position:
    //     absolute` keeps it there by being out of flow entirely. A naive fix
    //     that drops the float without replacing it fails here.
    test('an empty block placeholder stays inside its block box', async ({ page }) => {
      await waitForBoot(page)
      await expect(page.locator('[data-testid="block-static"]').first()).toBeVisible()

      const editor = await focusBlock(page, 0)
      const row = page
        .locator('[data-testid="sortable-block"]:has([data-testid="block-editor"])')
        .first()
      const rowHeight = () =>
        row.evaluate((el) => Math.round(el.getBoundingClientRect().height * 100) / 100)

      // Baseline: one short line of real text — the height a single-line block
      // is SUPPOSED to have at this width.
      await editor.fill('x')
      await expect(editor).toHaveText('x')
      const filledHeight = await rowHeight()

      // Empty it: TipTap's Placeholder extension flags the paragraph and the
      // long `editor.emptyBlockPlaceholder` hint renders through `::before`.
      await editor.fill('')
      const para = page
        .locator('[data-testid="block-editor"] .ProseMirror p.is-editor-empty')
        .first()
      await expect(para).toBeVisible()
      // Guard the guard: an empty `data-placeholder` would make every
      // measurement below trivially pass.
      await expect(para).toHaveAttribute('data-placeholder', /.{40,}/)

      const box = await para.evaluate((el) => {
        const before = getComputedStyle(el, '::before')
        return {
          beforeWidth: Number.parseFloat(before.width),
          beforeHeight: Number.parseFloat(before.height),
          clientWidth: el.clientWidth,
          clientHeight: el.clientHeight,
        }
      })

      expect(
        box.beforeHeight,
        `the empty-block placeholder has a ZERO-height box at ${profile.name} — ` +
          `it paints ${box.beforeWidth}px of wrapped text out of a 0px-tall box, ` +
          `straight over the content below`,
      ).toBeGreaterThan(0)
      expect(
        box.beforeHeight,
        `the empty-block placeholder is taller than its paragraph at ` +
          `${profile.name} (${box.beforeHeight}px in ${box.clientHeight}px)`,
      ).toBeLessThanOrEqual(box.clientHeight + 1)
      expect(
        box.beforeWidth,
        `the empty-block placeholder is wider than its paragraph at ` +
          `${profile.name} (${box.beforeWidth}px in ${box.clientWidth}px)`,
      ).toBeLessThanOrEqual(box.clientWidth + 1)

      const emptyHeight = await rowHeight()
      expect(
        emptyHeight,
        `an EMPTY block is taller than the same block holding one line of text ` +
          `at ${profile.name} (${emptyHeight}px vs ${filledHeight}px) — the ` +
          `placeholder is back in flow`,
      ).toBeLessThanOrEqual(filledHeight + 1)

      // Caret stays at the start of the empty block (placeholder out of flow).
      const caretOffset = await para.evaluate((el) => {
        const br = el.querySelector('br')
        if (!br) return null
        const style = getComputedStyle(el)
        const contentLeft = el.getBoundingClientRect().left + Number.parseFloat(style.paddingLeft)
        return br.getBoundingClientRect().left - contentLeft
      })
      expect(
        caretOffset,
        'no ProseMirror trailing break found in the empty paragraph',
      ).not.toBeNull()
      expect(
        Math.abs(caretOffset ?? 0),
        `caret shifted off the start of an empty block at ${profile.name} ` +
          `(${caretOffset}px) — the placeholder is shortening the line box`,
      ).toBeLessThanOrEqual(1)

      await expectNoHorizontalOverflow(page, undefined, `empty block @ ${profile.name}`)
    })
  })
}
