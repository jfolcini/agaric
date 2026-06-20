/**
 * SearchHelpDialog — in-app reference for the search panel.
 *
 * Triggered by the `?` button in the search toolbar (wired up by the
 * panel itself; this component is a passive `open` / `onOpenChange`
 * sink so the parent owns trigger state).
 *
 * Five populated sections: Filter syntax, Toggles, Regex syntax,
 * Boolean operators, and Tips. Section headings + the dialog
 * description are i18n'd; the body prose is i18n'd via t()/<Trans>
 *while monospace token identifiers (filter prefixes, regex
 * syntax) render verbatim as code.
 */

import { CaseSensitive, Regex, WholeWord } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'

interface SearchHelpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Filter syntax section body. */
function FilterSyntaxBody() {
  const { t } = useTranslation()
  const mono = <span className="font-mono" />
  return (
    <div className="text-muted-foreground text-sm space-y-2">
      <p>
        <Trans i18nKey="search.help.filter.intro" components={{ mono }} />
      </p>
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-left">
            <th className="pr-3">{t('search.help.filter.col.token')}</th>
            <th>{t('search.help.filter.col.meaning')}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="pr-3">tag:#name</td>
            <td>{t('search.help.filter.cell.tagName')}</td>
          </tr>
          <tr>
            <td className="pr-3">#name</td>
            <td>{t('search.help.filter.cell.bareTag')}</td>
          </tr>
          <tr>
            <td className="pr-3">path:GLOB</td>
            <td>{t('search.help.filter.cell.path')}</td>
          </tr>
          <tr>
            <td className="pr-3">not-path:GLOB</td>
            <td>{t('search.help.filter.cell.notPath')}</td>
          </tr>
          <tr>
            <td className="pr-3">state:VALUE</td>
            <td>{t('search.help.filter.cell.state')}</td>
          </tr>
          <tr>
            <td className="pr-3">priority:VALUE</td>
            <td>{t('search.help.filter.cell.priority')}</td>
          </tr>
          <tr>
            <td className="pr-3">due:RANGE</td>
            <td>{t('search.help.filter.cell.due')}</td>
          </tr>
          <tr>
            <td className="pr-3">scheduled:RANGE</td>
            <td>{t('search.help.filter.cell.scheduled')}</td>
          </tr>
          <tr>
            <td className="pr-3">prop:KEY=VALUE</td>
            <td>{t('search.help.filter.cell.prop')}</td>
          </tr>
          <tr>
            <td className="pr-3">not-prop:KEY=VALUE</td>
            <td>{t('search.help.filter.cell.notProp')}</td>
          </tr>
          <tr>
            <td className="pr-3">"phrase"</td>
            <td>{t('search.help.filter.cell.phrase')}</td>
          </tr>
          <tr>
            <td className="pr-3">AND / OR / NOT</td>
            <td>{t('search.help.filter.cell.boolean')}</td>
          </tr>
        </tbody>
      </table>
      <p>
        <Trans
          i18nKey="search.help.filter.datePredicates"
          components={{ mono, strong: <strong /> }}
        />
      </p>
      <p>
        <Trans
          i18nKey="search.help.filter.propertyFilters"
          components={{ mono, strong: <strong /> }}
        />
      </p>
      <p>
        <Trans
          i18nKey="search.help.filter.globs"
          components={{ mono, strong: <strong /> }}
          values={{ brace: '{a,b}' }}
        />
      </p>
      <p>{t('search.help.filter.examplesIntro')}</p>
      <ul className="list-disc pl-5">
        <li>
          <Trans i18nKey="search.help.filter.example.todo" components={{ mono }} />
        </li>
        <li>
          <Trans i18nKey="search.help.filter.example.meeting" components={{ mono }} />
        </li>
        <li>
          <Trans
            i18nKey="search.help.filter.example.brace"
            components={{ mono }}
            values={{ brace: '{Journal,Notes}' }}
          />
        </li>
      </ul>
    </div>
  )
}

/** Toggles section body. */
function TogglesBody() {
  const { t } = useTranslation()
  return (
    <div className="text-muted-foreground text-sm space-y-2">
      <p>{t('search.help.toggles.intro')}</p>
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-left">
            <th className="pr-3">{t('search.help.toggles.col.icon')}</th>
            <th className="pr-3">{t('search.help.toggles.col.mode')}</th>
            <th>{t('search.help.toggles.col.notes')}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="pr-3">
              <CaseSensitive className="h-4 w-4" aria-hidden="true" />
            </td>
            <td className="pr-3">{t('search.help.toggles.mode.caseSensitive')}</td>
            <td>{t('search.help.toggles.notes.caseSensitive')}</td>
          </tr>
          <tr>
            <td className="pr-3">
              <WholeWord className="h-4 w-4" aria-hidden="true" />
            </td>
            <td className="pr-3">{t('search.help.toggles.mode.wholeWord')}</td>
            <td>{t('search.help.toggles.notes.wholeWord')}</td>
          </tr>
          <tr>
            <td className="pr-3">
              <Regex className="h-4 w-4" aria-hidden="true" />
            </td>
            <td className="pr-3">{t('search.help.toggles.mode.regex')}</td>
            <td>{t('search.help.toggles.notes.regex')}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

/** Regex syntax section body. */
function RegexSyntaxBody() {
  const { t } = useTranslation()
  const mono = <span className="font-mono" />
  return (
    <div className="text-muted-foreground text-sm space-y-2">
      <p>
        <Trans i18nKey="search.help.regex.intro" components={{ mono }} />
      </p>
      <ul className="list-disc pl-5">
        <li>
          {/* Code tokens with angle brackets supplied verbatim so the Trans parser leaves them intact. */}
          <Trans
            i18nKey="search.help.regex.noLookaround"
            components={{
              strong: <strong />,
              m0: <span className="font-mono">(?=…)</span>,
              m1: <span className="font-mono">(?!…)</span>,
              m2: <span className="font-mono">(?&lt;=…)</span>,
              m3: <span className="font-mono">(?&lt;!…)</span>,
            }}
          />
        </li>
        <li>
          <Trans
            i18nKey="search.help.regex.noBackrefs"
            components={{
              strong: <strong />,
              m0: <span className="font-mono">\1</span>,
              m1: <span className="font-mono">\k&lt;name&gt;</span>,
            }}
          />
        </li>
        <li>
          <Trans
            i18nKey="search.help.regex.asciiBoundaries"
            components={{
              strong: <strong />,
              m0: <span className="font-mono">\b</span>,
              m1: <span className="font-mono">(?u:\b)</span>,
            }}
          />
        </li>
        <li>
          <Trans i18nKey="search.help.regex.inlineFlags" components={{ mono }} />
        </li>
        <li>
          <Trans i18nKey="search.help.regex.caps" components={{ mono }} />
        </li>
      </ul>
      <p>
        <Trans i18nKey="search.help.regex.bypassesFts" components={{ mono, strong: <strong /> }} />
      </p>
      <p>
        <Trans
          i18nKey="search.help.regex.seeAlso"
          components={{
            mono,
            // `lnk`, not `link`: `<link>` is a void element the Trans parser self-closes.
            lnk: (
              <a
                className="underline"
                href="https://docs.rs/regex/latest/regex/#syntax"
                target="_blank"
                rel="noreferrer"
                aria-label={t('search.help.regex.seeAlsoLinkLabel')}
              />
            ),
          }}
        />
      </p>
    </div>
  )
}

/** Boolean operators section body. */
function BooleanOperatorsBody() {
  const { t } = useTranslation()
  const mono = <span className="font-mono" />
  return (
    <div className="text-muted-foreground text-sm space-y-2">
      <p>{t('search.help.boolean.intro')}</p>
      <ul className="list-disc pl-5">
        <li>
          <Trans i18nKey="search.help.boolean.and" components={{ mono }} />
        </li>
        <li>
          <Trans i18nKey="search.help.boolean.or" components={{ mono }} />
        </li>
        <li>
          <Trans i18nKey="search.help.boolean.not" components={{ mono }} />
        </li>
      </ul>
      <p>
        <Trans i18nKey="search.help.boolean.phrases" components={{ mono }} />
      </p>
      <p>{t('search.help.boolean.regexNote')}</p>
    </div>
  )
}

/** Tips section body. */
function TipsBody() {
  const { t } = useTranslation()
  // #1005 — canonical chip. This is a standalone help kbd inside descriptive
  // prose (not an interactive row), so it stays readable to assistive tech;
  // no blanket `aria-hidden`.
  const kbd = <Kbd size="md" />
  return (
    <div className="text-muted-foreground text-sm space-y-2">
      <p>
        <Trans i18nKey="search.help.tips.recall" components={{ kbd, strong: <strong /> }} />
      </p>
      <ul className="list-disc pl-5">
        <li>{t('search.help.tips.dedupe')}</li>
        <li>{t('search.help.tips.perSpace')}</li>
        <li>{t('search.help.tips.dropdown')}</li>
        <li>{t('search.help.tips.clear')}</li>
        <li>{t('search.help.tips.toggleState')}</li>
      </ul>
    </div>
  )
}

export function SearchHelpDialog({ open, onOpenChange }: SearchHelpDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Radix `Dialog.Title` owns the label id: it renders the `<h2>` with
          its own generated `titleId` and points `Content`'s `aria-labelledby`
          at it automatically. Passing an explicit `id` to `DialogTitle`
          OVERRODE that generated id, so Radix's own labelling broke and its
          `TitleWarning` (which looks up the generated id via
          `getElementById`) fired a "DialogContent requires a DialogTitle"
          console.error. Let Radix wire it — no manual id / aria-labelledby. */}
      <DialogContent data-testid="search-help-dialog">
        <DialogHeader>
          <DialogTitle>{t('search.helpButtonLabel')}</DialogTitle>
          <DialogDescription>{t('search.help.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {/* Filter syntax section (populated). */}
          <section aria-labelledby="search-help-filter-syntax">
            <h3 id="search-help-filter-syntax" className="text-base font-semibold leading-tight">
              {t('search.help.section.filterSyntax')}
            </h3>
            <FilterSyntaxBody />
          </section>
          {/* Toggles. */}
          <section aria-labelledby="search-help-toggles">
            <h3 id="search-help-toggles" className="text-base font-semibold leading-tight">
              {t('search.help.section.toggles')}
            </h3>
            <TogglesBody />
          </section>
          {/* Regex syntax. */}
          <section aria-labelledby="search-help-regex-syntax">
            <h3 id="search-help-regex-syntax" className="text-base font-semibold leading-tight">
              {t('search.help.section.regexSyntax')}
            </h3>
            <RegexSyntaxBody />
          </section>
          {/* Boolean operators. */}
          <section aria-labelledby="search-help-boolean-operators">
            <h3
              id="search-help-boolean-operators"
              className="text-base font-semibold leading-tight"
            >
              {t('search.help.section.booleanOperators')}
            </h3>
            <BooleanOperatorsBody />
          </section>
          {/* Tips. */}
          <section aria-labelledby="search-help-tips">
            <h3 id="search-help-tips" className="text-base font-semibold leading-tight">
              {t('search.help.section.tips')}
            </h3>
            <TipsBody />
          </section>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
