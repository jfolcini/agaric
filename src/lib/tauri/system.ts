import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { SpaceRow, StatusInfo } from '@/lib/bindings'

/** Get materializer queue status and metrics. */
export async function getStatus(): Promise<StatusInfo> {
  return unwrap(await commands.getStatus())
}

/**
 * List every space (id + display name) alphabetical by name. Used by the
 * sidebar `SpaceSwitcher` + the Zustand `useSpaceStore`.
 */
export async function listSpaces(): Promise<SpaceRow[]> {
  return unwrap(await commands.listSpaces())
}

/**
 * Create a new page block and atomically assign it to `spaceId`.
 *
 * Phase 2 — the backend wraps both the `CreateBlock` op and the
 * `SetProperty(space = <spaceId>)` op in a single transaction so a page
 * never exists without its space property. Callers that create
 * top-level pages (PageBrowser new-page, App new-page actions, the
 * link-picker create-new-page affordance) must route through this
 * command rather than `createBlock({ blockType: 'page' })` — the latter
 * leaves the new page unscoped and violates the "nothing outside of
 * spaces" invariant.
 *
 * Returns the new page's ULID.
 */
export async function createPageInSpace(params: {
  parentId?: string | null | undefined
  content: string
  spaceId: string
}): Promise<string> {
  return unwrap(
    await commands.createPageInSpace(params.parentId ?? null, params.content, params.spaceId),
  )
}

/**
 * Create a new space (a top-level page block flagged
 * `is_space = 'true'`).
 *
 * Phase 6 — the backend wraps the `CreateBlock` op, the
 * `SetProperty(is_space = "true")` op, and the optional
 * `SetProperty(accent_color = …)` op in a single transaction so a
 * partial failure never leaves a half-created space (a page block
 * without its `is_space` flag) in the op log.
 *
 * `accentColor` accepts the palette tokens consumed by
 * (e.g. `accent-violet`, `accent-blue`, …). Pass `null` / `undefined`
 * to skip the accent-color property entirely.
 *
 * Returns the new space's ULID.
 */
export async function createSpace(params: {
  name: string
  accentColor?: string | null | undefined
}): Promise<string> {
  return unwrap(await commands.createSpace(params.name, params.accentColor ?? null))
}
