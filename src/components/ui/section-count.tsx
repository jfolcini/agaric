/**
 * SectionCount — how a section header writes its count (#7040): the label,
 * then the number in the muted count tone, at the header's own type size:
 * "Completed 2". Several pairs on one header join with a middle dot,
 * "Due 1 · Scheduled 2".
 */

import type * as React from 'react'

import { Badge } from '@/components/ui/badge'

interface SectionCountProps {
  label: React.ReactNode
  count: number
}

function SectionCount({ label, count }: SectionCountProps): React.ReactElement {
  return (
    <>
      {label}{' '}
      <Badge tone="metadata" className="text-[length:inherit]">
        {count}
      </Badge>
    </>
  )
}

export { SectionCount }
