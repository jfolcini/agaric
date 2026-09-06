/**
 * Tests for src/lib/page-tree.ts — buildPageTree utility.
 *
 * Validates:
 *  - Empty input returns empty array
 *  - Flat pages (no slashes) produce flat tree
 *  - Namespace paths create nested tree structure
 *  - Mixed flat and namespaced pages
 *  - Null content falls back to 'Untitled'
 *  - Hybrid nodes (both page and namespace)
 */

import { describe, expect, it } from 'vitest'

import { buildPageTree } from '@/lib/page-tree'

describe('buildPageTree', () => {
  it('returns empty array for empty input', () => {
    expect(buildPageTree([])).toEqual([])
  })

  it('produces flat nodes for pages without slashes', () => {
    const pages = [
      { id: 'P1', content: 'Alpha' },
      { id: 'P2', content: 'Beta' },
    ]
    const tree = buildPageTree(pages)

    expect(tree).toHaveLength(2)
    expect(tree[0]).toMatchObject({ name: 'Alpha', fullPath: 'Alpha', pageId: 'P1', children: [] })
    expect(tree[1]).toMatchObject({ name: 'Beta', fullPath: 'Beta', pageId: 'P2', children: [] })
  })

  it('builds nested tree from namespaced pages', () => {
    const pages = [
      { id: 'P1', content: 'work/project-alpha' },
      { id: 'P2', content: 'work/project-beta' },
    ]
    const tree = buildPageTree(pages)

    expect(tree).toHaveLength(1)
    expect(tree[0]?.name).toBe('work')
    expect(tree[0]?.fullPath).toBe('work')
    expect(tree[0]?.pageId).toBeUndefined()
    expect(tree[0]?.children).toHaveLength(2)
    expect(tree[0]?.children[0]).toMatchObject({
      name: 'project-alpha',
      fullPath: 'work/project-alpha',
      pageId: 'P1',
      children: [],
    })
    expect(tree[0]?.children[1]).toMatchObject({
      name: 'project-beta',
      fullPath: 'work/project-beta',
      pageId: 'P2',
      children: [],
    })
  })

  it('handles deeply nested namespaces', () => {
    const pages = [{ id: 'P1', content: 'a/b/c/d' }]
    const tree = buildPageTree(pages)

    expect(tree).toHaveLength(1)
    expect(tree[0]?.name).toBe('a')
    expect(tree[0]?.children[0]?.name).toBe('b')
    expect(tree[0]?.children[0]?.children[0]?.name).toBe('c')
    expect(tree[0]?.children[0]?.children[0]?.children[0]).toMatchObject({
      name: 'd',
      fullPath: 'a/b/c/d',
      pageId: 'P1',
      children: [],
    })
  })

  it('creates hybrid nodes when a page is also a namespace', () => {
    const pages = [
      { id: 'P1', content: 'work' },
      { id: 'P2', content: 'work/tasks' },
    ]
    const tree = buildPageTree(pages)

    expect(tree).toHaveLength(1)
    // "work" is both a page and a namespace
    expect(tree[0]?.name).toBe('work')
    expect(tree[0]?.pageId).toBe('P1')
    expect(tree[0]?.children).toHaveLength(1)
    expect(tree[0]?.children[0]).toMatchObject({
      name: 'tasks',
      fullPath: 'work/tasks',
      pageId: 'P2',
    })
  })

  it('falls back to "Untitled" for null content', () => {
    const pages = [{ id: 'P1', content: null }]
    const tree = buildPageTree(pages)

    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ name: 'Untitled', fullPath: 'Untitled', pageId: 'P1' })
  })

  it('merges shared namespace prefixes', () => {
    const pages = [
      { id: 'P1', content: 'dev/frontend' },
      { id: 'P2', content: 'dev/backend' },
      { id: 'P3', content: 'docs/readme' },
    ]
    const tree = buildPageTree(pages)

    expect(tree).toHaveLength(2)
    expect(tree[0]?.name).toBe('dev')
    expect(tree[0]?.children).toHaveLength(2)
    expect(tree[1]?.name).toBe('docs')
    expect(tree[1]?.children).toHaveLength(1)
  })

  // ── #4709 — duplicate titles ─────────────────────────────────────────
  //
  // Page titles are NOT unique (pages are ULID-keyed blocks). The final
  // segment used to be assigned as `node.pageId = page.id`, i.e.
  // last-writer-wins: the second page with a given title took over the
  // first one's node and the first became unreachable from the Pages
  // view entirely (41 of 286 live pages on the reporting vault).

  it('keeps BOTH pages reachable when two share a title', () => {
    const pages = [
      { id: 'P1', content: 'Agaric' },
      { id: 'P2', content: 'Agaric' },
    ]
    const tree = buildPageTree(pages)

    // Two sibling nodes, one per page — not one node standing for both.
    expect(tree).toHaveLength(2)
    expect(tree.map((n) => n.pageId).toSorted()).toEqual(['P1', 'P2'])
    // Same displayed path on both (they really do have the same title).
    expect(tree.map((n) => n.fullPath)).toEqual(['Agaric', 'Agaric'])
  })

  it('marks every node of a duplicate group, the first one included', () => {
    const tree = buildPageTree([
      { id: 'P1', content: 'Agaric' },
      { id: 'P2', content: 'Agaric' },
      { id: 'P3', content: 'Solo' },
    ])

    const agaric = tree.filter((n) => n.name === 'Agaric')
    expect(agaric).toHaveLength(2)
    // Both — otherwise the second copy looks like the odd one out and
    // the first reads as the canonical `Agaric`.
    expect(agaric.every((n) => n.duplicateTitle === true)).toBe(true)
    // A unique title stays unflagged, so the cue is not rendered on the
    // overwhelmingly common row.
    expect(tree.find((n) => n.name === 'Solo')?.duplicateTitle).toBeUndefined()
  })

  it('gives duplicate siblings a unique key, since fullPath no longer is', () => {
    const tree = buildPageTree([
      { id: 'P1', content: 'ns/dup' },
      { id: 'P2', content: 'ns/dup' },
      { id: 'P3', content: 'ns/other' },
    ])

    const children = tree[0]?.children ?? []
    expect(children).toHaveLength(3)
    // `fullPath` collides — that is exactly why it can no longer serve
    // as the React key / DOM id fragment.
    expect(children.filter((c) => c.fullPath === 'ns/dup')).toHaveLength(2)
    // `nodeKey ?? fullPath` is what consumers key off, and it is unique.
    const keys = children.map((c) => c.nodeKey ?? c.fullPath)
    expect(new Set(keys).size).toBe(children.length)
  })

  it('still merges the hybrid case when a duplicate of the parent exists', () => {
    // `work` is both a page and a namespace, AND a second page is also
    // titled `work`. The namespace must not fork: `work/tasks` still
    // hangs off the first `work` node.
    const tree = buildPageTree([
      { id: 'P1', content: 'work' },
      { id: 'P2', content: 'work/tasks' },
      { id: 'P3', content: 'work' },
    ])

    const withChildren = tree.filter((n) => n.children.length > 0)
    expect(withChildren).toHaveLength(1)
    expect(withChildren[0]).toMatchObject({ name: 'work', fullPath: 'work', pageId: 'P1' })
    expect(withChildren[0]?.children[0]).toMatchObject({ fullPath: 'work/tasks', pageId: 'P2' })
    // And the duplicate page is still reachable, as its own leaf row.
    const ids: string[] = []
    const visit = (n: (typeof tree)[number]): void => {
      if (n.pageId) ids.push(n.pageId)
      for (const c of n.children) visit(c)
    }
    for (const n of tree) visit(n)
    expect(ids.toSorted()).toEqual(['P1', 'P2', 'P3'])
  })

  it('keeps a namespace-first hybrid on the namespace node', () => {
    // Reverse arrival order: the namespace node exists (no pageId) when
    // the page named after it arrives, so it adopts the node rather than
    // forking a sibling. A THIRD page then forks.
    const tree = buildPageTree([
      { id: 'P1', content: 'work/tasks' },
      { id: 'P2', content: 'work' },
      { id: 'P3', content: 'work' },
    ])

    expect(tree).toHaveLength(2)
    expect(tree[0]).toMatchObject({ fullPath: 'work', pageId: 'P2' })
    expect(tree[0]?.children).toHaveLength(1)
    expect(tree[1]).toMatchObject({ fullPath: 'work', pageId: 'P3', children: [] })
  })

  it('leaves namespace ownership on the FIRST node when the duplicate arrives first', () => {
    // The load-bearing half of the hybrid case: the duplicate sibling is
    // deliberately NOT registered in the per-level index, so a namespace
    // child arriving AFTER it still hangs off the node that owns the
    // path. The two orders pinned above both put the duplicate LAST, so
    // neither exercises that decision — registering the duplicate in the
    // index leaves both of them green.
    const tree = buildPageTree([
      { id: 'P1', content: 'work' },
      { id: 'P2', content: 'work' },
      { id: 'P3', content: 'work/tasks' },
    ])

    expect(tree).toHaveLength(2)
    // First node owns the namespace…
    expect(tree[0]).toMatchObject({ fullPath: 'work', pageId: 'P1' })
    expect(tree[0]?.children).toHaveLength(1)
    expect(tree[0]?.children[0]).toMatchObject({ fullPath: 'work/tasks', pageId: 'P3' })
    // …and the duplicate stays a childless leaf rather than forking one.
    expect(tree[1]).toMatchObject({ fullPath: 'work', pageId: 'P2', children: [] })
  })

  it('keeps every page of a large duplicate cohort', () => {
    // The reporting vault's worst case: 14 pages sharing one journal title.
    const pages = Array.from({ length: 14 }, (_, i) => ({
      id: `P${i}`,
      content: '2026-05-05',
    }))
    const tree = buildPageTree(pages)

    expect(tree).toHaveLength(14)
    expect(new Set(tree.map((n) => n.pageId)).size).toBe(14)
    expect(new Set(tree.map((n) => n.nodeKey ?? n.fullPath)).size).toBe(14)
  })

  // The per-level Map index used internally must not leak
  // into the returned tree — node shape is `{ name, fullPath, pageId?,
  // children }` only, byte-equivalent to the pre-Map implementation.
  it('returned nodes expose no internal index fields', () => {
    const pages = [
      { id: 'P1', content: 'work/projects/alpha' },
      { id: 'P2', content: 'work/projects/beta' },
      { id: 'P3', content: 'work/notes' },
      { id: 'P4', content: 'docs' },
    ]
    const tree = buildPageTree(pages)

    function visit(node: unknown): void {
      const keys = Object.keys(node as object).toSorted()
      // `nodeKey` / `duplicateTitle` (#4709) are part of the public node
      // shape but are set ONLY on duplicate-title nodes — this fixture
      // has none, so they must not appear here either.
      const allowed = ['children', 'fullPath', 'name', 'pageId']
      for (const k of keys) {
        expect(allowed).toContain(k)
      }
      const children = (node as { children: unknown[] }).children
      for (const child of children) visit(child)
    }
    for (const node of tree) visit(node)

    // Byte-equivalent to the pre-Map implementation for this fixture.
    expect(tree).toEqual([
      {
        name: 'work',
        fullPath: 'work',
        children: [
          {
            name: 'projects',
            fullPath: 'work/projects',
            children: [
              { name: 'alpha', fullPath: 'work/projects/alpha', pageId: 'P1', children: [] },
              { name: 'beta', fullPath: 'work/projects/beta', pageId: 'P2', children: [] },
            ],
          },
          { name: 'notes', fullPath: 'work/notes', pageId: 'P3', children: [] },
        ],
      },
      { name: 'docs', fullPath: 'docs', pageId: 'P4', children: [] },
    ])
  })
})
