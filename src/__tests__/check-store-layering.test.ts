import { describe, expect, it } from 'vitest'

// The script is plain ESM (.mjs); `checkLayering` is a pure, I/O-free export
// over an already-built import graph. Importing it does NOT trigger the
// `src/stores/` scan (the CLI body is guarded behind a direct-invocation
// check), so this stays a fast unit test — mirrors
// `check-import-cycles-detect.test.ts`'s pattern for its sibling hook.
// @ts-expect-error — no type declarations for the .mjs script.
import { checkLayering, PAGE_BLOCK_STORE_FAMILY } from '../../scripts/check-store-layering.mjs'

/**
 * Pins the mechanical enforcement of docs/architecture/frontend.md's
 * "Dependencies flow one way: page-block stores → global focus, never the
 * reverse" (#2465). `checkLayering` takes a `Map<file, importedStoreFiles>`
 * so these tests exercise the layering RULE directly, independent of what
 * the real `src/stores/` graph happens to look like today.
 */
describe('check-store-layering checkLayering', () => {
  it('is clean when the page-block-store family only imports the allowed set', () => {
    const graph = new Map([
      ['page-blocks.ts', ['blocks.ts', 'space.ts', 'undo.ts', 'page-blocks-reducers.ts']],
      ['page-blocks-reducers.ts', ['undo.ts', 'page-blocks-map.ts']],
      ['page-blocks-map.ts', []],
      ['page-blocks-move.ts', ['page-blocks-map.ts']],
      ['page-blocks-types.ts', []],
      ['blocks.ts', ['navigation.ts', 'tabs.ts']],
    ])
    expect(checkLayering(graph)).toEqual([])
  })

  it('flags a page-block-store family module importing a store outside the allowlist', () => {
    const graph = new Map([['page-blocks.ts', ['navigation.ts']]])
    const violations = checkLayering(graph)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatch(/page-blocks\.ts imports navigation\.ts/)
  })

  it('flags blocks.ts importing ANY page-block-store family module (the reverse ban)', () => {
    for (const familyFile of PAGE_BLOCK_STORE_FAMILY as string[]) {
      const graph = new Map([['blocks.ts', [familyFile]]])
      const violations = checkLayering(graph)
      expect(violations).toHaveLength(1)
      expect(violations[0]).toMatch(
        new RegExp(`blocks\\.ts imports ${familyFile.replace('.', '\\.')}`),
      )
    }
  })

  it('allows intra-family imports without needing them in the allowlist', () => {
    const graph = new Map([['page-blocks-move.ts', ['page-blocks-map.ts', 'page-blocks-types.ts']]])
    expect(checkLayering(graph)).toEqual([])
  })

  it('is unaffected by stores outside the family/blocks.ts pairing', () => {
    const graph = new Map([
      ['navigation.ts', ['space.ts']],
      ['tabs.ts', ['navigation.ts', 'journal.ts', 'recent-pages.ts']],
    ])
    expect(checkLayering(graph)).toEqual([])
  })

  it('reports one violation per disallowed import, not just the first', () => {
    const graph = new Map([['page-blocks-reducers.ts', ['navigation.ts', 'journal.ts', 'undo.ts']]])
    // undo.ts is allowed; navigation.ts and journal.ts are not (tabs.ts and
    // recent-pages.ts became allowed edges with the #2802 stale-space heal).
    expect(checkLayering(graph)).toHaveLength(2)
  })
})
