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

// ---------------------------------------------------------------------------
// Containing-block vs. DOM-ancestor meta-tests (#3603).
//
// The suppression walk above must follow the CSS *containing-block* chain
// for a `position: absolute` node, not its plain DOM-parent chain. Those two
// chains coincide for the fixtures above (nothing there is itself
// `position: absolute`), so they can't tell the two implementations apart.
// These fixtures are built specifically to diverge the two chains.
// ---------------------------------------------------------------------------

test('marked clip does NOT suppress an abs-positioned descendant whose containing block escapes it', async ({
  page,
}) => {
  // `clip` is `position: static`, so it does not establish a containing
  // block for `offender` (`position: absolute`) even though it is marked
  // `data-overflow-clip="intentional"` and hard-clips with `overflow-x:
  // hidden`. `offender`'s containing block resolves past `clip` and past
  // `root` (neither is positioned/contains a containing-block-establishing
  // property) all the way to the initial containing block, so `offender` is
  // genuinely painted on top of the page — not clipped by anything.
  await page.setContent(`
    <main
      data-testid="overflow-root"
      style="position:static;width:200px;height:100px;overflow:visible;background:white;margin-left:20px"
    >
      <section
        data-testid="clip"
        data-overflow-clip="intentional"
        style="position:static;overflow-x:hidden;width:50px;height:50px"
      >
        <div
          data-testid="offender"
          style="position:absolute;left:400px;top:0;width:100px;height:20px"
        >
          overflow probe
        </div>
      </section>
    </main>
  `)
  const root = page.getByTestId('overflow-root')
  const offender = page.getByTestId('offender')

  // Ground truth: confirm the offender is actually rendered (not clipped) at
  // its right edge before trusting the assertion result below — otherwise a
  // failure here would just be testing geometry, not the guard's reasoning.
  const paintedAtRightEdge = await offender.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return document
      .elementFromPoint(Math.min(window.innerWidth - 1, rect.right - 2), rect.top + rect.height / 2)
      ?.getAttribute('data-testid')
  })
  expect(paintedAtRightEdge).toBe('offender')

  await expect(expectNoHorizontalOverflow(page, root, 'escaped containing block')).rejects.toThrow(
    /Horizontal overflow on escaped containing block/,
  )
})

test('marked clip still suppresses an abs-positioned descendant that is genuinely its containing block', async ({
  page,
}) => {
  // `clip` is itself `position: absolute`, so it IS `offender`'s containing
  // block — and it hard-clips with `overflow-x: hidden`, so `offender` is
  // genuinely invisible past `clip`'s edge. A correct fix must still
  // suppress this case; flagging it would make the guard trigger-happy.
  await page.setContent(`
    <main
      data-testid="overflow-root"
      style="position:relative;width:200px;height:100px;overflow:hidden;background:white"
    >
      <section
        data-testid="clip"
        data-overflow-clip="intentional"
        style="position:absolute;left:150px;top:0;width:50px;height:50px;overflow-x:hidden"
      >
        <div
          data-testid="offender"
          style="position:absolute;left:0;top:0;width:100px;height:20px"
        >
          overflow probe
        </div>
      </section>
    </main>
  `)
  const root = page.getByTestId('overflow-root')

  await expectNoHorizontalOverflow(page, root, 'genuinely contained abs descendant')
})
