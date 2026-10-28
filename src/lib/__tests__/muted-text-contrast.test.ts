/**
 * Muted text and a code block's syntax colours sit on `--muted`, and muted text also sits on
 * `--accent` (hover) and `--secondary`. Each pair clears WCAG AA in every theme (#6160).
 * Tokens are parsed from `src/index.css`, resolved through the cascade a page sees:
 * the theme's own block, then `.dark` for the dark themes, then `:root`.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

type Oklch = readonly [L: number, C: number, h: number]

function linearSrgb([L, C, hDeg]: Oklch): [number, number, number] {
  const h = (hDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

function luminance(color: Oklch): number {
  const [r, g, b] = linearSrgb(color)
  return 0.2126 * clamp01(r) + 0.7152 * clamp01(g) + 0.0722 * clamp01(b)
}

function contrast(fg: Oklch, bg: Oklch): number {
  const [a, b] = [luminance(fg), luminance(bg)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const CSS = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

/** The declaration body of a top-level selector that begins a line. */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(^|\\n)${escaped}\\s*\\{`).exec(CSS)
  if (!m) throw new Error(`selector not found in index.css: ${selector}`)
  let depth = 1
  let i = m.index + m[0].length
  const start = i
  for (; i < CSS.length && depth > 0; i++) {
    if (CSS[i] === '{') depth++
    else if (CSS[i] === '}') depth--
  }
  return CSS.slice(start, i - 1)
}

function token(layers: string[], name: string): Oklch {
  for (const css of layers) {
    const last = [
      ...css.matchAll(
        new RegExp(`--${name}\\s*:\\s*oklch\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)`, 'g'),
      ),
    ].at(-1)
    if (last) return [Number(last[1]), Number(last[2]), Number(last[3])]
  }
  throw new Error(`--${name} resolves to no oklch() value`)
}

const THEMES = [
  { theme: 'Light', layers: [':root'] },
  { theme: 'Dark', layers: ['.dark', ':root'] },
  { theme: 'Solarized Light', layers: ['.theme-solarized-light', ':root'] },
  { theme: 'Solarized Dark', layers: ['.theme-solarized-dark', '.dark', ':root'] },
  { theme: 'Dracula', layers: ['.theme-dracula', '.dark', ':root'] },
  { theme: 'One Dark Pro', layers: ['.theme-one-dark-pro', '.dark', ':root'] },
]

const PAIRS = [
  { fg: 'muted-foreground', bg: 'muted' },
  { fg: 'muted-foreground', bg: 'accent' },
  { fg: 'muted-foreground', bg: 'secondary' },
  // The tokens `.hljs-*` paint a code block's keywords, built-ins, names and sections with.
  { fg: 'alert-error-foreground', bg: 'muted' },
  { fg: 'alert-warning-foreground', bg: 'muted' },
  { fg: 'alert-tip-foreground', bg: 'muted' },
  { fg: 'alert-info-foreground', bg: 'muted' },
]

const CASES = THEMES.flatMap(({ theme, layers }) =>
  PAIRS.map(({ fg, bg }) => ({ theme, layers: layers.map(block), fg, bg })),
)

describe('muted text and syntax colours clear 4.5:1 in every theme (#6160)', () => {
  it.each(CASES)('$theme: --$fg on --$bg', ({ layers, fg, bg }) => {
    expect(contrast(token(layers, fg), token(layers, bg))).toBeGreaterThanOrEqual(4.5)
  })
})
