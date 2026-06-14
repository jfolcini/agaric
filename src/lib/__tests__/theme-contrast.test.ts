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
