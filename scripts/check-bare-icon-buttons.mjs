#!/usr/bin/env node
/**
 * check-bare-icon-buttons — forward guard for the IconButton migration (#1089).
 *
 * `docs/UX.md` mandates the `IconButton` primitive (mandatory tooltip +
 * ariaLabel) over a bare `<Button size="icon*">` + lone icon. We do NOT
 * blanket-mandate IconButton — there are legitimate `<Button size="icon*">`
 * call sites:
 *   - decorative / sentinel triggers that intentionally have NO accessible
 *     name (`aria-hidden` / `tabIndex={-1}`) — IconButton's mandatory label
 *     would be *wrong* there; and
 *   - buttons whose accessible name arrives via a forwarded `{...props}` /
 *     `{...rest}` spread (e.g. the shadcn `sidebar` trigger).
 *
 * What this catches is the genuinely-broken middle: a bare
 * `<Button size="icon*">` that has NEITHER an `aria-label` NOR an `aria-hidden`
 * (nor a props spread that could carry one). Those ship an icon-only button
 * with no accessible name at all — exactly what IconButton exists to prevent.
 *
 * The detector (`findBareIconButtons`) is a pure, I/O-free export so it can be
 * unit-tested on fixtures. The CLI body (guarded behind a direct-invocation
 * check) scans every `.tsx` file under `src/` and exits non-zero on any
 * violation.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Walk every `<Button …>` opening tag in `src` and return its raw attribute
 * text plus 1-based start line. Brace-aware + string-aware so a `>` inside a
 * `{() => …}` arrow prop or a `">"` string literal does not prematurely close
 * the tag (a naive `/<Button[^>]*>/` regex truncates the attribute list and
 * misses a trailing `aria-label`, producing false positives).
 *
 * @param {string} src
 * @returns {{ attrs: string, line: number }[]}
 */
export function findButtonOpeningTags(src) {
  const tags = []
  const NAME = '<Button'
  let i = 0
  for (;;) {
    const start = src.indexOf(NAME, i)
    if (start === -1) break
    // Reject `<ButtonGroup`, `<ButtonRow`, … — only the bare `<Button` element.
    const next = src[start + NAME.length]
    if (next && /[A-Za-z0-9]/.test(next)) {
      i = start + NAME.length
      continue
    }
    let depth = 0
    /** @type {string | null} */
    let quote = null
    let end = -1
    for (let j = start + NAME.length; j < src.length; j++) {
      const c = src[j]
      if (quote) {
        if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c
        continue
      }
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) {
        end = j
        break
      }
    }
    if (end === -1) break
    tags.push({
      attrs: src.slice(start + NAME.length, end),
      line: src.slice(0, start).split('\n').length,
    })
    i = end + 1
  }
  return tags
}

/**
 * Return the violating icon-only `<Button>` tags in `src`: those with a
 * `size="icon*"` (icon / icon-xs / icon-sm / icon-lg) but NEITHER `aria-label`
 * NOR `aria-hidden` NOR a `{...props}` / `{...rest}` spread (which may forward
 * an accessible name). Each violation is `{ line }`.
 *
 * @param {string} src
 * @returns {{ line: number }[]}
 */
export function findBareIconButtons(src) {
  const violations = []
  for (const { attrs, line } of findButtonOpeningTags(src)) {
    if (!/\bsize=["']icon/.test(attrs)) continue
    if (/\baria-label\b/.test(attrs)) continue
    if (/\baria-hidden\b/.test(attrs)) continue
    if (/\{\s*\.\.\.\w+\s*\}/.test(attrs)) continue // forwarded {...props}/{...rest}
    violations.push({ line })
  }
  return violations
}

/** Recursively collect `.tsx` files under `dir`, skipping tests + node_modules. */
function collectTsx(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue
      collectTsx(full, out)
    } else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) {
      out.push(full)
    }
  }
  return out
}

/**
 * Scan a source root and return human-readable `path:line` violations.
 * Exported so the vitest guard can assert on the live tree without shelling out.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function scanTree(root) {
  const out = []
  for (const file of collectTsx(root)) {
    const src = readFileSync(file, 'utf8')
    for (const { line } of findBareIconButtons(src)) {
      out.push(`${relative(root, file)}:${line}`)
    }
  }
  return out.toSorted()
}

// CLI: only run the filesystem scan when invoked directly (not on import).
const isDirectRun = process.argv[1] === import.meta.filename
if (isDirectRun) {
  const here = import.meta.dirname
  const srcRoot = join(here, '..', 'src')
  const violations = scanTree(srcRoot)
  if (violations.length > 0) {
    console.error(
      'Bare icon-only <Button size="icon*"> with no accessible name ' +
        '(neither aria-label nor aria-hidden):',
    )
    for (const v of violations) console.error(`  src/${v}`)
    console.error(
      '\nUse the IconButton primitive (src/components/ui/icon-button.tsx) — it ' +
        'mandates tooltip + ariaLabel — or add aria-hidden for a decorative trigger.',
    )
    process.exit(1)
  }
  console.log('check-bare-icon-buttons: no violations')
}
