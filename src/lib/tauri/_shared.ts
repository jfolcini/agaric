/**
 * Re-export shim. The scope helpers moved to `@/lib/space-scope` (#2927
 * phase 8).
 *
 * They were never part of the `@/lib/tauri` wrapper layer being retired —
 * they translate the JS-side `spaceId: string | null` shape into the
 * `SpaceScope` tagged enum the IPC boundary expects, which migrated call
 * sites need just as much as the wrappers do. Leaving them here would mean
 * consumers importing from the very directory this migration exists to
 * delete, re-establishing the dependency being removed.
 *
 * This shim keeps the remaining wrapper modules compiling unchanged; it goes
 * away with the rest of `src/lib/tauri/` once the last importer is migrated.
 */
export { requireActiveScope, toSpaceScope } from '@/lib/space-scope'
