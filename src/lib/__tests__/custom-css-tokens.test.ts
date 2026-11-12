/**
 * The custom CSS token list (#6558) is a compatibility promise: every token in
 * `docs/features/appearance.md`'s versioned list is defined in each of the six
 * themes, and none is declared only in `@theme inline`, whose values Tailwind
 * inlines into its utilities so a user's override never reaches them.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../../..')
const css = readFileSync(resolve(root, 'src/index.css'), 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '')
const doc = readFileSync(resolve(root, 'docs/features/appearance.md'), 'utf8')

/** Each top-level rule's prelude and body. */
function topLevelRules(source: string): { prelude: string; body: string }[] {
  const rules: { prelude: string; body: string }[] = []
  let depth = 0
  let preludeStart = 0
  let bodyStart = 0
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === ';' && depth === 0) preludeStart = i + 1
    if (ch === '{') {
      if (depth === 0) bodyStart = i + 1
      depth++
    }
    if (ch === '}') {
      depth--
      if (depth === 0) {
        rules.push({
          prelude: source.slice(preludeStart, bodyStart - 1).trim(),
          body: source.slice(bodyStart, i),
        })
        preludeStart = i + 1
      }
    }
  }
  return rules
}

const RULES = topLevelRules(css)

/** Custom properties the top-level `prelude` rules declare; a theme or `:root` must exist. */
function declared(prelude: string, required = true): Set<string> {
  const names = new Set<string>()
  const matching = RULES.filter((rule) => rule.prelude === prelude)
  if (required && matching.length === 0) {
    throw new Error(`no top-level \`${prelude}\` rule in src/index.css`)
  }
  for (const { body } of matching) {
    for (const [, name] of body.matchAll(/(?:^|[\s;{])(--[\w-]+)\s*:/g)) names.add(name as string)
  }
  return names
}

/** The classes `useTheme` sets on `<html>` for each theme; the light theme sets none. */
const THEMES: Record<string, readonly string[]> = {
  light: [],
  dark: ['.dark'],
  'solarized-light': ['.theme-solarized-light'],
  'solarized-dark': ['.dark', '.theme-solarized-dark'],
  dracula: ['.dark', '.theme-dracula'],
  'one-dark-pro': ['.dark', '.theme-one-dark-pro'],
}

const base = new Set([...declared(':root'), ...declared('@theme', false)])

const listed = (() => {
  const start = doc.indexOf('<!-- custom-css-tokens:start -->')
  const end = doc.indexOf('<!-- custom-css-tokens:end -->')
  if (start === -1 || end <= start) throw new Error('no token list markers in appearance.md')
  return [...doc.slice(start, end).matchAll(/`(--[\w-]+)`/g)].map(([, name]) => name as string)
})()

describe('custom CSS token list (#6558)', () => {
  it('reads the list from the docs', () => {
    expect(listed).toContain('--background')
    expect(new Set(listed).size).toBe(listed.length)
  })

  it.each(Object.entries(THEMES))('defines every listed token in the %s theme', (_, classes) => {
    const defined = new Set(base)
    for (const cls of classes) for (const name of declared(cls)) defined.add(name)
    expect(listed.filter((name) => !defined.has(name))).toEqual([])
  })

  it('lists no token that only `@theme inline` declares', () => {
    const inlined = declared('@theme inline', false)
    expect(listed.filter((name) => inlined.has(name) && !base.has(name))).toEqual([])
  })
})
