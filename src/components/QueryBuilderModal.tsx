/**
 * QueryBuilderModal -- visual builder for inline query expressions (F-24).
 *
 * Supports 3 query types: tag, property, backlinks.
 * Generates `{{query ...}}` expression strings.
 */

import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { logger } from '../lib/logger'
import { parseQueryExpression } from '../lib/query-utils'
import { listPropertyDefs } from '../lib/tauri'
import { cn } from '../lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryBuilderModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Initial expression to populate the form (for editing existing queries). */
  initialExpression?: string
  /** Called with the generated expression string when the user saves. */
  onSave: (expression: string) => void
}

type QueryType = 'tag' | 'property' | 'backlinks'

/** Map UI operator symbols to backend operator names. */
const OPERATOR_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '\u2260' },
  { value: 'lt', label: '<' },
  { value: 'gt', label: '>' },
  { value: 'lte', label: '\u2264' },
  { value: 'gte', label: '\u2265' },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QueryBuilderModal({
  open,
  onOpenChange,
  initialExpression,
  onSave,
}: QueryBuilderModalProps): React.ReactElement {
  const { t } = useTranslation()

  // ---- State ----
  const [queryType, setQueryType] = useState<QueryType>('tag')
  const [tagExpr, setTagExpr] = useState('')
  const [propertyKey, setPropertyKey] = useState('')
  const [propertyValue, setPropertyValue] = useState('')
  const [propertyOperator, setPropertyOperator] = useState('eq')
  const [backlinkTarget, setBacklinkTarget] = useState('')
  const [showAsTable, setShowAsTable] = useState(false)
  const [knownPropertyKeys, setKnownPropertyKeys] = useState<string[]>([])

  // ---- Load known property definitions for datalist autocomplete + validation ----
  useEffect(() => {
    if (!open) return
    let cancelled = false
    listPropertyDefs()
      .then((defs) => {
        if (!cancelled) setKnownPropertyKeys(defs.map((d) => d.key))
      })
      .catch((err) => {
        logger.warn('QueryBuilderModal', 'failed to load property definitions', undefined, err)
        if (!cancelled) setKnownPropertyKeys([])
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // ---- Parse initial expression (for editing existing queries) ----
  useEffect(() => {
    if (!initialExpression) return
    const parsed = parseQueryExpression(initialExpression)
    if (parsed.type === 'tag') {
      setQueryType('tag')
      setTagExpr(parsed.params['expr'] ?? '')
    } else if (parsed.type === 'property') {
      setQueryType('property')
      setPropertyKey(parsed.params['key'] ?? '')
      setPropertyValue(parsed.params['value'] ?? '')
      setPropertyOperator(parsed.params['operator'] ?? 'eq')
    } else if (parsed.type === 'backlinks') {
      setQueryType('backlinks')
      setBacklinkTarget(parsed.params['target'] ?? '')
    }
    setShowAsTable(parsed.params['table'] === 'true')
  }, [initialExpression])

  // ---- Expression generation ----
  const expression = useMemo(() => {
    let expr = ''
    if (queryType === 'tag') {
      if (!tagExpr.trim()) return ''
      expr = `type:tag expr:${tagExpr.trim()}`
    } else if (queryType === 'property') {
      if (!propertyKey.trim()) return ''
      expr = `type:property key:${propertyKey.trim()}`
      if (propertyValue.trim()) {
        expr += ` value:${propertyValue.trim()}`
        if (propertyOperator !== 'eq') {
          expr += ` operator:${propertyOperator}`
        }
      }
    } else if (queryType === 'backlinks') {
      if (!backlinkTarget.trim()) return ''
      expr = `type:backlinks target:${backlinkTarget.trim()}`
    }
    if (showAsTable) expr += ' table:true'
    return expr
  }, [
    queryType,
    tagExpr,
    propertyKey,
    propertyValue,
    propertyOperator,
    backlinkTarget,
    showAsTable,
  ])

  // ---- Property-key validation (UX-274) ----
  // Warn when the user enters a key that is not a known property definition.
  // This is a soft warning — submission is not blocked because the property
  // may be defined later or via another device. When `knownPropertyKeys` is
  // empty (e.g. listPropertyDefs failed) we suppress the warning to avoid a
  // false-positive on every key.
  const propertyKeyTrimmed = propertyKey.trim()
  const propertyKeyUnknown =
    queryType === 'property' &&
    propertyKeyTrimmed !== '' &&
    knownPropertyKeys.length > 0 &&
    !knownPropertyKeys.includes(propertyKeyTrimmed)

  const isValid = expression !== ''
  const isEditing = !!initialExpression

  const handleSave = () => {
    if (!isValid) return
    onSave(expression)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('queryBuilder.title')}</DialogTitle>
          <DialogDescription>{t('queryBuilder.description')}</DialogDescription>
        </DialogHeader>

        {/* ---- Query Type Selector ---- */}
        <div className="flex gap-2" role="radiogroup" aria-label={t('queryBuilder.typeLabel')}>
          {(['tag', 'property', 'backlinks'] as const).map((type) => (
            <Button
              key={type}
              variant={queryType === type ? 'default' : 'outline'}
              size="sm"
              role="radio"
              aria-checked={queryType === type}
              onClick={() => setQueryType(type)}
            >
              {t(`queryBuilder.type.${type}`)}
            </Button>
          ))}
        </div>

        {/* ---- Tag Query Form ---- */}
        {queryType === 'tag' && (
          <div className="space-y-2">
            <Label htmlFor="qb-tag-prefix">{t('queryBuilder.tagPrefix')}</Label>
            <Input
              id="qb-tag-prefix"
              value={tagExpr}
              onChange={(e) => setTagExpr(e.target.value)}
              placeholder={t('queryBuilder.tagPrefixPlaceholder')}
            />
          </div>
        )}

        {/* ---- Property Query Form ---- */}
        {queryType === 'property' && (
          <div className="space-y-2">
            <Label htmlFor="qb-prop-key">{t('queryBuilder.propertyKey')}</Label>
            <Input
              id="qb-prop-key"
              value={propertyKey}
              onChange={(e) => setPropertyKey(e.target.value)}
              placeholder={t('queryBuilder.propertyKeyPlaceholder')}
              list="qb-prop-key-list"
              aria-invalid={propertyKeyUnknown}
              aria-describedby={propertyKeyUnknown ? 'qb-prop-key-warning' : undefined}
              className={cn(propertyKeyUnknown && 'border-destructive')}
            />
            <datalist id="qb-prop-key-list" data-testid="qb-prop-key-list">
              {knownPropertyKeys.map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
            {propertyKeyUnknown && (
              <p id="qb-prop-key-warning" className="text-xs text-destructive" role="status">
                {t('queryBuilder.propertyKeyUnknown', { key: propertyKeyTrimmed })}
              </p>
            )}

            <Label htmlFor="qb-prop-operator">{t('queryBuilder.propertyOperator')}</Label>
            <Select value={propertyOperator} onValueChange={setPropertyOperator}>
              <SelectTrigger id="qb-prop-operator" aria-label={t('queryBuilder.propertyOperator')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPERATOR_OPTIONS.map((op) => (
                  <SelectItem key={op.value} value={op.value}>
                    {op.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Label htmlFor="qb-prop-value">{t('queryBuilder.propertyValue')}</Label>
            <Input
              id="qb-prop-value"
              value={propertyValue}
              onChange={(e) => setPropertyValue(e.target.value)}
              placeholder={t('queryBuilder.propertyValuePlaceholder')}
            />
          </div>
        )}

        {/* ---- Backlinks Query Form ---- */}
        {queryType === 'backlinks' && (
          <div className="space-y-2">
            <Label htmlFor="qb-backlink-target">{t('queryBuilder.backlinkTarget')}</Label>
            <Input
              id="qb-backlink-target"
              value={backlinkTarget}
              onChange={(e) => setBacklinkTarget(e.target.value)}
              placeholder={t('queryBuilder.backlinkTargetPlaceholder')}
            />
            <p className="text-xs text-muted-foreground">
              {t('queryBuilder.backlinkTargetHelper')}
            </p>
          </div>
        )}

        {/* ---- Display Options ---- */}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="qb-show-table"
            checked={showAsTable}
            onChange={(e) => setShowAsTable(e.target.checked)}
            className="size-4 [@media(pointer:coarse)]:size-6 rounded border accent-primary"
          />
          <Label htmlFor="qb-show-table" muted={false}>
            {t('queryBuilder.showAsTable')}
          </Label>
        </div>

        {/* ---- Expression Preview ---- */}
        {expression && (
          <div className="space-y-1">
            <Label>{t('queryBuilder.preview')}</Label>
            <code
              className="block rounded bg-muted px-3 py-2 text-xs break-all"
              data-testid="expression-preview"
            >
              {expression}
            </code>
          </div>
        )}

        {/* ---- Footer ---- */}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('queryBuilder.cancelButton')}
          </Button>
          <Button disabled={!isValid} onClick={handleSave}>
            {isEditing ? t('queryBuilder.updateButton') : t('queryBuilder.insertButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
