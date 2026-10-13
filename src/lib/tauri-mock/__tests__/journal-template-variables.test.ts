/**
 * `expandJournalTemplateVariables` — the mock twin of the backend's
 * `expand_journal_template_variables` (#5395). The day-bound forms are pinned
 * against the backend by `conformance/fixtures/journal_template_day.json`;
 * this covers what that fixture cannot carry, the clock, and the format
 * edges the backend's unit tests pin.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { expandJournalTemplateVariables } from '@/lib/tauri-mock/handlers/shared'

const DAY = '2031-01-02'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 2, 7, 21, 5, 7))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('expandJournalTemplateVariables', () => {
  it('formats the clock with the time tokens, on the day being created', () => {
    expect(expandJournalTemplateVariables('<% time %> <% time:HH|H|hh|h|mm|m|ss|s|a %>', DAY)).toBe(
      '21:05 21|21|09|9|05|5|07|7|PM',
    )
    expect(expandJournalTemplateVariables('<% datetime:yyyy-MM-dd HH:mm %>', DAY)).toBe(
      '2031-01-02 21:05',
    )
    expect(expandJournalTemplateVariables('{{date:EEEE}} at {{time}}', DAY)).toBe(
      'Thursday at 21:05',
    )
  })

  it('keeps quoted text and punctuation literal, side by side', () => {
    expect(expandJournalTemplateVariables("<% today:'Week of' d 'o''clock', 100% %>", DAY)).toBe(
      "Week of 2 o'clock, 100%",
    )
    expect(expandJournalTemplateVariables('<% today:EEEE, MMMM d, yyyy %>', DAY)).toBe(
      'Thursday, January 2, 2031',
    )
  })

  it('gives the default form for a format it does not know, and leaves a non-variable', () => {
    expect(
      expandJournalTemplateVariables("<% today:yyyyy %> <% time:x %> <% today:'open %>", DAY),
    ).toBe('2031-01-02 21:05 2031-01-02')
    expect(
      expandJournalTemplateVariables('<% date+x %> <% date + 1 %> <% date+-1 %> <% season %>', DAY),
    ).toBe('<% date+x %> <% date + 1 %> <% date+-1 %> <% season %>')
    expect(expandJournalTemplateVariables('<% date+99999999999 %>', DAY)).toBe(
      '<% date+99999999999 %>',
    )
  })
})
