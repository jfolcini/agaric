import type { SpaceScope } from '@/lib/bindings'

/**
 * Phase 3 — translate the JS-side `spaceId: string | null` shape
 * into the new tagged-enum [`SpaceScope`] the IPC boundary now expects.
 *
 * `null` / `undefined` → `{ kind: 'global' }` (cross-space view, the
 * Pre- behaviour for callsites that haven't promoted to per-space
 * scoping yet). A non-empty ULID → `{ kind: 'active', space_id }`.
 *
 * The wrapper signatures in this file keep accepting the legacy
 * `spaceId: string | null` for backward-compatibility with the rest of
 * the frontend; the SpaceScope object is constructed here so the
 * translation lives in one place.
 */
export function toSpaceScope(spaceId: string | null | undefined): SpaceScope {
  return spaceId == null ? { kind: 'global' } : { kind: 'active', space_id: spaceId }
}

/**
 * Required-active scope helper for the `b1` command group (page/tag
 * listing + journal lookup). Unlike {@link toSpaceScope}, there is NO
 * `null → global` mapping: these commands filter to a single active
 * space and have no meaningful cross-space (`Global`) form. The backend
 * rejects a `Global` scope for them via `SpaceScope::require_active`.
 *
 * Every caller MUST short-circuit locally (return an empty result)
 * before dispatching when there is no active space — passing an empty
 * or absent space id would encode `Active('')`, which the backend
 * rejects at deserialize (a never-matching filter would otherwise
 * silently return nothing). The empty-string guard here is a loud
 * tripwire for any caller that slips through that contract.
 */
export function requireActiveScope(spaceId: string): SpaceScope {
  if (spaceId.length === 0) {
    throw new Error(
      'requireActiveScope: empty space id — the caller must short-circuit to an empty ' +
        'result when there is no active space instead of dispatching this command',
    )
  }
  return { kind: 'active', space_id: spaceId }
}
