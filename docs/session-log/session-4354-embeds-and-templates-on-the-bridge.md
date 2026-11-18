# Session 4354 — embeds and templates on the bridge

Slice 13 of #6926: the embed and template specs move onto the headless bridge (#6529), and one WebdriverIO spec is ported.

**Promoted to `REAL_BACKEND_SPECS`:** `embed-edit-in-place`, `embed-render-states`, `embed-task-tick`, `embed-typing`, `templates`, `templates-view`, `template-keeps-fields-6530`. None needed `@mock-only`.

**One race the bridge showed, fixed in the spec:** `embed-edit-in-place` failed 2 runs in 3. Its `{{embed` picker took Enter before the query's results came in, so the first item was still the picker's opening one (today's journal page), which the embed then showed. The test now waits for the first item to read the block it picks. After: 10 of 10.

**Ported into `templates.spec.ts`, then deleted from `e2e-tauri/`:** `journal-template-variables`. A journal template's block carrying `<% weekday %>`, `<% date+1 %>` and `<% today:EEEE, MMMM d, yyyy %>` is expanded for the day being created, yesterday by the real clock, not for today: the editor shows it and `load_page_subtree` stores it. The template is flagged through `set_property`, as the kebab does, rather than through the UI; the WDIO spec's date-picker path is the Journal's own `Previous day` here.

**Shown red on the bridge:** `expand_journal_template_variables` expanding against the next day, which for yesterday is today (the block read `Wednesday 2026-11-19`, not `Tuesday 2026-11-18`).

**Ran:**
- the seven files on the bridge, three repeats: 105 passed;
- the same files on the mock, two repeats: 70 passed;
- `npm run typecheck`, `node --test scripts/e2e-related.test.mjs`.
