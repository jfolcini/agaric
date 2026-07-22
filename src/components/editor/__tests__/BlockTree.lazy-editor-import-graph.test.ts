import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * #2939 — structural guard for the lazy editor mount.
 *
 * The cold-start win depends on ONE invariant: nothing statically reachable from
 * `BlockTree.tsx` (the always-rendered read-only block tree) may pull the TipTap
 * editor stack or highlight.js. The heavy editor module is reached ONLY through
 * `React.lazy(() => import('./RovingEditorHost'))` in `useLazyRovingEditor`. If a
 * future refactor re-adds a static `@tiptap` / `lowlight` import anywhere on that
 * graph, the ~500 kB editor chunk gets modulepreloaded onto TTI again — this test
 * fails first.
 *
 * It walks the STATIC import graph (skipping `import type`, dynamic `import()`,
 * and pure re-export-of-types), following local `@/…` and relative edges, and
 * asserts no reached module has a value import from an editor/highlight package.
 */

const SRC = resolve(import.meta.dirname, '..', '..', '..')
const BLOCK_TREE = join(SRC, 'components', 'editor', 'BlockTree.tsx')

// Packages whose value import forces the (lazy) editor / highlight chunk onto
// startup. NOTE: @floating-ui is intentionally NOT here — it lives in the
// always-loaded `floating-vendor` chunk (Radix overlays use it too), so a static
// import of it does not drag in the editor stack.
const FORBIDDEN = /^(@tiptap\/|prosemirror-|prosemirror\/|lowlight$|lowlight\/|highlight\.js)/

/** Extract static import/re-export specifiers, skipping type-only imports. */
function staticEdges(src: string): string[] {
  const edges: string[] = []
  const push = (spec: string): void => {
    edges.push(spec)
  }
  // `import ... from '...'` — skip `import type ...`
  const importRe = /^\s*import\s+(type\s+)?([^;'"]*?)\s+from\s+['"]([^'"]+)['"]/gm
  let m: RegExpExecArray | null
  while ((m = importRe.exec(src)) !== null) {
    if (m[1]) continue // `import type … from`
    const clause = m[2] ?? ''
    const named = clause.match(/^\{([^}]*)\}$/)
    if (named) {
      const parts = (named[1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      // all-`type`-prefixed named import is erased at runtime → not an edge
      if (parts.length > 0 && parts.every((p) => p.startsWith('type '))) continue
    }
    push(m[3] ?? '')
  }
  // side-effect `import '...'`
  const bareRe = /^\s*import\s+['"]([^'"]+)['"]/gm
  while ((m = bareRe.exec(src)) !== null) push(m[1] ?? '')
  // `export … from '...'` (value re-exports; skip `export type`)
  const exportRe =
    /^\s*export\s+(type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm
  while ((m = exportRe.exec(src)) !== null) {
    if (m[1]) continue
    push(m[2] ?? '')
  }
  return edges
}

function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2))
  else if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(dirname(fromFile), spec)
  else return null
  for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
    const p = base + ext
    if (existsSync(p) && !p.endsWith('/')) return p
  }
  return null
}

function walk(entry: string): { visited: Set<string>; violations: string[] } {
  const visited = new Set<string>([entry])
  const violations: string[] = []
  const stack = [entry]
  while (stack.length > 0) {
    const file = stack.pop() as string
    let src: string
    try {
      src = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const spec of staticEdges(src)) {
      if (FORBIDDEN.test(spec)) {
        violations.push(`${file.replace(SRC, 'src')} statically imports "${spec}"`)
        continue
      }
      const resolved = resolveLocal(spec, file)
      if (resolved && !visited.has(resolved)) {
        visited.add(resolved)
        stack.push(resolved)
      }
    }
  }
  return { visited, violations }
}

describe('BlockTree lazy-editor import graph (#2939)', () => {
  const { visited, violations } = walk(BLOCK_TREE)

  it('does not statically import @tiptap / prosemirror / highlight from BlockTree', () => {
    expect(violations).toEqual([])
  })

  it('reaches the read-only render path (StaticBlock) but NOT the editor runtime', () => {
    const has = (rel: string): boolean => visited.has(join(SRC, rel))
    // Read-only path must be statically present so pages render immediately.
    expect(has('components/editor/StaticBlock.tsx')).toBe(true)
    expect(has('components/editor/EditableBlock.tsx')).toBe(true)
    // The heavy editor runtime must be reachable ONLY via dynamic import().
    expect(has('editor/use-roving-editor.ts')).toBe(false)
    expect(has('components/editor/RovingEditorHost.tsx')).toBe(false)
    expect(has('components/editor/EditorSurface.tsx')).toBe(false)
  })

  it('sanity: the walk actually traversed a non-trivial graph', () => {
    expect(visited.size).toBeGreaterThan(30)
  })
})
