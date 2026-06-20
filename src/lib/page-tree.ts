/**
 * Pure utility for converting a flat page list into a hierarchical tree
 * structure based on namespace separators (/).
 */

export interface PageTreeNode {
  name: string // segment name (e.g., "work" or "project-alpha")
  fullPath: string // full page name (e.g., "work/project-alpha")
  pageId?: string // only set for leaf pages that exist
  children: PageTreeNode[]
}

export function buildPageTree(
  pages: Array<{ id: string; content: string | null }>,
): PageTreeNode[] {
  const root: PageTreeNode[] = []
  // Keep a parallel `name → node` index per level so the inner
  // lookup is O(1) instead of `current.find(...)` over `current.length`.
  // The index is keyed off the `children` array reference (using the root
  // array as the top-level key) and never escapes this function, so the
  // returned `PageTreeNode` shape is unchanged for consumers.
  const indexByLevel = new Map<PageTreeNode[], Map<string, PageTreeNode>>()
  indexByLevel.set(root, new Map())

  for (const page of pages) {
    const path = page.content ?? 'Untitled'
    const segments = path.split('/')
    let current = root

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] as string
      const fullPath = segments.slice(0, i + 1).join('/')
      const index = indexByLevel.get(current) as Map<string, PageTreeNode>
      let node = index.get(segment)

      if (!node) {
        node = { name: segment, fullPath, children: [] }
        current.push(node)
        index.set(segment, node)
        indexByLevel.set(node.children, new Map())
      }

      if (i === segments.length - 1) {
        node.pageId = page.id
      }

      current = node.children
    }
  }

  return root
}
