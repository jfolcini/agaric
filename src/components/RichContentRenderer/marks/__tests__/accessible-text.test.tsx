/**
 * #5745 S3 — a chip's accessible text starts with the words it shows, so a
 * screen reader reads, and voice control ("click <label>") matches, what the
 * user sees. Anything after those words is a state a sighted user reads from
 * styling, such as "(deleted)". No full ULID ever reaches either text.
 *
 * jsdom has no layout, so "visible" here is the text outside `.sr-only` and
 * `aria-hidden` subtrees. What TalkBack, VoiceOver or Narrator actually say is
 * a device check, not something this file can show.
 */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { renderRichContent } from '@/components/RichContentRenderer'
import { TooltipProvider } from '@/components/ui/tooltip'

const PAGE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const TAG_ID = '01CRZ3NDEKTSV4RRFFQ69G5FAV'
const BLOCK_ID = '01NRZ3NDEKTSV4RRFFQ69G5FAV'
const FULL_ULID = /[0-9A-HJKMNP-TV-Z]{26}/

function visibleText(el: Element): string {
  const clone = el.cloneNode(true) as Element
  for (const hidden of clone.querySelectorAll('.sr-only, [aria-hidden="true"]')) hidden.remove()
  return clone.textContent ?? ''
}

/** No chip uses `aria-labelledby`, so its name is its `aria-label` or its content. */
function accessibleText(el: Element): string {
  const label = el.getAttribute('aria-label')
  if (label !== null) return label
  const clone = el.cloneNode(true) as Element
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove()
  return clone.textContent ?? ''
}

type Options = Parameters<typeof renderRichContent>[1]

function chip(content: string, selector: string, options: Options): Element {
  const { container } = render(
    <TooltipProvider>{renderRichContent(content, options)}</TooltipProvider>,
  )
  const el = container.querySelector(selector)
  if (el === null) throw new Error(`no ${selector} rendered for ${content}`)
  return el
}

function expectSpeaksWhatItShows(el: Element, shown: string): void {
  expect(visibleText(el)).toBe(shown)
  const spoken = accessibleText(el)
  expect(spoken.slice(0, shown.length)).toBe(shown)
  expect(spoken).not.toMatch(FULL_ULID)
}

const deleted = () => 'deleted' as const
const interactivity: [string, Options][] = [
  ['static', {}],
  ['clickable', { interactive: true, onNavigate: () => {}, onTagClick: () => {} }],
]

describe.each(interactivity)('rendered chips speak what they show (%s)', (_mode, base) => {
  const link = `[[${PAGE_ID}]]`
  const labelled = `[[${PAGE_ID}|My label]]`
  const linkChip = '[data-testid="block-link-chip"]'

  it('a page link reads its title', () => {
    const el = chip(link, linkChip, { ...base, resolveBlockTitle: () => 'Roadmap' })
    expectSpeaksWhatItShows(el, 'Roadmap')
  })

  it('a namespaced page link reads the leaf it shows', () => {
    const el = chip(link, linkChip, { ...base, resolveBlockTitle: () => 'Projects/Roadmap' })
    expectSpeaksWhatItShows(el, 'Roadmap')
  })

  it('a deleted namespaced page link reads the leaf it shows', () => {
    const el = chip(link, linkChip, {
      ...base,
      resolveBlockTitle: () => 'Projects/Roadmap',
      resolveBlockStatus: deleted,
    })
    expectSpeaksWhatItShows(el, 'Roadmap')
  })

  it('a deleted labelled page link reads its label', () => {
    const el = chip(labelled, linkChip, {
      ...base,
      resolveBlockTitle: () => 'Roadmap',
      resolveBlockStatus: deleted,
    })
    expectSpeaksWhatItShows(el, 'My label')
  })

  it('an unresolved page link reads the id prefix it shows, never the whole id', () => {
    const el = chip(link, linkChip, base)
    expectSpeaksWhatItShows(el, `[[${PAGE_ID.slice(0, 8)}...]]`)
  })

  it('a tag reads its name', () => {
    const tag = `#[${TAG_ID}]`
    const live = chip(tag, '[data-testid="tag-ref-chip"]', {
      ...base,
      resolveTagName: () => '#work',
    })
    expectSpeaksWhatItShows(live, '#work')
  })

  it('a deleted tag reads its name', () => {
    const el = chip(`#[${TAG_ID}]`, '[data-testid="tag-ref-chip"]', {
      ...base,
      resolveTagName: () => '#work',
      resolveTagStatus: deleted,
    })
    expectSpeaksWhatItShows(el, '#work')
  })

  it('an unresolved tag reads the id prefix it shows', () => {
    const el = chip(`#[${TAG_ID}]`, '[data-testid="tag-ref-chip"]', base)
    expectSpeaksWhatItShows(el, `#${TAG_ID.slice(0, 8)}...`)
  })

  it('a block ref reads its title', () => {
    const ref = `((${BLOCK_ID}))`
    const live = chip(ref, '[data-testid="block-ref-chip"]', {
      ...base,
      resolveBlockTitle: () => 'Call the bank',
    })
    expectSpeaksWhatItShows(live, 'Call the bank')
  })

  it('a deleted block ref reads its title', () => {
    const el = chip(`((${BLOCK_ID}))`, '[data-testid="block-ref-chip"]', {
      ...base,
      resolveBlockTitle: () => 'Call the bank',
      resolveBlockStatus: deleted,
    })
    expectSpeaksWhatItShows(el, 'Call the bank')
  })

  it('an external link reads its label', () => {
    const el = chip('[the docs](https://example.com)', '[data-testid="external-link"]', base)
    expectSpeaksWhatItShows(el, 'the docs')
  })

  it('an attachment link reads its label', () => {
    const el = chip(`[report.pdf](attachment:${BLOCK_ID})`, '[data-testid="attachment-link"]', base)
    expectSpeaksWhatItShows(el, 'report.pdf')
  })
})

describe('chip markup', () => {
  it('has no axe violations for live, deleted and unresolved chips', async () => {
    const content = `[[${PAGE_ID}]] [[${PAGE_ID}|My label]] #[${TAG_ID}] ((${BLOCK_ID})) [docs](https://example.com)`
    const { container } = render(
      <TooltipProvider>
        {renderRichContent(content, {
          resolveBlockTitle: () => 'Projects/Roadmap',
          resolveBlockStatus: deleted,
          resolveTagStatus: deleted,
        })}
      </TooltipProvider>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
