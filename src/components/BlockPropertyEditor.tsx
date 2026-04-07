import type React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { BlockRow } from '../lib/tauri'
import { setProperty } from '../lib/tauri'
import { cn } from '../lib/utils'

export interface BlockPropertyEditorProps {
  blockId: string
  editingProp: { key: string; value: string } | null
  setEditingProp: (prop: { key: string; value: string } | null) => void
  editingKey: { oldKey: string; value: string } | null
  setEditingKey: (keyInfo: { oldKey: string; value: string } | null) => void
  selectOptions: string[] | null
  isRefProp: boolean
  refPages: BlockRow[]
  refSearch: string
  setRefSearch: (search: string) => void
}

export function BlockPropertyEditor({
  blockId,
  editingProp,
  setEditingProp,
  editingKey,
  setEditingKey,
  selectOptions,
  isRefProp,
  refPages,
  refSearch,
  setRefSearch,
}: BlockPropertyEditorProps): React.ReactElement | null {
  const { t } = useTranslation()

  return (
    <>
      {editingProp && (
        <div
          className="absolute z-50 mt-1 rounded-md border bg-popover p-1 shadow-lg"
          role="dialog"
          aria-label={t('block.editProperty')}
        >
          {selectOptions ? (
            <div className="flex flex-col gap-0.5" data-testid="select-options-dropdown">
              {selectOptions.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={cn(
                    'text-left rounded px-2 py-1 text-sm hover:bg-accent transition-colors',
                    opt === editingProp.value && 'bg-accent font-medium',
                  )}
                  onClick={async () => {
                    try {
                      await setProperty({ blockId, key: editingProp.key, valueText: opt })
                    } catch {
                      toast.error(t('property.saveFailed'))
                    }
                    setEditingProp(null)
                  }}
                >
                  {opt}
                </button>
              ))}
            </div>
          ) : isRefProp ? (
            <fieldset
              className="flex flex-col gap-0.5 w-56 border-none p-0 m-0"
              data-testid="ref-picker"
              aria-label={t('block.refPickerLabel')}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditingProp(null)
              }}
            >
              <input
                ref={(el) => el?.focus()}
                type="text"
                className="rounded border px-2 py-1 text-sm w-full"
                placeholder={t('block.searchPages')}
                data-testid="ref-search-input"
                value={refSearch}
                onChange={(e) => setRefSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditingProp(null)
                }}
              />
              <ScrollArea className="max-h-48 flex flex-col gap-0.5">
                {(() => {
                  const filtered = refPages.filter((page) => {
                    if (!refSearch) return true
                    const title = page.content || ''
                    return title.toLowerCase().includes(refSearch.toLowerCase())
                  })
                  if (filtered.length === 0) {
                    return (
                      <div
                        className="px-2 py-1 text-sm text-muted-foreground"
                        data-testid="ref-no-results"
                      >
                        {t('block.noPagesFound')}
                      </div>
                    )
                  }
                  return filtered.map((page) => (
                    <button
                      key={page.id}
                      type="button"
                      className={cn(
                        'text-left rounded px-2 py-1 text-sm hover:bg-accent transition-colors truncate',
                        page.id === editingProp.value && 'bg-accent font-medium',
                      )}
                      onClick={async () => {
                        try {
                          await setProperty({
                            blockId,
                            key: editingProp.key,
                            valueRef: page.id,
                          })
                        } catch {
                          toast.error(t('property.saveFailed'))
                        }
                        setEditingProp(null)
                      }}
                    >
                      {page.content || t('block.untitled')}
                    </button>
                  ))
                })()}
              </ScrollArea>
            </fieldset>
          ) : (
            <input
              ref={(el) => el?.focus()}
              type="text"
              className="rounded border px-2 py-1 text-sm w-32"
              aria-label={t('block.editProperty')}
              defaultValue={editingProp.value}
              onBlur={async (e) => {
                const newValue = e.target.value.trim()
                if (newValue !== editingProp.value) {
                  try {
                    await setProperty({
                      blockId,
                      key: editingProp.key,
                      valueText: newValue || null,
                    })
                  } catch {
                    toast.error(t('property.saveFailed'))
                  }
                }
                setEditingProp(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditingProp(null)
              }}
            />
          )}
        </div>
      )}

      {editingKey && (
        <div className="property-key-editor absolute z-50 mt-1 rounded-md border bg-popover p-1 shadow-lg">
          <input
            ref={(el) => el?.focus()}
            type="text"
            className="rounded border px-2 py-1 text-sm w-32"
            aria-label={t('block.editProperty')}
            defaultValue={editingKey.oldKey}
            onBlur={async (e) => {
              const newKey = e.target.value.trim()
              if (newKey && newKey !== editingKey.oldKey) {
                try {
                  await setProperty({
                    blockId,
                    key: newKey,
                    valueText: editingKey.value,
                  })
                  await setProperty({
                    blockId,
                    key: editingKey.oldKey,
                    valueText: null,
                  })
                } catch {
                  toast.error(t('property.renameFailed'))
                }
              }
              setEditingKey(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditingKey(null)
            }}
          />
        </div>
      )}
    </>
  )
}
