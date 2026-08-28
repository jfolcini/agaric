// ---------------------------------------------------------------------------
// Unit tests for the on-failure visibility diagnostic (#4428, review of #4449).
//
// These are VITEST tests, not WDIO specs — `wdio.conf.ts`'s `specs` glob is
// `./e2e-tauri/**/*.e2e.ts`, so nothing here is ever run by the weekly lane.
// They live in `e2e-tauri/` rather than `src/__tests__/` for one reason:
// `wdio.conf.ts` type-checks only under `tsconfig.wdio.json` (it needs
// `@wdio/globals/types` for `WebdriverIO.Config` and `browser`), and importing
// it from `src/**` would drag it into `tsconfig.app.json`, where those ambient
// types do not exist. `vitest.config.ts`'s `include` names this directory so
// the tests actually run.
//
// WHY THEY EXIST. Every function under test runs only AFTER a spec has already
// failed, and its only job is to tell a human which half failed. That makes a
// WRONG verdict strictly worse than no verdict: the ambiguity these functions
// exist to remove is exactly what a confident-but-wrong sentence re-creates,
// pointed the other way. The three failure shapes below each produced such a
// sentence in review, and each has a test here:
//
//   1. a `clickable`/`enabled` wait answered with a `displayed` verdict;
//   2. a document-wide `querySelector` resolving a DIFFERENT node than the
//      chained assertion targeted (`row.$('[data-testid="task-marker"]')`);
//   3. a hiding mechanism the four-property walk does not model, where the
//      engine's own `checkVisibility()` disagrees with it.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  explainVisibilityProbe,
  parseWaitFailure,
  probeVisibilityInPage,
  type VisibilityProbe,
} from '../wdio.conf'

/** A `present`, fully-visible, unremarkable probe — the baseline to perturb. */
function presentProbe(overrides: Partial<VisibilityProbe> = {}): VisibilityProbe {
  return {
    status: 'present',
    matchCount: 1,
    width: 120,
    height: 24,
    hiddenBy: [],
    checkVisibility: true,
    inViewport: true,
    blockedBy: [],
    ...overrides,
  }
}

describe('parseWaitFailure', () => {
  it('recovers a quote-laden selector and the `displayed` verb', () => {
    expect(
      parseWaitFailure(
        'element ("[data-testid="tag-item-wdio-tag"]") still not displayed after 60000ms',
      ),
    ).toEqual({ selector: '[data-testid="tag-item-wdio-tag"]', waitedFor: 'displayed' })
  })

  it('carries `clickable` through instead of flattening it to `displayed`', () => {
    // tag-roundtrip.e2e.ts:58 — `$('button*=Add Tag').waitForClickable(...)`,
    // in the very spec this diagnostic was written for.
    expect(
      parseWaitFailure('element ("button*=Add Tag") still not clickable after 30000ms'),
    ).toEqual({ selector: 'button*=Add Tag', waitedFor: 'clickable' })
  })

  it('carries `enabled` and `existing` through as themselves', () => {
    expect(parseWaitFailure('element ("#go") still not enabled after 5000ms')?.waitedFor).toBe(
      'enabled',
    )
    expect(parseWaitFailure('element ("#go") still not existing after 5000ms')?.waitedFor).toBe(
      'existing',
    )
  })

  it('keeps `displayed within viewport` whole — it is a stronger assertion', () => {
    expect(
      parseWaitFailure('element ("#go") still not displayed within viewport after 5000ms')
        ?.waitedFor,
    ).toBe('displayed within viewport')
  })

  it('ignores a reverse wait, whose verdicts would all come out inverted', () => {
    // helpers.ts:111 — `waitForExist({ reverse: true })` renders without `not`.
    expect(parseWaitFailure('element ("#modal") still existing after 30000ms')).toBeUndefined()
  })

  it('ignores states the probe cannot speak to, and non-wait failures', () => {
    expect(parseWaitFailure('element ("#go") still not stable after 5000ms')).toBeUndefined()
    expect(
      parseWaitFailure('task-marker aria-label never reflected a set todo state'),
    ).toBeUndefined()
    expect(parseWaitFailure('expected true to be false')).toBeUndefined()
  })
})

describe('probeVisibilityInPage', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('reports `absent` when nothing in the document matches', () => {
    expect(probeVisibilityInPage('[data-testid="nope"]')).toMatchObject({
      status: 'absent',
      matchCount: 0,
    })
  })

  it('reports `unsupported-selector` for WDIO`s non-CSS selectors', () => {
    // `button*=Add Tag` and the XPath unions throw inside `querySelectorAll`.
    expect(probeVisibilityInPage('button*=Add Tag').status).toBe('unsupported-selector')
    expect(probeVisibilityInPage('.//button[text()="Add"]').status).toBe('unsupported-selector')
  })

  it('counts EVERY document-wide match, which is the whole scope exposure', () => {
    // The shape of reserved-property-roundtrip.e2e.ts:63: the row the
    // assertion scoped to has no marker, two other blocks on the page do.
    document.body.innerHTML = `
      <li data-block-id="wanted"></li>
      <li data-block-id="other-1"><span data-testid="task-marker"></span></li>
      <li data-block-id="other-2"><span data-testid="task-marker"></span></li>`
    expect(probeVisibilityInPage('[data-testid="task-marker"]')).toMatchObject({
      status: 'present',
      matchCount: 2,
    })
  })

  it('names the hiding ANCESTOR, and reports checkVisibility() verbatim beside it', () => {
    // The #4428 failure itself: the tag was in the DOM, an ancestor
    // view-transition wrapper was stuck at opacity-0.
    document.body.innerHTML = `
      <div class="view-transition" style="opacity: 0">
        <span data-testid="tag-item-wdio"></span>
      </div>`
    const probe = probeVisibilityInPage('[data-testid="tag-item-wdio"]')
    expect(probe.hiddenBy).toHaveLength(1)
    expect(probe.hiddenBy[0]).toContain('ancestor 1 level(s) up')
    expect(probe.hiddenBy[0]).toContain('opacity:0')
    expect(probe.checkVisibility).toBe(false)
  })

  it('does NOT treat an unresolved opacity as opacity:0', () => {
    // `Number('') === 0`: under the wrong coercion every node on the chain
    // reports `opacity:0` and the diagnostic blames a wrapper that is fine.
    document.body.innerHTML = '<div><span data-testid="x"></span></div>'
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      display: '',
      visibility: '',
      opacity: '',
      contentVisibility: '',
      pointerEvents: '',
    } as unknown as CSSStyleDeclaration)
    expect(probeVisibilityInPage('[data-testid="x"]').hiddenBy).toEqual([])
  })

  it('files pointer-events:none under blockedBy, never under hiddenBy', () => {
    // A `pointer-events:none` element is fully VISIBLE and merely un-hittable.
    // Counting it as hiding would answer a `clickable` failure with a
    // `displayed` verdict — the note-1 shape, one layer down.
    document.body.innerHTML =
      '<div style="pointer-events: none"><button data-testid="go">go</button></div>'
    const probe = probeVisibilityInPage('[data-testid="go"]')
    expect(probe.hiddenBy).toEqual([])
    expect(probe.blockedBy).toHaveLength(1)
    expect(probe.blockedBy[0]).toContain('pointer-events:none')
    expect(probe.blockedBy[0]).toContain('ancestor 1 level(s) up')
  })

  it('files [disabled] and aria-disabled under blockedBy', () => {
    document.body.innerHTML = '<button data-testid="go" disabled aria-disabled="true">go</button>'
    const probe = probeVisibilityInPage('[data-testid="go"]')
    expect(probe.hiddenBy).toEqual([])
    expect(probe.blockedBy).toEqual([
      'the element itself carries the [disabled] attribute',
      'the element itself carries aria-disabled="true"',
    ])
  })

  it('names whatever the hit test at the centre point lands on', () => {
    // happy-dom lays everything out at 0x0 and stubs `elementFromPoint`, so
    // both have to be supplied for this branch to be reachable at all.
    document.body.innerHTML =
      '<button data-testid="go">go</button><div data-testid="overlay"></div>'
    const overlay = document.querySelector('[data-testid="overlay"]')
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 20,
      left: 10,
      top: 10,
      right: 110,
      bottom: 30,
    } as DOMRect)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(overlay)
    const probe = probeVisibilityInPage('[data-testid="go"]')
    expect(probe.inViewport).toBe(true)
    expect(probe.blockedBy).toHaveLength(1)
    expect(probe.blockedBy[0]).toContain('data-testid="overlay"')
    expect(probe.blockedBy[0]).toContain('neither the element nor a descendant')
  })
})

describe('explainVisibilityProbe — note 1: the verdict answers the verb that was awaited', () => {
  it('never issues the timing verdict for a `clickable` wait', () => {
    const message = explainVisibilityProbe(
      { selector: 'button*=Add Tag', waitedFor: 'clickable' },
      presentProbe({
        blockedBy: ['ancestor 1 level(s) up <div class="overlay"> — pointer-events:none'],
      }),
    )
    expect(message).not.toContain('TIMING failure')
    expect(message).toContain('never became clickable')
    expect(message).toContain('which visibility does not decide')
    expect(message).toContain('pointer-events:none')
    expect(message).toContain('INTERACTION failure')
  })

  it('says NO VERDICT when it finds no blocker, rather than falling through to timing', () => {
    const message = explainVisibilityProbe(
      { selector: '[data-testid="go"]', waitedFor: 'enabled' },
      presentProbe(),
    )
    expect(message).not.toContain('TIMING failure')
    expect(message).toContain('NO VERDICT on `enabled`')
    expect(message).toContain('NOTHING more')
  })

  it('does not print NO VERDICT under a hiding cause that already explains it', () => {
    // A hidden element is neither clickable nor enabled, so "hidden by X"
    // IS the answer here. Printing "no verdict on `clickable`" one sentence
    // later would contradict the sentence above it.
    const message = explainVisibilityProbe(
      { selector: 'button*=Add Tag', waitedFor: 'clickable' },
      presentProbe({
        hiddenBy: ['ancestor 1 level(s) up <div class="view-transition"> — opacity:0'],
        checkVisibility: false,
      }),
    )
    expect(message).not.toContain('NO VERDICT')
    expect(message).toContain('RENDERING')
    expect(message).toContain('enough to fail a `clickable` wait')
  })

  it('still issues the timing verdict for a `displayed` wait — the branch is live', () => {
    const message = explainVisibilityProbe(
      { selector: '[data-testid="tag-item-wdio"]', waitedFor: 'displayed' },
      presentProbe(),
    )
    expect(message).toContain('TIMING failure')
  })

  it('blames the viewport half, not visibility, for `displayed within viewport`', () => {
    const message = explainVisibilityProbe(
      { selector: '[data-testid="go"]', waitedFor: 'displayed within viewport' },
      presentProbe({ inViewport: false }),
    )
    expect(message).not.toContain('TIMING failure')
    expect(message).toContain('does not intersect the')
    expect(message).toContain('`within viewport` half')
  })

  it('issues ONE verdict when a hiding cause and an interaction fact co-occur', () => {
    // The shape the review caught: a `disabled` button inside a `display:none`
    // container. `hiddenBy` and `blockedBy` are independent facts and nothing
    // stops both being populated, so the first block printed "this is a
    // RENDERING failure ... NOT a failure of the feature under test" and the
    // interaction block, testing `blockedBy` BEFORE `visibilityAlreadyExplains`,
    // appended "this reads as an INTERACTION failure rather than a rendering
    // one" directly underneath it. One message, two verdicts, opposite ways.
    const message = explainVisibilityProbe(
      { selector: 'button*=Add Tag', waitedFor: 'clickable' },
      presentProbe({
        hiddenBy: ['ancestor 2 level(s) up <div class="dialog"> — display:none'],
        checkVisibility: false,
        blockedBy: ['the element itself carries the [disabled] attribute'],
      }),
    )
    expect(message).toContain('RENDERING')
    expect(message).not.toContain('INTERACTION failure')
    expect(message).toContain('enough to fail a `clickable` wait')
    // The interaction FACT survives; only its rival verdict is suppressed.
    expect(message).toContain('ADDITIONALLY')
    expect(message).toContain('[disabled]')
    expect(message).toContain('NOT as a competing verdict')
    expect(message).not.toContain('NO VERDICT')
  })

  it('reaches that co-occurrence from a real DOM, not just a hand-built probe', () => {
    // Reachability, not construction: `probeVisibilityInPage` is what fills
    // both arrays on a red run, so the branch is exercised from the DOM the
    // reviewer named rather than from a `presentProbe` override.
    document.body.innerHTML = `
      <div class="dialog" style="display: none">
        <button data-testid="add-tag" disabled>Add Tag</button>
      </div>`
    const probe = probeVisibilityInPage('[data-testid="add-tag"]')
    expect(probe.hiddenBy.length).toBeGreaterThan(0)
    expect(probe.blockedBy.length).toBeGreaterThan(0)
    const message = explainVisibilityProbe(
      { selector: '[data-testid="add-tag"]', waitedFor: 'clickable' },
      probe,
    )
    expect(message).toContain('HIDDEN BY')
    expect(message).not.toContain('INTERACTION failure')
    expect(message).toContain('ADDITIONALLY')
    document.body.innerHTML = ''
  })

  it('does not explain an `existing` failure with hiding — a hidden element exists', () => {
    const message = explainVisibilityProbe(
      { selector: '[data-testid="task-marker"]', waitedFor: 'existing' },
      presentProbe({ hiddenBy: ['the element itself <span> — display:none'] }),
    )
    expect(message).not.toContain('RENDERING')
    expect(message).toContain('hiding does not affect')
    expect(message).toContain('For reference only')
  })
})

describe('explainVisibilityProbe — note 2: a document-wide match is not a scoped one', () => {
  it('qualifies every `present` verdict with the chained-lookup exposure', () => {
    const message = explainVisibilityProbe(
      { selector: '[data-testid="task-marker"]', waitedFor: 'displayed' },
      presentProbe(),
    )
    expect(message).toContain('CAVEAT')
    expect(message).toContain('the child half alone')
    expect(message).toContain('not provably the one the assertion targeted')
  })

  it('names the count when several nodes match document-wide', () => {
    const message = explainVisibilityProbe(
      { selector: '[data-testid="task-marker"]', waitedFor: 'displayed' },
      presentProbe({ matchCount: 4 }),
    )
    expect(message).toContain('4 nodes in the document match')
    expect(message).toContain('read the FIRST')
  })

  it('does NOT qualify `absent` — a scoped lookup can only match a subset', () => {
    const message = explainVisibilityProbe(
      { selector: '[data-testid="task-marker"]', waitedFor: 'displayed' },
      presentProbe({ status: 'absent', matchCount: 0 }),
    )
    expect(message).not.toContain('CAVEAT')
    expect(message).toContain('genuinely MISSING')
  })

  it('issues no verdict at all for a selector it could not resolve', () => {
    const message = explainVisibilityProbe(
      { selector: 'button*=Add Tag', waitedFor: 'clickable' },
      presentProbe({ status: 'unsupported-selector' }),
    )
    expect(message).toContain('no verdict')
    expect(message).not.toContain('TIMING failure')
  })
})

describe('explainVisibilityProbe — note 3: the engine outranks the walk', () => {
  it('reports the disagreement instead of a timing verdict when checkVisibility() is false', () => {
    // A zero-size `overflow:hidden` ancestor, an off-screen transform, or
    // `opacity: 0.004` — all invisible to the four-property walk, all caught
    // by the engine. Under the old fall-through this printed "it became
    // visible after the wait expired. A timing failure, not a state failure."
    const message = explainVisibilityProbe(
      { selector: '[data-testid="tag-item-wdio"]', waitedFor: 'displayed' },
      presentProbe({ checkVisibility: false }),
    )
    expect(message).not.toContain('TIMING failure')
    expect(message).toContain('DISAGREEMENT')
    expect(message).toContain('does NOT model')
    expect(message).toContain('RENDERING')
  })

  it('flags the opposite disagreement too, and defers to the engine', () => {
    const message = explainVisibilityProbe(
      { selector: '[data-testid="tag-item-wdio"]', waitedFor: 'displayed' },
      presentProbe({
        hiddenBy: ['ancestor 1 level(s) up <div> — opacity:0'],
        checkVisibility: true,
      }),
    )
    expect(message).toContain('DISAGREEMENT')
    expect(message).toContain('lead')
  })

  it('reports the engine`s answer verbatim in the facts line, including `unavailable`', () => {
    expect(
      explainVisibilityProbe(
        { selector: '#x', waitedFor: 'displayed' },
        presentProbe({ checkVisibility: null }),
      ),
    ).toContain('checkVisibility()=unavailable')
    expect(
      explainVisibilityProbe(
        { selector: '#x', waitedFor: 'displayed' },
        presentProbe({ checkVisibility: true }),
      ),
    ).toContain('checkVisibility()=true')
  })
})

describe('explainVisibilityProbe — #4457 note 1: no opinion is not agreement', () => {
  // The gap the review found: the test above (`reports the engine's answer
  // verbatim...`) already drove `checkVisibility: null` through this
  // function, but asserted only on the FACTS line ("checkVisibility()=
  // unavailable"), never on the VERDICT sentence built beside it. That let a
  // verdict built on `checkVisibility !== false` (a DENY-list: "not
  // disagreement" read as "agreement") survive review even though the
  // `false` case had its own dedicated test just above. These assert on the
  // verdict itself.

  it('does NOT print the timing verdict when the engine has no opinion — the acceptance for note 1', () => {
    const message = explainVisibilityProbe(
      { selector: '[data-testid="tag-item-wdio"]', waitedFor: 'displayed' },
      presentProbe({ checkVisibility: null }),
    )
    expect(message).not.toContain('TIMING failure')
    expect(message).not.toContain('the engine agrees')
    expect(message).toContain('NO VERDICT')
    expect(message).toContain('no opinion')
  })

  it('still prints the timing verdict when the engine actually agrees — the branch stays live', () => {
    const message = explainVisibilityProbe(
      { selector: '[data-testid="tag-item-wdio"]', waitedFor: 'displayed' },
      presentProbe({ checkVisibility: true }),
    )
    expect(message).toContain('TIMING failure')
    expect(message).toContain('the engine agrees')
  })

  it('does not claim agreement for the viewport verdict when the engine has no opinion', () => {
    const message = explainVisibilityProbe(
      { selector: '[data-testid="go"]', waitedFor: 'displayed within viewport' },
      presentProbe({ inViewport: false, checkVisibility: null }),
    )
    expect(message).not.toContain('the engine agrees')
    expect(message).toContain('no opinion')
    expect(message).toContain('`within viewport` half')
  })

  it('does not claim agreement for a clickable/enabled wait when the engine has no opinion', () => {
    const message = explainVisibilityProbe(
      { selector: 'button*=Add Tag', waitedFor: 'clickable' },
      presentProbe({ checkVisibility: null }),
    )
    expect(message).not.toContain('the engine agrees')
    expect(message).toContain('no opinion')
    expect(message).toContain('visibility does not decide')
  })

  it('never lets an unanticipated checkVisibility value read as agreement (classify positively)', () => {
    // `VisibilityProbe['checkVisibility']` is typed `boolean | null`, so this
    // reaches through the type system deliberately — the point of a POSITIVE
    // classification (`=== true`) rather than a deny-list (`!== false`) is
    // that it stays correct even for a value neither branch was written to
    // expect, which `!== false` cannot promise.
    const message = explainVisibilityProbe(
      { selector: '[data-testid="tag-item-wdio"]', waitedFor: 'displayed' },
      presentProbe({
        checkVisibility: 'maybe' as unknown as VisibilityProbe['checkVisibility'],
      }),
    )
    expect(message).not.toContain('the engine agrees')
    expect(message).not.toContain('TIMING failure')
    expect(message).toContain('NO VERDICT')
  })
})
