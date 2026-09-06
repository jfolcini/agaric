/**
 * Pure utility for converting a flat page list into a hierarchical tree
 * structure based on namespace separators (/).
 *
 * Titles are NOT unique (pages are ULID-keyed blocks), so a path does not
 * identify a node: two pages sharing a title produce two sibling nodes
 * with the same `fullPath`, told apart by `nodeKey`. See `PageTreeNode`.
 */

export interface PageTreeNode {
  name: string // segment name (e.g., "work" or "project-alpha")
  fullPath: string // full page name (e.g., "work/project-alpha")
  pageId?: string // only set for leaf pages that exist
  /**
   * #4709 — unique React key / DOM-id fragment for this node.
   *
   * `fullPath` used to be the key (`key={child.fullPath}`,
   * `id={`page-row-${node.fullPath}`}`), which is only unique while page
   * titles are. They are not: pages are ULID-keyed and nothing stops two
   * of them sharing a title, so a duplicate emits a SIBLING node with the
   * same `name`/`fullPath` (see below) and the path stops identifying a
   * row. `nodeKey` is absent on the node that owns the path — consumers
   * read `node.nodeKey ?? node.fullPath` — and present only on the extra
   * siblings, so the common case keeps the readable path-based key and
   * every existing hand-built `PageTreeNode` fixture stays valid.
   */
  nodeKey?: string
  /**
   * #4709 — set on EVERY node of a duplicate-title group, the first one
   * included, so the UI can render a disambiguating cue on all of them
   * rather than making the second copy look like the odd one out.
   */
  duplicateTitle?: boolean
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
        if (node.pageId === undefined) {
          node.pageId = page.id
        } else {
          // #4709 — title collision. This used to be a bare
          // `node.pageId = page.id`, i.e. last-writer-wins: the second
          // page with a given title took over the first one's node and
          // the first became unreachable (41 of 286 live pages on the
          // reporting vault). Emit a SIBLING node instead so both pages
          // get a row of their own.
          //
          // The duplicate is deliberately NOT registered in `index`: the
          // first node keeps ownership of the namespace, so a later
          // `work/tasks` still merges into the same `work` node and the
          // hybrid case (a page named `work` that also parents others)
          // behaves exactly as before.
          node.duplicateTitle = true
          current.push({
            name: segment,
            fullPath,
            pageId: page.id,
            // Unique among siblings because page ids are: `fullPath` is
            // shared with the twin, the id is not.
            nodeKey: `${fullPath}#${page.id}`,
            duplicateTitle: true,
            children: [],
          })
        }
      }

      current = node.children
    }
  }

  return root
}
