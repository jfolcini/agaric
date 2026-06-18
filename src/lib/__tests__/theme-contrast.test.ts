/**
 * WCAG AA contrast regression guard for theme OKLCH tokens (#744).
 *
 * Several theme color tokens in `src/index.css` are used as body text on a
 * paired background (e.g. a Button label `--primary-foreground` on `--primary`,
 * or muted helper text `--muted-foreground` on `--background`). WCAG 2.x
 * requires a contrast ratio of at least 4.5:1 for normal-size text.
 *
 * Two pairs previously failed:
 *   - `--primary-foreground` on `--primary` (light + dark) = 4.09:1
 *   - Solarized Light `--muted-foreground` on `--background` = 3.89:1
 *
 * This test recomputes contrast from scratch (OKLCH → linear sRGB →
 * relative luminance → WCAG ratio) so a real regression — not a guessed
 * number — fails the suite. The token values below are mirrored from
 * `src/index.css`; if a value there changes, update it here too.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

type Oklch = readonly [L: number, C: number, h: number]

/** OKLCH (D65) → linear-light sRGB, per the Oklab/CSS Color 4 matrices. */
function oklchToLinearSrgb([L, C, hDeg]: Oklch): [number, number, number] {
  const h = (hDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b

  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

/** WCAG 2.x relative luminance from a linear-light sRGB OKLCH color. */
function relativeLuminance(color: Oklch): number {
  const [r, g, b] = oklchToLinearSrgb(color)
  return 0.2126 * clamp01(r) + 0.7152 * clamp01(g) + 0.0722 * clamp01(b)
}

/** WCAG 2.x contrast ratio between two OKLCH colors. */
function contrastRatio(fg: Oklch, bg: Oklch): number {
  const l1 = relativeLuminance(fg)
  const l2 = relativeLuminance(bg)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

const AA_NORMAL = 4.5

// Body-text token pairs mirrored from src/index.css. `min` is the WCAG ratio
// the pair must clear for the text size it renders at (all normal text → 4.5).
const PAIRS: ReadonlyArray<{
  name: string
  fg: Oklch
  bg: Oklch
  min: number
}> = [
  // ── Fixed in #744 ──────────────────────────────────────────────────
  {
    name: 'light: --primary-foreground on --primary (Button label)',
    fg: [0.911, 0.04, 84.583],
    bg: [0.5, 0.188, 28.71],
    min: AA_NORMAL,
  },
  {
    name: 'dark: --primary-foreground on --primary (Button label)',
    fg: [0.911, 0.04, 84.583],
    bg: [0.5, 0.188, 28.71],
    min: AA_NORMAL,
  },
  {
    name: 'Solarized Light: --muted-foreground on --background',
    fg: [0.5, 0.02, 210],
    bg: [0.97, 0.02, 85],
    min: AA_NORMAL,
  },
  // ── Passing calibration pairs (left unchanged in #744) ─────────────
  {
    name: 'default: --muted-foreground on --background',
    fg: [0.554, 0.046, 257.417],
    bg: [1, 0, 0],
    min: AA_NORMAL,
  },
  {
    name: 'light: --accent-foreground on --accent',
    fg: [0.377, 0.136, 28.584],
    bg: [0.93, 0.02, 28.71],
    min: AA_NORMAL,
  },
  // ── #1097: dark-family card/popover surfaces are tonally lifted above
  //    --background; --card-foreground/--popover-foreground must still clear AA
  //    on the brighter (lower-contrast) surface. ──────────────────────────
  {
    name: 'dark: --card-foreground on lifted --card',
    fg: [0.984, 0.003, 247.858],
    bg: [0.18, 0.042, 264.695],
    min: AA_NORMAL,
  },
  {
    name: 'Solarized Dark: --card-foreground on lifted --card',
    fg: [0.68, 0.01, 195],
    bg: [0.27, 0.04, 210],
    min: AA_NORMAL,
  },
  {
    name: 'Dracula: --card-foreground on lifted --card',
    fg: [0.96, 0.01, 90],
    bg: [0.32, 0.03, 275],
    min: AA_NORMAL,
  },
  {
    name: 'One Dark Pro: --card-foreground on lifted --card',
    fg: [0.75, 0.02, 255],
    bg: [0.33, 0.02, 260],
    min: AA_NORMAL,
  },
]

describe('theme OKLCH contrast (WCAG AA)', () => {
  it('reproduces a known WCAG ratio (sanity-checks the math)', () => {
    // Pure black on pure white is exactly 21:1.
    expect(contrastRatio([0, 0, 0], [1, 0, 0])).toBeCloseTo(21, 1)
    // The pre-fix --primary pair (L 0.55) was the documented 4.09:1 failure.
    expect(contrastRatio([0.911, 0.04, 84.583], [0.55, 0.188, 28.71])).toBeCloseTo(4.09, 1)
  })

  it.each(PAIRS)('$name clears its WCAG ratio', ({ fg, bg, min }) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(min)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Live-CSS guard (#1684).
//
// The PAIRS table above mirrors token values by hand, so a tweak in
// `src/index.css` can silently drift below AA while this suite stays green.
// The block below instead parses the *actual* OKLCH declarations out of
// `src/index.css` per theme selector and asserts the contrast guarantees the
// CSS comments themselves document — so a regression in the stylesheet fails
// CI, not just a stale copy.
// ─────────────────────────────────────────────────────────────────────────

// Resolved from the project root (vitest cwd) so it stays valid regardless of
// how `import.meta.url` is exposed under the test transform.
const CSS_PATH = resolve(process.cwd(), 'src/index.css')
const CSS_SOURCE = readFileSync(CSS_PATH, 'utf8')

/**
 * Slice the declaration body of a top-level theme selector (`:root`, `.dark`,
 * `.theme-solarized-light`, …) from the stylesheet. Brace-counts from the
 * selector's opening `{` so nested at-rules/blocks don't truncate it early.
 */
function themeBlock(selector: string): string {
  // Anchor on a selector that begins a line so we don't match it inside a
  // descendant rule like `.dark .hljs`.
  const re = new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`)
  const m = re.exec(CSS_SOURCE)
  if (!m) throw new Error(`theme selector not found in index.css: ${selector}`)
  const start = m.index + m[0].length
  let depth = 1
  let i = start
  for (; i < CSS_SOURCE.length && depth > 0; i++) {
    if (CSS_SOURCE[i] === '{') depth++
    else if (CSS_SOURCE[i] === '}') depth--
  }
  return CSS_SOURCE.slice(start, i - 1)
}

/** Read the first `--token: oklch(...)` value declared inside a theme block. */
function readOklch(block: string, token: string): Oklch {
  const re = new RegExp(`--${token}\\s*:\\s*oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)`)
  const m = re.exec(block)
  if (!m) throw new Error(`token --${token} (oklch) not found in theme block`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

// Each entry mirrors a contrast guarantee asserted in an index.css comment.
const DOCUMENTED_GUARANTEES: ReadonlyArray<{
  name: string
  selector: string
  fg: string
  bg: string
  min: number
  /** Documented ratio from the CSS comment, for a tighter regression bound. */
  documented: number
}> = [
  {
    // index.css ~159-163: "Darkening --primary L 0.55 → 0.50 raises it to ≈5.07:1"
    name: 'light :root — --primary-foreground on --primary ≈5.07:1',
    selector: ':root',
    fg: 'primary-foreground',
    bg: 'primary',
    min: AA_NORMAL,
    documented: 5.07,
  },
  {
    // index.css ~315: ".dark — same --primary-foreground/--primary pair as light"
    name: 'dark .dark — --primary-foreground on --primary ≈5.07:1',
    selector: '.dark',
    fg: 'primary-foreground',
    bg: 'primary',
    min: AA_NORMAL,
    documented: 5.07,
  },
  {
    // index.css ~466-468: "muted-foreground … L 0.58 → 0.50 raises it to ≈5.45:1"
    name: 'Solarized Light — --muted-foreground on --background ≈5.45:1',
    selector: '.theme-solarized-light',
    fg: 'muted-foreground',
    bg: 'background',
    min: AA_NORMAL,
    documented: 5.45,
  },
]

describe('documented CSS contrast guarantees hold in src/index.css (#1684)', () => {
  it('the parser locates a known token and theme block', () => {
    // --background in :root is pure white (oklch(1 0 0)); a smoke test that the
    // brace-matching slice + token regex agree with the live stylesheet.
    expect(readOklch(themeBlock(':root'), 'background')).toEqual([1, 0, 0])
  })

  it.each(DOCUMENTED_GUARANTEES)(
    '$name (parsed from index.css)',
    ({ selector, fg, bg, min, documented }) => {
      const block = themeBlock(selector)
      const ratio = contrastRatio(readOklch(block, fg), readOklch(block, bg))
      // Hard floor: never regress below the WCAG minimum the comment promises.
      expect(ratio).toBeGreaterThanOrEqual(min)
      // Soft bound: stay within tolerance of the ratio the comment documents,
      // so a token tweak that changes the real contrast trips this test.
      expect(ratio).toBeCloseTo(documented, 1)
    },
  )
})
