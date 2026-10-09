import { useCallback } from 'react'

import { useItemCount } from '@/hooks/useItemCount'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { requireActiveScope } from '@/lib/space-scope'
import { useSpaceStore } from '@/stores/space'

/** Returns the number of trashed items. Polls every 30 s and on focus. */
export function useTrashCount(): number {
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
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
  return useItemCount(queryFn, 30_000)
}
