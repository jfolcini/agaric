/**
 * #4006 — moved down from `@/components/search/AutocompletePopover` so
 * `hooks/`-tier consumers (`useAutocompleteSources`) can depend on the item
 * shape without importing `components/`, which the lib-layering guard
 * (#3121) forbids. Pure data — no React dependency.
 */
export interface AutocompleteItem {
  /** The string inserted into the input when this item is picked. */
  value: string
  /** Display label (defaults to `value`). */
  label?: string
}
