/**
 * Minimal type shim for the untyped `turndown-plugin-gfm` package (#1439).
 *
 * We only consume the `strikethrough` plugin (for `~~strike~~`), passed to
 * `TurndownService.use(...)`. Typing it as a `Plugin` keeps the dynamic import
 * type-safe without pulling in the whole GFM surface (tables / task lists are
 * out of MVP scope). The package has no bundled `.d.ts` and no `@types/*`.
 */
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown'

  export const strikethrough: TurndownService.Plugin
  export const tables: TurndownService.Plugin
  export const taskListItems: TurndownService.Plugin
  export const gfm: TurndownService.Plugin
}
