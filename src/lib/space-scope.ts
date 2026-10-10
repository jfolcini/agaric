import type { SpaceScope } from '@/lib/bindings'

/**
 * The one way the frontend builds a `SpaceScope` (#5415): every IPC carries
 * exactly the active space. There is no `null → global` mapping — a caller
 * that has no active space short-circuits (empty result, disabled query,
 * refused action) instead of dispatching, the way `stores/page-blocks.ts`
 * `load()` and `stores/resolve.ts` `preload()` do.
 *
 * The empty-string guard is a loud tripwire for a caller that slipped
 * through that contract: `Active('')` would deserialize into a
 * never-matching filter and silently return nothing.
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
