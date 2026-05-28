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

import { buildPageTree } from '../page-tree'

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

  // PEND-27 P8: the per-level Map index used internally must not leak
  // into the returned tree — node shape is `{ name, fullPath, pageId?,
  // children }` only, byte-equivalent to the pre-Map implementation.
  it('PEND-27 P8: returned nodes expose no internal index fields', () => {
    const pages = [
      { id: 'P1', content: 'work/projects/alpha' },
      { id: 'P2', content: 'work/projects/beta' },
      { id: 'P3', content: 'work/notes' },
      { id: 'P4', content: 'docs' },
    ]
    const tree = buildPageTree(pages)

    function visit(node: unknown): void {
      const keys = Object.keys(node as object).sort()
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
