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

  for (const page of pages) {
    const path = page.content ?? 'Untitled'
    const segments = path.split('/')
    let current = root

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] as string
      const fullPath = segments.slice(0, i + 1).join('/')
      let node = current.find((n) => n.name === segment)

      if (!node) {
        node = { name: segment, fullPath, children: [] }
        current.push(node)
      }

      if (i === segments.length - 1) {
        node.pageId = page.id
      }

      current = node.children
    }
  }

  return root
}
