/**
 * Authoritative Rolldown vendor chunk groups.
 *
 * The single-bundle default pushed `index-*.js` past 1.8 MB raw, which
 * triggered Vite's 500 kB warning and slowed first-paint parse on Android and
 * low-end devices. Logical vendor groups trim the entry chunk, enable parallel
 * downloads, and let the browser cache editor/highlight independently from app
 * code. Total payload is unchanged; the win is parallelism, cache granularity,
 * and critical-path parse size.
 *
 * Each `test` runs against a module's absolute id; the highest-priority match
 * wins. Anything unmatched (lucide icons, match-sorter, sonner, date-fns,
 * @tanstack/react-virtual, zustand, and similar small/startup dependencies)
 * stays with the entry/default split.
 *
 * #2939 — priority order matters. Common runtime groups (react-vendor,
 * highlight, floating-vendor) outrank the broad editor group so nested TipTap
 * dependencies are classified by what they are, while floating UI and
 * fast-equals remain in the small always-loaded chunk shared by startup Radix
 * and the dynamically loaded editor.
 *
 * Both Vite's production chunking and the bundle-budget gate import this
 * array, so adding a named chunk automatically makes it budget-tracked.
 */
interface VendorChunkGroup {
  name: string
  test: RegExp
  priority: number
}

export const VENDOR_CHUNK_GROUPS = [
  // React baseline — extracted so app-code changes don't bust its cache.
  {
    name: 'react-vendor' as const,
    test: /[\\/]node_modules[\\/](react|react-dom|scheduler|react-i18next|i18next|use-sync-external-store)[\\/]/,
    priority: 60,
  },
  // Syntax highlighting — highlight.js grammars (~260 kB) + lowlight. Loaded
  // lazily by both the read-only renderer (idle) and the editor chunk.
  {
    name: 'highlight' as const,
    test: /[\\/]node_modules[\\/](highlight\.js|lowlight|@wooorm)[\\/]/,
    priority: 55,
  },
  // Floating UI + fast-equals — shared between startup overlays (Radix) and the
  // dynamic editor stack; MUST outrank `editor` to keep the editor chunk lazy.
  {
    name: 'floating-vendor' as const,
    test: /[\\/]node_modules[\\/](@floating-ui|fast-equals)[\\/]/,
    priority: 50,
  },
  // Editor stack — @tiptap + prosemirror. Reached ONLY via the dynamic
  // `RovingEditorHost` import (#2939), so this chunk is no longer modulepreloaded
  // from index.html: it loads on an idle callback after first paint, or on the
  // first edit interaction.
  {
    name: 'editor' as const,
    test: /[\\/]node_modules[\\/](@tiptap[\\/]|prosemirror-|linkifyjs[\\/]|rope-sequence[\\/]|w3c-keyname[\\/]|orderedmap[\\/]|crelt[\\/])/,
    priority: 40,
  },
  // Drag-and-drop — only exercised in block trees and sortable lists.
  { name: 'dnd' as const, test: /[\\/]node_modules[\\/]@dnd-kit[\\/]/, priority: 30 },
  // Date picker (calendar popover) — date properties + journal date selection.
  {
    name: 'datepicker' as const,
    test: /[\\/]node_modules[\\/]react-day-picker[\\/]/,
    priority: 30,
  },
  // Radix UI overlay primitives (dialogs/popovers, also pulled by sonner toasts).
  { name: 'ui-radix' as const, test: /[\\/]node_modules[\\/]@radix-ui[\\/]/, priority: 30 },
  // d3-* (force, selection, drag, zoom, quadtree) — only the graph-view sim.
  { name: 'd3' as const, test: /[\\/]node_modules[\\/]d3-/, priority: 30 },
] satisfies VendorChunkGroup[]
