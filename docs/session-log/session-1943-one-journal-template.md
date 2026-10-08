# Session 1943 — one journal template mechanism (#5373, #5357)

The journal had two template mechanisms: the page-based `journal-template`
flag and a per-space `journal_template` text property edited in Manage
spaces. The text one flattened every line to a top-level block, so nested
templates lost their indentation (#5357). Maintainer decision: keep the
page-based one only.

What shipped:

- `src/lib/template-utils.ts`: `loadJournalTemplateForSpace` and
  `insertTemplateBlocksFromString` are gone; a new day copies the space's
  journal template page with `insertTemplateBlocks`, which keeps nesting.
- `SpaceJournalTemplateEditor` and its Manage spaces section are deleted.
- `deleteSpaceTextJournalTemplates` removes the retired text values with
  ordinary `DeleteProperty` ops, once per device (`useAppSpaceLifecycle`,
  device preference `spaceTextJournalTemplatesDeleted`). The flag is written
  only after every delete lands, so a failure retries on the next boot.
- `src/components/journal/JournalTemplateButton.tsx` replaces the journal
  header's Manage spaces shortcut: a click opens the journal template page
  when the space has one; otherwise a popover lists the space's template
  pages to mark as the journal template, or creates a new one.
- `e2e/templates.spec.ts`: picking a template from the journal seeds a new
  day whose nested block keeps its parent.

Left as is: three backend doc comments still name the deleted text property;
changing them regenerates `bindings.ts`, so they go in a later backend PR.

Verified: the reviewer falsified each new test on a copy (flattened
`insertTemplateBlocks`, skipped template copy, removed the ref guard, the
flag check, the empty-space-list guard, and wrote the flag before the
deletes; every case red, restored and `cmp`-checked) and added the missing
empty-list case. Full `npx vitest run` exit 0 (20,761 passed);
`npm run typecheck` exit 0; `npx knip` clean; oxlint and oxfmt clean on the
changed files.
