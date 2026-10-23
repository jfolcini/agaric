/**
 * useSpaceMove — the cross-space move with its property-loss confirmation
 * (#5841 S0.6), shared by the page header's and the Pages batch toolbar's
 * *Move to space*.
 *
 * Definitions are per space, so a move drops each property the target space
 * does not define identically. `requestMove` previews the losses; a move that
 * loses nothing goes straight through, one that loses something waits for the
 * user in `SpaceMoveConfirmDialog` and then moves with the losses as its
 * acknowledgement. When the backend refuses the acknowledgement (another
 * device or view changed a page or a definition since the preview), the move
 * previews again and asks again.
 */

import { useCallback, useState } from 'react'

import { isValidation, unwrap, validationCode } from '@/lib/app-error'
import type { PropertyLoss } from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { formatErrorForDisplay } from '@/lib/error-display'
import { logger } from '@/lib/logger'
import { ValidationCode } from '@/lib/search-query/validation-codes'

export interface SpaceMoveRequest {
  /** The pages to move. */
  ids: string[]
  targetSpaceId: string
  /** The target's name, for the confirmation copy. */
  targetName: string
  /** The move went through; `count` is how many pages moved. */
  onMoved: (count: number) => void
  /** The preview or the move failed; the caller surfaces it. */
  onFailed: (err: unknown) => void
}

export interface SpaceMoveConfirmation {
  request: SpaceMoveRequest
  losses: PropertyLoss[]
  /** Asked again because the losses changed after the user confirmed. */
  changed: boolean
}

/** Thrown into `ConfirmDialog` so it stays open to ask again. */
class AskedAgain extends Error {}

/**
 * The backend's own words for a refused move (the undo cap: "move fewer
 * pages"), or `fallback` for anything else.
 */
export function spaceMoveFailureMessage(err: unknown, fallback: string): string {
  return isValidation(err) ? formatErrorForDisplay(err) : fallback
}

/**
 * Moves with `ack`. Resolves `true` once moved; on a refused acknowledgement
 * it previews again and either moves (nothing is lost now) or hands the new
 * losses to `ask` and resolves `false`.
 */
async function moveOrAskAgain(
  request: SpaceMoveRequest,
  ack: PropertyLoss[] | null,
  ask: (confirmation: SpaceMoveConfirmation | null) => void,
): Promise<boolean> {
  try {
    const count = unwrap(await commands.moveBlocksToSpace(request.ids, request.targetSpaceId, ack))
    ask(null)
    // The pages moved: a throw from here on is the caller's bug, not a failed move.
    try {
      request.onMoved(count)
    } catch (err) {
      logger.error('useSpaceMove', 'onMoved threw after the move', { count }, err)
    }
    return true
  } catch (err) {
    if (validationCode(err) !== ValidationCode.UnacknowledgedPropertyLoss) throw err
  }
  const losses = unwrap(await commands.previewSpaceMove(request.ids, request.targetSpaceId))
  if (losses.length === 0) return moveOrAskAgain(request, null, ask)
  // Only a refused acknowledgement means something changed since the user confirmed.
  ask({ request, losses, changed: ack !== null })
  return false
}

export function useSpaceMove(): {
  requestMove: (request: SpaceMoveRequest) => Promise<void>
  confirmation: SpaceMoveConfirmation | null
  /** The dialog's confirm: the move with the listed losses acknowledged. */
  confirm: () => Promise<void>
  /** The dialog closed without moving. */
  dismiss: () => void
} {
  const [confirmation, setConfirmation] = useState<SpaceMoveConfirmation | null>(null)

  const requestMove = useCallback(async (request: SpaceMoveRequest): Promise<void> => {
    try {
      const losses = unwrap(await commands.previewSpaceMove(request.ids, request.targetSpaceId))
      if (losses.length > 0) {
        setConfirmation({ request, losses, changed: false })
        return
      }
      await moveOrAskAgain(request, null, setConfirmation)
    } catch (err) {
      request.onFailed(err)
    }
  }, [])

  const confirm = useCallback(async (): Promise<void> => {
    if (confirmation === null) return
    let moved: boolean
    try {
      moved = await moveOrAskAgain(confirmation.request, confirmation.losses, setConfirmation)
    } catch (err) {
      confirmation.request.onFailed(err)
      throw err
    }
    if (!moved) throw new AskedAgain()
  }, [confirmation])

  const dismiss = useCallback(() => setConfirmation(null), [])

  return { requestMove, confirmation, confirm, dismiss }
}
