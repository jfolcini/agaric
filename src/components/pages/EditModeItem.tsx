/**
 * The *Page actions* row that switches the page's editing mode (#5691),
 * naming the mode the page is not in; a blocked page's row says why and does
 * nothing (`PageHeaderMenu`, and the journal day's menu in `DayPageEditor`).
 */

import { FileText, Rows3 } from 'lucide-react'
import type React from 'react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import type { EditMode } from '@/lib/preferences'
import { cn } from '@/lib/utils'

interface EditModeItemProps extends React.ComponentProps<'button'> {
  mode: EditMode | undefined
  blocked: string | null | undefined
  onModeChange: (mode: EditMode) => void
}

export function EditModeItem({
  mode,
  blocked,
  onModeChange,
  className,
  ...props
}: EditModeItemProps): React.ReactElement {
  const { t } = useTranslation()
  const labelId = useId()
  const reasonId = useId()
  const to: EditMode = mode === 'page' ? 'blocks' : 'page'
  const Icon = to === 'page' ? FileText : Rows3
  return (
    <button
      type="button"
      className={cn(
        className,
        'aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground',
      )}
      aria-labelledby={labelId}
      aria-disabled={blocked ? true : undefined}
      aria-describedby={blocked ? reasonId : undefined}
      onClick={() => {
        if (!blocked) onModeChange(to)
      }}
      {...props}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="flex flex-col">
        <span id={labelId}>
          {t(to === 'page' ? 'pageMode.editAsPage' : 'pageMode.editAsBlocks')}
        </span>
        {blocked && (
          <span id={reasonId} className="text-xs">
            {blocked}
          </span>
        )}
      </span>
    </button>
  )
}
