/**
 * QueryColumnPicker — chooses and orders the columns of an inline query table
 * (#6544). The choice is written into the query itself (`readQueryColumns`),
 * so it syncs with the block; until the user picks, the table derives its
 * columns from the rows.
 */

import { ArrowDown, ArrowUp, Columns3 } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import type { TableColumn } from '@/components/query/QueryResultTable'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { IconButton } from '@/components/ui/icon-button'
import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'

export interface QueryColumnPickerProps {
  /** The columns shown after Content, in order. */
  columns: TableColumn[]
  /** Every column the user can show: the shown ones and the ones the rows carry. */
  pickable: TableColumn[]
  /** Whether the query names its columns, rather than deriving them. */
  named: boolean
  /** The new ordered property keys, or `null` to derive the columns again. */
  onChange: (keys: string[] | null) => void
}

/** The property key a column stands for, as the query names it. */
function specKey(col: TableColumn): string {
  return col.propKey ?? col.key
}

export function QueryColumnPicker({
  columns,
  pickable,
  named,
  onChange,
}: QueryColumnPickerProps): React.ReactElement {
  const { t } = useTranslation()
  const shown = columns.map(specKey)
  const hidden = pickable.filter((col) => !shown.includes(specKey(col)))
  const move = (index: number, by: -1 | 1) => {
    const next = [...shown]
    const [key] = next.splice(index, 1)
    next.splice(index + by, 0, key as string)
    onChange(next)
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 px-1.5"
          aria-label={t('queryResult.columns.trigger')}
          onClick={(e) => e.stopPropagation()}
        >
          <Columns3 />
        </Button>
      </PopoverTrigger>
      <MenuPopoverContent align="end" aria-label={t('queryResult.columns.trigger')}>
        <ul className="space-y-0.5">
          {columns.map((col, index) => (
            <li key={col.key} className="flex items-center gap-1 px-2">
              <Checkbox
                checked
                aria-label={col.label}
                onCheckedChange={() => onChange(shown.filter((key) => key !== specKey(col)))}
              />
              <span className="flex-1 truncate text-sm">{col.label}</span>
              <IconButton
                variant="ghost"
                size="icon-xs"
                tooltip={t('queryResult.columns.moveUp', { column: col.label })}
                ariaLabel={t('queryResult.columns.moveUp', { column: col.label })}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp />
              </IconButton>
              <IconButton
                variant="ghost"
                size="icon-xs"
                tooltip={t('queryResult.columns.moveDown', { column: col.label })}
                ariaLabel={t('queryResult.columns.moveDown', { column: col.label })}
                disabled={index === columns.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown />
              </IconButton>
            </li>
          ))}
          {hidden.map((col) => (
            <li key={col.key} className="flex items-center gap-1 px-2">
              <Checkbox
                checked={false}
                aria-label={col.label}
                onCheckedChange={() => onChange([...shown, specKey(col)])}
              />
              <span className="flex-1 truncate text-sm text-muted-foreground">{col.label}</span>
            </li>
          ))}
        </ul>
        {named && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 w-full justify-start"
            onClick={() => onChange(null)}
          >
            {t('queryResult.columns.automatic')}
          </Button>
        )}
      </MenuPopoverContent>
    </Popover>
  )
}
