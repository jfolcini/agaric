/**
 * E2E coverage for the Spaces flagship feature (#2684) — switching,
 * creating, renaming, recolouring, deleting, and moving pages between
 * spaces, plus per-space content isolation.
 *
 * Before this spec the ONLY e2e coverage for spaces was
 * `spaces-coverage.spec.ts` (page creation routes through
 * `create_page_in_space`) and a `keyboard-collisions.spec.ts` test that
 * documents Ctrl+1 as a deliberate no-op because the mock seeded exactly
 * ONE space (`list_spaces` returned a hardcoded `[SPACE_PERSONAL]`
 * array). No spec ever created or switched to a second space, so a
 * regression in the switcher, the space-scoping filter, or the
 * create/rename/recolour/delete/move flows could pass the whole suite.
 *
 * Mock changes required (documented, not faked — see #2684's own
 * adversarial verification, which flagged this as necessary):
 *
 *   - `list_spaces` (src/lib/tauri-mock/handlers.ts) was a hardcoded
 *     one-element array. It now ALSO scans `blocks` for any
 *     `is_space='true'` block, so a space created via `create_space`
 *     during a test is actually discoverable on the next refresh.
 *   - `create_space` wrote `is_space` / `accent_color` to the op log
 *     only, never to the queryable `properties` map `list_spaces` reads.
 *     It now writes both, mirroring every other `set_property`-style
 *     handler in the file.
 *
 * Both changes are purely additive (the handlers were previously
 * write-only / unreachable) and do not touch the seeded `SPACE_PERSONAL`
 * entry's own behaviour, so no other spec's assumptions change.
 *
 * Documented (not implemented) gaps — cite the exact mechanism, no fakes:
 *
 *   1. **Delete-after-emptying a space** (suggested scenario "delete is
 *      blocked for a non-empty space and allowed after moving pages out")
 *      is NOT exercisable. `SpaceManageDialog`'s emptiness probe calls
 *      `listBlocks({ blockType: 'page', spaceId })`
 *      (src/components/SpaceManageDialog.tsx); the mock's `list_blocks`
 *      handler (src/lib/tauri-mock/handlers.ts:1278) ignores the
 *      `scope`/`spaceId` argument entirely and returns EVERY non-deleted
 *      page block in the whole mock vault. Because seed pages always
 *      exist, `items.length` is never 0 for ANY space — `emptiness` is
 *      permanently `false` and Delete stays disabled no matter how many
 *      pages actually live in the target space. Rewriting `list_blocks`
 *      to honour `scope` is out of scope here: it is a generic,
 *      widely-reused handler (agenda, trash-adjacent queries, the "[["
 *      picker, …) and many existing specs depend on its current
 *      deliberately-unscoped "return everything" behaviour — narrowing it
 *      is a wide-blast-radius change that belongs in its own PR. The test
 *      below asserts the CURRENT (limited) mock behaviour honestly,
 *      labelled as such.
 *   2. **Cross-space `[[link]]` broken-link chip** (docs/features/spaces.md:47,
 *      "renders as a broken-link chip … click removes it, Ctrl+Z
 *      restores") has no locatable implementation to exercise. The two
 *      i18n strings the doc's behaviour implies —
 *      `editor.brokenLinkTooltip` / `editor.brokenLinkRemoved`
 *      (src/lib/i18n/editor.ts) — are defined but never referenced
 *      anywhere else in `src/` (grepped `brokenLink` repo-wide); the
 *      editable `block_link` TipTap extension's `resolveStatus` option is
 *      explicitly commented "Phase 4 — no-op; kept for test backward
 *      compat" (src/editor/extensions/block-link.ts). A foreign-space
 *      `[[link]]` currently resolves through the same "deleted" cache
 *      placeholder path as any missing target
 *      (src/hooks/useBlockLinkResolve.ts) with no distinct undo-friendly
 *      removal UI found. This looks like a pre-existing product-doc /
 *      code mismatch, independent of this e2e task's scope — not
 *      attempted here.
 */

import { expect, openPage, test, waitForBoot } from './helpers'

const SWITCH_SPACE = 'Switch space'
const MANAGE_SPACES = 'Manage spaces…'

/** Click the sidebar "Pages" nav button, without asserting on the grid. */
async function clickPagesNav(page: import('@playwright/test').Page) {
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole('button', { name: 'Pages', exact: true })
    .click()
}

/**
 * Open the Pages view and wait for the (non-empty) grid to render. A
 * space with zero pages hides the ARIA grid behind an empty-state
 * placeholder instead — use `clickPagesNav` directly for that case.
 */
async function openPagesView(page: import('@playwright/test').Page) {
  await clickPagesNav(page)
  await expect(page.getByRole('grid')).toBeVisible()
}

/** Open the SpaceSwitcher dropdown and select an option by its accessible name. */
async function selectSwitcherOption(
  page: import('@playwright/test').Page,
  name: string,
): Promise<void> {
  await page.getByRole('combobox', { name: SWITCH_SPACE, exact: true }).click()
  // The trigger wraps a hover Tooltip ("Tip: Ctrl+1-9 to switch spaces",
  // `delayDuration = 0` — src/components/ui/tooltip.tsx). Clicking the
  // trigger also hovers it, and its Radix popper occasionally renders on top
  // of the now-open SelectContent option list, intercepting the click below
  // (observed flake). Move the mouse off the trigger first so the tooltip
  // closes before selecting an option.
  await page.mouse.move(0, 0)
  await page.getByRole('option', { name, exact: true }).click()
}

/** Switch the active space via the sidebar SpaceSwitcher. */
async function switchToSpace(page: import('@playwright/test').Page, name: string): Promise<void> {
  await selectSwitcherOption(page, name)
}

/**
 * Open Manage Spaces, create a space with the given name via the inline
 * create form, and leave the dialog open (returns its locator). The new
 * row's presence is asserted before returning.
 */
async function createSpaceViaDialog(
  page: import('@playwright/test').Page,
  name: string,
): Promise<import('@playwright/test').Locator> {
  await selectSwitcherOption(page, MANAGE_SPACES)
  const dialog = page.getByTestId('space-manage-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Create new space', exact: true }).click()
  await dialog.getByPlaceholder('New space name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  // The new row's name lives inside an `<input value=…>` (SpaceNameEditor),
  // not a text node — `getByText` never matches it. Assert via the input's
  // value instead. `.last()` assumes `name` sorts alphabetically AFTER
  // "Personal" (rows render in `list_spaces`'s alphabetical order, #2684)
  // — true for every caller in this file ("Work", "Work Renamed").
  await expect(dialog.getByRole('textbox', { name: 'Rename space' }).last()).toHaveValue(name)
  return dialog
}

/** Close the Manage Spaces dialog via its built-in close button. */
async function closeManageDialog(page: import('@playwright/test').Page): Promise<void> {
  const dialog = page.getByTestId('space-manage-dialog')
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).not.toBeVisible()
}

test.describe('Spaces — create, switch, content isolation', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('creating a space via Manage Spaces adds it to the switcher and switching re-scopes the Pages list', async ({
    page,
  }) => {
    // Baseline: the seeded "Getting Started" page is visible in Personal.
    await openPagesView(page)
    await expect(
      page.locator('[data-page-item]').filter({ hasText: 'Getting Started' }),
    ).toBeVisible()

    await createSpaceViaDialog(page, 'Work')
    await closeManageDialog(page)

    // The switcher trigger now lists Work as a selectable option.
    await page.getByRole('combobox', { name: SWITCH_SPACE, exact: true }).click()
    await expect(page.getByRole('option', { name: 'Work', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')

    await switchToSpace(page, 'Work')

    // Top accent stripe now reflects the new active space, not the seed.
    await expect(page.getByTestId('space-top-stripe')).not.toHaveAttribute(
      'data-space-id',
      'SPACE_PERSONAL',
    )

    // Content isolation: Work is a brand-new space, so the Personal-only
    // seed pages are gone from its Pages list. Work has ZERO pages at
    // this point, so the grid itself is hidden behind an empty-state
    // placeholder — use the plain nav click, not `openPagesView`.
    await clickPagesNav(page)
    await expect(
      page.locator('[data-page-item]').filter({ hasText: 'Getting Started' }),
    ).toHaveCount(0)
    await expect(page.locator('[data-page-item]').filter({ hasText: 'Quick Notes' })).toHaveCount(0)

    // A page created while Work is active lands in Work, not Personal.
    await page.getByRole('button', { name: 'Journal', exact: true }).click()
    await expect(page.locator('[data-testid="block-tree"]').first()).toBeVisible()
    const todayStr = await page.evaluate(() => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    })
    await openPagesView(page)
    await expect(
      page.locator('[data-page-item]').filter({ hasText: new RegExp(todayStr) }),
    ).toBeVisible()

    // Switching back to Personal hides Work's journal page and restores
    // Personal's seed pages — isolation holds in both directions.
    await switchToSpace(page, 'Personal')
    await openPagesView(page)
    await expect(
      page.locator('[data-page-item]').filter({ hasText: 'Getting Started' }),
    ).toBeVisible()
  })

  test('Ctrl+2 switches to the second space by alphabetical index', async ({ page }) => {
    await createSpaceViaDialog(page, 'Work')
    await closeManageDialog(page)

    // "Personal" < "Work" alphabetically, so Personal is Ctrl+1 (current
    // space, no-op — see keyboard-collisions.spec.ts) and Work is Ctrl+2.
    await page.keyboard.press('Control+2')

    await expect(page.getByRole('combobox', { name: SWITCH_SPACE, exact: true })).toContainText(
      'Work',
    )
    await expect(page.getByTestId('space-top-stripe')).not.toHaveAttribute(
      'data-space-id',
      'SPACE_PERSONAL',
    )
  })
})

test.describe('Spaces — rename, recolour, delete', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('renaming and recolouring a newly created space updates the switcher and the top accent stripe', async ({
    page,
  }) => {
    const dialog = await createSpaceViaDialog(page, 'Work')

    // Rows render alphabetically (list_spaces sorts by name, #2684):
    // Personal (0), Work (1).
    const workRow = dialog.locator('[data-slot="space-manage-row"]').nth(1)
    const nameInput = workRow.getByRole('textbox', { name: 'Rename space' })
    await expect(nameInput).toHaveValue('Work')

    // Recolour to rose FIRST — `SpaceAccentPicker` writes the property
    // straight to the mock (`setProperty`) but, unlike rename/delete/
    // create, never calls `onRefresh()` (see its file-header comment:
    // "nothing flows back up … refreshAvailableSpaces picks it up via
    // the next list_spaces call"). Renaming right after DOES call
    // `onRefresh()`, so doing the rename SECOND is what actually
    // refreshes the space store with both the new name AND the new
    // accent in one shot — reordering these two steps would leave the
    // switcher/stripe assertions below reading the stale accent.
    const roseSwatch = workRow.getByRole('button', { name: 'Use rose accent', exact: true })
    await roseSwatch.click()
    await expect(roseSwatch).toHaveAttribute('aria-pressed', 'true')

    await nameInput.fill('Work Renamed')
    await nameInput.press('Enter')
    await expect(nameInput).toHaveValue('Work Renamed')

    await closeManageDialog(page)

    await switchToSpace(page, 'Work Renamed')

    // Switcher's accent dot and the top stripe both carry the new token.
    await expect(page.getByTestId('space-switcher-accent-dot')).toHaveAttribute(
      'style',
      /accent-rose/,
    )
    await expect(page.getByTestId('space-top-stripe')).toHaveAttribute('style', /accent-rose/)
  })

  test('delete is blocked for the sole seeded space, and (documented mock limitation) for a freshly created space too', async ({
    page,
  }) => {
    // Sole space: the last-space guard disables Delete outright.
    await selectSwitcherOption(page, MANAGE_SPACES)
    const dialog = page.getByTestId('space-manage-dialog')
    await expect(dialog.getByRole('button', { name: 'Delete space', exact: true })).toBeDisabled()

    // Create a second, never-populated space. In the real backend this
    // would be immediately deletable; under this mock it is not — see the
    // file-header comment (`list_blocks` ignores `scope`, so the
    // emptiness probe always sees the globally-seeded pages and reports
    // "non-empty" for every space). Asserting the CURRENT behaviour here,
    // not the real one.
    await dialog.getByRole('button', { name: 'Create new space', exact: true }).click()
    await dialog.getByPlaceholder('New space name').fill('Empty Space')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    // Rows render alphabetically (#2684): "Empty Space" < "Personal", so
    // the new row is first.
    const newRow = dialog.locator('[data-slot="space-manage-row"]').first()
    await expect(newRow.getByRole('textbox', { name: 'Rename space' })).toHaveValue('Empty Space')
    await expect(newRow.getByRole('button', { name: 'Delete space', exact: true })).toBeDisabled()
    await expect(newRow.getByTestId('space-delete-blocked-hint')).toBeVisible()
  })
})

test.describe('Spaces — move a page between spaces', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Move to space relocates a page — it disappears from the origin space and appears in the destination', async ({
    page,
  }) => {
    await createSpaceViaDialog(page, 'Work')
    await closeManageDialog(page)

    await openPage(page, 'Getting Started')
    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Move to space', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Work', exact: true }).click()
    await expect(page.getByText('Page moved to Work', { exact: true })).toBeVisible()

    // #2785: moving the CURRENTLY-VIEWED page no longer reloads it under
    // the stale old-space scope (which raised a spurious "Failed to load
    // blocks" toast); PageHeader.handleMoveToSpace now navigates back
    // instead, mirroring the delete flow. The editor closes and no error
    // toast appears.
    await expect(page.locator('[aria-label="Page title"]')).not.toBeVisible()
    await expect(page.getByText('Failed to load blocks', { exact: true })).not.toBeVisible()

    // Origin (Personal): the page is gone from the Pages list.
    await openPagesView(page)
    await expect(
      page.locator('[data-page-item]').filter({ hasText: 'Getting Started' }),
    ).toHaveCount(0)

    // Destination (Work): the page now shows up.
    await switchToSpace(page, 'Work')
    await openPagesView(page)
    await expect(
      page.locator('[data-page-item]').filter({ hasText: 'Getting Started' }),
    ).toBeVisible()
  })
})
