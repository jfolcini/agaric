import type React from 'react'

import type { HardBreakNode } from '../../../editor/types'

export function renderHardBreak(_node: HardBreakNode, key: string): React.ReactElement {
  return <span key={key}> </span>
}
