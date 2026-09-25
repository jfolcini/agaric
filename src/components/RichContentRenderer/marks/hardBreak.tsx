import type React from 'react'

import type { RenderContext } from '@/components/RichContentRenderer/context'
import type { HardBreakNode } from '@/editor/types'

/**
 * A line break inside the block, shown as one at rest (#5160 D2). A preview
 * keeps a space: a <br> would break a clamped row and hide the next line.
 */
export function renderHardBreak(
  _node: HardBreakNode,
  key: string,
  ctx: RenderContext,
): React.ReactElement {
  return ctx.inline ? <span key={key}> </span> : <br key={key} />
}
