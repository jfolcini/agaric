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
/** WCAG 1.4.11 minimum for a non-text indicator such as the focus ring. */
const NON_TEXT = 3

// Body-text token pairs mirrored from src/index.css. `min` is the WCAG ratio
// the pair must clear for the text size it renders at (all normal text → 4.5).
const PAIRS: ReadonlyArray<{
  name: string
  fg: Oklch
  bg: Oklch
  min: number
}> = [
  // ── Fixed in #744; ink since #5332 ─────────────────────────────────
  {
    name: 'light: --primary-foreground on --primary (Button label)',
    fg: [0.985, 0.004, 70],
    bg: [0.22, 0.01, 70],
    min: AA_NORMAL,
  },
  {
    name: 'dark: --primary-foreground on --primary (Button label)',
    fg: [0.2, 0.006, 70],
    bg: [0.93, 0.005, 70],
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
    fg: [0.51, 0.02, 70],
    bg: [0.99, 0.004, 70],
    min: AA_NORMAL,
  },
  // ── #1097: dark-family card/popover surfaces are tonally lifted above
  //    --background; --card-foreground/--popover-foreground must still clear AA
  //    on the brighter (lower-contrast) surface. ──────────────────────────
  {
    name: 'dark: --card-foreground on lifted --card',
    fg: [0.955, 0.004, 70],
    bg: [0.235, 0.006, 70],
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
  return blockBody(CSS_SOURCE, m.index + m[0].length)
}

/** The body of the block whose opening `{` ends just before `start`. */
function blockBody(css: string, start: number): string {
  let depth = 1
  let i = start
  for (; i < css.length && depth > 0; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') depth--
  }
  return css.slice(start, i - 1)
}

/** The last `--token: oklch(...)` declared in `css` (later declarations win). */
function findOklch(css: string, token: string): Oklch | undefined {
  const re = new RegExp(`--${token}\\s*:\\s*oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)`, 'g')
  let last: Oklch | undefined
  for (const m of css.matchAll(re)) last = [Number(m[1]), Number(m[2]), Number(m[3])]
  return last
}

function readOklch(block: string, token: string): Oklch {
  const value = findOklch(block, token)
  if (!value) throw new Error(`token --${token} (oklch) not found in theme block`)
  return value
}

/**
 * Every rule body inside `@media (prefers-contrast: more)` whose selector list
 * names `selector`, concatenated in source order so `findOklch` sees the
 * cascade winner last.
 */
function highContrastBody(selector: ':root' | '.dark'): string {
  const css = CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')
  let out = ''
  for (const media of css.matchAll(/@media \(prefers-contrast: more\) \{/g)) {
    const body = blockBody(css, media.index + media[0].length)
    for (const rule of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if ((rule[1] ?? '').split(',').some((s) => s.trim() === selector)) out += rule[2]
    }
  }
  return out
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
    // index.css :root --primary: ink, "16.6:1"
    name: 'light :root — --primary-foreground on --primary ≈16.59:1',
    selector: ':root',
    fg: 'primary-foreground',
    bg: 'primary',
    min: AA_NORMAL,
    documented: 16.59,
  },
  {
    // index.css .dark --primary: "Ink inverts … 14.7:1"
    name: 'dark .dark — --primary-foreground on --primary ≈14.73:1',
    selector: '.dark',
    fg: 'primary-foreground',
    bg: 'primary',
    min: AA_NORMAL,
    documented: 14.73,
  },
  {
    // index.css :root --ring: "4.2:1 on --background"
    name: 'light :root — --ring on --background ≈4.21:1',
    selector: ':root',
    fg: 'ring',
    bg: 'background',
    min: NON_TEXT,
    documented: 4.21,
  },
  {
    // index.css .dark --ring: "7.4:1 on --background"
    name: 'dark .dark — --ring on --background ≈7.44:1',
    selector: '.dark',
    fg: 'ring',
    bg: 'background',
    min: NON_TEXT,
    documented: 7.44,
  },
  {
    // index.css .theme-solarized-dark: "0.66 is ≈4.8:1" on the lifted --popover
    name: 'Solarized Dark — --muted-foreground on --popover ≈4.8:1',
    selector: '.theme-solarized-dark',
    fg: 'muted-foreground',
    bg: 'popover',
    min: AA_NORMAL,
    documented: 4.8,
  },
  {
    // index.css .theme-one-dark-pro: "0.70 is ≈4.6:1" on the lifted --popover
    name: 'One Dark Pro — --muted-foreground on --popover ≈4.6:1',
    selector: '.theme-one-dark-pro',
    fg: 'muted-foreground',
    bg: 'popover',
    min: AA_NORMAL,
    documented: 4.57,
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
    // --background in :root is warm stone (#5332); a smoke test that the
    // brace-matching slice + token regex agree with the live stylesheet.
    expect(readOklch(themeBlock(':root'), 'background')).toEqual([0.99, 0.004, 70])
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

// ─────────────────────────────────────────────────────────────────────────
// Focus ring, chips and hover surfaces in every theme (#5332).
//
// Each token resolves through the cascade the page sees: a `prefers-contrast:
// more` override first (it comes later in index.css than every theme block),
// then the theme's own block, then `.dark` for the dark themes (`useTheme`
// sets both classes), then `:root`.
// ─────────────────────────────────────────────────────────────────────────

const THEMES = [
  { theme: 'Light', selector: ':root', dark: false },
  { theme: 'Dark', selector: '.dark', dark: true },
  { theme: 'Solarized Light', selector: '.theme-solarized-light', dark: false },
  { theme: 'Solarized Dark', selector: '.theme-solarized-dark', dark: true },
  { theme: 'Dracula', selector: '.theme-dracula', dark: true },
  { theme: 'One Dark Pro', selector: '.theme-one-dark-pro', dark: true },
] as const

type Theme = (typeof THEMES)[number]

const HIGH_CONTRAST_ROOT = highContrastBody(':root')
const HIGH_CONTRAST_DARK = highContrastBody('.dark')

function resolveToken(theme: Theme, highContrast: boolean, token: string): Oklch {
  const highContrastLayers = theme.dark
    ? [HIGH_CONTRAST_DARK, HIGH_CONTRAST_ROOT]
    : [HIGH_CONTRAST_ROOT]
  const cascade = [
    ...(highContrast ? highContrastLayers : []),
    themeBlock(theme.selector),
    ...(theme.dark ? [themeBlock('.dark')] : []),
    themeBlock(':root'),
  ]
  for (const css of cascade) {
    const value = findOklch(css, token)
    if (value) return value
  }
  throw new Error(`--${token} resolves to no oklch() value for ${theme.theme}`)
}

const THEME_PAIRS = [
  { pair: 'focus ring on the page', fg: 'ring', bg: 'background', min: NON_TEXT },
  // --brand is inherited from :root / .dark by every theme (#5332).
  { pair: 'brand mark label (today, FAB)', fg: 'brand-foreground', bg: 'brand', min: AA_NORMAL },
  { pair: 'brand numeral on the page', fg: 'brand', bg: 'background', min: AA_NORMAL },
  // Every theme: Button and Badge paint the fill opaque in dark themes too.
  {
    pair: 'destructive button label',
    fg: 'destructive-foreground',
    bg: 'destructive',
    min: AA_NORMAL,
  },
  { pair: 'P1 chip', fg: 'priority-urgent-foreground', bg: 'priority-urgent', min: AA_NORMAL },
  { pair: 'P2 chip', fg: 'priority-high-foreground', bg: 'priority-high', min: AA_NORMAL },
  { pair: 'P3 chip', fg: 'priority-normal-foreground', bg: 'priority-normal', min: AA_NORMAL },
  {
    pair: 'scheduled / future due chip',
    fg: 'secondary-foreground',
    bg: 'secondary',
    min: AA_NORMAL,
  },
  {
    pair: 'today due chip and search match',
    fg: 'status-pending-foreground',
    bg: 'status-pending',
    min: AA_NORMAL,
  },
  { pair: 'overdue due chip', fg: 'alert-error-foreground', bg: 'alert-error', min: AA_NORMAL },
  { pair: 'hover / selected surface', fg: 'accent-foreground', bg: 'accent', min: AA_NORMAL },
  {
    pair: 'sidebar hover / active item',
    fg: 'sidebar-accent-foreground',
    bg: 'sidebar-accent',
    min: AA_NORMAL,
  },
] as const

const CASES = [false, true].flatMap((highContrast) =>
  THEMES.flatMap((theme) =>
    THEME_PAIRS.map(({ pair, fg, bg, min }) => ({
      pair,
      fg,
      bg,
      min,
      theme,
      label: `${theme.theme}${highContrast ? ' (high contrast)' : ''}`,
      highContrast,
    })),
  ),
)

describe('focus ring, chips and hover surfaces clear WCAG in every theme (#5332)', () => {
  it('the high-contrast reader finds the overrides, not the base theme', () => {
    // Without this, a parser that found nothing would re-measure the base
    // theme under every "(high contrast)" label and pass.
    expect(readOklch(HIGH_CONTRAST_ROOT, 'ring')).not.toEqual(
      readOklch(themeBlock(':root'), 'ring'),
    )
    expect(readOklch(HIGH_CONTRAST_DARK, 'ring')).not.toEqual(
      readOklch(themeBlock('.dark'), 'ring'),
    )
  })

  it('index.css paints the ring opaque, which the ring ratios assume', () => {
    // A `ring-ring/50` composites toward the page: 2.6:1 in light (#5332).
    expect(CSS_SOURCE).not.toMatch(/ring-ring\/\d/)
  })

  it.each(CASES)('$label — $pair', ({ theme, highContrast, fg, bg, min }) => {
    const ratio = contrastRatio(
      resolveToken(theme, highContrast, fg),
      resolveToken(theme, highContrast, bg),
    )
    expect(ratio).toBeGreaterThanOrEqual(min)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Crimson, link and muted text in the default themes (#5332).
//
// Only Light and Dark: the alternate themes keep their own --destructive and
// --muted-foreground. The destructive label is pinned in every theme above.
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_THEME_PAIRS = [
  { pair: 'destructive text on the page', fg: 'destructive', bg: 'background' },
  { pair: 'link text on the page', fg: 'foreground', bg: 'background' },
  { pair: 'muted text on --muted (tag chip)', fg: 'muted-foreground', bg: 'muted' },
  { pair: 'muted text on the page', fg: 'muted-foreground', bg: 'background' },
  { pair: 'muted text on a hovered row', fg: 'muted-foreground', bg: 'accent' },
] as const

const DEFAULT_CASES = [false, true].flatMap((highContrast) =>
  THEMES.slice(0, 2).flatMap((theme) =>
    DEFAULT_THEME_PAIRS.map(({ pair, fg, bg }) => ({
      pair,
      fg,
      bg,
      theme,
      label: `${theme.theme}${highContrast ? ' (high contrast)' : ''}`,
      highContrast,
    })),
  ),
)

describe('crimson, link and muted text clears WCAG AA in the default themes (#5332)', () => {
  it.each(DEFAULT_CASES)('$label — $pair', ({ theme, highContrast, fg, bg }) => {
    const ratio = contrastRatio(
      resolveToken(theme, highContrast, fg),
      resolveToken(theme, highContrast, bg),
    )
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL)
  })
})
