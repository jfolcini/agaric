import { expect, openPage, test, waitForBoot } from './helpers'

/**
 * E2E — Unlinked References "Link it" flow (#2711).
 *
 * `e2e/menus-popovers.spec.ts` and `e2e/inner-links.spec.ts` only ever touch
 * `getByTestId('linked-references')` as a popover host / layout anchor.
 * `UnlinkedReferences.tsx` — the panel that surfaces plain-text mentions of
 * a page's title and lets the user promote one into a real `[[link]]` — had
 * zero e2e coverage before this spec.
 *
 * No seed page mentions another page's title as plain (unlinked) text
 * (checked `src/lib/tauri-mock/seed.ts` — `seed.ts:457-465` explicitly
 * warns "Quick Notes is a SHARED fixture" other specs depend on, so it is
 * not edited here). Per the established e2e convention (`addBlock` in
 * `e2e/error-scenarios.spec.ts`, `focusBlock`/`saveBlock` in
 * `e2e/helpers.ts`), the mention is created at runtime through the real
 * editor — a genuine `create_block` IPC round trip — on the seeded
 * "Meetings" page, which mentions no other page title by default.
 *
 * Attribute-only production hook added for this spec:
 * `src/components/backlinks/UnlinkedReferences.tsx` gained
 * `data-testid="unlinked-references"` on its root `<section>`, matching the
 * sibling `LinkedReferences.tsx:301` convention (`linked-references`) —
 * the unlinked panel previously had no stable root selector at all.
 *
 * Structural limitation (documented, not tested around): `handleLinkIt`
 * (`UnlinkedReferences.tsx:187-262`) calls `edit_block` and then patches
 * ONLY its own TanStack query cache optimistically — the comment at
 * `UnlinkedReferences.tsx:229-231` states `edit_block` "emits no
 * `block:properties-changed`, so nothing else refetches". `LinkedReferences`
 * shares the same `queryClient` (`src/lib/query-client.ts`,
 * `staleTime: Infinity` / `gcTime: Infinity`, invalidated only by that
 * event). So within one test session the "Getting Started" page's
 * `LinkedReferences` panel will NOT show the freshly-created backlink group
 * — there is no invalidation trigger, and `page.reload()` cannot force a
 * refetch either, because the mock's entire block store is an in-memory JS
 * Map re-seeded from scratch on every page load (no persistence), which
 * would discard the newly created block along with everything else. What
 * IS asserted instead: the source block's rendered content becomes a real
 * link chip after "Link it" (proving the text rewrite happened), and the
 * occurrence disappears from Unlinked (the optimistic removal this
 * component's own query DOES support).
 */

async function addBlock(page: import('@playwright/test').Page, text: string) {
  await page.getByRole('button', { name: /add block/i }).click()
  const editor = page.getByRole('textbox', { name: 'Block editor' })
  await expect(editor).toBeVisible({ timeout: 5000 })
  await editor.pressSequentially(text, { delay: 30 })
  await editor.press('Enter')
  await expect(page.getByText(text)).toBeVisible()
}

test.describe('Unlinked references — link this occurrence', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a plain-text page-title mention appears under Unlinked References', async ({ page }) => {
    await openPage(page, 'Meetings')
    await addBlock(page, 'Getting Started has more onboarding tips for new teammates.')

    await openPage(page, 'Getting Started')
    const unlinked = page.getByTestId('unlinked-references')
    await expect(unlinked).toBeVisible()

    // Collapsed by default (UnlinkedReferences.tsx:70) — expand via the
    // header (class-scoped: the header's own accessible name is dynamic
    // count text, so a stable class selector avoids re-deriving it).
    await unlinked.locator('.unlinked-references-header').click()

    const row = unlinked
      .locator('.unlinked-reference-item')
      .filter({ hasText: 'Getting Started has more onboarding tips' })
    await expect(row).toBeVisible()
    await expect(row.locator('.link-it-button')).toBeVisible()
  })

  test('clicking "Link it" converts the mention to a real link and removes it from Unlinked', async ({
    page,
  }) => {
    await openPage(page, 'Meetings')
    await addBlock(page, 'Getting Started has more onboarding tips for new teammates.')

    await openPage(page, 'Getting Started')
    const unlinked = page.getByTestId('unlinked-references')
    await expect(unlinked).toBeVisible()
    await unlinked.locator('.unlinked-references-header').click()

    const row = unlinked
      .locator('.unlinked-reference-item')
      .filter({ hasText: 'Getting Started has more onboarding tips' })
    await expect(row).toBeVisible()

    await row.locator('.link-it-button').click()

    // Optimistic removal (UnlinkedReferences.tsx:232-256) — the row leaves
    // the list without a refetch/reload.
    await expect(row).toHaveCount(0)

    // Verify the underlying content actually changed: navigate to the
    // source page ("Meetings") and confirm the mention now renders as a
    // resolved link chip, exactly like the seeded [[ULID]] chips asserted
    // in e2e/inner-links.spec.ts:36. "Meetings" is now a RECENT page (we're
    // on "Getting Started"), so `openPage`'s `getByText(title, {exact})`
    // would strict-mode-collide between the QuickAccessBar recents chip and
    // the Pages-browser row (QuickAccessBar.tsx:60 excludes only the
    // CURRENTLY active page from recents, and "Meetings" isn't it anymore)
    // — go via the recents chip directly instead of reopening the browser.
    await page
      .getByTestId('quick-access-bar')
      .getByRole('button', { name: 'Meetings', exact: true })
      .click()
    await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
    await expect(
      page.locator('[data-testid="block-link-chip"]', { hasText: 'Getting Started' }),
    ).toBeVisible()
  })
})
