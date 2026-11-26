import { useCallback, useSyncExternalStore } from 'react'

import { useItemCount } from '@/hooks/useItemCount'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { queryClient } from '@/lib/query-client'
import { requireActiveScope } from '@/lib/space-scope'
import { useSpaceStore } from '@/stores/space'

const subscribeToQueries = (onChange: () => void) => queryClient.getQueryCache().subscribe(onChange)

/**
 * Returns the number of trashed items. Polls every 30 s, on focus, when
 * `recountKey` changes, and when the Trash view's list (`['trash', space]`)
 * updates, which each restore and purge does once it lands: a badge that stays
 * mounted recounts on navigation and beside the Trash list.
 */
export function useTrashCount(recountKey: string): number {
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const trashListUpdatedAt = useSyncExternalStore(
    subscribeToQueries,
    () => queryClient.getQueryState(['trash', currentSpaceId])?.dataUpdatedAt,
  )
  const queryFn = useCallback(
    () =>
      // `countTrash` pushes the count into SQL so the trash badge stays
      // accurate regardless of trash size. #2248 — trash is inherently
      // space-scoped, so with no active space there is nothing to count:
      // short-circuit to `0` locally instead of passing an empty-string
      // sentinel to the backend (which would now reject a malformed scope).
      currentSpaceId == null
        ? Promise.resolve(0)
        : commands.countTrash(requireActiveScope(currentSpaceId)).then(unwrap),
    [currentSpaceId],
  )
  return useItemCount(queryFn, 30_000, `${recountKey} ${trashListUpdatedAt}`)
}
