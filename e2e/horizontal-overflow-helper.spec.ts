/**
 * Browser-level contract tests for `expectNoHorizontalOverflow` (#3540).
 *
 * Synthetic layout keeps these cases focused on real Chromium geometry. In
 * particular, the nested clip makes the assertion root report equal scroll
 * and client widths even while the clipped child's box extends past it.
 */

import { expect, expectNoHorizontalOverflow, test } from './helpers'

const ROOT_STYLE = 'position:relative;width:200px;height:100px;overflow:hidden;background:white'
const CONTAINER_STYLE =
  'position:absolute;left:150px;top:0;width:50px;height:50px;overflow-x:hidden'
const OFFENDER_STYLE = 'width:100px;height:20px'

async function installFixture(
  page: Parameters<typeof expectNoHorizontalOverflow>[0],
  options: {
    clipOverflow?: 'hidden' | 'clip' | 'visible' | 'auto' | 'scroll'
    markClip?: boolean
    markRoot?: boolean
    clipWidth?: number
  } = {},
): Promise<void> {
  const { clipOverflow = 'hidden', markClip = false, markRoot = false, clipWidth = 50 } = options

  await page.setContent(`
    <main
      data-testid="overflow-root"
      ${markRoot ? 'data-overflow-clip="intentional"' : ''}
      style="${ROOT_STYLE}"
    >
      <section
        data-testid="clip"
        ${markClip ? 'data-overflow-clip="intentional"' : ''}
        style="${CONTAINER_STYLE};width:${clipWidth}px;overflow-x:${clipOverflow}"
      >
        <div data-testid="offender" style="${OFFENDER_STYLE}">overflow probe</div>
      </section>
    </main>
  `)
}

test('unmarked hard clip remains an overflow failure when root widths look safe', async ({
  page,
}) => {
  await installFixture(page)
  const root = page.getByTestId('overflow-root')

  await expect
    .poll(() => root.evaluate((element) => [element.scrollWidth, element.clientWidth]))
    .toEqual([200, 200])
  await expect(expectNoHorizontalOverflow(page, root, 'unmarked clip')).rejects.toThrow(
    /Horizontal overflow on unmarked clip/,
  )
})

for (const overflow of ['hidden', 'clip'] as const) {
  test(`explicit ${overflow} clip suppresses only its clipped descendants`, async ({ page }) => {
    await installFixture(page, { markClip: true, clipOverflow: overflow })
    const root = page.getByTestId('overflow-root')

    await expectNoHorizontalOverflow(page, root, `marked ${overflow} clip`)
  })
}

for (const overflow of ['auto', 'scroll'] as const) {
  test(`existing ${overflow} scroller suppression remains intact`, async ({ page }) => {
    await installFixture(page, { clipOverflow: overflow })
    const root = page.getByTestId('overflow-root')

    await expectNoHorizontalOverflow(page, root, `${overflow} scroller`)
  })
}

test('marker with visible overflow does not suppress a descendant', async ({ page }) => {
  await installFixture(page, { markClip: true, clipOverflow: 'visible' })
  const root = page.getByTestId('overflow-root')

  await expect(expectNoHorizontalOverflow(page, root, 'visible marker')).rejects.toThrow(
    /Horizontal overflow on visible marker/,
  )
})

test('marker on the assertion target cannot opt the whole surface out', async ({ page }) => {
  await installFixture(page, { markRoot: true })
  const root = page.getByTestId('overflow-root')

  await expect(expectNoHorizontalOverflow(page, root, 'marked target')).rejects.toThrow(
    /Horizontal overflow on marked target/,
  )
})

test('marked clip container itself remains measurable when it overflows', async ({ page }) => {
  await installFixture(page, { markClip: true, clipWidth: 100 })
  const root = page.getByTestId('overflow-root')

  await expect(expectNoHorizontalOverflow(page, root, 'overflowing marked clip')).rejects.toThrow(
    /Horizontal overflow on overflowing marked clip/,
  )
})
