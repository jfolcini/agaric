import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export interface PageAliasSectionProps {
  aliases: string[]
  editingAliases: boolean
  aliasInput: string
  onAliasInputChange: (value: string) => void
  onAddAlias: () => void
  onRemoveAlias: (alias: string) => void
  onStartEditing: () => void
  onStopEditing: () => void
}

export function PageAliasSection({
  aliases,
  editingAliases,
  aliasInput,
  onAliasInputChange,
  onAddAlias,
  onRemoveAlias,
  onStartEditing,
  onStopEditing,
}: PageAliasSectionProps) {
  const { t } = useTranslation()

  if (aliases.length === 0 && !editingAliases) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1">
      {aliases.length > 0 && <span className="font-medium">{t('pageHeader.aliases')}</span>}
      {aliases.map((alias) => (
        <Badge key={alias} variant="secondary" className="gap-1">
          {alias}
          {editingAliases && (
            <button
              type="button"
              className="ml-0.5 inline-flex items-center justify-center rounded-full p-0.5 hover:bg-muted-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:p-2"
              onClick={() => onRemoveAlias(alias)}
              aria-label={t('pageHeader.removeAlias', { alias })}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </Badge>
      ))}
      {editingAliases ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            onAddAlias()
          }}
        >
          <Input
            type="text"
            className="w-24 [@media(pointer:coarse)]:w-full h-7 text-xs"
            placeholder={t('pageHeader.newAliasPlaceholder')}
            value={aliasInput}
            onChange={(e) => onAliasInputChange(e.target.value)}
            aria-label={t('pageHeader.newAliasInput')}
          />
          <Button type="submit" variant="ghost" size="xs">
            {t('pageHeader.add')}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={onStopEditing}>
            {t('pageHeader.done')}
          </Button>
        </form>
      ) : (
        <Button
          variant="ghost"
          size="xs"
          className="gap-1 text-muted-foreground"
          onClick={onStartEditing}
        >
          {t('pageHeader.edit')}
        </Button>
      )}
    </div>
  )
}
