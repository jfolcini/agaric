import type React from 'react'

import type { HardBreakNode } from '@/editor/types'

/** A line break inside the block, shown as one at rest (#5160 D2). */
export function renderHardBreak(_node: HardBreakNode, key: string): React.ReactElement {
  return <br key={key} />
}
