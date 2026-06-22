/**
 * QueryBuilderModal -- visual builder for inline query expressions (F-24).
 *
 * Supports 3 query types: tag, property, backlinks.
 * Generates `{{query ...}}` expression strings.
 */

import type React from 'react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogBody,
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
import { encodeInlineQueryPayload, decodeInlineQueryPayload } from '@/lib/inline-query-spec'
import { logger } from '@/lib/logger'
import { parseQueryExpression } from '@/lib/query-utils'
import type { FilterPrimitive } from '@/lib/tauri'
import { listPropertyDefs } from '@/lib/tauri'
import { cn } from '@/lib/utils'
import {
  addGroupToTree,
  addLeafToTree,
  builderTreeToFilterExpr,
  type BuilderGroupNode,
  type BuilderNode,
  type BuilderPath,
  filterExprToBuilderTree,
  makeEmptyRoot,
  removeNodeFromTree,
  setGroupOpInTree,
  toggleNegateInTree,
} from '@/stores/advancedQuery'

// The nested-builder UI (and its AddFilterPopover subtree) is only needed when
// the user opens Advanced mode, so it is lazy-loaded to keep it off the entry
// chunk's critical path (#750 bundle budget).
const FilterGroup = lazy(() =>
  import('@/components/AdvancedQuery/FilterGroup').then((m) => ({ default: m.FilterGroup })),
)

/** Total number of leaf (condition) nodes in a builder tree. */
function countLeaves(node: BuilderNode): number {
  if (node.kind === 'leaf') return 1
  return node.children.reduce((sum, child) => sum + countLeaves(child), 0)
}

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

// Shared by the roving-tabindex keyboard handler and the `.map` below so the
// arrow-key navigation order always matches the rendered radio order.
const QUERY_TYPES = ['tag', 'property', 'backlinks'] as const

/**
 * Map UI operator symbols to backend operator names.
 *
 * Each option carries both the glyph (`symbol`) — shown in the
 * trigger and as a leading affordance in the dropdown row — and a
 * translation key (`descKey`) for the human-readable description that
 * appears beside the glyph in the dropdown only. The description is
 * rendered via `<SelectItem endContent>` so it stays out of the
 * Radix auto-mirror surface that fills the trigger (see
 * `src/components/ui/select.tsx` for the contract).
 */
const OPERATOR_OPTIONS: Array<{ value: string; symbol: string; descKey: string }> = [
  { value: 'eq', symbol: '=', descKey: 'query.operator.eqDesc' },
  { value: 'neq', symbol: '\u2260', descKey: 'query.operator.neqDesc' },
  { value: 'lt', symbol: '<', descKey: 'query.operator.ltDesc' },
  { value: 'gt', symbol: '>', descKey: 'query.operator.gtDesc' },
  { value: 'lte', symbol: '\u2264', descKey: 'query.operator.lteDesc' },
  { value: 'gte', symbol: '\u2265', descKey: 'query.operator.gteDesc' },
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
  // `simple` is the legacy 3-type form (emits a `type:… key:…` text query);
  // `advanced` is the nested And/Or/Not builder (emits a structured `v2:` payload
  // executed by the rich engine). Defaults to simple so existing flows/tests are
  // unchanged; editing a `v2:` block switches to advanced automatically.
  const [mode, setMode] = useState<'simple' | 'advanced'>('simple')
  const [queryType, setQueryType] = useState<QueryType>('tag')
  const radioRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [tagExpr, setTagExpr] = useState('')
  const [propertyKey, setPropertyKey] = useState('')
  const [propertyValue, setPropertyValue] = useState('')
  const [propertyOperator, setPropertyOperator] = useState('eq')
  const [backlinkTarget, setBacklinkTarget] = useState('')
  const [showAsTable, setShowAsTable] = useState(false)
  const [knownPropertyKeys, setKnownPropertyKeys] = useState<string[]>([])

  // ---- Advanced (nested-builder) state ----
  // A LOCAL builder tree (the modal edits one block's query, so it does NOT use
  // the per-space advancedQuery store). Node ids are React-key-only and compile
  // away, so a local monotonic counter is sufficient (see `makeEmptyRoot`).
  const [builderRoot, setBuilderRoot] = useState<BuilderGroupNode>(() => makeEmptyRoot(0))
  const idRef = useRef(0)
  const nextId = (): number => {
    idRef.current += 1
    return idRef.current
  }
  const handleAddLeaf = (path: BuilderPath, primitive: FilterPrimitive): void =>
    setBuilderRoot((root) => addLeafToTree(root, path, primitive, nextId()))
  const handleAddGroup = (path: BuilderPath): void =>
    setBuilderRoot((root) => addGroupToTree(root, path, nextId()))
  const handleRemoveNode = (path: BuilderPath): void =>
    setBuilderRoot((root) => removeNodeFromTree(root, path))
  const handleSetGroupOp = (path: BuilderPath, op: 'And' | 'Or'): void =>
    setBuilderRoot((root) => setGroupOpInTree(root, path, op))
  const handleToggleNegate = (path: BuilderPath): void =>
    setBuilderRoot((root) => toggleNegateInTree(root, path))
  const advancedLeafCount = countLeaves(builderRoot)

  // ---- Load known property definitions for datalist autocomplete + validation ----
  // `listPropertyDefs` is paginated; the modal is single-page-by-design —
  // datalist suggestions only need the first page worth of keys.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    listPropertyDefs()
      .then(({ items: defs }) => {
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
    // A structured `v2:` block opens straight into the advanced builder with its
    // tree rehydrated; a legacy text block opens the simple form as before.
    const structured = decodeInlineQueryPayload(initialExpression)
    if (structured) {
      setMode('advanced')
      setBuilderRoot(filterExprToBuilderTree(structured.filter, nextId))
      setShowAsTable(structured.table)
      return
    }
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
    // Advanced mode emits the structured `v2:` payload run by the rich engine.
    // An empty tree (no leaves) is not a meaningful saved query, so it is
    // treated as invalid (empty string) — same gate as the simple form's empty
    // inputs.
    if (mode === 'advanced') {
      if (advancedLeafCount === 0) return ''
      return encodeInlineQueryPayload({
        filter: builderTreeToFilterExpr(builderRoot),
        table: showAsTable,
      })
    }
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
    mode,
    advancedLeafCount,
    builderRoot,
    queryType,
    tagExpr,
    propertyKey,
    propertyValue,
    propertyOperator,
    backlinkTarget,
    showAsTable,
  ])

  // ---- Plain-English readable summary ----
  // Surfaces a humanised paraphrase of the generated `expression` above the
  // raw `<code>` block so users unfamiliar with the `type:... key:...` syntax
  // can verify intent. Mirrors `expression`'s empty-form gate so the line
  // disappears whenever the raw preview would.
  const humanReadable = useMemo(() => {
    if (queryType === 'tag') {
      if (!tagExpr.trim()) return ''
      return t('queryBuilder.readable.tag', { expr: tagExpr.trim() })
    }
    if (queryType === 'property') {
      const k = propertyKey.trim()
      if (!k) return ''
      const v = propertyValue.trim()
      if (!v) return t('queryBuilder.readable.propertyKeyOnly', { key: k })
      const opLabel = t(`queryBuilder.readable.op.${propertyOperator}`)
      return t('queryBuilder.readable.propertyKeyValue', { key: k, op: opLabel, value: v })
    }
    if (queryType === 'backlinks') {
      const target = backlinkTarget.trim()
      if (!target) return ''
      return t('queryBuilder.readable.backlinks', { target })
    }
    return ''
  }, [queryType, tagExpr, propertyKey, propertyValue, propertyOperator, backlinkTarget, t])

  // ---- Property-key validation ----
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

  // WAI-ARIA radiogroup: vertical+horizontal roving tabindex with automatic
  // activation — arrow keys move focus AND select the radio. Up/Left go to the
  // previous option, Down/Right to the next, both with wraparound; Home/End
  // jump to the ends.
  const handleRadioGroupKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const count = QUERY_TYPES.length
    const currentIndex = QUERY_TYPES.indexOf(queryType)
    let nextIndex: number
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight': {
        nextIndex = (currentIndex + 1) % count
        break
      }
      case 'ArrowUp':
      case 'ArrowLeft': {
        nextIndex = (currentIndex - 1 + count) % count
        break
      }
      case 'Home': {
        nextIndex = 0
        break
      }
      case 'End': {
        nextIndex = count - 1
        break
      }
      default: {
        return
      }
    }
    e.preventDefault()
    const target = QUERY_TYPES[nextIndex] as QueryType
    setQueryType(target)
    radioRefs.current[target]?.focus()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('queryBuilder.title')}</DialogTitle>
          <DialogDescription>{t('queryBuilder.description')}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          {/* ---- Mode toggle (Simple text form vs. nested And/Or/Not builder) ---- */}
          <div className="flex flex-wrap gap-2" aria-label={t('queryBuilder.mode.label')}>
            {(['simple', 'advanced'] as const).map((m) => (
              <Button
                key={m}
                variant={mode === m ? 'default' : 'outline'}
                size="sm"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
              >
                {t(`queryBuilder.mode.${m}`)}
              </Button>
            ))}
          </div>

          {/* ---- Query Type Selector (simple mode) ---- */}
          {mode === 'simple' && (
            <div
              className="flex flex-wrap gap-2"
              role="radiogroup"
              aria-label={t('queryBuilder.typeLabel')}
              tabIndex={-1}
              onKeyDown={handleRadioGroupKeyDown}
            >
              {QUERY_TYPES.map((type) => (
                <Button
                  key={type}
                  ref={(el) => {
                    radioRefs.current[type] = el
                  }}
                  variant={queryType === type ? 'default' : 'outline'}
                  size="sm"
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role="radio" on a styled <Button> inside a roving-tabindex radiogroup; a native <input type="radio"> would lose the Button styling and the aria-checked/roving-focus toggle behavior
                  role="radio"
                  aria-checked={queryType === type}
                  tabIndex={queryType === type ? 0 : -1}
                  onClick={() => setQueryType(type)}
                >
                  {t(`queryBuilder.type.${type}`)}
                </Button>
              ))}
            </div>
          )}

          {/* ---- Tag Query Form ---- */}
          {mode === 'simple' && queryType === 'tag' && (
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
          {mode === 'simple' && queryType === 'property' && (
            <div className="space-y-2">
              <Label htmlFor="qb-prop-key">{t('queryBuilder.propertyKey')}</Label>
              <Input
                id="qb-prop-key"
                value={propertyKey}
                onChange={(e) => setPropertyKey(e.target.value)}
                placeholder={t('queryBuilder.propertyKeyPlaceholder')}
                list="qb-prop-key-list"
                aria-autocomplete="list"
                aria-controls="qb-prop-key-list"
                aria-invalid={propertyKeyUnknown}
                aria-describedby={propertyKeyUnknown ? 'qb-prop-key-warning' : undefined}
                className={cn(propertyKeyUnknown && 'border-destructive')}
              />
              <datalist id="qb-prop-key-list" data-testid="qb-prop-key-list">
                {knownPropertyKeys.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </datalist>
              {propertyKeyUnknown && (
                <p id="qb-prop-key-warning" className="text-xs text-destructive" aria-live="polite">
                  {t('queryBuilder.propertyKeyUnknown', { key: propertyKeyTrimmed })}
                </p>
              )}

              <Label htmlFor="qb-prop-operator">{t('queryBuilder.propertyOperator')}</Label>
              <Select value={propertyOperator} onValueChange={setPropertyOperator}>
                <SelectTrigger
                  id="qb-prop-operator"
                  aria-label={t('queryBuilder.propertyOperator')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPERATOR_OPTIONS.map((op) => (
                    <SelectItem
                      key={op.value}
                      value={op.value}
                      endContent={
                        <span className="ml-2 text-muted-foreground">{t(op.descKey)}</span>
                      }
                    >
                      {op.symbol}
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
          {mode === 'simple' && queryType === 'backlinks' && (
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

          {/* ---- Advanced (nested And/Or/Not) builder ---- */}
          {mode === 'advanced' && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t('queryBuilder.advanced.hint')}</p>
              <Suspense fallback={<div className="text-xs text-muted-foreground">…</div>}>
                <FilterGroup
                  node={builderRoot}
                  path={[]}
                  depth={0}
                  onAddLeaf={handleAddLeaf}
                  onAddGroup={handleAddGroup}
                  onRemoveNode={handleRemoveNode}
                  onSetGroupOp={handleSetGroupOp}
                  onToggleNegate={handleToggleNegate}
                />
              </Suspense>
              <p className="text-xs text-muted-foreground" data-testid="advanced-filter-count">
                {advancedLeafCount === 0
                  ? t('queryBuilder.advanced.empty')
                  : t('queryBuilder.advanced.filterCount', { count: advancedLeafCount })}
              </p>
            </div>
          )}

          {/* ---- Display Options ---- */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="qb-show-table"
              aria-label={t('queryBuilder.showAsTable')}
              checked={showAsTable}
              onCheckedChange={(next) => setShowAsTable(next === true)}
            />
            <Label htmlFor="qb-show-table" muted={false}>
              {t('queryBuilder.showAsTable')}
            </Label>
          </div>

          {/* ---- Expression Preview (simple mode only — the advanced builder is
              its own visual preview, and its `v2:` payload is opaque base64) ---- */}
          {mode === 'simple' && expression && (
            <div className="space-y-1">
              <Label>{t('queryBuilder.preview')}</Label>
              {humanReadable && (
                <p className="text-xs text-muted-foreground" data-testid="readable-preview">
                  {humanReadable}
                </p>
              )}
              <code
                className="block rounded bg-muted px-3 py-2 text-xs break-all"
                data-testid="expression-preview"
              >
                {expression}
              </code>
              {showAsTable && (
                <p className="text-xs text-muted-foreground">{t('queryBuilder.readable.table')}</p>
              )}
            </div>
          )}
        </DialogBody>

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
