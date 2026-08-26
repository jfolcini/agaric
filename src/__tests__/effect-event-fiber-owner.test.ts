/**
 * Guard: no `useEffectEvent` may end up owned by a `memo()`-wrapped or
 * `forwardRef()`-wrapped component fiber (#4377).
 *
 * React 19.2 publishes an effect event's implementation from the commit
 * phase, in `commitBeforeMutationEffectsOnFiber`. That switch drains the
 * fiber's `updateQueue.events` for the `FunctionComponent` tag and then falls
 * straight through:
 *
 *   case FunctionComponent:      // <- drains updateQueue.events
 *     ...
 *     break
 *   case ForwardRef:             // <- drains NOTHING
 *   case SimpleMemoComponent:    // <- drains NOTHING
 *     break
 *
 * `memo(Fn)` with no compare function is downgraded by React to a
 * `SimpleMemoComponent` fiber (one fiber, not two), and `forwardRef(Fn)` is a
 * `ForwardRef` fiber. On either, an effect event's `ref.impl` is written once
 * at mount and never republished — so it silently dispatches to the closure
 * captured on the FIRST render, forever. There is no warning, and no lint rule
 * catches it: `react-hooks/rules-of-hooks` only polices where an effect event
 * is *called*, not which fiber owns it. `memo(Fn, compare)` is a
 * `MemoComponent` that renders a separate inner `FunctionComponent` fiber and
 * is therefore fine.
 *
 * `effect-event-fiber-tags.test.tsx` pins that React behaviour itself. This file
 * pins OUR side of it: every component whose fiber owns an effect event —
 * directly, or through any chain of custom hooks — must be a plain function
 * component.
 *
 * This bit once. `DaySection` is `memo(DaySectionInner)`, and converting its
 * `onEnter` mirror to `useEffectEvent` made it report viewport entry into the
 * mount-time `useDayMountWindow` closure for the component's whole life; days
 * evicted from the mount window would never have remounted. It uses the
 * dependency-array-less `useLayoutEffect` mirror instead — see
 * `docs/architecture/frontend.md § Latest-value mirrors`.
 *
 * Analysis is deliberately syntactic (no type information): it attributes each
 * call to the nearest preceding top-level declaration, which is exact for this
 * codebase's one-component-per-declaration style. Its blind spots are noted at
 * the assertion.
 */

import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '..')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!/^(__tests__|__mocks__)$/.test(entry.name)) sourceFiles(p, out)
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec|d)\.tsx?$/.test(entry.name)) {
      out.push(p)
    }
  }
  return out
}

interface Decl {
  name: string
  line: number
}

/** Top-level `function foo` / `const foo =` declarations, in source order. */
function topLevelDecls(lines: string[]): Decl[] {
  const decls: Decl[] = []
  lines.forEach((line, i) => {
    const m =
      /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(line) ??
      /^(?:export\s+)?(?:const|let)\s+([A-Za-z0-9_$]+)\s*[:=]/.exec(line)
    if (m?.[1]) decls.push({ name: m[1], line: i })
  })
  return decls
}

/** The nearest top-level declaration at or above `line`. */
function ownerOf(decls: Decl[], line: number): string | null {
  let owner: string | null = null
  for (const d of decls) {
    if (d.line > line) break
    owner = d.name
  }
  return owner
}

interface Site {
  file: string
  owner: string
}

describe('useEffectEvent fiber ownership (#4377)', () => {
  it('is never owned by a memo() or forwardRef() component', () => {
    const files = sourceFiles(SRC)
    const text = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]))
    const rel = (f: string) => path.relative(SRC, f)

    // symbol -> every top-level declaration that calls it
    const callersOf = new Map<string, Site[]>()
    // declarations that call `useEffectEvent` directly
    const seeds: Site[] = []

    for (const [file, body] of text) {
      const lines = body.split('\n')
      const decls = topLevelDecls(lines)
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/\b(use[A-Z][A-Za-z0-9_$]*)\s*\(/g)) {
          const callee = m[1]
          const owner = ownerOf(decls, i)
          if (callee === undefined || !owner || owner === callee) continue
          if (callee === 'useEffectEvent') {
            seeds.push({ file, owner })
            continue
          }
          const list = callersOf.get(callee) ?? []
          list.push({ file, owner })
          callersOf.set(callee, list)
        }
      })
    }

    // Nothing to guard would mean the scan broke, not that the repo is clean.
    expect(seeds.length).toBeGreaterThan(0)

    // Walk up through custom hooks; a component terminates the chain because
    // its fiber is the one that owns the hook state.
    const seen = new Set<string>()
    const componentOwners: Site[] = []
    const queue = [...seeds]
    while (queue.length > 0) {
      const cur = queue.pop() as Site
      const key = `${cur.file}#${cur.owner}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!/^use[A-Z]/.test(cur.owner)) {
        componentOwners.push(cur)
        continue
      }
      for (const c of callersOf.get(cur.owner) ?? []) queue.push(c)
    }

    // A component is "wrapped" if its identifier appears as the first argument
    // of memo(...) / forwardRef(...) anywhere in its own module. Blind spots,
    // both currently absent from this codebase: a component wrapped in a
    // DIFFERENT module, and two same-named declarations in one module.
    const wrapped = componentOwners.filter(({ file, owner }) =>
      new RegExp(
        String.raw`(?:React\.)?(?:memo|forwardRef)\(\s*(?:function\s+)?${owner}\b`,
        's',
      ).test(text.get(file) as string),
    )

    expect(wrapped.map(({ file, owner }) => `${rel(file)} :: ${owner}`)).toEqual([])
  })
})
