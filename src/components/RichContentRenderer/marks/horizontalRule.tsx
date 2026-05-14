import type React from 'react'

export function renderHorizontalRuleBlock(key: string): React.ReactElement {
  return <hr key={key} className="my-2 border-t border-border" data-testid="horizontal-rule" />
}
