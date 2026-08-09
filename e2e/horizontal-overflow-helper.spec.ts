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

// ---------------------------------------------------------------------------
// Containing-block property coverage (#3609).
//
// `establishesContainingBlock` decides where an abs-positioned node's clipping
// chain starts. Under-reporting a property makes the walk skip PAST the real
// containing block, so a marked clip that genuinely hides the node is never
// consulted and the guard reports a phantom offender. Over-reporting does the
// mirror damage: the walk stops at a box that does NOT clip the node, and a
// real overflow is suppressed.
//
// Note the asymmetry these fixtures encode. Adding a property to the predicate
// can only move the chain's start point DOWN (closer to the node), and the
// remaining walk still visits every ancestor above it — so a new property can
// only ever make the guard suppress MORE, never flag more. That is why the
// "before" state of each new property is a guard that FLAGS a genuinely
// clipped node, and the fixtures below assert non-rejection.
//
// Both property questions were settled by measurement in Chromium 151, not by
// reading prose (both directions of the `container-type` claim were tested):
//
//   backdrop-filter: blur(2px)     abs child resolves against it   → IS a CB
//   will-change: backdrop-filter   abs child resolves against it   → IS a CB
//   contain: layout                abs child resolves against it   → IS a CB
//   container-type: inline-size    abs child resolves against ICB  → NOT a CB
//   container-type: size           abs child resolves against ICB  → NOT a CB
// ---------------------------------------------------------------------------

/** Right edge of the element under `data-testid`, and the id painted there. */
async function paintedAtOffenderRightEdge(page: Parameters<typeof expectNoHorizontalOverflow>[0]) {
  return page.getByTestId('offender').evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return document
      .elementFromPoint(Math.min(window.innerWidth - 1, rect.right - 2), rect.top + rect.height / 2)
      ?.getAttribute('data-testid')
  })
}

/**
 * Whether the offender's box actually escapes the assertion root's right edge
 * — i.e. whether the guard had anything to suppress in the first place.
 *
 * The suppression fixtures below assert NON-rejection, which is the vacuous
 * shape: "no offenders" is also what you get from a fixture that has rotted
 * into harmlessness. `paintedAtOffenderRightEdge` catches the common rot (the
 * offender shrinks back inside the clip) but not a degenerate one — collapse
 * the offender to zero area and the guard skips it outright (`r.width === 0`),
 * so every other assertion here still passes. This states the precondition
 * directly, mirroring the guard's own 1px TOLERANCE.
 */
async function offenderEscapesRoot(page: Parameters<typeof expectNoHorizontalOverflow>[0]) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="overflow-root"]') as Element
    const offender = document.querySelector('[data-testid="offender"]') as Element
    const rect = offender.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.right > root.getBoundingClientRect().right + 1
  })
}

/** Whether the offender's abs position resolved against `clip`'s box. */
async function offenderIsPlacedByClip(page: Parameters<typeof expectNoHorizontalOverflow>[0]) {
  return page.evaluate(() => {
    const clip = document.querySelector('[data-testid="clip"]') as Element
    const offender = document.querySelector('[data-testid="offender"]') as Element
    return offender.getBoundingClientRect().left === clip.getBoundingClientRect().left
  })
}

test('marked clip whose containing block comes only from backdrop-filter suppresses its abs descendant', async ({
  page,
}) => {
  // `clip` is `position: static` with no transform/filter/contain — the ONLY
  // property making it a containing block is `backdrop-filter` (Filter Effects
  // 2 gives a non-`none` `backdrop-filter` the same containing-block powers as
  // `filter`). `offender` is therefore laid out inside `clip` and hard-clipped
  // by its `overflow-x: hidden`, so the marker genuinely applies to it.
  await page.setContent(`
    <main
      data-testid="overflow-root"
      style="position:relative;width:200px;height:100px;overflow:hidden;background:white"
    >
      <section
        data-testid="clip"
        data-overflow-clip="intentional"
        style="position:static;backdrop-filter:blur(2px);margin-left:150px;width:50px;height:50px;overflow-x:hidden"
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

  // Ground truth 0: there is a real overflow here for the guard to suppress.
  expect(await offenderEscapesRoot(page)).toBe(true)
  // Ground truth 1: the abs child really is placed by `clip` (its left edge
  // coincides with `clip`'s), i.e. Chromium does treat `backdrop-filter` as
  // establishing a containing block. Without this the test would prove nothing
  // about the guard.
  expect(await offenderIsPlacedByClip(page)).toBe(true)
  // Ground truth 2: it is genuinely invisible past `clip`'s edge — something
  // other than the offender paints there.
  expect(await paintedAtOffenderRightEdge(page)).not.toBe('offender')

  await expectNoHorizontalOverflow(page, root, 'backdrop-filter containing block')
})

test('marked clip whose containing block comes only from will-change: backdrop-filter suppresses its abs descendant', async ({
  page,
}) => {
  // `will-change: backdrop-filter` promotes the box the same way, and the token
  // is NOT matched by a `will-change` list check that only looks for
  // `transform`/`filter`/`perspective` — `'backdrop-filter' !== 'filter'`.
  await page.setContent(`
    <main
      data-testid="overflow-root"
      style="position:relative;width:200px;height:100px;overflow:hidden;background:white"
    >
      <section
        data-testid="clip"
        data-overflow-clip="intentional"
        style="position:static;will-change:backdrop-filter;margin-left:150px;width:50px;height:50px;overflow-x:hidden"
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

  expect(await offenderEscapesRoot(page)).toBe(true)
  expect(await offenderIsPlacedByClip(page)).toBe(true)
  expect(await paintedAtOffenderRightEdge(page)).not.toBe('offender')

  await expectNoHorizontalOverflow(page, root, 'will-change backdrop-filter containing block')
})

test('backdrop-filter: none does not make a marked clip suppress an escaping abs descendant', async ({
  page,
}) => {
  // Must-still-fail companion to the two fixtures above. The computed value of
  // `backdrop-filter` on an unfiltered element is the non-empty string
  // `'none'`, so a predicate written as `if (style.backdropFilter) return true`
  // would treat EVERY element as a containing block and silently swallow real
  // overflow. Here `clip` is static and unfiltered, so `offender` escapes it to
  // the initial containing block and is genuinely painted on the page.
  await page.setContent(`
    <main
      data-testid="overflow-root"
      style="position:static;width:200px;height:100px;overflow:visible;background:white;margin-left:20px"
    >
      <section
        data-testid="clip"
        data-overflow-clip="intentional"
        style="position:static;backdrop-filter:none;overflow-x:hidden;width:50px;height:50px"
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

  expect(await offenderIsPlacedByClip(page)).toBe(false)
  expect(await paintedAtOffenderRightEdge(page)).toBe('offender')

  await expect(expectNoHorizontalOverflow(page, root, 'unfiltered marker')).rejects.toThrow(
    /Horizontal overflow on unfiltered marker/,
  )
})

test('container-type does NOT establish a containing block, so a marked query container cannot suppress an escaping abs descendant', async ({
  page,
}) => {
  // #3609 proposed treating `container-type: size | inline-size` as
  // containing-block-establishing (on the old "it applies layout containment"
  // reading). Measurement says otherwise: the CSSWG resolved that
  // `container-type` forces only an independent formatting context (csswg
  // issue #10102), and Chromium implements that — abs descendants escape a
  // query container. So this stays a FLAGGED overflow, and this fixture is the
  // regression guard: adding `container-type` to the predicate turns it red.
  await page.setContent(`
    <main
      data-testid="overflow-root"
      style="position:static;width:200px;height:100px;overflow:visible;background:white;margin-left:20px"
    >
      <section
        data-testid="clip"
        data-overflow-clip="intentional"
        style="position:static;container-type:inline-size;overflow-x:hidden;width:50px;height:50px"
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

  // Ground truth 1: `container-type` is live on the clip, yet computed
  // `contain` reads `none` — a `contain`-only check cannot see query
  // containers at all, in either direction.
  const containment = await page.getByTestId('clip').evaluate((el) => {
    const style = getComputedStyle(el)
    return { contain: style.contain, containerType: style.containerType }
  })
  expect(containment).toEqual({ contain: 'none', containerType: 'inline-size' })
  // Ground truth 2: the abs child escaped the query container and is painted
  // outside it, so suppressing it here would hide a real overflow.
  expect(await offenderIsPlacedByClip(page)).toBe(false)
  expect(await paintedAtOffenderRightEdge(page)).toBe('offender')

  await expect(expectNoHorizontalOverflow(page, root, 'query container')).rejects.toThrow(
    /Horizontal overflow on query container/,
  )
})

// ---------------------------------------------------------------------------
// Independent transform properties and content-visibility (#3625).
//
// `establishesContainingBlock` used to ask only `transform !== 'none'`. The
// independent transform properties (`translate` / `scale` / `rotate`, CSS
// Transforms 2) establish a containing block while leaving computed
// `transform` at `none`, and `content-visibility: auto | hidden` does the same
// while leaving computed `contain` at `none`. Neither was visible to the
// predicate.
//
// Live in this repo, not theoretical: Tailwind v4 emits the LONGHANDS for its
// transform utilities and never `transform:`. Counted on this branch,
// `src/**` uses ~39 `scale-*`, ~18 `rotate-*`, ~18 `translate-x-*` and ~15
// `translate-y-*` utilities. A marked clip styled with any of them was
// invisible to the walk, so a genuinely clipped abs descendant under it was
// reported as a PHANTOM offender.
//
// Measured in Chromium 151 with the displacement probe (shift the clip by
// 30px, see whether the abs child moves with it) rather than read off prose,
// because the naive left-edge probe misreads a rotated containing block:
//
//   translate: 12px               child moves with the box  → IS a CB
//   scale: 0.95                   child moves with the box  → IS a CB
//   rotate: 45deg / 180deg        child moves with the box  → IS a CB
//   content-visibility: auto      child moves with the box  → IS a CB
//   content-visibility: hidden    child moves with the box  → IS a CB
//   will-change: translate        child moves with the box  → IS a CB
//   will-change: scale            child moves with the box  → IS a CB
//   will-change: rotate           child moves with the box  → IS a CB
//   will-change: contain          child moves with the box  → IS a CB
//   translate|scale|rotate: none  child resolves vs the ICB → NOT a CB
//   content-visibility: visible   child resolves vs the ICB → NOT a CB
//   will-change: content-visibility  child resolves vs ICB  → NOT a CB
//   will-change: opacity          child resolves vs the ICB → NOT a CB
//
// The last four are the must-still-flag companions below. They matter because
// each of these computed values is the NON-EMPTY string `'none'` / `'visible'`
// / `'auto'` on an unstyled element, so a predicate written as
// `if (style.translate)` would treat every element as a containing block and
// silently swallow real overflow — the exact bug the `backdrop-filter: none`
// fixture already guards against for its own property.
// ---------------------------------------------------------------------------

/**
 * Marked hard clip near the root's right edge with an abs child that spills
 * past it. `clipDecl` is the ONLY thing that can make `clip` a containing
 * block — it is `position: static` with no transform/filter/contain otherwise.
 * `clipMarginLeft` exists so a case that shifts the clip's own box (translate)
 * can keep the clip itself inside the root; a clip that escapes the root is
 * flagged in its own right (see "marked clip container itself remains
 * measurable"), which would make the fixture red for the wrong reason.
 */
async function installContainingBlockFixture(
  page: Parameters<typeof expectNoHorizontalOverflow>[0],
  clipDecl: string,
  clipMarginLeft = 150,
): Promise<void> {
  await page.setContent(`
    <main
      data-testid="overflow-root"
      style="position:relative;width:200px;height:100px;overflow:hidden;background:white"
    >
      <section
        data-testid="clip"
        data-overflow-clip="intentional"
        style="position:static;margin-left:${clipMarginLeft}px;width:50px;height:50px;overflow-x:hidden;${clipDecl}"
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
}

for (const { label, decl, margin } of [
  { label: 'translate', decl: 'translate:12px', margin: 130 },
  { label: 'scale', decl: 'scale:0.95', margin: 150 },
  { label: 'content-visibility: auto', decl: 'content-visibility:auto', margin: 150 },
  { label: 'content-visibility: hidden', decl: 'content-visibility:hidden', margin: 150 },
  { label: 'will-change: translate', decl: 'will-change:translate', margin: 150 },
  { label: 'will-change: scale', decl: 'will-change:scale', margin: 150 },
  { label: 'will-change: rotate', decl: 'will-change:rotate', margin: 150 },
  { label: 'will-change: contain', decl: 'will-change:contain', margin: 150 },
] as const) {
  test(`marked clip whose containing block comes only from ${label} suppresses its abs descendant`, async ({
    page,
  }) => {
    await installContainingBlockFixture(page, decl, margin)
    const root = page.getByTestId('overflow-root')

    // Ground truth 0: there is a real overflow here for the guard to suppress
    // (and the offender has non-zero area, so the walk does not skip it).
    expect(await offenderEscapesRoot(page)).toBe(true)
    // Ground truth 1: Chromium really does place the abs child against `clip`,
    // i.e. `clip` really is its containing block. Without this the test would
    // prove nothing about the guard's reasoning.
    expect(await offenderIsPlacedByClip(page)).toBe(true)
    // Ground truth 2: and it is genuinely invisible past `clip`'s edge, so
    // suppressing it is the correct answer rather than a convenient one.
    expect(await paintedAtOffenderRightEdge(page)).not.toBe('offender')

    await expectNoHorizontalOverflow(page, root, `${label} containing block`)
  })
}

test('marked clip whose containing block comes only from a non-identity rotate suppresses its abs descendant', async ({
  page,
}) => {
  // `rotate` gets its own fixture because a real rotation moves the abs child
  // out from under the left-edge ground truth used above. Geometry, with the
  // root spanning [0, 200]: `clip` occupies [150, 200] (centre 175) and the
  // child is laid out at local x ∈ [-100, 0] → [50, 150]. A 180° rotation
  // about `clip`'s centre maps x ↦ 350 − x, so the child lands at [200, 300]:
  // 100px past the root's right edge, and fully outside `clip`'s own
  // `overflow-x: hidden` box, hence painted nowhere.
  //
  // Reusing the identity value `rotate: 0deg` would have been simpler and
  // still exercises the predicate (measured: `rotate: 0deg` computes to the
  // non-`none` string `'0deg'` and does establish a containing block), but the
  // utilities actually in `src/**` are `rotate-90` and `rotate-180`, so the
  // realistic value is the one worth pinning.
  await page.setContent(`
    <main
      data-testid="overflow-root"
      style="position:relative;width:200px;height:100px;overflow:hidden;background:white"
    >
      <section
        data-testid="clip"
        data-overflow-clip="intentional"
        style="position:static;rotate:180deg;margin-left:150px;width:50px;height:50px;overflow-x:hidden"
      >
        <div
          data-testid="offender"
          style="position:absolute;left:-100px;top:0;width:100px;height:20px"
        >
          overflow probe
        </div>
      </section>
    </main>
  `)
  const root = page.getByTestId('overflow-root')

  expect(await offenderEscapesRoot(page)).toBe(true)
  // Rotation-aware stand-in for `offenderIsPlacedByClip`: after a 180° turn
  // about `clip`'s box, a child laid out flush against `clip`'s LEFT edge from
  // the outside lands flush against its RIGHT edge. That coincidence is only
  // possible if the child resolved against `clip`; had it escaped to the
  // initial containing block it would sit at viewport x = −100 and never be
  // rotated at all.
  const placedByRotatedClip = await page.evaluate(() => {
    const clip = document.querySelector('[data-testid="clip"]') as Element
    const offender = document.querySelector('[data-testid="offender"]') as Element
    return (
      Math.abs(offender.getBoundingClientRect().left - clip.getBoundingClientRect().right) < 0.5
    )
  })
  expect(placedByRotatedClip).toBe(true)
  expect(await paintedAtOffenderRightEdge(page)).not.toBe('offender')

  await expectNoHorizontalOverflow(page, root, 'rotate containing block')
})

for (const { label, decl } of [
  { label: 'translate: none', decl: 'translate:none' },
  { label: 'scale: none', decl: 'scale:none' },
  { label: 'rotate: none', decl: 'rotate:none' },
  { label: 'content-visibility: visible', decl: 'content-visibility:visible' },
  { label: 'will-change: content-visibility', decl: 'will-change:content-visibility' },
  { label: 'will-change: opacity', decl: 'will-change:opacity' },
] as const) {
  test(`${label} does not make a marked clip suppress an escaping abs descendant`, async ({
    page,
  }) => {
    // Must-still-flag companions. `clip` is static and carries only the inert
    // value under test, so `offender` escapes to the initial containing block
    // and is genuinely painted on the page — flagging it is correct, and any
    // predicate that reads these computed strings as truthy (or treats
    // `will-change` as a blanket promotion) turns this red.
    await page.setContent(`
      <main
        data-testid="overflow-root"
        style="position:static;width:200px;height:100px;overflow:visible;background:white;margin-left:20px"
      >
        <section
          data-testid="clip"
          data-overflow-clip="intentional"
          style="position:static;overflow-x:hidden;width:50px;height:50px;${decl}"
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

    expect(await offenderIsPlacedByClip(page)).toBe(false)
    expect(await paintedAtOffenderRightEdge(page)).toBe('offender')

    await expect(expectNoHorizontalOverflow(page, root, `inert ${label}`)).rejects.toThrow(
      new RegExp(`Horizontal overflow on inert ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    )
  })
}

test('contain: layout marked clip still suppresses its abs descendant', async ({ page }) => {
  // Contrast case for the fixture above: real `contain` values DO establish a
  // containing block (measured: the abs child resolves against this box), and
  // unlike `container-type` they surface in computed `contain`. The pair
  // documents that the `container-type` omission is a deliberate distinction,
  // not an oversight in the `contain` regex.
  await page.setContent(`
    <main
      data-testid="overflow-root"
      style="position:relative;width:200px;height:100px;overflow:hidden;background:white"
    >
      <section
        data-testid="clip"
        data-overflow-clip="intentional"
        style="position:static;contain:layout;margin-left:150px;width:50px;height:50px;overflow-x:hidden"
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

  expect(await offenderEscapesRoot(page)).toBe(true)
  expect(await offenderIsPlacedByClip(page)).toBe(true)
  expect(await paintedAtOffenderRightEdge(page)).not.toBe('offender')

  await expectNoHorizontalOverflow(page, root, 'contain layout containing block')
})
