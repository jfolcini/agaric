/**
 * The drag-to-reorder setup the sidebar's bookmarks and the tab strip share: a
 * dnd-kit sortable list moved by the pointer, or by Space, arrows, Space.
 */

import {
  type Announcements,
  KeyboardCode,
  KeyboardSensor,
  type KeyboardSensorOptions,
  PointerSensor,
  type ScreenReaderInstructions,
  TouchSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import type { TFunction } from 'i18next'

import { MOUSE_DRAG_ACTIVATION_DISTANCE } from '@/components/block-tree/use-block-dnd'
import {
  LONG_PRESS_DELAY,
  LONG_PRESS_MOVE_THRESHOLD,
} from '@/components/block-tree/use-block-touch-long-press'
import { useIsTouch } from '@/hooks/useIsTouch'

/**
 * Space picks an item up; Enter is left to the button, so it still opens or
 * activates it. Enter and Tab still drop one that is already up.
 */
const KEYBOARD_SENSOR_OPTIONS: KeyboardSensorOptions = {
  coordinateGetter: sortableKeyboardCoordinates,
  keyboardCodes: {
    start: [KeyboardCode.Space],
    cancel: [KeyboardCode.Esc],
    end: [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Tab],
  },
}

/**
 * The block tree's pointer sensors (`use-block-dnd.ts`): on a coarse pointer
 * the drag waits for the long-press hold, so a swipe still scrolls; on a fine
 * one it waits for 8px of travel, so a click still activates the item.
 */
export function useReorderSensors() {
  const isTouch = useIsTouch()
  return useSensors(
    useSensor(isTouch ? TouchSensor : PointerSensor, {
      activationConstraint: isTouch
        ? { delay: LONG_PRESS_DELAY, tolerance: LONG_PRESS_MOVE_THRESHOLD }
        : { distance: MOUSE_DRAG_ACTIVATION_DISTANCE },
    }),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS),
  )
}

/** Announcements naming items by `titleOf`: dnd-kit's default reads the id, a ULID (#2943). */
export function reorderAccessibility(
  t: TFunction,
  titleOf: (id: UniqueIdentifier) => string,
  instructions: string,
): { announcements: Announcements; screenReaderInstructions: ScreenReaderInstructions } {
  return {
    announcements: {
      onDragStart: ({ active }) => t('dnd.pickedUp', { block: titleOf(active.id) }),
      onDragOver: ({ active, over }) =>
        over
          ? t('dnd.movedOver', { block: titleOf(active.id), target: titleOf(over.id) })
          : t('dnd.movedOutside', { block: titleOf(active.id) }),
      onDragEnd: ({ active, over }) =>
        over
          ? t('dnd.dropped', { block: titleOf(active.id), target: titleOf(over.id) })
          : t('dnd.droppedOutside', { block: titleOf(active.id) }),
      onDragCancel: ({ active }) => t('dnd.cancelled', { block: titleOf(active.id) }),
    },
    screenReaderInstructions: { draggable: instructions },
  }
}
